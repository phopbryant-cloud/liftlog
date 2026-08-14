# LIFTLOG — Handoff

Personal workout-tracking PWA. Single-user, no auth, no backend. Mobile-first
(used on a phone in the gym). Differentiator: import workouts by pasting messy
raw text.

Owner: spratlin@rehabceos.com. Built 2026-08-14. Status: **fully functional,
verified end-to-end.** All originally-requested features are implemented.

**Update 2026-08-14 (same day):** per-exercise notes are now editable during a
live workout, persist week over week, and show previous weeks' notes inline and
in the exercise sheet. The rest-timer beep is now a synthesized boxing bell that
also rings when the app is backgrounded or the phone is locked. See §6 for the
behaviors and §8 for what is and is not verified — **the locked-screen bell still
needs a real-iPhone test.**

---

## 1. How to run

Static files, no build step. Serve the folder over HTTP (service worker + Google
Fonts need http(s), not `file://`):

```bash
cd "Workout app"
python3 -m http.server 8777
# open http://localhost:8777
```

### Verify without a manual click-through (headless Chrome is on this Mac)
```bash
# clean boot + console errors
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --enable-logging=stderr --v=1 \
  --virtual-time-budget=3000 --dump-dom "http://localhost:8777/index.html" \
  2>/tmp/cerr >/tmp/dom.html
grep -o 'No templates\|Import workout' /tmp/dom.html   # boot rendered
grep -i CONSOLE /tmp/cerr | grep -vi 'deprecated\|service worker'  # JS errors
```
NOTE: headless screenshots lay out at ~500px CSS width regardless of
`--window-size`, so a 390px screenshot canvas *clips* the right edge — that is a
capture artifact, not a layout bug. Screenshot at `--window-size=520,...` to see
the true layout. `scrollWidth <= innerWidth` = no real overflow.

### Node logic tests (in `tests/`, committed)
```bash
node tests/test-notes.js   # 21 checks — notes storage, dated log, settings
node tests/test-bell.js    # 22 checks — WAV encoder, double-schedule race
```
Both stub `window`/`localStorage` and `require()` the module the way the browser
loads it. Earlier `test-parser.js` / `test-store.js` lived only in the session
scratchpad and are gone — that is why these are committed.

---

## 2. Serving to the phone TODAY (deployment situation)

The user has personal GitHub + Netlify but **could not log in** during the build
session (work instances occupying them). Interim solution in use:

- **cloudflared quick tunnel** (installed via `brew install cloudflared`, no
  account/key needed):
  ```bash
  cloudflared tunnel --url http://localhost:8777
  ```
  Prints a `https://<random>.trycloudflare.com` URL.
- Plan given to user: open that URL on the phone → **Add to Home Screen /
  Install** → open once so the SW caches the shell → then the app runs **fully
  offline from the phone**, no Mac/tunnel/network needed at the gym.

**⚠ Background processes from the build session (server on :8777, the tunnel) do
NOT persist into a new session** — restart them if needed. The specific tunnel
URL printed earlier is dead once cloudflared stops.

**Data-migration caveat:** localStorage is per-origin. The random trycloudflare
subdomain changes each run, and the eventual Netlify URL is different again — so
history does NOT carry across origins automatically. The app has **Settings →
Export / Import JSON** for exactly this: export from the temp instance, import
into the permanent one. Tell the user to do this when migrating.

**Preferred permanent host:** drop the folder on Netlify or GitHub Pages (any
static host) once the user can log in → stable HTTPS origin → installable,
offline, and background notifications all work permanently.

---

## 3. Architecture

Vanilla JS, no framework, no bundler. Classic `<script>` tags (NOT ES modules).

### ⚠ Critical gotcha: shared global scope
Classic scripts share ONE global lexical scope. A `function foo(){}` in one file
and a `const foo = …` in another are a **redeclaration SyntaxError** that aborts
the whole script (this actually happened — `parseWorkout` collided). Mitigation:
`parser.js`, `store.js`, `session.js`, `history.js`, `settings.js` are each
wrapped in an **IIFE** and expose exactly one global (`window.WorkoutParser`,
`window.Store`, `window.Session`, `window.History`, `window.Settings`).
`app.js` is intentionally NOT wrapped — its top-level helpers (`el`, `$`,
`fmtTime`, `toast`, `show`) are the shared globals the IIFE modules call at
runtime. `node --check` does NOT catch cross-file collisions; only a real browser
load does. Keep new files IIFE-wrapped.

### Script load order (index.html, bottom of body)
`parser.js → store.js → bell.js → session.js → history.js → settings.js → app.js`
app.js is last and owns boot (`DOMContentLoaded`). `bell.js` must precede
`session.js`, which calls it.

