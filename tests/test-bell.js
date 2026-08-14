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

// ---- scheduleAt reentrancy: visibilitychange + pagehide can BOTH fire for a
// single backgrounding, so scheduleAt can be called twice in a row. Reassigning
// audioEl.src while a play() promise is pending rejects that pending promise
// (real browser semantics) — a stale rejection from the first call must not
// clobber a second, still-live call's armed state. This needs document, URL,
// Blob, and an OfflineAudioContext stub, since scheduleAt requires a rendered
// buffer and a media element. ----

class FakeOfflineAudioContext {
  constructor(channels, length, sampleRate) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.destination = {};
  }
  createOscillator() { return { frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
  createBuffer(channels, length) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createBiquadFilter() { return { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect() {} }; }
  startRendering() {
    const N = this.length;
    const rate = this.sampleRate;
    return Promise.resolve({
      numberOfChannels: 1,
      sampleRate: rate,
      length: N,
      getChannelData: () => new Float32Array(N),
    });
  }
}
global.window.OfflineAudioContext = FakeOfflineAudioContext;

// A fake <audio> element that models the one real-browser behavior this bug
// hinges on: assigning `.src` while a play() promise is still pending
// rejects that pending promise.
function makeFakeAudioEl() {
  const listeners = {};
  let pendingPlay = null;
  const el = {
    _srcValue: '',
    preload: '',
    setAttribute() {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    play() {
      return new Promise((resolve, reject) => { pendingPlay = { resolve, reject }; });
    },
    pause() {},
    fireEnded() { (listeners.ended || []).slice().forEach((fn) => fn()); },
  };
  Object.defineProperty(el, 'src', {
    get() { return el._srcValue; },
    set(v) {
      el._srcValue = v;
      if (pendingPlay) {
        const p = pendingPlay;
        pendingPlay = null;
        p.reject(new Error('interrupted by new load'));
      }
    },
  });
  return el;
}

let createObjectURLCalls = 0;
let lastAudioEl = null;
global.document = {
  body: { appendChild() {} },
  createElement(tag) {
    if (tag === 'audio') { lastAudioEl = makeFakeAudioEl(); return lastAudioEl; }
    return {};
  },
};
global.URL = {
  createObjectURL() { createObjectURLCalls++; return 'blob:fake-' + createObjectURLCalls; },
  revokeObjectURL() {},
};

// Let queued microtasks (the stale play() rejection's .catch handler) run.
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function runReentrancyTests() {
  console.log('\nbell — scheduleAt reentrancy (visibilitychange + pagehide double-fire)');

  await Bell.renderBell();
  Bell.init();
  // init() deliberately does NOT touch the media element — creating and
  // unlocking it claims an audio session and kills the user's music, so it is
  // opt-in behind the background-bell setting. The scheduled locked-screen bell
  // is exactly what needs it, hence prepareBackground() here.
  Bell.prepareBackground(); // ensureAudioEl + autoplay unlock

  // --- case 1: duplicate scheduleAt for the SAME endAt — layer 2 (no-op) ---
  const urlsBefore = createObjectURLCalls;
  const endAtA = Date.now() + 5000;
  Bell.scheduleAt(endAtA);
  Bell.scheduleAt(endAtA); // duplicate for the same rest — must be a true no-op
  check('duplicate schedule for the same endAt creates no second blob', createObjectURLCalls, urlsBefore + 1);
  await flush();
  lastAudioEl.fireEnded();
  check('same-endAt double schedule: bell recorded as fired', Bell.didFireScheduled(), true);

  // --- case 2: duplicate scheduleAt for DIFFERENT endAt values — layer 2's
  // no-op does not apply here, so layer 1 (the generation token) is what
  // must stop the first call's stale play() rejection from clearing the
  // second call's armed flag. ---
  Bell.cancel(); // reset armed/fired state between cases; does not touch scheduleGen
  const endAtB1 = Date.now() + 5000;
  const endAtB2 = Date.now() + 9000;
  Bell.scheduleAt(endAtB1);
  Bell.scheduleAt(endAtB2); // reassigns src -> rejects call 1's still-pending play()
  await flush();            // let the stale rejection's .catch microtask run
  lastAudioEl.fireEnded();
  check('different-endAt double schedule: stale rejection does not clear armed', Bell.didFireScheduled(), true);
}

runReentrancyTests().then(() => {
  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
  process.exit(failures ? 1 : 0);
}).catch((e) => {
  console.error('reentrancy tests crashed:', e);
  process.exit(1);
});
