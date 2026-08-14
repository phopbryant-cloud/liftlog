// session.js — active workout: prefilled one-tap logging, background-safe rest
// timer, supersets, per-set warm-up/skip/add, finish summary with PRs.
// Uses globals from app.js: el, $, fmtTime, toast, show.
(function () {

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

let S = null;            // active session state (serializable)
let elapsedTimer = null; // header clock

// ---- timer (worker + fallback) ----
let worker = null;
let fallbackInterval = null;
let audioCtx = null;

function ensureWorker() {
  if (worker) return worker;
  try {
    worker = new Worker('./js/timer-worker.js');
    worker.onmessage = (e) => {
      if (e.data.type === 'tick') updateTimerDisplay(e.data.remaining);
      else if (e.data.type === 'done') onRestDone();
    };
  } catch (err) {
    worker = null; // fall back to main-thread interval
  }
  return worker;
}

function startTimerLoop(endAt) {
  stopTimerLoop();
  const w = ensureWorker();
  if (w) {
    w.postMessage({ cmd: 'start', endAt });
  } else {
    fallbackInterval = setInterval(() => {
      const remaining = endAt - Date.now();
      if (remaining <= 0) { stopTimerLoop(); onRestDone(); }
      else updateTimerDisplay(remaining);
    }, 200);
    updateTimerDisplay(endAt - Date.now());
  }
}
function stopTimerLoop() {
  if (worker) worker.postMessage({ cmd: 'stop' });
  if (fallbackInterval) { clearInterval(fallbackInterval); fallbackInterval = null; }
}

// ---- audio / notify / vibrate ----
function initAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function chime() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [880, 1320, 880].forEach((f, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    const t = now + i * 0.16;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.16);
  });
}
function notify(body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification('Rest complete 💪', { body, icon: './icons/icon.svg', tag: 'liftlog-rest', renotify: true }); } catch (e) {}
}
function vibrate(pattern) { if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} } }

// ================= BUILD / START / RESUME =================
function buildEntries(template) {
  return template.exercises.map((ex) => {
    const prev = window.Store.lastSetsForExercise(ex.name);
    const sets = [];
    let k = 0;
    ex.setGroups.forEach((g) => {
      for (let i = 0; i < g.sets; i++) {
        const p = prev[k] || {};
        sets.push({
          label: g.label || null,
          weight: p.weight != null ? String(p.weight) : '',
          reps: p.reps != null ? String(p.reps) : '',
          done: false, warmup: false, skipped: false,
          prefilled: p.weight != null || p.reps != null,
        });
        k++;
      }
    });
    return {
      exId: ex.id, name: ex.name,
      note: window.Store.hasNote(ex.name) ? window.Store.getNote(ex.name) : (ex.cue || ''),
      supersetId: ex.supersetId || null, restSec: ex.restSec || 120,
      sets,
    };
  });
}

function start(template) {
  initAudio();
  requestNotifyPermission();
  S = {
    id: 'sess_' + Date.now().toString(36),
    templateId: template.id,
    name: template.name,
    startedAt: Date.now(),
    finishedAt: null,
    entries: buildEntries(template),
    rest: null, // { endAt, entryName }
  };
  persist();
  render();
  show('session');
}

function resume(active) {
  S = active;
  render();
  // Resume a running rest timer if its target is still in the future.
  if (S.rest && S.rest.endAt) {
    if (S.rest.endAt - Date.now() > 0) startTimerLoop(S.rest.endAt);
    else onRestDone();
  }
  show('session');
}

function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) {}
  }
}

function persist() { if (S) window.Store.setActive(S); }
function isActive() { return !!S; }

