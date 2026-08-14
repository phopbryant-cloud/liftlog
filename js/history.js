// history.js — session history list + tappable per-exercise progression sheet
// (weight×reps log, best-set highlight, PR badges, top-set line chart).
// Uses globals from app.js: el, $, fmtTime, show.
(function () {

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtDateFull(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function render() {
  const scr = $('#screen-history');
  scr.innerHTML = '';
  const wrap = el('div', 'wrap');
  wrap.appendChild(el('div', 'h-section', 'History'));

  const sessions = window.Store.completedSessions();
  if (!sessions.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('div', 'big', 'No sessions'));
    empty.appendChild(el('div', null, 'Finish a workout and it lands here.'));
    wrap.appendChild(empty);
  } else {
    sessions.forEach((s) => wrap.appendChild(sessionCard(s)));
  }
  scr.appendChild(wrap);
}

function sessionCard(s) {
  const card = el('div', 'tpl-card');
  const top = el('div', 'sess-card-top');
  const left = el('div');
  left.appendChild(el('h3', null, s.name));
  left.appendChild(el('div', 'tpl-meta', fmtDateFull(s.finishedAt || s.startedAt)));
  top.appendChild(left);
  const prCount = prCountFor(s);
  if (prCount) top.appendChild(el('span', 'badge-pr', `🏆 ${prCount}`));
  card.appendChild(top);

  const dur = Math.floor(((s.finishedAt || s.startedAt) - s.startedAt) / 1000);
  const vol = volumeOf(s);
  const meta = el('div', 'sess-stats');
  meta.appendChild(miniStat(fmtTime(dur), 'time'));
  meta.appendChild(miniStat(vol.toLocaleString(), 'volume lb'));
  meta.appendChild(miniStat(String(setCount(s)), 'sets'));
  card.appendChild(meta);

  const chips = el('div', 'ex-chips');
  s.entries.forEach((e) => {
    if (!e.sets.some((st) => st.done && !st.skipped)) return;
    const c = el('button', 'ex-chip', e.name);
    c.onclick = () => openExercise(e.name);
    chips.appendChild(c);
  });
  card.appendChild(chips);
  return card;
}

function miniStat(v, label) {
  const b = el('div', 'mini-stat');
  b.appendChild(el('div', 'mini-val', v));
  b.appendChild(el('div', 'mini-label', label));
  return b;
}
function volumeOf(s) {
  let v = 0;
  s.entries.forEach((e) => e.sets.forEach((st) => { if (st.done && !st.skipped && !st.warmup) v += num(st.weight) * num(st.reps); }));
  return Math.round(v);
}
function setCount(s) {
  return s.entries.reduce((n, e) => n + e.sets.filter((st) => st.done && !st.skipped && !st.warmup).length, 0);
}
function prCountFor(s) {
  // A session "has a PR" if any exercise's top weight equals the all-time best.
  let count = 0;
  const seen = new Set();
  s.entries.forEach((e) => {
    const key = e.name.toLowerCase();
    if (seen.has(key)) return; seen.add(key);
    const best = window.Store.allTimeBestWeight(e.name);
    const top = e.sets.filter((st) => st.done && !st.skipped && !st.warmup)
      .reduce((m, st) => Math.max(m, num(st.weight)), 0);
    if (top > 0 && top >= best) count++;
  });
  return count;
}

// ================= EXERCISE PROGRESSION SHEET =================
function openExercise(name) {
  const hist = window.Store.historyForExercise(name); // newest first
  const ov = el('div', 'overlay');
  const sheet = el('div', 'ex-sheet');

  const head = el('div', 'ex-sheet-head');
  const titles = el('div');
  titles.appendChild(el('div', 'summary-kicker', 'Exercise history'));
  titles.appendChild(el('h2', 'summary-title', name));
  head.appendChild(titles);
  const close = el('button', 'icon-btn', '✕');
  close.onclick = () => ov.remove();
  head.appendChild(close);
  sheet.appendChild(head);

  if (!hist.length) {
    sheet.appendChild(el('div', 'summary-note', 'No logged history yet. Do this exercise in a workout and it will appear here.'));
  } else {
    const best = window.Store.allTimeBestWeight(name);
    const bestBadge = el('div', 'best-badge');
    bestBadge.innerHTML = `<span class="best-label">All-time best</span><span class="best-val">${best} lb</span>`;
    sheet.appendChild(bestBadge);

    // Chart (chronological)
    const chrono = hist.slice().reverse();
    sheet.appendChild(chart(chrono.map((h) => ({ x: h.date, y: h.topWeight }))));

    // Per-session log
    hist.forEach((h) => {
      const blk = el('div', 'hist-block');
      const top = el('div', 'hist-top');
      top.appendChild(el('span', 'hist-date', fmtDateFull(h.date)));
      if (h.topWeight >= best && best > 0) top.appendChild(el('span', 'badge-pr', '🏆 PR'));
      blk.appendChild(top);
      // best set = max weight, tiebreak max reps
      let bi = -1, bw = -1, br = -1;
      h.sets.forEach((st, i) => {
        if (st.warmup) return;
        const w = num(st.weight), r = num(st.reps);
        if (w > bw || (w === bw && r > br)) { bw = w; br = r; bi = i; }
      });
      const setsWrap = el('div', 'hist-sets');
      h.sets.forEach((st, i) => {
        const pill = el('div', 'set-pill' + (i === bi ? ' best' : '') + (st.warmup ? ' warm' : ''));
        pill.textContent = `${st.weight || '–'}×${st.reps || '–'}` + (st.warmup ? ' (w)' : '');
        setsWrap.appendChild(pill);
      });
      blk.appendChild(setsWrap);
      sheet.appendChild(blk);
    });
  }

  ov.appendChild(sheet);
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
  document.body.appendChild(ov);
}

// ================= SVG LINE CHART =================
function chart(points) {
  const box = el('div', 'chart-box');
  if (points.length < 2) {
    box.appendChild(el('div', 'summary-note', points.length === 1
      ? `First data point: ${points[0].y} lb. Two+ sessions unlock the trend line.` : ''));
    if (points.length === 0) return box;
    if (points.length === 1) return box;
  }
  const W = 320, H = 140, padX = 8, padY = 16;
  const ys = points.map((p) => p.y);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (min === max) { min = Math.max(0, min - 10); max = max + 10; }
  const n = points.length;
  const xAt = (i) => padX + (i / (n - 1)) * (W - padX * 2);
  const yAt = (v) => padY + (1 - (v - min) / (max - min)) * (H - padY * 2);

  const line = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(' ');
  const area = `${padX},${H - padY} ${line} ${W - padX},${H - padY}`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart-svg');
  svg.innerHTML = `
    <defs>
      <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--volt)" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="var(--volt)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${area}" fill="url(#fill)"/>
    <polyline points="${line}" fill="none" stroke="var(--gold)" stroke-width="2.5"
      stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="3.5" fill="var(--gold)"/>`).join('')}
  `;
  box.appendChild(svg);

  const axis = el('div', 'chart-axis');
  axis.appendChild(el('span', null, `${fmtDate(points[0].x)} · ${min} lb`));
  axis.appendChild(el('span', null, `${max} lb · ${fmtDate(points[n - 1].x)}`));
  box.appendChild(axis);
  return box;
}

window.History = { render, openExercise };

})();