### Files
| File | Role |
|---|---|
| `index.html` | App shell: 7 `<section class="screen">` + bottom nav. Fonts via Google Fonts. |
| `css/app.css` | All styling. Lakers theme via CSS vars in `:root`. |
| `js/parser.js` | `window.WorkoutParser` — forgiving text→workout parser. |
| `js/store.js` | `window.Store` — single versioned localStorage key + all data queries. |
| `js/app.js` | Import/preview/rest-setup flow, template list, nav, boot. `window.App`. |
| `js/bell.js` | `window.Bell` — boxing-bell synthesis, foreground ring, WAV encode + background scheduling. |
| `js/session.js` | `window.Session` — active workout engine, rest timer, finish summary. |
| `js/history.js` | `window.History` — history list + per-exercise progression sheet + SVG chart. |
| `js/settings.js` | `window.Settings` — export/import/erase. |
| `js/timer-worker.js` | Web Worker: timestamp-based rest countdown. |
| `sw.js` | Service worker: cache-first shell + Google Fonts. **Bump `CACHE` on any shell change.** |
| `manifest.webmanifest` | PWA manifest. |
| `icons/icon.svg` | App icon (gold barbell on Laker purple). |

### Screens (client-side, no router lib)
`show(name)` toggles `.screen.active`. Screens: `templates`, `import`,
`preview`, `rest`, `session`, `history`, `settings`. Overlays (summary,
exercise-history sheet) are appended to `<body>`, not screens.

---

## 4. Data model — single localStorage key `workout-tracker-v1`

```js
{
  version: 1,
  templates: [ Template ],
  sessions:  [ Session ],   // completed workouts (newest unshifted to front)
  active:    Session|null,  // in-progress workout, persisted every change (crash-safe resume)
  notes:     { "<normalized exercise name>": { text, updatedAt } },  // standing notes
  settings:  { units: 'lbs', lastRestSec: 120, bellEnabled: true, bgBellEnabled: true }
}
```

```js
Template = {
  id, name, createdAt,
  exercises: [{
    id, name, cue,                       // cue = free text shown under name in session
    setGroups: [{ label|null, sets }],   // >1 group = split implement (e.g. cable / dumbbell)
    restSec,                             // per-exercise rest, seconds
    supersetId|null                      // shared id pairs alternating exercises
  }]
}

Session = {
  id, templateId, name, startedAt, finishedAt|null,
  entries: [{
    exId, name, note, supersetId, restSec,   // `cue` on pre-notes entries only
    sets: [{ label|null, weight, reps, done, warmup, skipped, prefilled }]  // weight/reps are strings
  }],
  rest: { endAt, entryName, total }|null   // live rest timer target (ms epoch)
}
```

Progression is keyed by **normalized exercise name** (lowercase/trim), so the same
exercise across different templates aggregates. Key `Store` queries:
`lastSetsForExercise(name)` (prefill source, newest completed session, includes
warm-ups positionally), `allTimeBestWeight(name)` (max weight, warm-ups
excluded), `historyForExercise(name)` (newest-first, each with `topWeight`).

---

## 5. Parser rules (`parser.js`, the differentiator)

Input = messy pasted text. Output `{ name, exercises:[...] }`. Rules:
- **Title** = first non-empty line with no set count, before any exercise. If the
  first meaningful line has a set count, there's no title → "Imported Workout".
- Split each exercise line on ` - `. First fragment = **name**. Any fragment
  matching a set count (`/(\d+)\s*(?:x\s*)?sets?/i`, also `sets: N`) sets the
  count; **all other fragments = cues** (so mid-line cues are kept, not just
  trailing).
- **`superset:` header** starts a group. Following lines with NO own set count
  join it and inherit its count. A line WITH its own count exits the superset.
  Blank line closes it.
- **Split implement** — a line with multiple set-count fragments
  (`2 sets cable - 2 sets dumbbell`) → ONE exercise, multiple labeled `setGroups`
  (label = fragment minus the "N sets" token). **Decision: one labeled exercise,
  NOT two separate exercises** (user confirmed OK; flip in `parseExerciseLine` if
  they change their mind).
- No count found → defaults to 3 sets, flagged `inferred:true` (amber highlight
  in preview).

Verified output for the Push-day sample: Rear Delt 4 / Incline 3 / Cable fly 4
(cues: "seated straight up · cables slightly above bottom") / superset curls +
hammer curls @3 / side laterals [2 cable + 2 dumbbell]. ✓

---

## 6. Key UX behaviors (don't regress these)

- **One-tap logging**: set rows pre-fill weight/reps from the last session for
  that exercise+set index. `oninput` writes to the model as you type. Tapping ✓
  just sets `done:true` and reads current model values → one tap logs a repeat.