// ================= RENDER =================
function render() {
  editingNote = null; // a full rebuild destroys any open editor by definition
  const scr = $('#screen-session');
  scr.innerHTML = '';
  if (!S) return;
  const wrap = el('div', 'wrap');

  // Header
  const head = el('div', 'sess-head');
  const title = el('div');
  title.appendChild(el('div', 'sess-name', S.name));
  const clock = el('div', 'sess-clock'); clock.id = 'sess-clock';
  title.appendChild(clock);
  head.appendChild(title);
  const finishBtn = el('button', 'btn btn-primary btn-sm', 'Finish');
  finishBtn.onclick = confirmFinish;
  head.appendChild(finishBtn);
  wrap.appendChild(head);

  // Exercise blocks (group supersets)
  const list = el('div');
  let i = 0;
  while (i < S.entries.length) {
    const e = S.entries[i];
    if (e.supersetId) {
      const group = [];
      const gid = e.supersetId;
      while (i < S.entries.length && S.entries[i].supersetId === gid) { group.push(i); i++; }
      list.appendChild(supersetBlock(group));
    } else {
      list.appendChild(exerciseBlock(i));
      i++;
    }
  }
  wrap.appendChild(list);

  // Ad-hoc add + discard
  const addEx = el('button', 'add-ex', '+ Add exercise');
  addEx.onclick = addAdHoc;
  wrap.appendChild(addEx);

  const discard = el('button', 'btn btn-ghost btn-block', 'Discard workout');
  discard.style.color = 'var(--text-faint)';
  discard.style.marginTop = '8px';
  discard.onclick = () => {
    if (confirm('Discard this workout? Nothing will be saved.')) {
      cleanup(); window.Store.clearActive(); S = null;
      window.App.renderTemplates(); show('templates');
    }
  };
  wrap.appendChild(discard);

  wrap.appendChild(el('div', null, '')).style.height = '90px'; // room above timer bar

  scr.appendChild(wrap);
  scr.appendChild(timerBar());

  startElapsed();
}

function startElapsed() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  const tick = () => {
    const c = document.getElementById('sess-clock');
    if (!c || !S) return;
    const secs = Math.floor(((S.finishedAt || Date.now()) - S.startedAt) / 1000);
    c.textContent = fmtTime(secs) + ' elapsed';
  };
  tick();
  elapsedTimer = setInterval(tick, 1000);
}

// ---- note block ----
// editingNote holds the entry index currently in edit mode. It is transient UI
// state, deliberately not persisted.
let editingNote = null;

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
      persist();
      grow();
    };
    // The standing note is shared across every template containing this
    // exercise; it has no reason to be written mid-keystroke. Once per edit
    // is enough, and it keeps oninput to a single serialization like the
    // weight/reps inputs. e.note is still persisted on every keystroke, so a
    // crash mid-edit loses nothing from this session.
    ta.onblur = () => {
      window.Store.setNote(e.name, ta.value);
      editingNote = null;
      refreshNoteBlock(idx);
    };
    box.appendChild(ta);
    // Deferred because noteBlock() fills a DETACHED node — focus() and
    // scrollHeight are both no-ops until the caller appends it.
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

  const prev = previousNote(e.name, text);
  if (prev) {
    const p = el('div', 'note-prev');
    p.textContent = 'Last time · ' + fmtNoteDate(prev.date) + ' — ' + prev.text;
    p.title = prev.text;
    p.onclick = () => window.History.openExercise(e.name);
    box.appendChild(p);
  }
}

function exerciseBlock(idx) {
  const e = S.entries[idx];
  const card = el('div', 'ex-card');
  card.appendChild(exHeader(e, idx));
  card.appendChild(noteBlock(idx));
  const rows = el('div', 'set-rows');
  e.sets.forEach((st, si) => rows.appendChild(setRow(idx, si)));
  card.appendChild(rows);
  const addSet = el('button', 'add-set', '+ Set');
  addSet.onclick = () => { addSetTo(idx); };
  card.appendChild(addSet);
  return card;
}

function supersetBlock(groupIdxs) {
  const block = el('div', 'ss-block');
  const names = groupIdxs.map((i) => S.entries[i].name).join(' + ');
  block.appendChild(el('div', 'ss-title', `Superset · ${names}`));
  // rounds = max set count among members
  const maxSets = Math.max(...groupIdxs.map((i) => S.entries[i].sets.length));
  for (let r = 0; r < maxSets; r++) {
    const round = el('div', 'ss-round');
    round.appendChild(el('div', 'ss-round-tag', `Round ${r + 1}`));
    groupIdxs.forEach((i) => {
      const e = S.entries[i];
      if (r === 0) {
        const h = el('div', 'ss-member-head');
        const nm = el('span', 'ss-member-name', e.name);
        nm.onclick = () => window.History.openExercise(e.name);
        h.appendChild(nm);
        round.appendChild(h);
        round.appendChild(noteBlock(i));
      }
      if (r < e.sets.length) round.appendChild(setRow(i, r, e.name));
    });
    block.appendChild(round);
  }
  // per-member add set + header tools
  const tools = el('div', 'ss-tools');
  groupIdxs.forEach((i) => {
    const b = el('button', 'add-set add-set-sm', `+ Set: ${S.entries[i].name}`);
    b.onclick = () => addSetTo(i);
    tools.appendChild(b);
  });
  block.appendChild(tools);
  return block;
}

