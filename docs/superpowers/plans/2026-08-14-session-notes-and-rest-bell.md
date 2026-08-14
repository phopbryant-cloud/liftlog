# Session Notes + Background Rest Bell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-exercise note editable during a live workout, persist it week over week with a dated log, and replace the rest-timer beep with a boxing bell that rings even when the phone is locked.

**Architecture:** Notes get a new `notes` map in the existing single localStorage key, keyed by normalized exercise name (the key progression already uses); the dated log is derived from completed sessions rather than stored twice. Audio moves into a new IIFE module `js/bell.js` that rings via WebAudio in the foreground and, only when the page is backgrounded mid-rest, encodes `[silence + bell]` to a WAV and hands it to a media element so iOS plays it with the screen off.

**Tech Stack:** Vanilla JS, classic `<script>` tags (NOT ES modules), no build step, no framework. localStorage. WebAudio + OfflineAudioContext. Node for logic tests, headless Chrome for load verification.

**Design doc:** `docs/superpowers/specs/2026-08-14-session-notes-and-rest-bell-design.md`

---

## Critical constraints (read before touching a file)

1. **Shared global scope.** Classic scripts share ONE lexical scope. A `function foo(){}` in one file and a `const foo = …` in another is a redeclaration SyntaxError that aborts the whole script. `parser.js`, `store.js`, `session.js`, `history.js`, `settings.js` are each IIFE-wrapped and expose exactly one global. `app.js` is deliberately NOT wrapped — its top-level helpers (`el`, `$`, `fmtTime`, `toast`, `show`) are the globals the other modules call. **`js/bell.js` must be IIFE-wrapped and expose only `window.Bell`.**
2. **`node --check` does not catch cross-file collisions.** Only a real browser load does. Every task that adds a global ends with a headless load.
3. **Service worker caches the shell.** Any change to a file listed in `sw.js` `SHELL` requires bumping `CACHE`, or phones keep serving the old file. This plan bumps `liftlog-v4` → `v5` (end of Feature 1) → `v6` (end of Feature 2).
4. **Local dev and the SW.** While testing on `localhost`, the SW may serve stale JS. Use a fresh incognito window, or run `navigator.serviceWorker.getRegistrations().then(r=>r.forEach(x=>x.unregister()))` in the console, before concluding a change did not work.

## Test commands used throughout

Start the server once, in its own terminal:

```bash
cd "/Users/bryantspratlin/Desktop/claude personal/Workout app"
python3 -m http.server 8777
```

Headless load check (the only thing that catches global collisions):

```bash
cd "/Users/bryantspratlin/Desktop/claude personal/Workout app"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --enable-logging=stderr --v=1 \
  --virtual-time-budget=3000 --dump-dom "http://localhost:8777/index.html" \
  2>/tmp/cerr >/tmp/dom.html
grep -o 'No templates\|Import workout' /tmp/dom.html
grep -i CONSOLE /tmp/cerr | grep -vi 'deprecated\|service worker'
```

Expected: the first `grep` prints a match (boot rendered). The second prints **nothing** (no JS errors).

---

## File Structure

| File | Change | Responsibility after this plan |
|---|---|---|
| `js/store.js` | Modify | Adds the `notes` map, `getNote`/`setNote`/`notesForExercise`, and generic `getSetting`/`setSetting`. Stays the only module that touches localStorage. |
| `js/session.js` | Modify | Gains the editable note block and the bell wiring. Loses its oscillator chime (moves to `bell.js`), so it does not grow much net. |
| `js/bell.js` | **Create** | All audio: bell synthesis, foreground ring, WAV encoding, background scheduling. Nothing else in the app knows how audio works. |
| `js/history.js` | Modify | Adds the Notes section to the exercise sheet. |
| `js/app.js` | Modify | Seeds a standing note from a template cue on save (both save paths). |
| `js/settings.js` | Modify | Adds the Rest bell section (Test button + two toggles). |
| `css/app.css` | Modify | Note block and note log styles. |
| `index.html` | Modify | Loads `bell.js` before `session.js`. |
| `sw.js` | Modify | Caches `bell.js`; `CACHE` bumped. |
| `tests/test-notes.js` | **Create** | Node test for the notes layer. |
| `tests/test-bell.js` | **Create** | Node test for the WAV encoder. |
| `HANDOFF.md` | Modify | Documents both features for the next session. |

Audio lives in its own file because `session.js` is already 572 lines and audio is a self-contained concern with a narrow interface (`init`/`ring`/`scheduleAt`/`cancel`/`didFireScheduled`/`test`). Notes stay in `store.js` because they are queries over the same single db object every other query reads.

---

## Task 0: Put the project under version control

The folder is not a git repo, so the commit steps below have nothing to commit to, and this is the user's only copy of the app.

**Files:**
- Create: `.gitignore`

- [ ] **Step 1: Create `.gitignore`**

```
.DS_Store
```

- [ ] **Step 2: Init and make the baseline commit**

```bash
cd "/Users/bryantspratlin/Desktop/claude personal/Workout app"
git init
git add -A
git commit -m "chore: baseline — LIFTLOG as shipped"
```

Expected: `git log --oneline` shows one commit.

---

# FEATURE 1 — Editable notes with week-over-week history

## Task 1: Store — `notes` map backfill, `getNote`, `setNote`

**Files:**
- Modify: `js/store.js`
- Create: `tests/test-notes.js`

- [ ] **Step 1: Write the failing test**

Create `tests/test-notes.js`:

```js
// tests/test-notes.js — node test for the notes layer in js/store.js.
// Stubs window + localStorage, then requires the module the way the browser does.
// Run: node tests/test-notes.js
const path = require('path');

global.localStorage = {
  _v: null,
  getItem() { return this._v; },
  setItem(k, v) { this._v = v; },
  removeItem() { this._v = null; },
};
global.window = {};
require(path.join(__dirname, '..', 'js', 'store.js'));
const Store = global.window.Store;

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

// Replace the whole db. importJSON is the only external reset hook.
function reset(db) {
  Store.importJSON(JSON.stringify(Object.assign({
    version: 1, templates: [], sessions: [], active: null,
    settings: { units: 'lbs', lastRestSec: 120 },
  }, db)));
}

console.log('\nnotes — standing note');
reset({});                                  // no `notes` key at all: pre-feature backup
check('missing notes key backfills', Store.getNote('Incline press'), '');
Store.setNote('Incline press', 'elbows tucked');
check('round trip', Store.getNote('Incline press'), 'elbows tucked');
check('name is normalized', Store.getNote('  INCLINE PRESS '), 'elbows tucked');
Store.setNote('Incline press', '   ');
check('blank text clears the note', Store.getNote('Incline press'), '');
check('clearing removes the key', Object.keys(Store.load().notes), []);

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/bryantspratlin/Desktop/claude personal/Workout app"
node tests/test-notes.js
```

Expected: crashes with `TypeError: Store.getNote is not a function`.

- [ ] **Step 3: Add the backfill and the two functions to `js/store.js`**

