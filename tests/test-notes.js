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

// _db is still null here, so this is the one chance to exercise load()'s
// parse-from-raw-localStorage branch. reset() goes through importJSON and
// would never reach it.
global.localStorage._v = JSON.stringify({
  version: 1, templates: [], sessions: [], active: null,
  settings: { units: 'lbs', lastRestSec: 120 },
});
check('load() backfills notes for a pre-feature db', Store.getNote('Incline press'), '');

reset({});                                  // no `notes` key at all: pre-feature backup
check('importJSON backfills notes for a pre-feature backup', Store.getNote('Incline press'), '');
Store.setNote('Incline press', 'elbows tucked');
check('round trip', Store.getNote('Incline press'), 'elbows tucked');
check('name is normalized', Store.getNote('  INCLINE PRESS '), 'elbows tucked');
Store.setNote('Incline press', '   ');
check('blank text clears the note', Store.getNote('Incline press'), '');
check('clearing leaves a tombstone key', Object.keys(Store.load().notes), ['incline press']);
check('hasNote is true for a cleared (tombstoned) note', Store.hasNote('Incline press'), true);
check('hasNote is false for an exercise never written to', Store.hasNote('Never touched'), false);
check('hasNote normalizes the name like getNote', Store.hasNote('  INCLINE PRESS '), true);

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

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