function exHeader(e, idx) {
  const head = el('div', 'ex-head');
  head.appendChild(el('div', 'ex-index', String(idx + 1)));
  const name = el('div', 'ex-name-static');
  name.textContent = e.name;
  name.onclick = () => window.History.openExercise(e.name);
  head.appendChild(name);
  const tools = el('div', 'ex-tools');
  const up = el('button', 'icon-btn', '↑'); up.onclick = () => moveEx(idx, -1);
  const down = el('button', 'icon-btn', '↓'); down.onclick = () => moveEx(idx, 1);
  const skip = el('button', 'icon-btn', '⤫'); skip.title = 'Skip exercise';
  skip.onclick = () => { e.sets.forEach((st) => { if (!st.done) st.skipped = true; }); persist(); render(); };
  tools.append(up, down, skip);
  head.appendChild(tools);
  return head;
}

function setRow(entryIdx, setIdx, ssName) {
  const e = S.entries[entryIdx];
  const st = e.sets[setIdx];
  const row = el('div', 'set-row' + (st.done ? ' done' : '') + (st.warmup ? ' warm' : '') + (st.skipped ? ' skipped' : ''));

  // set number / label badge
  const badge = el('button', 'set-badge');
  badge.textContent = st.warmup ? 'W' : (st.label ? st.label : String(workingIndex(e, setIdx)));
  badge.title = 'Tap: toggle warm-up · long-press: skip';
  badge.onclick = () => { st.warmup = !st.warmup; persist(); render(); };
  attachLongPress(badge, () => { st.skipped = !st.skipped; st.done = false; persist(); render(); });
  row.appendChild(badge);

  if (st.skipped) {
    const sk = el('div', 'skip-note', 'skipped — tap badge to restore');
    row.appendChild(sk);
    return row;
  }

  // weight
  const wWrap = el('label', 'field');
  const wIn = el('input', 'num-in');
  wIn.type = 'text'; wIn.inputMode = 'decimal'; wIn.value = st.weight;
  wIn.placeholder = '–';
  wIn.oninput = () => { st.weight = wIn.value; st.prefilled = false; persist(); };
  wWrap.append(wIn, el('span', 'unit', 'lb'));
  row.appendChild(wWrap);

  row.appendChild(el('span', 'x', '×'));

  // reps
  const rWrap = el('label', 'field');
  const rIn = el('input', 'num-in');
  rIn.type = 'text'; rIn.inputMode = 'numeric'; rIn.value = st.reps;
  rIn.placeholder = '–';
  rIn.oninput = () => { st.reps = rIn.value; st.prefilled = false; persist(); };
  rWrap.append(rIn, el('span', 'unit', 'reps'));
  row.appendChild(rWrap);

  // check
  const check = el('button', 'check' + (st.done ? ' on' : ''));
  check.innerHTML = st.done ? '✔' : '✓';
  check.onclick = () => toggleDone(entryIdx, setIdx);
  row.appendChild(check);

  return row;
}

// number shown = position among non-warmup sets before it +1
function workingIndex(e, setIdx) {
  let n = 0;
  for (let i = 0; i <= setIdx; i++) if (!e.sets[i].warmup) n++;
  return n;
}

// ================= LOGGING =================
function toggleDone(entryIdx, setIdx) {
  const st = S.entries[entryIdx].sets[setIdx];
  initAudio();
  if (st.done) {
    st.done = false; persist(); render(); return;
  }
  st.done = true;
  // default reps to 1 if left blank but weight present? leave as-is; allow empty bodyweight.
  persist();
  render();
  maybeStartRest(entryIdx, setIdx);
}

// Start rest: for supersets, only after the whole round is done.
function maybeStartRest(entryIdx, setIdx) {
  const e = S.entries[entryIdx];
  if (e.supersetId) {
    const members = S.entries.filter((x) => x.supersetId === e.supersetId);
    const roundDone = members.every((m) => {
      const s = m.sets[setIdx];
      return !s || s.done || s.skipped;
    });
    if (!roundDone) return; // wait for the other superset member(s)
  }
  startRest(e.restSec, e.name);
}