In `freshDB()` (line 8), add the `notes` key:

```js
function freshDB() {
  return {
    version: SCHEMA_VERSION,
    templates: [],
    sessions: [],
    active: null,
    notes: {},
    settings: { units: 'lbs', lastRestSec: 120 },
  };
}
```

In `load()`, after the `if (!_db.version) _db = freshDB();` line, add the backfill for databases saved before this feature:

```js
  if (!_db.version) _db = freshDB();
  if (!_db.notes) _db.notes = {};
  return _db;
```

In `importJSON()`, add the same backfill — import assigns the parsed object directly and bypasses `load()`, so a backup exported before this feature has no `notes` key:

```js
function importJSON(text) {
  const parsed = JSON.parse(text);
  if (!parsed || !parsed.version) throw new Error('Not a valid backup file');
  _db = parsed;
  if (!_db.notes) _db.notes = {};
  save();
}
```

Add the two functions in a new section directly above `// ---- Active (in-progress) session persistence ----`:

```js
// ---- Notes (keyed by normalized exercise name, like progression) ----
function getNote(name) {
  const n = load().notes[normName(name)];
  return n && n.text ? n.text : '';
}

// Empty/whitespace text deletes the key so getNote falls back to the
// template cue seed rather than storing a meaningless ''.
function setNote(name, text) {
  const db = load();
  const key = normName(name);
  const t = (text || '').trim();
  if (!t) delete db.notes[key];
  else db.notes[key] = { text: t, updatedAt: Date.now() };
  save();
}
```

Add both to the exported object:

```js
    historyForExercise, lastSetsForExercise, allTimeBestWeight,
    getNote, setNote,
    setActive, getActive, clearActive,
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/test-notes.js
```

Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add js/store.js tests/test-notes.js
git commit -m "feat(notes): standing per-exercise note in store"
```

---

## Task 2: Store — `notesForExercise` dated log

Derives the log from completed sessions and collapses consecutive runs of identical text, so a note unchanged for eight weeks reads as one row, not eight.

**Files:**
- Modify: `js/store.js`
- Modify: `tests/test-notes.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/test-notes.js`, immediately above the final `console.log` summary line:

```js
console.log('\nnotes — dated log');

// Helper: a completed session containing one entry with a note.
function sess(day, name, note, legacyCue) {
  const e = { exId: 'x', name, sets: [{ done: true, skipped: false, warmup: false, weight: '100', reps: '8' }] };
  if (note != null) e.note = note;
  if (legacyCue != null) e.cue = legacyCue;
  return {
    id: 's' + day, name: 'Push', startedAt: Date.UTC(2026, 6, day),
    finishedAt: Date.UTC(2026, 6, day, 1), entries: [e],
  };
}

// Newest first in storage order is not required — completedSessions() sorts.
reset({ sessions: [
  sess(1, 'Incline press', 'start at 45'),
  sess(8, 'Incline press', 'went too heavy'),
  sess(15, 'Incline press', 'went too heavy'),
  sess(22, 'Incline press', 'went too heavy'),
  sess(29, 'Incline press', 'start at 45'),
] });

const log = Store.notesForExercise('Incline press');
check('rows are collapsed and newest first', log.map((r) => r.text),
  ['start at 45', 'went too heavy', 'start at 45']);
check('run count', log[1].count, 3);
check('run newest date', log[1].date, Date.UTC(2026, 6, 22, 1));
check('run oldest date', log[1].since, Date.UTC(2026, 6, 8, 1));
check('single row count is 1', log[0].count, 1);
check('non-consecutive repeat stays separate', log[2].since, Date.UTC(2026, 6, 1, 1));

reset({ sessions: [sess(1, 'Rear delt', null, 'legacy cue text')] });
check('legacy cue is read when note is absent',
  Store.notesForExercise('Rear delt').map((r) => r.text), ['legacy cue text']);

reset({ sessions: [sess(1, 'Rear delt', '')] });
check('empty note contributes no row', Store.notesForExercise('Rear delt'), []);
check('unknown exercise returns empty', Store.notesForExercise('Never done'), []);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node tests/test-notes.js
```

Expected: `TypeError: Store.notesForExercise is not a function`.

- [ ] **Step 3: Implement it in `js/store.js`**

Add below `setNote`, in the same notes section:

```js
// Reads a note off a session entry. Entries written before this feature only
// have `cue`, so both history and the session render go through here.
function noteOfEntry(e) {
  return (e.note != null ? e.note : (e.cue || '')) || '';
}

// Dated note log, newest first. Consecutive sessions with identical text
// collapse into one row: { text, date (newest), since (oldest), count }.
function notesForExercise(name) {
  const key = normName(name);
  const rows = [];
  completedSessions().forEach((s) => {
    (s.entries || []).forEach((e) => {
      if (normName(e.name) !== key) return;
      const text = noteOfEntry(e).trim();
      if (!text) return;
      const date = s.finishedAt || s.startedAt;
      const last = rows[rows.length - 1];
      if (last && last.text === text) {
        last.since = Math.min(last.since, date);
        last.count++;
      } else {
        rows.push({ text, date, since: date, count: 1 });
      }
    });
  });
  return rows;
}
```

Export `noteOfEntry` and `notesForExercise` alongside the others — `noteOfEntry` is used by `session.js` and `history.js` too:

```js
    getNote, setNote, notesForExercise, noteOfEntry,
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/test-notes.js
```

Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add js/store.js tests/test-notes.js
git commit -m "feat(notes): dated note log derived from completed sessions"
```

---

## Task 3: Session entries carry `note`

**Files:**
- Modify: `js/session.js:78-102` (`buildEntries`), `js/session.js:439-448` (`addAdHoc`), `js/session.js:213-225` (`exerciseBlock`)

- [ ] **Step 1: Seed the note in `buildEntries`**

Replace the return object at the end of `buildEntries` (currently line 96-100):

```js
    return {
      exId: ex.id, name: ex.name,
      note: window.Store.getNote(ex.name) || ex.cue || '',
      supersetId: ex.supersetId || null, restSec: ex.restSec || 120,
      sets,
    };
```

The standing note wins over the template cue; the cue is only a seed for exercises that have never had a note.

- [ ] **Step 2: Use `note` in `addAdHoc`**

In `addAdHoc` (line 442), replace `cue: '',` with `note: '',`:

```js
  S.entries.push({
    exId: 'adhoc_' + Date.now().toString(36), name: name.trim(), note: '',
    supersetId: null, restSec: window.Store.getLastRest(),
    sets: [{ label: null, weight: '', reps: '', done: false, warmup: false, skipped: false, prefilled: false }],
  });
```

- [ ] **Step 3: Read through `noteOfEntry` in `exerciseBlock`**

Replace line 217 (`if (e.cue) card.appendChild(el('div', 'ex-cue', e.cue));`) with:

```js
  const noteText = window.Store.noteOfEntry(e);
  if (noteText) card.appendChild(el('div', 'ex-cue', noteText));
```

