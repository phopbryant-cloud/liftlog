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
check('clearing removes the key', Object.keys(Store.load().notes), []);

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