- **Rest timer**: auto-starts on log. Web Worker ticks but the **main thread owns
  the target timestamp** (`rest.endAt`), so background/lock throttling can't
  drift it. `visibilitychange`→visible recomputes and fires `onRestDone` if
  already elapsed. Falls back to main-thread `setInterval` if Worker fails.
  Chime = WebAudio oscillator (needs a prior user gesture; init on start + each
  log). Also `navigator.vibrate` + Notifications API (best-effort).
- **Supersets**: rest starts only after the WHOLE round is done
  (`maybeStartRest` checks all members' set[round]).
- **Per-set**: tap badge = toggle warm-up (excluded from volume/PR); long-press
  badge = skip; `+ Set` adds (prefilled from last row). Exercise header: ↑ ↓
  reorder, ⤫ skip remaining. `+ Add exercise` = ad-hoc (uses `prompt()`).
- **Finish**: computes PRs vs history **before** saving (heaviest weight any rep,
  warm-ups excluded), total volume, duration, set count → summary overlay.
- **Crash-safe**: `active` session persisted on every change; boot auto-resumes
  it (`app.js` boot → `Session.resume`).
- **Tap any exercise name anywhere** (templates, session, history) →
  `History.openExercise(name)` progression sheet: all-time best, notes, top-set
  SVG line chart (needs 2+ sessions), per-session log with best-set highlight +
  PR badges.
- **Notes** (per exercise, editable mid-workout). Keyed by *normalized exercise
  name* in `db.notes`, so one note is shared by every template containing that
  exercise, and it survives deleting a template. Read entries through
  `Store.noteOfEntry(entry)` — never `entry.cue` directly — since entries
  persisted before this feature only have `cue`.
  - A template `cue` only **seeds** a note that does not exist yet. Seeding
    checks `Store.hasNote()` (key existence), NOT truthiness. Clearing a note
    stores a **tombstone** (`text: ''`) rather than deleting the key, so a note
    you deliberately delete is never resurrected from a stale template cue on
    re-import or on the next workout. This is why `hasNote` exists.
  - The dated log (`Store.notesForExercise`) is **derived** from completed
    sessions, not stored twice. Consecutive sessions with identical text collapse
    into one row; `count` counts collapsed *entries*, not sessions, so any UI
    rendering "unchanged since" must guard `since !== date` (the same exercise
    can appear twice in one session via ad-hoc re-add).
  - **Never call `render()` from the note textarea.** From `oninput` it destroys
    the textarea and drops focus mid-word; from `onblur` it removes the node
    under a pending tap and swallows the tap that caused the blur, silently
    failing to log a set. Use `refreshNoteBlock(idx)`, which replaces only that
    block. `oninput` does a single `persist()`; the standing note is written once
    on blur, not per keystroke.
- **Rest bell** (`bell.js`), replaces the old oscillator beep.
  - **Foreground:** rings via WebAudio with no media element, so the user's music
    is untouched. This is the common case.
  - **Backgrounded/locked mid-rest:** `visibilitychange`→hidden and `pagehide`
    both call `onHidden`, which encodes `[silence for the remaining rest + bell]`
    to a WAV and plays it through a media element. This claims the iOS
    *playback* audio session — the only way to ring from a locked screen. On
    return, `Bell.cancel()` releases the session.
  - **`bgBellEnabled` DEFAULTS OFF.** On-device testing confirmed the mechanism
    works — the bell does ring from a locked iPhone — but also that iOS does
    **not** restart the user's music once the interruption ends. In practice
    every trip out of the app mid-rest permanently killed their music, which the
    owner judged worse than losing the locked-screen bell. Do not flip this
    default back without re-testing on a real phone with music playing. The
    default lives in TWO places that must agree: `bgBellEnabled()` in
    `session.js` and the `toggleRow(...)` call in `settings.js`.
  - iOS gives web audio either *ambient* (mixes, dies when backgrounded) or
    *playback* (survives backgrounding and the ringer switch, interrupts others).
    There is no mix-and-continue mode and no local notification scheduling, so
    claiming playback only at the moment of backgrounding is the whole design.
  - `Bell.didFireScheduled()` prevents a double bell on return, and is read
    **before** `Bell.cancel()` resets it. `scheduleAt` is reentrancy-safe: both
    listeners can fire for one backgrounding, and without the generation token a
    stale `play()` rejection would clear a newer call's `armed` flag and defeat
    that guard.
  - The rendered buffer is **normalized to 0.89 peak**. Raw summed partials peak
    near 2.0 and hard-clip into a buzz — the node tests cannot catch this, so
    measure peak/RMS in a real browser after touching the synthesis.
  - `vibrate` and the notification are deliberately NOT gated by `bellEnabled` —
    they are the redundancy layer.

---

## 7. Design system — LA Lakers

CSS vars in `css/app.css` `:root`. Purple-led, gold accent.
- `--bg #0c0a12`, cards `--bg-card #191124`, lines `--line #2b2139`
- `--volt #a855f7` = primary interactive purple (name is legacy from the original
  lime theme; it's purple now — every `var(--volt)` reference is intended purple)
- `--purple-btn #7c3aed` (CTA fill), `--purple-deep #552583` (official, glows)
- `--gold #fdb927` (official) = values, PR badges, timer numbers, brand mark
- `--ss #c084fc` = superset lavender (kept distinct from primary purple)
- Fonts: **Anton** (display/headers), **Archivo** (body), **JetBrains Mono**
  (all numerics). Loaded from Google Fonts, cached by SW for offline.
- Touch targets ≥52px (`--tap`). High contrast for sweaty hands.

---

## 8. Verified (evidence, not assumption)

- Parser: node test, all patterns correct.
- Data layer: node test — prefill, all-time best (warm-up excluded), history
  order, topWeight all PASS.
- Full app: headless boot with **zero console errors**.
- Live session render: prefill shows, supersets show Round 1/2/3, split shows
  cable/dumbbell labels, all rows fit at true width.
- Finish summary: PR detection correct incl. "(was 75)" previous-best display,
  volume + set count correct.
- History + progression chart + best-set highlight + PR badge: correct.

### Notes + rest bell (added 2026-08-14)
- Store layer: 21 node checks — tombstones, name normalization, dated-log run
  collapsing, legacy `cue` fallback, both `notes` backfill paths, settings.
- Bell: 22 node checks — WAV header/sizes/clamping, plus a regression test for
  the double-schedule race (mutation-tested: 3 failures against the unfixed code).
- Real-browser measurements: bell buffer 1ch / 22050 Hz / 48511 samples, peak
  0.89, **zero** samples at the 16-bit rails, WAV length matches expected.
- Driven in real Chrome: note editing round trip, `Last time` line appearing only
  when the note differs, all six history-sheet note cases, template-cue seeding
  incl. the cleared-note case, both settings toggles persisting across reload,
  and the toggles actually gating `Bell.ring` / `Bell.scheduleAt`.
- Full regression re-run after the bell landed: parser shape, prefill, supersets,
  split implements, PR detection, export/import round trip — all unchanged.

### On-device results (owner's iPhone, installed PWA)
- App installs, Settings opens, bell synthesizes and sounds correct. ✓
- **Locked-screen bell WORKS** — iOS does honor `play()` inside the
  visibility-change window, so the scheduled-WAV approach is sound. ✓
- **But iOS never restarts the user's music** after that interruption. Every
  trip out of the app mid-rest killed their music for the remainder of the
  workout. Owner's call: not worth it → `bgBellEnabled` now defaults OFF.
- Root cause of a "dead Settings button" during that session was the service
  worker silently dropping an uncached asset (fixed, see §10) — NOT a bug in the
  notes or bell code.

---

## 9. Backlog / possible next steps (all originally-requested items are DONE)

Nice-to-haves not requested but natural extensions:
- Real PNG icons (currently one SVG; some launchers prefer maskable PNGs 192/512).
- Bodyweight/assisted handling (empty weight is allowed; volume treats it as 0).
- Rest-timer "skip rest for warm-up sets" option.
- Template drag-reorder (currently ↑↓ buttons).
- Prefill alignment when warm-up counts differ between sessions (currently
  positional over all logged sets — good enough, occasionally off by the warm-up
  offset).
- Per-set RPE / notes.
- Trend chart: switch between top-set weight and est. 1RM or volume.

## 10. When editing
- Change anything in the SW shell list (`sw.js` SHELL) or any cached asset →
  **bump `CACHE` version** (`liftlog-vN`) or the old file is served from cache.
  Currently at `liftlog-v6`. This bit us during development: a browser profile
  served a stale `index.html` predating the `bell.js` script tag, making
  `window.Bell` undefined. When testing locally, use a fresh incognito window or
  unregister the SW before concluding a change did not work.
- Node tests now live in `tests/` (not the scratchpad, which does not survive a
  session): `node tests/test-notes.js` (21 checks) and `node tests/test-bell.js`
  (22 checks). Both stub `window`/`localStorage` and `require()` the module the
  way the browser loads it.
- The repo is now under **git**, on branch `feature/notes-and-bell`.
- After editing JS, do a **real browser load** (headless dump-dom) to catch
  global-scope collisions — `node --check` won't.
- Keep new modules IIFE-wrapped, exposing one `window.X`.
- `Date.now()` / `Math.random()` are fine in this app's runtime JS (the ban on
  them applies only to Workflow orchestration scripts, which this project doesn't use).
```