This is a placeholder replaced in Task 4 — it exists so a session started from an old `active` object still shows its note at this commit.

- [ ] **Step 4: Verify in the browser**

Run the headless load check from the top of this plan.
Expected: boot grep matches, no CONSOLE errors.

- [ ] **Step 5: Commit**

```bash
git add js/session.js
git commit -m "feat(notes): session entries carry note, seeded from the standing note"
```

---

## Task 4: Editable note block in a live session

**Files:**
- Modify: `js/session.js` (replace the Step 3 placeholder; add the block under superset member heads)
- Modify: `css/app.css`

- [ ] **Step 1: Add the note block component to `js/session.js`**

Insert directly above `function exerciseBlock(idx) {` (line 213):

```js
// ---- note block ----
// editingNote holds the entry index currently in edit mode. It is transient UI
// state, deliberately not persisted.
let editingNote = null;

function noteBlock(idx) {
  const box = el('div', 'note-block');
  box.dataset.noteIdx = String(idx);
  fillNoteBlock(box, idx);
  return box;
}

// Replaces ONLY this block, never the whole screen. A full render() on blur
// would remove the DOM node under a pending tap and swallow the tap that
// caused the blur (e.g. tapping ✓ straight out of the textarea).
function refreshNoteBlock(idx) {
  const box = document.querySelector('.note-block[data-note-idx="' + idx + '"]');
  if (!box) return;
  box.innerHTML = '';
  fillNoteBlock(box, idx);
}

function fillNoteBlock(box, idx) {
  const e = S.entries[idx];
  const text = window.Store.noteOfEntry(e);

  if (editingNote === idx) {
    const ta = el('textarea', 'note-input');
    ta.value = text;
    ta.rows = 1;
    ta.placeholder = 'Cues, form notes, what to fix next time…';
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    // Writes on every keystroke, same crash-safe path as the weight/reps
    // inputs. Must NOT call render() — that destroys the textarea mid-word.
    ta.oninput = () => {
      e.note = ta.value;
      window.Store.setNote(e.name, ta.value);
      persist();
      grow();
    };
    ta.onblur = () => { editingNote = null; refreshNoteBlock(idx); };
    box.appendChild(ta);
    setTimeout(() => { ta.focus(); grow(); }, 0);
    return;
  }

  if (text) {
    const line = el('div', 'ex-cue');
    line.textContent = text;
    line.appendChild(el('span', 'note-edit-ic', ' ✎'));
    line.onclick = () => { editingNote = idx; refreshNoteBlock(idx); };
    box.appendChild(line);
  } else {
    const add = el('button', 'note-add', '+ Note');
    add.onclick = () => { editingNote = idx; refreshNoteBlock(idx); };
    box.appendChild(add);
  }
}
```

- [ ] **Step 2: Use it in `exerciseBlock`**

Replace the two lines added in Task 3 Step 3 with:

```js
  card.appendChild(noteBlock(idx));
```

- [ ] **Step 3: Use it in `supersetBlock`**

In `supersetBlock`, inside the `if (r === 0)` branch, after `round.appendChild(h);` (line 243), add:

```js
        round.appendChild(noteBlock(i));
```

The full branch now reads:

```js
      if (r === 0) {
        const h = el('div', 'ss-member-head');
        const nm = el('span', 'ss-member-name', e.name);
        nm.onclick = () => window.History.openExercise(e.name);
        h.appendChild(nm);
        round.appendChild(h);
        round.appendChild(noteBlock(i));
      }
```

- [ ] **Step 4: Add the styles to `css/app.css`**

Append directly after the `.ex-cue` rule (which ends at line 390):

```css
.note-block { margin: 2px 0 10px 38px; }
.note-block .ex-cue { margin: 0; }
.note-edit-ic { color: var(--text-faint); font-style: normal; }
.note-add {
  background: none; border: 1px dashed var(--line);
  border-radius: 8px; padding: 7px 12px;
  color: var(--text-faint); font-size: 13px;
}
.note-add:active { color: var(--volt); border-color: var(--volt); }
.note-input {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--volt-dim);
  border-radius: 10px;
  padding: 9px 11px;
  font-size: 14px; line-height: 1.45;
  color: var(--text);
  font-style: italic;
  resize: none;
  overflow: hidden;
  min-height: 40px;
}
.note-input::placeholder { color: var(--text-faint); font-style: normal; }
.note-input:focus { outline: none; border-color: var(--volt); }
```

`resize: none` + `overflow: hidden` are load-bearing: the JS sets `height` from `scrollHeight`, and a scrollbar would make that measurement grow without bound.

- [ ] **Step 5: Verify in the browser**

Run the headless load check. Expected: no CONSOLE errors.

Then, manually at `http://localhost:8777`: Templates → Start workout → tap `+ Note` on an exercise → type → tap elsewhere. Expected: the text persists as italic note text, and reloading the page (which resumes the active session) still shows it.

- [ ] **Step 6: Commit**

```bash
git add js/session.js css/app.css
git commit -m "feat(notes): edit exercise notes inside a live session"
```

---

## Task 5: "Last time" line under the note

**Files:**
- Modify: `js/session.js` (`fillNoteBlock`)
- Modify: `css/app.css`

- [ ] **Step 1: Add the lookup helpers to `js/session.js`**

Insert directly above `function noteBlock(idx) {`:

```js
// Newest logged note that differs from what is on screen. Returns null when
// the note has not changed, so an unchanged note shows no redundant line.
function previousNote(name, current) {
  const cur = (current || '').trim();
  const rows = window.Store.notesForExercise(name);
  return rows.find((r) => r.text !== cur) || null;
}

function fmtNoteDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
```

- [ ] **Step 2: Render the line in `fillNoteBlock`**

At the end of `fillNoteBlock`, after the `if (text) { … } else { … }` branch, add:

```js
  const prev = previousNote(e.name, text);
  if (prev) {
    const p = el('div', 'note-prev');
    p.textContent = 'Last time · ' + fmtNoteDate(prev.date) + ' — ' + prev.text;
    p.title = prev.text;
    p.onclick = () => window.History.openExercise(e.name);
    box.appendChild(p);
  }
```

Note this sits after the early `return` in the editing branch, so it does not render while the textarea is open.

- [ ] **Step 3: Add the style to `css/app.css`**

Append after the `.note-input:focus` rule:

```css
.note-prev {
  margin-top: 6px;
  font-size: 12px; line-height: 1.4;
  color: var(--text-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-left: 2px solid var(--line);
  padding-left: 8px;
}
.note-prev:active { color: var(--gold); border-left-color: var(--gold); }
```

- [ ] **Step 4: Verify in the browser**

Run the headless load check — no CONSOLE errors.

Then manually: start a workout, put a note on an exercise, finish the workout, start it again, and change the note. Expected: the `Last time · <date> — <old text>` line appears under the new note and is truncated to one line.

- [ ] **Step 5: Commit**

