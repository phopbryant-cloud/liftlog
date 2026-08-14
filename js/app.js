// app.js — Import → Preview/Edit → Rest setup → Save. Plus template list + nav.
// (Active session, history, progression come in the next phase.)

const { parseWorkout, totalSets, uid } = window.WorkoutParser;

// ---- Sample pastes (quick-fill on the import screen) ----
const SAMPLES = {
  push: `Push day 1
Rear Delt - 4 sets
Incline Dumbell press - 3 sets
Cable fly low to high - seated straight up - cables slightly above bottom - 4 sets
superset: 3 sets
curls
hammer curls
side laterals - 2 sets cable - 2 sets dumbbell`,
  pull: `Pull Day 1
Lat pulldown - wide grip - lean back slightly - 4 sets
Chest supported row - squeeze at top - 3 sets
superset: 3 sets
face pulls
straight arm pulldown
Barbell curl - 4 sets`,
};

// Working copy of the workout currently being previewed/edited.
let draft = null;

// ---------- Utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = el('div', 'toast'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- Navigation ----------
function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${screen}`));
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.screen === screen));
  updateResumeBar(screen);
  window.scrollTo(0, 0);
}

// The bottom nav has no session tab, so tapping Settings or History mid-workout
// used to strand the user — the only way back was to close and reopen the app.
// This floats a one-tap route back above the nav on every screen except the
// session itself.
function updateResumeBar(screen) {
  const active = window.Store.getActive();
  const wanted = !!(active && active.entries && screen !== 'session');
  let bar = document.getElementById('resume-bar');
  if (!wanted) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = el('button', 'resume-bar');
    bar.id = 'resume-bar';
    bar.onclick = () => { window.Session.reopen(); };
    document.body.appendChild(bar);
  }
  bar.textContent = '● ' + (active.name || 'Workout') + ' in progress — tap to return';
}

// ================= IMPORT =================
function renderImport() {
  const s = $('#screen-import');
  s.innerHTML = '';
  const wrap = el('div', 'wrap');

  wrap.appendChild(headingWithHint('Import workout', 'Paste your notes — messy is fine.'));

  const samples = el('div', 'samples');
  const c1 = el('button', 'chip', '▚ Push day 1 sample');
  const c2 = el('button', 'chip', '▚ Pull day 1 sample');
  c1.onclick = () => { ta.value = SAMPLES.push; };
  c2.onclick = () => { ta.value = SAMPLES.pull; };
  samples.append(c1, c2);
  wrap.appendChild(samples);

  const ta = el('textarea', 'paste');
  ta.placeholder = 'Push day 1\nRear Delt - 4 sets\nIncline Dumbell press - 3 sets\n...';
  ta.value = SAMPLES.push;
  wrap.appendChild(ta);

  const actions = el('div', 'sticky-actions');
  const parseBtn = el('button', 'btn btn-primary btn-block', 'Parse → Preview');
  parseBtn.onclick = () => {
    if (!ta.value.trim()) { toast('Paste something first'); return; }
    draft = parseWorkout(ta.value);
    renderPreview();
    show('preview');
  };
  actions.appendChild(parseBtn);
  wrap.appendChild(actions);

  s.appendChild(wrap);
}

function headingWithHint(title, hint) {
  const box = el('div');
  const h = el('div', 'h-section', title);
  box.appendChild(h);
  if (hint) { const p = el('div', 'meta-line', hint); box.appendChild(p); }
  return box;
}

// ================= PREVIEW / EDIT =================
function renderPreview() {
  const s = $('#screen-preview');
  s.innerHTML = '';
  const wrap = el('div', 'wrap');

  // Editable workout name
  const nameIn = el('input', 'preview-name');
  nameIn.value = draft.name;
  nameIn.oninput = () => { draft.name = nameIn.value; };
  wrap.appendChild(nameIn);

  const summary = el('div', 'meta-line');
  const updateSummary = () => {
    const exs = draft.exercises.length;
    const sets = draft.exercises.reduce((n, e) => n + totalSets(e), 0);
    summary.textContent = `${exs} exercises · ${sets} working sets · edit anything below`;
  };
  wrap.appendChild(summary);

  const list = el('div');
  wrap.appendChild(list);

  const addBtn = el('button', 'add-ex', '+ Add exercise');
  addBtn.onclick = () => {
    draft.exercises.push({
      id: uid('ex'), name: 'New exercise', cue: '',
      setGroups: [{ label: null, sets: 3, inferred: false }], supersetId: null,
    });
    rebuild();
  };
  wrap.appendChild(addBtn);

  const actions = el('div', 'sticky-actions');
  const back = el('button', 'btn btn-ghost', '← Re-paste');
  back.onclick = () => show('import');
  const next = el('button', 'btn btn-primary', 'Set rest times →');
  next.style.flex = '1';
  next.onclick = () => { renderRest(); show('rest'); };
  const row = el('div'); row.style.display = 'flex'; row.style.gap = '10px';
  row.append(back, next);
  actions.appendChild(row);
  wrap.appendChild(actions);

  s.appendChild(wrap);

  function rebuild() { renderExerciseList(list, rebuild); updateSummary(); }
  rebuild();
}

function renderExerciseList(list, rebuild) {
  list.innerHTML = '';
  let lastSS = null;
  draft.exercises.forEach((ex, i) => {
    // Superset band header when a new superset group starts
    if (ex.supersetId && ex.supersetId !== lastSS) {
      const members = draft.exercises.filter((e) => e.supersetId === ex.supersetId).length;
      list.appendChild(el('div', 'ss-band', `Superset · ${members} exercises alternate`));
    }
    if (!ex.supersetId) lastSS = null; else lastSS = ex.supersetId;

    list.appendChild(exerciseCard(ex, i, rebuild));
  });
}

function exerciseCard(ex, i, rebuild) {
  const card = el('div', 'ex-card' + (ex.supersetId ? ' ss' : ''));

  const head = el('div', 'ex-head');
  head.appendChild(el('div', 'ex-index', String(i + 1)));

  const nameIn = el('input', 'ex-name');
  nameIn.value = ex.name;
  nameIn.oninput = () => { ex.name = nameIn.value; };
  head.appendChild(nameIn);

  const tools = el('div', 'ex-tools');
  const up = el('button', 'icon-btn', '↑');
  up.onclick = () => { if (i > 0) { swap(i, i - 1); rebuild(); } };
  const down = el('button', 'icon-btn', '↓');
  down.onclick = () => { if (i < draft.exercises.length - 1) { swap(i, i + 1); rebuild(); } };
  const del = el('button', 'icon-btn del', '✕');
  del.onclick = () => { draft.exercises.splice(i, 1); rebuild(); };
  tools.append(up, down, del);
  head.appendChild(tools);
  card.appendChild(head);

  // Cue field
  const cue = el('textarea', 'cue-input');
  cue.placeholder = 'Cues / notes (shown under the name during your workout)';
  cue.value = ex.cue || '';
  cue.rows = ex.cue && ex.cue.length > 40 ? 2 : 1;
  cue.oninput = () => { ex.cue = cue.value; };
  card.appendChild(cue);

  // Set groups
  const groups = el('div', 'groups');
  ex.setGroups.forEach((g, gi) => groups.appendChild(setGroupEl(ex, g, gi, rebuild)));
  card.appendChild(groups);

  if (ex.setGroups.some((g) => g.inferred)) {
    card.appendChild(el('div', 'hint', '⚠ No set count found — defaulted to 3. Adjust if needed.'));
  }
  if (ex.setGroups.length > 1) {
    const h = el('div', 'meta-line', 'Split implement — logged as one exercise, sets grouped by label');
    h.style.marginTop = '8px';
    card.appendChild(h);
  }

  return card;
}

function setGroupEl(ex, g, gi, rebuild) {
  const box = el('div', 'group' + (g.inferred ? ' inferred' : ''));
  if (g.label) box.appendChild(el('span', 'group-label', g.label));
  const stepper = el('div', 'stepper');
  const minus = el('button', null, '−');
  const val = el('span', 'val', String(g.sets));
  const plus = el('button', null, '+');
  const unit = el('span', 'unit', 'sets');
  minus.onclick = () => { g.sets = Math.max(1, g.sets - 1); g.inferred = false; val.textContent = g.sets; box.classList.remove('inferred'); rebuild(); };
  plus.onclick = () => { g.sets += 1; g.inferred = false; val.textContent = g.sets; box.classList.remove('inferred'); rebuild(); };
  stepper.append(minus, val, plus, unit);
  box.appendChild(stepper);
  return box;
}

function swap(a, b) {
  const arr = draft.exercises;
  [arr[a], arr[b]] = [arr[b], arr[a]];
}

// ================= REST TIME SETUP =================
function renderRest() {
  const s = $('#screen-rest');
  s.innerHTML = '';
  const wrap = el('div', 'wrap');

  wrap.appendChild(headingWithHint('Rest per exercise', 'How long between sets? Set one and apply to all, then tweak.'));

  // Seed each exercise with last-used default if unset.
  const defaultRest = window.Store.getLastRest();
  draft.exercises.forEach((ex) => { if (ex.restSec == null) ex.restSec = defaultRest; });

  // "apply to all" control
  const apply = el('div', 'rest-apply');
  [90, 120, 150, 180].forEach((sec) => {
    const c = el('button', 'chip', `Apply ${fmtTime(sec)} to all`);
    c.onclick = () => {
      draft.exercises.forEach((ex) => { ex.restSec = sec; });
      window.Store.setLastRest(sec);
      renderRows();
    };
    apply.appendChild(c);
  });
  wrap.appendChild(apply);

  const rows = el('div');
  wrap.appendChild(rows);

  const actions = el('div', 'sticky-actions');
  const row = el('div'); row.style.display = 'flex'; row.style.gap = '10px';
  const back = el('button', 'btn btn-ghost', '← Edit');
  back.onclick = () => show('preview');
  const saveBtn = el('button', 'btn btn-primary', 'Save template ✓');
  saveBtn.style.flex = '1';
  saveBtn.onclick = saveTemplate;
  row.append(back, saveBtn);
  actions.appendChild(row);
  wrap.appendChild(actions);

  s.appendChild(wrap);

  function renderRows() {
    rows.innerHTML = '';
    draft.exercises.forEach((ex) => {
      const r = el('div', 'rest-row');
      r.appendChild(el('div', 'rname', ex.name));
      const stepper = el('div', 'rest-stepper');
      const minus = el('button', null, '−');
      const time = el('div', 'rest-time', fmtTime(ex.restSec));
      const plus = el('button', null, '+');
      minus.onclick = () => { ex.restSec = Math.max(15, ex.restSec - 15); time.textContent = fmtTime(ex.restSec); };
      plus.onclick = () => { ex.restSec = Math.min(600, ex.restSec + 15); time.textContent = fmtTime(ex.restSec); };
      stepper.append(minus, time, plus);
      r.appendChild(stepper);
      rows.appendChild(r);
    });
  }
  renderRows();
}

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

function saveTemplate() {
  const tpl = {
    id: uid('tpl'),
    name: draft.name.trim() || 'Untitled Workout',
    createdAt: Date.now(),
    exercises: draft.exercises.map((ex) => ({
      id: ex.id,
      name: ex.name.trim(),
      cue: ex.cue || '',
      setGroups: ex.setGroups.map((g) => ({ label: g.label || null, sets: parseInt(g.sets, 10) || 1 })),
      restSec: ex.restSec || 120,
      supersetId: ex.supersetId || null,
    })),
  };
  window.Store.addTemplate(tpl);
  seedNotesFromExercises(tpl.exercises);
  draft = null;
  renderTemplates();
  show('templates');
  toast('Template saved');
}

// ================= TEMPLATE LIST =================
function renderTemplates() {
  const s = $('#screen-templates');
  s.innerHTML = '';
  const wrap = el('div', 'wrap');

  const head = el('div', 'h-section', 'Your templates');
  wrap.appendChild(head);

  const tpls = window.Store.getTemplates();
  if (!tpls.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('div', 'big', 'No templates'));
    empty.appendChild(el('div', null, 'Import your first workout to get started.'));
    wrap.appendChild(empty);
  } else {
    tpls.forEach((t) => wrap.appendChild(templateCard(t)));
  }

  const actions = el('div', 'sticky-actions');
  const imp = el('button', 'btn btn-primary btn-block', '+ Import workout');
  imp.onclick = () => { renderImport(); show('import'); };
  actions.appendChild(imp);
  wrap.appendChild(actions);

  s.appendChild(wrap);
}

function templateCard(t) {
  const card = el('div', 'tpl-card');
  card.appendChild(el('h3', null, t.name));
  const sets = t.exercises.reduce((n, e) => n + e.setGroups.reduce((m, g) => m + g.sets, 0), 0);
  card.appendChild(el('div', 'tpl-meta', `${t.exercises.length} exercises · ${sets} sets`));

  const exs = el('div', 'ex-chips');
  t.exercises.forEach((e) => {
    const c = el('button', 'ex-chip', e.name);
    c.onclick = () => window.History.openExercise(e.name);
    exs.appendChild(c);
  });
  card.appendChild(exs);

  const row = el('div'); row.style.display = 'flex'; row.style.gap = '8px'; row.style.marginTop = '14px';
  const startBtn = el('button', 'btn btn-primary btn-sm', 'Start workout');
  startBtn.onclick = () => {
    if (window.Store.getActive() && !confirm('Start a new workout? Your in-progress one will be discarded.')) return;
    window.Session.start(t);
  };
  const editBtn = el('button', 'btn btn-sm', 'Edit');
  editBtn.onclick = () => {
    draft = JSON.parse(JSON.stringify(t));
    renderPreview();
    show('preview');
    // Editing a saved template overwrites it on save
    _editingId = t.id;
  };
  const delBtn = el('button', 'btn btn-sm btn-danger', 'Delete');
  delBtn.onclick = () => {
    if (confirm(`Delete "${t.name}"?`)) { window.Store.deleteTemplate(t.id); renderTemplates(); }
  };
  row.append(startBtn, editBtn, delBtn);
  card.appendChild(row);
  return card;
}

let _editingId = null;

// Override save to handle edits of existing templates.
const _origSave = saveTemplate;
saveTemplate = function () {
  if (_editingId) {
    const tpl = window.Store.getTemplate(_editingId);
    tpl.name = draft.name.trim() || tpl.name;
    tpl.exercises = draft.exercises.map((ex) => ({
      id: ex.id, name: ex.name.trim(), cue: ex.cue || '',
      setGroups: ex.setGroups.map((g) => ({ label: g.label || null, sets: parseInt(g.sets, 10) || 1 })),
      restSec: ex.restSec || 120, supersetId: ex.supersetId || null,
    }));
    window.Store.updateTemplate(tpl);
    seedNotesFromExercises(tpl.exercises);
    _editingId = null; draft = null;
    renderTemplates(); show('templates'); toast('Template updated');
    return;
  }
  _origSave();
};

// Shared surface for the other modules.
window.App = { renderTemplates, renderImport, show };

// ================= BOOT =================
function boot() {
  document.querySelectorAll('.nav a').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const scr = a.dataset.screen;
      if (scr === 'templates') renderTemplates();
      if (scr === 'import') renderImport();
      if (scr === 'history') window.History.render();
      if (scr === 'settings') window.Settings.render();
      show(scr);
    };
  });
  renderTemplates();
  renderImport();

  // Resume an in-progress workout if the app was closed/reloaded mid-session.
  const active = window.Store.getActive();
  if (active && active.entries) {
    window.Session.resume(active);
  } else {
    show('templates');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
document.addEventListener('DOMContentLoaded', boot);
