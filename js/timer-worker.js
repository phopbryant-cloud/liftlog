// timer-worker.js — timestamp-based rest countdown that survives background/lock.
// The main thread owns the target time (endAt); the worker just ticks and
// reports remaining ms computed from Date.now(), so throttling can't drift it.
let endAt = null;
let interval = null;

self.onmessage = (e) => {
  const { cmd } = e.data;
  if (cmd === 'start') {
    endAt = e.data.endAt;
    if (interval) clearInterval(interval);
    interval = setInterval(tick, 200);
    tick();
  } else if (cmd === 'stop') {
    if (interval) clearInterval(interval);
    interval = null;
    endAt = null;
  }
};

function tick() {
  if (endAt == null) return;
  const remaining = endAt - Date.now();
  if (remaining <= 0) {
    self.postMessage({ type: 'done' });
    clearInterval(interval);
    interval = null;
    endAt = null;
  } else {
    self.postMessage({ type: 'tick', remaining });
  }
}