```bash
git add js/session.js css/app.css
git commit -m "feat(notes): show last session's differing note inline"
```

---

## Task 6: Notes section in the exercise history sheet

**Files:**
- Modify: `js/history.js:94-149` (`openExercise`)
- Modify: `css/app.css`

- [ ] **Step 1: Add the section builder to `js/history.js`**

Insert directly above `function openExercise(name) {` (line 94):

```js
// Dated note log for the sheet. The standing note is pinned first, even when
// it has never appeared in a completed session (e.g. seeded from a template).
function notesSection(name) {
  const box = el('div', 'note-log');
  box.appendChild(el('div', 'note-log-head', 'Notes'));

  const current = (window.Store.getNote(name) || '').trim();
  const rows = window.Store.notesForExercise(name);

  if (!current && !rows.length) {
    box.appendChild(el('div', 'summary-note', 'No notes yet. Add one from a workout.'));
    return box;
  }

  const newestMatchesCurrent = !!(current && rows[0] && rows[0].text === current);

  if (current) {
    const r = el('div', 'note-log-row');
    const label = 'Current' + (newestMatchesCurrent && rows[0].count > 1
      ? ' · logged ' + rows[0].count + '×' : '');
    r.appendChild(el('div', 'note-log-date note-log-current', label));
    r.appendChild(el('div', 'note-log-text', current));
    box.appendChild(r);
  }

  rows.forEach((n, i) => {
    if (i === 0 && newestMatchesCurrent) return; // already shown as Current
    const r = el('div', 'note-log-row');
    // `count` counts collapsed entries, not sessions, so the same exercise
    // logged twice in ONE session yields count 2 with since === date. Guard
    // against rendering the nonsense "Jul 1 · unchanged since Jul 1".
    const spansSessions = n.count > 1 && n.since !== n.date;
    const label = fmtDate(n.date) + (spansSessions ? ' · unchanged since ' + fmtDate(n.since) : '');
    r.appendChild(el('div', 'note-log-date', label));
    r.appendChild(el('div', 'note-log-text', n.text));
    box.appendChild(r);
  });

  return box;
}
```

- [ ] **Step 2: Call it from `openExercise`**

In the empty branch (line 109-111), add the notes section before the message:

```js
  if (!hist.length) {
    sheet.appendChild(notesSection(name));
    sheet.appendChild(el('div', 'summary-note', 'No logged history yet. Do this exercise in a workout and it will appear here.'));
  } else {
```

In the `else` branch, insert the call between the best badge and the chart — after `sheet.appendChild(bestBadge);` (line 115) and before the `// Chart (chronological)` comment:

```js
    sheet.appendChild(bestBadge);

    sheet.appendChild(notesSection(name));

    // Chart (chronological)
```

Notes sit above the chart so they are readable without scrolling, which matters because this sheet is how notes get read mid-workout.

- [ ] **Step 3: Add the styles to `css/app.css`**

Append after the `.note-prev:active` rule:

```css
.note-log { margin: 14px 0 4px; }
.note-log-head {
  font-family: var(--font-display); text-transform: uppercase;
  font-size: 13px; letter-spacing: 0.08em;
  color: var(--text-dim); margin-bottom: 8px;
}
.note-log-row {
  border-left: 2px solid var(--line);
  padding: 0 0 12px 10px; margin-bottom: 2px;
}
.note-log-date {
  font-family: var(--font-mono); font-size: 11px;
  letter-spacing: 0.05em; color: var(--text-faint);
  margin-bottom: 3px;
}
.note-log-current { color: var(--gold); }
.note-log-text { font-size: 14px; line-height: 1.45; color: var(--text-dim); font-style: italic; }
```

- [ ] **Step 4: Verify in the browser**

Run the headless load check — no CONSOLE errors.

Then manually: tap any exercise name (templates screen, session, or history). Expected: a Notes section between the all-time-best badge and the chart, with the standing note tagged `Current`.

- [ ] **Step 5: Commit**

```bash
git add js/history.js css/app.css
git commit -m "feat(notes): dated note log in the exercise history sheet"
```

---

## Task 7: Template cue seeds the standing note

**Files:**
- Modify: `js/app.js:292-311` (`saveTemplate`), `js/app.js:382-397` (the edit-path override)

There are two save paths — a new template and an edit of an existing one — and both must seed. `app.js` is NOT IIFE-wrapped, so the helper name must not collide with any global in the other modules; `seedNotesFromExercises` is unique.

- [ ] **Step 1: Add the helper to `js/app.js`**

Insert directly above `function saveTemplate() {` (line 292):

```js
// A template cue is only a seed: it fills in a standing note that does not
// exist yet. Re-importing the same workout text must never clobber a note the
// user has refined over weeks — nor resurrect one they deliberately cleared,
// which is why this tests key existence via hasNote rather than truthiness.
function seedNotesFromExercises(exercises) {
  exercises.forEach((ex) => {
    const cue = (ex.cue || '').trim();
    if (cue && !window.Store.hasNote(ex.name)) window.Store.setNote(ex.name, cue);
  });
}
```

- [ ] **Step 2: Call it from the new-template path**

In `saveTemplate`, after `window.Store.addTemplate(tpl);` (line 306):

```js
  window.Store.addTemplate(tpl);
  seedNotesFromExercises(tpl.exercises);
```

- [ ] **Step 3: Call it from the edit path**

In the override at line 382, after `window.Store.updateTemplate(tpl);` (line 391):

```js
    window.Store.updateTemplate(tpl);
    seedNotesFromExercises(tpl.exercises);
```

- [ ] **Step 4: Verify in the browser**

Run the headless load check — no CONSOLE errors.

Then manually: Import → the Push sample already carries cues on `Cable fly low to high` → save the template → tap that exercise name. Expected: the Notes section shows the cue tagged `Current`.

- [ ] **Step 5: Commit**

```bash
git add js/app.js
git commit -m "feat(notes): seed standing notes from template cues on save"
```

---

## Task 8: Ship Feature 1 — cache bump

**Files:**
- Modify: `sw.js:2`

- [ ] **Step 1: Bump the cache version**

```js
const CACHE = 'liftlog-v5';
```

Without this, an installed phone keeps serving the v4 copies of `store.js`, `session.js`, `history.js`, `app.js`, and `app.css` and none of Feature 1 appears.

- [ ] **Step 2: Verify**

```bash
node tests/test-notes.js
```
Expected: `ALL PASS`.

Then the headless load check. Expected: no CONSOLE errors.

- [ ] **Step 3: Commit**

```bash
git add sw.js
git commit -m "chore(sw): bump cache to v5 for editable notes"
```

---

# FEATURE 2 — Boxing bell that rings when backgrounded

## Task 9: `js/bell.js` — synthesis and the WAV encoder

Pure logic first, no DOM, so it can be node-tested. Nothing at module top level may touch `document`, `navigator`, or `AudioContext` — the node test requires this file with only `window` stubbed.

**Files:**
- Create: `js/bell.js`
- Create: `tests/test-bell.js`

