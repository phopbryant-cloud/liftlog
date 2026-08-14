# LIFTLOG — Handoff

Personal workout-tracking PWA. Single-user, no auth, no backend. Mobile-first
(used on a phone in the gym). Differentiator: import workouts by pasting messy
raw text.

Owner: spratlin@rehabceos.com. Built 2026-08-14. Status: **fully functional,
verified end-to-end.** All originally-requested features are implemented.

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

### Node logic tests (in scratchpad, reusable)
- `test-parser.js` — parser against the Push-day example.
- `test-store.js` — prefill / PR / history math against real session shapes.
Both stub `window`/`localStorage` and `require()` the module. Run with `node`.
`parser.js` and `store.js` have a `module.exports` guard for this.

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
`parser.js → store.js → session.js → history.js → settings.js → app.js`
app.js is last and owns boot (`DOMContentLoaded`).

### Files
| File | Role |
|---|---|
| `index.html` | App shell: 7 `<section class="screen">` + bottom nav. Fonts via Google Fonts. |
| `css/app.css` | All styling. Lakers theme via CSS vars in `:root`. |
| `js/parser.js` | `window.WorkoutParser` — forgiving text→workout parser. |
| `js/store.js` | `window.Store` — single versioned localStorage key + all data queries. |
| `js/app.js` | Import/preview/rest-setup flow, template list, nav, boot. `window.App`. |
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
  settings:  { units: 'lbs', lastRestSec: 120 }
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
    exId, name, cue, supersetId, restSec,
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
  `History.openExercise(name)` progression sheet: all-time best, top-set SVG line
  chart (needs 2+ sessions), per-session log with best-set highlight + PR badges.

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
  Currently at `liftlog-v4`.
- After editing JS, do a **real browser load** (headless dump-dom) to catch
  global-scope collisions — `node --check` won't.
- Keep new modules IIFE-wrapped, exposing one `window.X`.
- `Date.now()` / `Math.random()` are fine in this app's runtime JS (the ban on
  them applies only to Workflow orchestration scripts, which this project doesn't use).
```