function startRest(sec, name) {
  S.rest = { endAt: Date.now() + sec * 1000, entryName: name, total: sec };
  persist();
  startTimerLoop(S.rest.endAt);
  showTimerBar();
  updateTimerDisplay(sec * 1000);
}

function onRestDone() {
  stopTimerLoop();
  chime(); vibrate([300, 120, 300]); notify(S && S.rest ? `${S.rest.entryName} — back to it.` : 'Back to it.');
  if (S) { S.rest = null; persist(); }
  const bar = document.getElementById('timer-bar');
  if (bar) { bar.classList.add('flash'); setTimeout(() => hideTimerBar(), 900); }
}

// ================= TIMER BAR =================
function timerBar() {
  const bar = el('div', 'timer-bar'); bar.id = 'timer-bar';
  const label = el('div', 'timer-label'); label.id = 'timer-label';
  const time = el('div', 'timer-time'); time.id = 'timer-time'; time.textContent = '0:00';
  const controls = el('div', 'timer-controls');
  const minus = el('button', 'btn btn-sm', '−15');
  const skip = el('button', 'btn btn-sm', 'Skip');
  const plus = el('button', 'btn btn-sm', '+15');
  minus.onclick = () => adjustRest(-15);
  plus.onclick = () => adjustRest(15);
  skip.onclick = () => { stopTimerLoop(); if (S) { S.rest = null; persist(); } hideTimerBar(); };
  controls.append(minus, skip, plus);
  bar.append(label, time, controls);
  if (!(S && S.rest && S.rest.endAt && S.rest.endAt > Date.now())) bar.classList.add('hidden');
  else { label.textContent = 'REST · ' + S.rest.entryName; }
  return bar;
}
function showTimerBar() {
  const bar = document.getElementById('timer-bar');
  if (bar) { bar.classList.remove('hidden', 'flash'); document.getElementById('timer-label').textContent = 'REST · ' + S.rest.entryName; }
}
function hideTimerBar() {
  const bar = document.getElementById('timer-bar');
  if (bar) bar.classList.add('hidden');
}
function updateTimerDisplay(remainingMs) {
  const t = document.getElementById('timer-time');
  if (!t) return;
  const secs = Math.max(0, Math.ceil(remainingMs / 1000));
  t.textContent = fmtTime(secs);
  const bar = document.getElementById('timer-bar');
  if (bar && S && S.rest) {
    const frac = 1 - Math.max(0, remainingMs) / (S.rest.total * 1000);
    bar.style.setProperty('--prog', Math.min(1, Math.max(0, frac)));
  }
}
function adjustRest(delta) {
  if (!S || !S.rest) return;
  S.rest.endAt += delta * 1000;
  S.rest.total = Math.max(15, S.rest.total + delta);
  if (S.rest.endAt - Date.now() <= 0) { onRestDone(); return; }
  persist();
  startTimerLoop(S.rest.endAt);
}

// ================= EDITS =================
function moveEx(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= S.entries.length) return;
  [S.entries[idx], S.entries[j]] = [S.entries[j], S.entries[idx]];
  persist(); render();
}
function addSetTo(entryIdx) {
  const e = S.entries[entryIdx];
  const last = [...e.sets].reverse().find((s) => !s.skipped);
  e.sets.push({
    label: last ? last.label : null,
    weight: last ? last.weight : '', reps: last ? last.reps : '',
    done: false, warmup: false, skipped: false, prefilled: false,
  });
  persist(); render();
}
function addAdHoc() {
  const name = prompt('Exercise name?');
  if (!name || !name.trim()) return;
  S.entries.push({
    exId: 'adhoc_' + Date.now().toString(36), name: name.trim(), note: '',
    supersetId: null, restSec: window.Store.getLastRest(),
    sets: [{ label: null, weight: '', reps: '', done: false, warmup: false, skipped: false, prefilled: false }],
  });
  persist(); render();
}

// ================= FINISH =================
function confirmFinish() {
  const anyLogged = S.entries.some((e) => e.sets.some((s) => s.done && !s.skipped));
  if (!anyLogged) {
    if (!confirm('No sets logged. Discard this workout?')) return;
    cleanup(); window.Store.clearActive(); S = null; window.App.renderTemplates(); show('templates'); return;
  }
  finish();
}

