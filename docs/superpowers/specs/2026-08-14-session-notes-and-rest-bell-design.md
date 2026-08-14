# LIFTLOG — Editable session notes + background rest bell

Date: 2026-08-14
Status: approved design, ready for implementation plan

Two independent features against the existing vanilla-JS PWA described in
`HANDOFF.md`. They share no code and can ship in either order.

1. **Notes** — make the per-exercise note editable inside a live workout, keep it
   week over week, and show past weeks' notes during the workout.
2. **Rest bell** — replace the beep-at-zero with a boxing-gym bell that rings
   even when the app is backgrounded or the phone is locked.

---

# Feature 1 — Editable exercise notes with week-over-week history

## Problem

The note under each exercise is the `cue` field. It is parsed at import
(`parser.js`), editable only on the import-preview screen (`app.js:188`), copied
into the session entry (`session.js:97`), and rendered read-only in the workout
(`session.js:217`). Nothing writes it back. A cue you discover mid-set is lost.

## Decisions

- Scope is **per-exercise only**. No workout-level note, no per-set note.
- A note edit is **sticky and dated**: it becomes the standing note for that
  exercise everywhere, and each session keeps a snapshot so you get a dated log.
- Notes are keyed by **normalized exercise name**, the same `normName` key
  progression already uses. Editing "Incline press" in one template updates it in
  every template containing it, and the note survives deleting a template.
- The dated log is **derived from completed sessions**, not stored separately, so
  there is one source of truth.

Rejected: writing back to `template.exercises[].cue` (notes trapped per template,
divergent copies of the same exercise, lost when a template is deleted) and a
separately stored log array (second source of truth that can drift).

## Data model

New top-level key on the existing `workout-tracker-v1` object:

```js
notes: {
  "<normalized exercise name>": { text: String, updatedAt: Number }
}
```

Additive, so `SCHEMA_VERSION` stays `1`. Two backfill points, both required:

- `store.js` `load()` — `if (!_db.notes) _db.notes = {};` after the version check.
- `store.js` `importJSON()` — same backfill after `_db = parsed`, because import
  assigns the parsed object directly and bypasses `load()`. A backup exported
  before this feature has no `notes` key.

`exportJSON` needs no change; `notes` lives inside the db object it serializes.

Session entries gain a `note` string:

```js
entries: [{ exId, name, note, supersetId, restSec, sets: [...] }]
```

`cue` is no longer written onto new entries. Every reader uses one helper so old
data keeps working:

```js
noteOf(entry) => entry.note != null ? entry.note : (entry.cue || '')
```

This matters for sessions already in the user's history and for an `active`
session persisted by the previous build and resumed after upgrade.

## Store API

```js
getNote(name) -> String            // '' when unset
setNote(name, text) -> void        // trims; empty text deletes the key
notesForExercise(name) -> [{ text, date, since, count }]   // newest first
```

`setNote` writes `{ text, updatedAt: Date.now() }` and calls `save()`. Empty or
whitespace-only text deletes the key rather than storing `''`, so `getNote`
falls through to the template cue seed.

`notesForExercise` walks `completedSessions()` (already newest-first), collects
each entry matching the normalized name whose `noteOf` is non-empty, then
collapses **consecutive runs of identical text** into one row:

- `text` — the note
- `date` — newest session in the run
- `since` — oldest session in the run
- `count` — number of sessions in the run

An unchanged note across eight weeks is one row reading "unchanged since Jun 3",
not eight identical rows. Non-consecutive repeats stay separate rows, because
reverting to an earlier cue is real information.

## Template cue becomes a seed

`app.js` saves a template around line 387. After building the exercise list, for
each exercise with a non-empty cue:

```js
if (!Store.getNote(name)) Store.setNote(name, cue);
```

Only when no standing note exists. Re-importing the same workout text must not
clobber a note refined over weeks. Session entry construction
(`session.js` `buildEntries`) resolves in the same order:

