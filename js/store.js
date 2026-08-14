// store.js — single versioned localStorage key. All app data lives here.
// IIFE-wrapped so internals stay private; only window.Store is exposed.
(function () {

const STORAGE_KEY = 'workout-tracker-v1';
const SCHEMA_VERSION = 1;

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

let _db = null;

function load() {
  if (_db) return _db;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _db = raw ? JSON.parse(raw) : freshDB();
  } catch (e) {
    console.warn('Corrupt store, starting fresh', e);
    _db = freshDB();
  }
  if (!_db.version) _db = freshDB();
  if (!_db.notes) _db.notes = {};
  return _db;
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_db));
}

// ---- Templates ----
function getTemplates() {
  return load().templates;
}

function getTemplate(id) {
  return load().templates.find((t) => t.id === id) || null;
}

function addTemplate(tpl) {
  load().templates.unshift(tpl);
  save();
  return tpl;
}

function updateTemplate(tpl) {
  const db = load();
  const i = db.templates.findIndex((t) => t.id === tpl.id);
  if (i >= 0) db.templates[i] = tpl;
  save();
}

function deleteTemplate(id) {
  const db = load();
  db.templates = db.templates.filter((t) => t.id !== id);
  save();
}

// Remember the most-recent rest choice so future imports pre-fill it.
function setLastRest(sec) {
  load().settings.lastRestSec = sec;
  save();
}
function getLastRest() {
  return load().settings.lastRestSec || 120;
}

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

// ---- Sessions & progression ----
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function normName(n) { return (n || '').trim().toLowerCase(); }

function addSession(sess) {
  load().sessions.unshift(sess);
  save();
  return sess;
}
function getSessions() {
  return load().sessions.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}
function completedSessions() {
  return getSessions().filter((s) => s.finishedAt);
}

// Every logged appearance of an exercise (by name), newest session first.
function historyForExercise(name) {
  const key = normName(name);
  const out = [];
  completedSessions().forEach((s) => {
    (s.entries || []).forEach((e) => {
      if (normName(e.name) !== key) return;
      const logged = (e.sets || []).filter((st) => st.done && !st.skipped);
      if (!logged.length) return;
      const working = logged.filter((st) => !st.warmup);
      const topWeight = working.reduce((m, st) => Math.max(m, num(st.weight)), 0);
      out.push({
        date: s.finishedAt || s.startedAt,
        sessionName: s.name,
        sets: logged,
        working,
        topWeight,
      });
    });
  });
  return out;
}

// Sets (weight/reps) from the most recent completed session of this exercise.
function lastSetsForExercise(name) {
  const h = historyForExercise(name);
  return h.length ? h[0].sets.map((st) => ({ weight: st.weight, reps: st.reps, warmup: st.warmup })) : [];
}

// Heaviest weight ever lifted (any rep count), excluding warm-ups.
function allTimeBestWeight(name) {
  let best = 0;
  historyForExercise(name).forEach((h) => h.working.forEach((st) => { best = Math.max(best, num(st.weight)); }));
  return best;
}

// ---- Notes (keyed by normalized exercise name, like progression) ----
function getNote(name) {
  const n = load().notes[normName(name)];
  return n && n.text ? n.text : '';
}

// Blank text still writes a tombstone ({ text: '', updatedAt }) instead of
// deleting the key. The key's existence means "the user has an opinion
// about this exercise"; deleting it on clear would make a deliberately
// cleared note indistinguishable from one never written, and callers that
// seed from the template cue on a missing note (buildEntries, and the
// template-reseed path) would resurrect the stale cue the user just erased.
function setNote(name, text) {
  const db = load();
  const key = normName(name);
  const t = (text || '').trim();
  db.notes[key] = { text: t, updatedAt: Date.now() };
  save();
}

// Whether the user has ever saved (or cleared) a note for this exercise, as
// opposed to never having touched it. Distinguishes the two cases getNote's
// '' return value can't: a cleared note vs. one that was never set.
function hasNote(name) {
  return Object.prototype.hasOwnProperty.call(load().notes, normName(name));
}

// Reads a note off a session entry. Entries written before this feature only
// have `cue`, so both history and the session render go through here. An
// explicitly cleared note ('') stays cleared rather than falling back to a
// stale legacy cue.
function noteOfEntry(e) {
  if (e.note != null) return e.note;
  return e.cue || '';
}

// Dated note log, newest first. Consecutive sessions with identical text
// collapse into one row: { text, date (newest), since (oldest), count }.
// Relies on completedSessions() returning newest-first — if that sort ever
// flips, date and since silently swap meaning.
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

// ---- Active (in-progress) session persistence ----
function setActive(sess) { load().active = sess; save(); }
function getActive() { return load().active || null; }
function clearActive() { load().active = null; save(); }

// ---- Export / Import (used by Settings later) ----
function exportJSON() {
  return JSON.stringify(load(), null, 2);
}
function importJSON(text) {
  const parsed = JSON.parse(text);
  if (!parsed || !parsed.version) throw new Error('Not a valid backup file');
  _db = parsed;
  if (!_db.notes) _db.notes = {};
  save();
}

if (typeof window !== 'undefined') {
  window.Store = {
    load, save,
    getTemplates, getTemplate, addTemplate, updateTemplate, deleteTemplate,
    setLastRest, getLastRest, getSetting, setSetting,
    addSession, getSessions, completedSessions,
    historyForExercise, lastSetsForExercise, allTimeBestWeight,
    getNote, setNote, hasNote, notesForExercise, noteOfEntry,
    setActive, getActive, clearActive,
    exportJSON, importJSON,
    STORAGE_KEY,
  };
}

})();