- [ ] **Step 1: Write the failing test**

Create `tests/test-bell.js`:

```js
// tests/test-bell.js — node test for the WAV encoder in js/bell.js.
// The encoder is what makes the locked-screen bell possible, and it is the
// only part of the audio path that can be verified off-device.
// Run: node tests/test-bell.js
const path = require('path');

global.window = {};
require(path.join(__dirname, '..', 'js', 'bell.js'));
const Bell = global.window.Bell;

let failures = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}\n        expected ${expected}\n        actual   ${actual}`);
}

const RATE = 22050;
// Minimal stand-in for an AudioBuffer: three samples at the extremes.
const fakeBell = { length: 3, getChannelData: () => new Float32Array([0, 1, -1]) };

console.log('\nbell — wav encoder');
const bytes = Bell.wavBytes(fakeBell, 2);      // 2 seconds of lead silence
const view = new DataView(bytes);
const str = (off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
};
const samples = RATE * 2 + 3;

check('RIFF magic', str(0, 4), 'RIFF');
check('WAVE magic', str(8, 4), 'WAVE');
check('fmt chunk id', str(12, 4), 'fmt ');
check('data chunk id', str(36, 4), 'data');
check('total byte length', bytes.byteLength, 44 + samples * 2);
check('riff size field', view.getUint32(4, true), 44 + samples * 2 - 8);
check('data size field', view.getUint32(40, true), samples * 2);
check('pcm format', view.getUint16(20, true), 1);
check('mono', view.getUint16(22, true), 1);
check('sample rate', view.getUint32(24, true), RATE);
check('byte rate', view.getUint32(28, true), RATE * 2);
check('block align', view.getUint16(32, true), 2);
check('bit depth', view.getUint16(34, true), 16);

check('lead silence starts at zero', view.getInt16(44, true), 0);
check('lead silence ends at zero', view.getInt16(44 + (RATE * 2 - 1) * 2, true), 0);
const bellAt = 44 + RATE * 2 * 2;
check('bell sample 0', view.getInt16(bellAt, true), 0);
check('bell sample +1 clamps to max', view.getInt16(bellAt + 2, true), 32767);
check('bell sample -1 clamps to min', view.getInt16(bellAt + 4, true), -32768);

const silent = Bell.wavBytes(null, 0.05);
check('null bell encodes pure silence', silent.byteLength, 44 + Math.round(0.05 * RATE) * 2);

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/bryantspratlin/Desktop/claude personal/Workout app"
node tests/test-bell.js
```

Expected: `Error: Cannot find module` for `js/bell.js`.

- [ ] **Step 3: Create `js/bell.js` with synthesis + encoder**

```js
// bell.js — the rest bell. Rings through WebAudio while the app is open; when
// the app is backgrounded mid-rest, encodes [silence + bell] to a WAV and hands
// it to a media element so iOS plays it with the screen locked.
// IIFE-wrapped, exposes only window.Bell (see HANDOFF.md global-scope rule).
// Nothing at top level may touch document/navigator/AudioContext — tests/test-bell.js
// requires this file in node with only `window` stubbed.
(function () {

// 22050 Hz mono 16-bit is the memory/brightness tradeoff for the scheduled
// file: ~44 KB/s, so a 180s rest is ~4 MB held transiently. 44.1k doubles it;
// 8k flattens the bell, which is the whole point of the sound.
const WAV_RATE = 22050;
const BELL_SECS = 2.2;
const F0 = 880;

// Inharmonic partials = metallic bell rather than a sine beep.
const PARTIALS = [
  { ratio: 1.00, gain: 0.90, decay: 1.60 },
  { ratio: 2.76, gain: 0.55, decay: 1.00 },
  { ratio: 5.40, gain: 0.32, decay: 0.70 },
  { ratio: 8.93, gain: 0.18, decay: 0.50 },
];

let buffer = null;        // rendered bell, cached after the first render
let rendering = null;     // in-flight render promise

function strike(oc, at, level) {
  PARTIALS.forEach((p) => {
    const o = oc.createOscillator();
    const g = oc.createGain();
    o.type = 'sine';
    o.frequency.value = F0 * p.ratio;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(p.gain * level, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + p.decay);
    o.connect(g); g.connect(oc.destination);
    o.start(at); o.stop(at + p.decay + 0.02);
  });
  // Mallet transient: a short band-passed noise burst. This is what makes the
  // bell cut through gym noise instead of sounding like a tone.
  const n = oc.createBufferSource();
  const nb = oc.createBuffer(1, Math.floor(oc.sampleRate * 0.03), oc.sampleRate);
  const d = nb.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  n.buffer = nb;
  const bp = oc.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 0.8;
  const ng = oc.createGain();
  ng.gain.setValueAtTime(0.45 * level, at);
  n.connect(bp); bp.connect(ng); ng.connect(oc.destination);
  n.start(at);
}

// Two strikes, the second slightly quieter: the boxing-gym ding-ding.
function renderBell() {
  if (buffer) return Promise.resolve(buffer);
  if (rendering) return rendering;
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OC) return Promise.resolve(null);
  let oc;
  try {
    oc = new OC(1, Math.ceil(WAV_RATE * BELL_SECS), WAV_RATE);
  } catch (e) {
    return Promise.resolve(null);
  }
  strike(oc, 0, 1.0);
  strike(oc, 0.35, 0.85);
  rendering = oc.startRendering()
    .then((b) => { buffer = b; rendering = null; return b; })
    .catch(() => { rendering = null; return null; });
  return rendering;
}

// 16-bit mono PCM WAV. `bellBuffer` may be null for pure silence.
// `leadSeconds` of silence precede the bell — that lead is the remaining rest.
function wavBytes(bellBuffer, leadSeconds) {
  const leadSamples = Math.max(0, Math.round(leadSeconds * WAV_RATE));
  const bell = bellBuffer ? bellBuffer.getChannelData(0) : null;
  const bellSamples = bell ? bell.length : 0;
  const total = leadSamples + bellSamples;
  const size = 44 + total * 2;
  const bytes = new ArrayBuffer(size);
  const view = new DataView(bytes);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  view.setUint32(4, size - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt chunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, WAV_RATE, true);
  view.setUint32(28, WAV_RATE * 2, true);  // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  str(36, 'data');
  view.setUint32(40, total * 2, true);

  // The lead stays zero-filled — a fresh ArrayBuffer is already zeros.
  let off = 44 + leadSamples * 2;
  for (let i = 0; i < bellSamples; i++) {
    const s = Math.max(-1, Math.min(1, bell[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return bytes;
}

window.Bell = { wavBytes, renderBell };

})();
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/test-bell.js
```

Expected: `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add js/bell.js tests/test-bell.js
git commit -m "feat(bell): boxing-bell synthesis and WAV encoder"
```

---

## Task 10: `js/bell.js` — foreground ring, unlock, background scheduling

**Files:**
- Modify: `js/bell.js`

- [ ] **Step 1: Add the runtime state and the DOM/audio functions**

Add these module vars directly below `let rendering = null;`:

```js
let ctx = null;           // live AudioContext for the foreground ring
let audioEl = null;       // persistent media element for the background ring
let blobUrl = null;
let unlocked = false;
let armed = false;        // a scheduled background bell is pending
let scheduledFired = false;
let silentUrl = null;
```

Add everything below, directly above the `window.Bell = ...` line:

```js
// ---- media element (background path) ----
function ensureAudioEl() {
  if (audioEl || typeof document === 'undefined' || !document.body) return audioEl;
  audioEl = document.createElement('audio');
  audioEl.setAttribute('playsinline', '');
  audioEl.preload = 'auto';
  audioEl.addEventListener('ended', () => {
    if (armed) { scheduledFired = true; armed = false; }
    release();
  });
  document.body.appendChild(audioEl);
  return audioEl;
}

function silentSrc() {
  if (!silentUrl) silentUrl = URL.createObjectURL(new Blob([wavBytes(null, 0.05)], { type: 'audio/wav' }));
  return silentUrl;
}

// Autoplay unlock: a media element that has played once inside a user gesture
// may be played again later without one, which is what lets the background
// bell start from the visibilitychange handler. Silent and instantly paused.
function unlock() {
  if (unlocked || !audioEl) return;
  try {
    audioEl.src = silentSrc();
    const p = audioEl.play();
    if (p && p.then) p.then(() => { audioEl.pause(); unlocked = true; }).catch(() => {});
    else { audioEl.pause(); unlocked = true; }
  } catch (e) {}
}

function release() {
  if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} blobUrl = null; }
}

// 'playback' survives backgrounding and the ringer switch but interrupts other
// audio, so it is claimed only while a background bell is actually pending.
function setSession(type) {
  if (typeof navigator === 'undefined' || !navigator.audioSession) return;
  try { navigator.audioSession.type = type; } catch (e) {}
}

function setMetadata() {
  if (typeof navigator === 'undefined' || !navigator.mediaSession || !window.MediaMetadata) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: 'Rest timer', artist: 'LIFTLOG',
    });
  } catch (e) {}
}