```js
note: Store.getNote(ex.name) || ex.cue || ''
```

## Session UI

Replace `session.js:217` (`if (e.cue) card.appendChild(...)`) with a
`noteBlock(entryIdx)` component. Same block is appended under each superset
member head at `r === 0` in `supersetBlock`.

Collapsed state:

- Note present — `.ex-cue` text with a `✎` affordance; tapping anywhere enters
  edit mode.
- No note — a low-profile `+ Note` button so empty exercises stay compact.

Edit state:

- A `<textarea class="note-input">`, autofocused, auto-growing (`height =
  scrollHeight` on input), styled like the existing `.cue-input`.
- `oninput` writes `entry.note`, calls `Store.setNote(name, value)` and
  `persist()` — the same crash-safe path the weight/reps inputs use
  (`session.js:301`). No save button.
- `oninput` must **not** call `render()`. A full re-render destroys the textarea
  and drops focus mid-word.
- `onblur` exits edit mode by replacing **only that note block** via a
  `refreshNoteBlock(entryIdx)` helper — not a full `render()`. A full re-render
  on blur removes the DOM node under a pending tap, so the tap on the `✓` that
  caused the blur would be swallowed on mobile.

Previous-week line:

- One dimmed, single-line, ellipsis-truncated `.note-prev` under the note:
  `Last time · Aug 7 — "went too heavy, drop to 45"`.
- Sourced from the first `notesForExercise` row whose text differs from what is
  currently on screen. Hidden when there is no such row, so an unchanged note
  shows nothing.
- Tapping it opens `History.openExercise(name)`.

Edit mode is transient module state, not persisted. The rest timer updates
targeted DOM ids rather than re-rendering, so a running timer will not disturb
an open editor.

## Exercise history sheet

`history.js` `openExercise` gains a **Notes** section immediately after the
all-time-best badge and before the chart — notes must be readable without
scrolling, because this sheet is how you read them mid-workout.

- First row: the standing note tagged `Current`, shown even when it has never
  appeared in a completed session.
- Then each `notesForExercise` row: date (and `unchanged since <since>` when
  `count > 1`) plus the text.
- Empty state: "No notes yet. Add one from a workout."

## CSS

New classes in `css/app.css`, using existing vars only:
`.note-block`, `.note-input`, `.note-add`, `.note-prev`, `.note-log`,
`.note-log-row`, `.note-log-date`, `.note-log-current`. `.note-input` inherits
the `.cue-input` treatment. Tap targets on `+ Note` and the note body stay at
`var(--tap)` height or greater.

---

# Feature 2 — Boxing bell that rings when the app is backgrounded

## Problem

`session.js` `chime()` fires a WebAudio oscillator at the moment rest hits zero.
When the phone is locked or the user has switched to a music app, the page is
frozen and nothing fires. The notification is the only surviving signal, and iOS
web notifications cannot carry a custom sound.

## The iOS constraint, stated plainly

On iPhone, web audio gets one of two OS audio sessions:

- **ambient** — mixes with other apps' audio, but is suspended when the page is
  backgrounded and silenced by the ringer switch.
- **playback** — survives backgrounding and the ringer switch, but interrupts
  whatever else is playing.

There is no mix-and-continue-in-background mode available to web apps, and iOS
has no local notification scheduling (no `TimestampTrigger`), so a future-dated
alert without a server is impossible. The user wants both an uninterrupted music
app and a bell that rings from a locked screen; these cannot both hold at the
same instant. The design resolves it by claiming audio only when it must.

## Approach: claim the audio session at backgrounding, not at rest start

- **Foreground** — no media element playing. The bell rings through WebAudio at
  zero. Music untouched. This is the common case.
- **Backgrounding or screen lock mid-rest** — `visibilitychange` → `hidden` (and
  `pagehide`) fire while JS is still briefly alive. At that moment: generate a
  WAV of [silence for the remaining seconds + bell], claim the playback session,
  and play it through a persistent `<audio>` element. iOS carries the media to
  completion with the screen off.
