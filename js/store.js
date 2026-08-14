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
    setLastRest, getLastRest,
    addSession, getSessions, completedSessions,
    historyForExercise, lastSetsForExercise, allTimeBestWeight,
    getNote, setNote,
    setActive, getActive, clearActive,
    exportJSON, importJSON,
    STORAGE_KEY,
  };
}

})();