// ---- public API ----
// Idempotent. Must be called from a user gesture; every call site already is.
function init() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { try { ctx = new AC(); } catch (e) { ctx = null; } }
  }
  if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
  renderBell();
  ensureAudioEl();
  unlock();
}

// Foreground ring. No media element involved, so other apps' audio is untouched.
function ring() {
  if (!ctx) return;
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
  renderBell().then((b) => {
    if (!b || !ctx) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(ctx.destination);
      src.start();
    } catch (e) {}
  });
}

// Background ring. Called from visibilitychange while JS is still briefly
// alive: encode the remaining rest as silence, followed by the bell, and let
// the OS media pipeline carry it to completion with the screen off.
function scheduleAt(endAt) {
  if (!audioEl || !buffer) return false;
  const lead = Math.max(0, (endAt - Date.now()) / 1000);
  release();
  scheduledFired = false;
  try {
    blobUrl = URL.createObjectURL(new Blob([wavBytes(buffer, lead)], { type: 'audio/wav' }));
    audioEl.src = blobUrl;
    setSession('playback');
    setMetadata();
    armed = true;
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => { armed = false; setSession('auto'); });
    return true;
  } catch (e) {
    armed = false;
    setSession('auto');
    return false;
  }
}

// Stops a pending background bell and gives the audio session back, so the
// user's music can resume.
function cancel() {
  armed = false;
  scheduledFired = false;
  if (audioEl) { try { audioEl.pause(); } catch (e) {} }
  release();
  setSession('auto');
}

function didFireScheduled() { return scheduledFired; }

function test() { init(); renderBell().then(ring); }
```

Replace the export line with:

```js
window.Bell = { init, ring, scheduleAt, cancel, didFireScheduled, test, wavBytes, renderBell };
```

`wavBytes` and `renderBell` stay exported for `tests/test-bell.js`.

- [ ] **Step 2: Verify the node test still passes**

```bash
node tests/test-bell.js
```

Expected: `ALL PASS`. This confirms nothing at top level reaches for `document` or `navigator`.

- [ ] **Step 3: Commit**

```bash
git add js/bell.js
git commit -m "feat(bell): foreground ring, autoplay unlock, background scheduling"
```

---

## Task 11: Load `bell.js` in the shell

**Files:**
- Modify: `index.html:41-46`
- Modify: `sw.js:3-16`

- [ ] **Step 1: Add the script tag before `session.js`**

```html
  <script src="./js/parser.js"></script>
  <script src="./js/store.js"></script>
  <script src="./js/bell.js"></script>
  <script src="./js/session.js"></script>
  <script src="./js/history.js"></script>
  <script src="./js/settings.js"></script>
  <script src="./js/app.js"></script>
```

`app.js` stays last and unwrapped; `bell.js` must load before `session.js` uses it.

- [ ] **Step 2: Add it to the SW shell list**

```js
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/parser.js',
  './js/store.js',
  './js/bell.js',
  './js/session.js',
  './js/history.js',
  './js/settings.js',
  './js/timer-worker.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];
```

- [ ] **Step 3: Verify in the browser**

Run the headless load check. Expected: no CONSOLE errors — this is the check that catches a `Bell` global colliding with anything else.

Then in the browser console at `http://localhost:8777`:

```js
Bell.init(); setTimeout(() => Bell.ring(), 300);
```

Expected: a metallic double bell. (A click in the page first is required — audio needs a gesture.)

- [ ] **Step 4: Commit**

```bash
git add index.html sw.js
git commit -m "feat(bell): load bell.js in the shell and cache it"
```

---

## Task 12: Store — generic settings accessors

The bell wiring in Task 13 reads two settings, so the accessors land first.

**Files:**
- Modify: `js/store.js`
- Modify: `tests/test-notes.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/test-notes.js`, above the final summary `console.log`:

```js
console.log('\nsettings — generic accessors');
reset({});
check('unset key returns the default', Store.getSetting('bellEnabled', true), true);
Store.setSetting('bellEnabled', false);
check('false is stored, not treated as unset', Store.getSetting('bellEnabled', true), false);
check('existing settings are untouched', Store.getSetting('lastRestSec', 0), 120);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node tests/test-notes.js
```

Expected: `TypeError: Store.getSetting is not a function`.

- [ ] **Step 3: Implement in `js/store.js`**

Add directly below `getLastRest()`:

```js
// Generic settings access. Note the `undefined` check rather than a falsy
// check, so a stored `false` is not mistaken for an unset key.
function getSetting(key, dflt) {
  const v = load().settings[key];
  return v === undefined ? dflt : v;
}
function setSetting(key, val) {
  load().settings[key] = val;
  save();
}
```

Add to the export list:

```js
    setLastRest, getLastRest, getSetting, setSetting,
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/test-notes.js
```

Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add js/store.js tests/test-notes.js
git commit -m "feat(store): generic settings accessors"
```

---

## Task 13: Wire the bell into the rest timer

**Files:**
- Modify: `js/session.js:11-75` (timer/audio block), `js/session.js:360-374` (`startRest`, `onRestDone`), `js/session.js:387` (skip), `js/session.js:413-420` (`adjustRest`), `js/session.js:563-568` (visibility handler)

- [ ] **Step 1: Replace the local audio code with `Bell`**

Delete `let audioCtx = null;` from the timer block (line 15), and replace `initAudio()` (lines 50-55) and `chime()` (lines 56-70) entirely with:

```js
// Audio lives in bell.js. initAudio() is kept as the name every call site
// already uses; it must run inside a user gesture, which all its callers are.
function initAudio() { window.Bell.init(); }

function bellEnabled() { return window.Store.getSetting('bellEnabled', true); }
function bgBellEnabled() { return window.Store.getSetting('bgBellEnabled', true); }
```

- [ ] **Step 2: Reset any pending bell when a new rest starts**

In `startRest` (line 360), add the cancel as the first line:

```js
function startRest(sec, name) {
  window.Bell.cancel(); // clears any stale scheduled bell + its fired flag
  S.rest = { endAt: Date.now() + sec * 1000, entryName: name, total: sec };
  persist();
  startTimerLoop(S.rest.endAt);
  showTimerBar();
  updateTimerDisplay(sec * 1000);
}
```

- [ ] **Step 3: Ring from `onRestDone`**

Replace the `chime(); vibrate(...); notify(...);` line (line 370) with:

```js
function onRestDone() {
  stopTimerLoop();
  // If the app was backgrounded, the scheduled media bell already rang — do
  // not ring a second time on return.
  if (bellEnabled() && !window.Bell.didFireScheduled()) window.Bell.ring();
  window.Bell.cancel();
  vibrate([300, 120, 300]); notify(S && S.rest ? `${S.rest.entryName} — back to it.` : 'Back to it.');
  if (S) { S.rest = null; persist(); }
  const bar = document.getElementById('timer-bar');
  if (bar) { bar.classList.add('flash'); setTimeout(() => hideTimerBar(), 900); }
}
```

Vibrate and the notification are unchanged and unaffected by the bell toggle — they are the redundancy layer.

- [ ] **Step 4: Cancel on Skip and on rest adjustment**

In `timerBar()`, the skip handler (line 387) becomes:

```js
  skip.onclick = () => { stopTimerLoop(); window.Bell.cancel(); if (S) { S.rest = null; persist(); } hideTimerBar(); };
```

In `adjustRest` (line 413), add the cancel after the guard:

```js
function adjustRest(delta) {
  if (!S || !S.rest) return;
  window.Bell.cancel(); // ±15 is only reachable in the foreground; defensive
  S.rest.endAt += delta * 1000;
```

- [ ] **Step 5: Schedule on backgrounding, cancel on return**

Replace the existing `visibilitychange` listener at the bottom of the file (lines 562-568) with:

```js
// Leaving the app mid-rest is the only case where the page cannot ring at zero
// itself, so that is the moment the scheduled media bell is armed.
function onHidden() {
  if (!S || !S.rest || !S.rest.endAt) return;
  if (S.rest.endAt - Date.now() <= 0) return;
  if (!bellEnabled() || !bgBellEnabled()) return;
  window.Bell.scheduleAt(S.rest.endAt);
}

// Recompute on return to foreground (worker may have been throttled while
// locked) and hand the audio session back so the user's music can resume.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { onHidden(); return; }
  if (!S || !S.rest) return;
  const remaining = S.rest.endAt - Date.now();
  if (remaining <= 0) { onRestDone(); return; }
  window.Bell.cancel();
  updateTimerDisplay(remaining);
  startTimerLoop(S.rest.endAt);
});
document.addEventListener('pagehide', onHidden);
```

Note the ordering in `onRestDone`: `didFireScheduled()` is read before `cancel()` resets it.

- [ ] **Step 6: Verify in the browser**

Run the headless load check. Expected: no CONSOLE errors.

Then manually at `http://localhost:8777`: start a workout, log a set, and let the rest timer run out with the tab focused. Expected: the boxing bell rings at zero.

- [ ] **Step 7: Commit**

```bash
git add js/session.js
git commit -m "feat(bell): ring at zero in-app, schedule a media bell when backgrounded"
```

---

## Task 14: Settings — Test bell and the two toggles

**Files:**
- Modify: `js/settings.js`
- Modify: `css/app.css`

- [ ] **Step 1: Add the toggle helper to `js/settings.js`**

Insert directly above `function doExport() {`:

```js
function toggleRow(label, sublabel, key, dflt) {
  const row = el('div', 'toggle-row');
  const text = el('div');
  text.appendChild(el('div', 'toggle-label', label));
  if (sublabel) text.appendChild(el('div', 'toggle-sub', sublabel));
  row.appendChild(text);

  const btn = el('button', 'toggle');
  const paint = () => {
    const on = window.Store.getSetting(key, dflt);
    btn.classList.toggle('on', !!on);
    btn.textContent = on ? 'ON' : 'OFF';
  };
  btn.onclick = () => {
    window.Store.setSetting(key, !window.Store.getSetting(key, dflt));
    paint();
  };
  paint();
  row.appendChild(btn);
  return row;
}
```

- [ ] **Step 2: Render the section in `render()`**

Insert directly above `wrap.appendChild(el('div', 'h-section', 'Backup'));`:

```js
  wrap.appendChild(el('div', 'h-section', 'Rest bell'));

  const testBtn = el('button', 'btn btn-block', '🔔 Test bell');
  testBtn.onclick = () => { window.Bell.test(); toast('Ringing'); };
  wrap.appendChild(testBtn);

  wrap.appendChild(toggleRow('Bell sound', null, 'bellEnabled', true));
  wrap.appendChild(toggleRow(
    'Ring when the app is closed',
    'Pauses your music during rest',
    'bgBellEnabled', true));
```

The Test button doubles as the audio unlock, since it calls `Bell.init()` from a real tap.

- [ ] **Step 3: Add the styles to `css/app.css`**

Append at the end of the file:

```css
.toggle-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 12px 0;
  border-bottom: 1px solid var(--line-soft);
}
.toggle-label { font-size: 15px; font-weight: 600; color: var(--text); }
.toggle-sub { font-size: 12px; color: var(--text-faint); margin-top: 2px; }
.toggle {
  min-width: 62px; height: 34px; border-radius: 999px;
  background: var(--bg-input); border: 1px solid var(--line);
  font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  letter-spacing: 0.06em; color: var(--text-faint);
}
.toggle.on { background: var(--purple-btn); border-color: var(--volt); color: #fff; }
```

- [ ] **Step 4: Verify in the browser**

Run the headless load check. Expected: no CONSOLE errors.

Then manually: Settings → tap `Test bell`. Expected: the boxing bell rings. Toggle both switches and reload — expected: they keep their state.

- [ ] **Step 5: Commit**