- **Returning before it rings** — cancel playback, release the audio session and
  blob, and let the foreground path handle the bell.

Music is therefore interrupted only during a rest period the user spent outside
the app, which is exactly the case where the bell is the only signal available.

Playing the silence-plus-bell from rest start instead was rejected: it would
interrupt music for every rest period including the majority spent staring at
the app.

## New module: `js/bell.js`

`session.js` is already 572 lines. Audio goes in its own IIFE module exposing
one global, per the `HANDOFF.md` global-scope rule.

```js
window.Bell = { init, ring, scheduleAt, cancel, didFireScheduled, test }
```

- `init()` — idempotent. Creates/resumes the `AudioContext`, renders the bell
  buffer once, creates the persistent `<audio playsinline>` element, and
  performs the autoplay unlock (assign a tiny silent WAV, `play()`, immediately
  `pause()`), which is what later permits `play()` outside a gesture. Must be
  called from a user gesture; existing `initAudio()` call sites already are.
- `ring()` — plays the rendered buffer through the `AudioContext` now.
- `scheduleAt(endAt)` — computes remaining seconds, encodes the WAV, sets
  `navigator.audioSession.type = 'playback'` when the API exists, sets the blob
  as `src`, and `play()`s. Sets `navigator.mediaSession.metadata` to a LIFTLOG
  rest title so the lock screen is not confusing.
- `cancel()` — pauses, clears `src`, revokes the object URL, and restores
  `navigator.audioSession.type = 'auto'`.
- `didFireScheduled()` — whether the scheduled audio already played, tracked via
  the element's `ended` event. Prevents a double bell when the user returns to a
  foreground `onRestDone` after the background bell already rang.
- `test()` — `init()` then `ring()`, for the Settings button.

### Bell synthesis

Rendered once through `OfflineAudioContext(1, sampleRate * 2.2, sampleRate)` and
cached as an `AudioBuffer`:

- Two strikes, second at +0.35s, second slightly quieter.
- Each strike: inharmonic partials at ratios `[1, 2.76, 5.40, 8.93]` over
  `f0 ≈ 880 Hz` — the classic bell inharmonicity that reads as metallic rather
  than as a sine beep. Descending gains, exponential decay, longest on the
  fundamental (~1.6s) and shortest on the top partial (~0.5s).
- A ~30ms bandpassed noise burst at each strike for the mallet transient, which
  is what makes it cut through gym noise and headphones.

No audio asset ships, so nothing new to download or cache-bust.

### WAV encoding

`encodeWav(buffer, leadSilenceSec)` → 16-bit PCM mono `Blob` at **22050 Hz**.

Sample rate is a deliberate memory tradeoff: 22050 Hz mono 16-bit is ~44 KB/s, so
a 180-second rest is ~4 MB held transiently on a phone. 44.1 kHz would double it;
8 kHz would flatten the bell's brightness, which is the whole point of the sound.
The blob is allocated only on backgrounding and revoked on `cancel()` or on the
`ended` event.

### Fallback chain

1. Scheduled media plays → bell rings, locked screen or not.
2. `play()` rejects (iOS declines the hidden-window playback) → the existing
   notification + `navigator.vibrate` still fire when the page next wakes. This
   is exactly today's behavior, so the feature degrades to the status quo rather
   than regressing it.
3. `AudioContext` unavailable → `ring()` is a no-op; notification and vibrate
   remain.

## `session.js` wiring

- `initAudio()` delegates to `Bell.init()`. The `chime()` oscillator function is
  deleted.
- `onRestDone()` — `if (settings.bellEnabled && !Bell.didFireScheduled())
  Bell.ring();` then the existing `vibrate()` and `notify()`, both retained as
  redundancy and both unaffected by the bell toggle.
- New `visibilitychange` → `hidden` and `pagehide` handlers: when `S.rest` is
  active and `endAt` is in the future and the background-bell setting is on, call
  `Bell.scheduleAt(S.rest.endAt)`.