function finish() {
  // Compute PRs vs history BEFORE saving this session.
  const prs = [];
  const seen = new Set();
  S.entries.forEach((e) => {
    if (seen.has(e.name.toLowerCase())) return;
    seen.add(e.name.toLowerCase());
    const prevBest = window.Store.allTimeBestWeight(e.name);
    let sessionBest = 0, bestReps = 0;
    S.entries.filter((x) => x.name.toLowerCase() === e.name.toLowerCase()).forEach((x) => {
      x.sets.forEach((s) => {
        if (s.done && !s.skipped && !s.warmup && num(s.weight) > sessionBest) {
          sessionBest = num(s.weight); bestReps = num(s.reps);
        }
      });
    });
    if (sessionBest > prevBest && sessionBest > 0) {
      prs.push({ name: e.name, weight: sessionBest, reps: bestReps, prev: prevBest });
    }
  });

  S.finishedAt = Date.now();
  const totalVolume = volumeOf(S);
  const duration = Math.floor((S.finishedAt - S.startedAt) / 1000);
  const setCount = S.entries.reduce((n, e) => n + e.sets.filter((s) => s.done && !s.skipped && !s.warmup).length, 0);

  window.Store.addSession(S);
  window.Store.clearActive();
  cleanup();

  showSummary({ totalVolume, duration, setCount, prs });
  const saved = S; S = null;
}

function volumeOf(sess) {
  let v = 0;
  sess.entries.forEach((e) => e.sets.forEach((s) => {
    if (s.done && !s.skipped && !s.warmup) v += num(s.weight) * num(s.reps);
  }));
  return Math.round(v);
}

function cleanup() {
  stopTimerLoop();
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

function showSummary({ totalVolume, duration, setCount, prs }) {
  const ov = el('div', 'overlay');
  const sheet = el('div', 'summary-sheet');
  sheet.appendChild(el('div', 'summary-kicker', 'Workout complete'));
  sheet.appendChild(el('h2', 'summary-title', '💪 Nice work'));

  const stats = el('div', 'summary-stats');
  stats.appendChild(statTile(fmtTime(duration), 'Duration'));
  stats.appendChild(statTile(totalVolume.toLocaleString() + ' lb', 'Total volume'));
  stats.appendChild(statTile(String(setCount), 'Working sets'));
  sheet.appendChild(stats);

  if (prs.length) {
    sheet.appendChild(el('div', 'pr-head', `🏆 ${prs.length} new PR${prs.length > 1 ? 's' : ''}`));
    const wrap = el('div');
    prs.forEach((p) => {
      const r = el('div', 'pr-row');
      r.appendChild(el('span', 'pr-name', p.name));
      r.appendChild(el('span', 'pr-val', `${p.weight} lb${p.reps ? ' × ' + p.reps : ''}` + (p.prev ? `  (was ${p.prev})` : '')));
      wrap.appendChild(r);
    });
    sheet.appendChild(wrap);
  } else {
    sheet.appendChild(el('div', 'summary-note', 'No new PRs this session — consistency wins.'));
  }

  const done = el('button', 'btn btn-primary btn-block', 'Done');
  done.style.marginTop = '20px';
  done.onclick = () => { ov.remove(); window.App.renderTemplates(); window.History.render(); show('history'); };
  sheet.appendChild(done);

  ov.appendChild(sheet);
  document.body.appendChild(ov);
}

function statTile(value, label) {
  const t = el('div', 'stat-tile');
  t.appendChild(el('div', 'stat-value', value));
  t.appendChild(el('div', 'stat-label', label));
  return t;
}

// ---- long press helper ----
function attachLongPress(node, fn) {
  let t = null;
  const start = () => { t = setTimeout(() => { t = null; fn(); }, 500); };
  const cancel = () => { if (t) { clearTimeout(t); t = null; } };
  node.addEventListener('touchstart', start, { passive: true });
  node.addEventListener('touchend', cancel);
  node.addEventListener('touchmove', cancel);
  node.addEventListener('mousedown', start);
  node.addEventListener('mouseup', cancel);
  node.addEventListener('mouseleave', cancel);
}

// Recompute on return to foreground (worker may have been throttled while locked).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S || !S.rest) return;
  const remaining = S.rest.endAt - Date.now();
  if (remaining <= 0) onRestDone();
  else { updateTimerDisplay(remaining); startTimerLoop(S.rest.endAt); }
});

window.Session = { start, resume, isActive };

})();