```bash
git add js/settings.js css/app.css
git commit -m "feat(bell): settings section with test button and toggles"
```

---

## Task 15: Ship Feature 2 — cache bump and full regression

**Files:**
- Modify: `sw.js:2`

- [ ] **Step 1: Bump the cache version**

```js
const CACHE = 'liftlog-v6';
```

- [ ] **Step 2: Run both node tests**

```bash
cd "/Users/bryantspratlin/Desktop/claude personal/Workout app"
node tests/test-notes.js && node tests/test-bell.js
```

Expected: `ALL PASS` from both, exit 0.

- [ ] **Step 3: Run the headless load check**

Expected: boot grep matches, zero CONSOLE errors.

- [ ] **Step 4: Manual regression at `http://localhost:8777`**

Nothing from the original build may regress. Walk:

1. Import the Push sample → Preview → Set rest times → Save template.
2. Start the workout. Confirm prefill, superset Round 1/2/3, and the cable/dumbbell split labels still render.
3. Add a note to one exercise; add a note to a superset member.
4. Log a set → rest timer starts → bell rings at zero.
5. Tap the badge (warm-up), long-press the badge (skip), `+ Set`, `↑ ↓`, `⤫`.
6. Finish → summary shows duration, volume, working sets, and any PRs.
7. History → tap the exercise → Notes section, chart, best-set highlight.
8. Settings → Export JSON. Confirm the downloaded file contains a `notes` key.
9. Settings → Import that file back. Confirm no error and notes survive.

- [ ] **Step 5: Commit**

```bash
git add sw.js
git commit -m "chore(sw): bump cache to v6 for the rest bell"
```

---

## Task 16: On-device verification (the user's iPhone)

The locked-screen path cannot be verified headlessly — it depends on whether iOS honors `play()` inside the visibility-change window. This task is a handoff, not a code change.

- [ ] **Step 1: Serve the app to the phone**

```bash
cd "/Users/bryantspratlin/Desktop/claude personal/Workout app"
python3 -m http.server 8777 &
cloudflared tunnel --url http://localhost:8777
```

Open the printed `https://<random>.trycloudflare.com` URL on the phone. Note: localStorage is per-origin, so this instance starts empty — that is expected.

- [ ] **Step 2: Walk the checklist with the user**

1. Rest completes with the app open and in the foreground → bell rings.
2. Rest completes after switching to another app → bell rings.
3. Rest completes with the screen locked → bell rings.
4. Music playing, app in the foreground the whole rest → music never interrupted.
5. Music playing, phone locked mid-rest → note whether music pauses and whether it resumes.
6. Return to the app before rest ends → no double bell.
7. Edit a note mid-workout, finish, start the same workout again → the note is pre-filled, and a changed note shows the `Last time` line.
8. First `✓` of a workout with music playing → note whether the unlock's 0.05s of silence audibly ducks the music.

- [ ] **Step 3: Record the outcome**

If test 3 fails, the feature degrades to the existing notification + vibrate, which is not a regression; record it in `HANDOFF.md` rather than patching blind.

If test 8 shows an audible duck, move the `Bell.init()` call out of `toggleDone` and into `Session.start` only, so the unlock happens once per workout instead of on the first log.

---

## Task 17: Update `HANDOFF.md`

**Files:**
- Modify: `HANDOFF.md`

- [ ] **Step 1: Add `bell.js` to the file table (§3)**

```markdown
| `js/bell.js` | `window.Bell` — boxing-bell synthesis, foreground ring, WAV encode + background scheduling. |
```

- [ ] **Step 2: Update the script load order line (§3)**

```markdown
`parser.js → store.js → bell.js → session.js → history.js → settings.js → app.js`
```

- [ ] **Step 3: Update the data model (§4)**

Add `notes` to the top-level object and `note` to the session entry shape:

```js
{
  version: 1,
  templates: [ Template ],
  sessions:  [ Session ],
  active:    Session|null,
  notes:     { "<normalized exercise name>": { text, updatedAt } },
  settings:  { units: 'lbs', lastRestSec: 120, bellEnabled: true, bgBellEnabled: true }
}
```

Note that session entries now carry `note` and that `cue` survives only on
pre-existing entries — every reader goes through `Store.noteOfEntry(entry)`.

- [ ] **Step 4: Add two entries to §6 (key UX behaviors)**

```markdown
- **Notes**: per-exercise, editable mid-workout, keyed by normalized exercise
  name in `db.notes` so the same exercise shares one note across templates. A
  template `cue` only *seeds* a note that does not exist yet — re-import never
  clobbers a refined note. The dated log is derived from completed sessions
  (`Store.notesForExercise`), collapsing consecutive identical text into one
  row. Never call `render()` from the note textarea's `oninput` (kills focus)
  or its `onblur` (swallows the tap that caused the blur) — use
  `refreshNoteBlock(idx)`.
- **Rest bell**: `bell.js`. Foreground rings via WebAudio with no media element,
  so music is untouched. On `visibilitychange → hidden` mid-rest it encodes
  [silence + bell] to a WAV and plays it through a media element, which is the
  only way iOS rings from a locked screen — this claims the 'playback' audio
  session and interrupts music for that rest period, which is why it is a
  toggle. `Bell.didFireScheduled()` prevents a double bell on return.
```

- [ ] **Step 5: Update §8 and §10**

In §8, record the on-device results from Task 16. In §10, update the cache
version line to `liftlog-v6` and add:

```markdown
- Node tests now live in `tests/` (not the scratchpad): `node tests/test-notes.js`
  and `node tests/test-bell.js`. Both stub `window`/`localStorage` and require
  the module the way the browser does.
```

- [ ] **Step 6: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: handoff covers notes and the rest bell"
```

---

## Self-review notes

Checked against the design doc:

- Every spec section maps to a task. `notes` map + both backfill points → Task 1. `notesForExercise` run collapsing → Task 2. Entry `note` + `noteOf` → Task 3 (implemented as `Store.noteOfEntry` so `history.js` shares it rather than duplicating the fallback). Template cue as seed → Task 7. Session note UI + `refreshNoteBlock` → Tasks 4-5. History sheet section → Task 6. Bell synthesis/encode → Task 9. init/ring/scheduleAt/cancel/didFireScheduled/test → Task 10. Shell wiring → Task 11. Settings accessors → Task 12. Session wiring → Task 13. Settings UI → Task 14. SW bumps → Tasks 8, 15. Manual checklist → Task 16.
- The spec named the helper `noteOf(entry)` living in `session.js`; it is `Store.noteOfEntry(entry)` here because `history.js` needs the same legacy-`cue` fallback and duplicating it in two IIFEs would be the kind of drift that produces a bug.
- First draft had `Store.getSetting` called in the session-wiring task but defined a task later, which would have thrown on the first rest timer. The settings accessors are now Task 12, ahead of the wiring in Task 13.
- Each of Tasks 8 and 15 leaves the app fully working, so Feature 1 can ship to the phone without waiting on the bell.