- The existing `visibilitychange` → `visible` handler additionally calls
  `Bell.cancel()` when the rest is still pending.
- `Skip` calls `Bell.cancel()`.
- `adjustRest` calls `Bell.cancel()` defensively; `±15` is only reachable in the
  foreground, where no scheduled audio should exist.

Adjusting or skipping rest while backgrounded is impossible by construction —
those controls only exist in the app. Skipping after returning cancels a bell
that has not fired yet.

## Settings

A **Rest bell** section in `settings.js`:

- `Test bell` button — calls `Bell.test()`, and doubles as the audio unlock.
- `Bell sound` toggle → `settings.bellEnabled`, default `true`.
- `Ring when the app is closed` toggle → `settings.bgBellEnabled`, default
  `true`, with the honest sublabel: *pauses your music during rest*.

Both persist in the existing `settings` object in the db.

## Shell changes

- `index.html` script order becomes:
  `parser.js → store.js → bell.js → session.js → history.js → settings.js → app.js`
  Bell must load before `session.js`, and `app.js` stays last and unwrapped.
- `sw.js` — add `./js/bell.js` to `SHELL` and bump `CACHE` from `liftlog-v4` to
  `liftlog-v5`. Without the bump, phones serve the old shell from cache.

---

# Verification

## Automated

- `test-notes.js` (node, scratchpad, same stubbing pattern as the existing
  `test-store.js`): `getNote` / `setNote` round trip; empty text deletes the key;
  `notesForExercise` ordering, consecutive-run collapsing with correct
  `date`/`since`/`count`; non-consecutive repeats stay separate; legacy `cue`
  fallback; exercise with no history returns `[]`; `importJSON` of a backup
  without a `notes` key does not throw.
- `test-bell.js` (node): `encodeWav` against a stub buffer — RIFF/WAVE header
  bytes, declared chunk sizes matching actual byte length, correct total length
  for a given lead silence, and silence samples actually zero. `bell.js` gets the
  same `module.exports` guard `parser.js` and `store.js` use.
- Headless Chrome load per `HANDOFF.md` §1: zero console errors, which is the
  only thing that catches cross-file global collisions, plus a DOM check that the
  note block renders in a session.

## Manual, on the user's iPhone

The locked-screen path cannot be verified headlessly. Checklist:

1. Rest completes with the app open and in the foreground → bell rings.
2. Rest completes after switching to another app → bell rings.
3. Rest completes with the screen locked → bell rings.
4. Music playing, app in foreground the whole rest → music never interrupted.
5. Music playing, phone locked mid-rest → bell rings over/through, music behavior
   noted.
6. Return to the app before rest ends → no double bell, music resumes.
7. Edit a note mid-workout, finish, start the same workout next time → note is
   pre-filled, and last week's differing note shows on the `Last time` line.

---

# Out of scope

Workout-level and per-set notes; a user-selectable sound library; Web Push (needs
a server this app does not have); rich text or images in notes; editing notes
from the templates screen.

# Risks

- **iOS may reject `play()` during the visibility-change window.** The single
  largest unknown. Degrades to today's notification + vibrate, so it cannot
  regress the current experience. Confirmed only by manual test 3.
- **Transient blob memory** for long rests (~4 MB at 180s). Revoked promptly.
- **The autoplay unlock in `init()`** plays a fraction of a second of silence,
  which on iOS can briefly duck other audio. It runs on the first `✓` tap of a
  workout and on `Test bell`, not once per rest. If manual test 4 shows an
  audible duck, move the unlock to the `Start workout` tap so it happens once per
  session, well before any music matters.
- **Music interruption** when backgrounding mid-rest is inherent to the platform,
  disclosed in the Settings sublabel, and switchable off.
- **Focus loss in the note textarea** if any code path calls a full `render()`
  during editing. Mitigated by `refreshNoteBlock` and by never re-rendering on
  `oninput`.
