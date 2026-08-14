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
let ctx = null;           // live AudioContext for the foreground ring
let audioEl = null;       // persistent media element for the background ring
let blobUrl = null;
let unlocked = false;
let armed = false;        // a scheduled background bell is pending
let scheduledFired = false;
let silentUrl = null;
let scheduleGen = 0;       // bumped on every scheduleAt call; guards against a stale play() rejection
let scheduledEndAt = 0;    // endAt of the currently-armed schedule, for de-duping repeat calls

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
    .then((b) => { buffer = normalize(b, 0.89); rendering = null; return buffer; })
    .catch(() => { rendering = null; return null; });
  return rendering;
}

// Summed partials plus the mallet transient overshoot unity badly (measured
// ~1.96 peak), which hard-clips on both the WebAudio path and in the 16-bit
// WAV. Normalize once, to just under full scale: as loud as a gym needs
// without distorting, and self-correcting if the partials are ever retuned.
function normalize(b, target) {
  const d = b.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  if (peak > 0) {
    const g = target / peak;
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return b;
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

// ---- media element (background path) ----
function ensureAudioEl() {
  if (audioEl || typeof document === 'undefined' || !document.body) return audioEl;
  audioEl = document.createElement('audio');
  audioEl.setAttribute('playsinline', '');
  audioEl.preload = 'auto';
  audioEl.addEventListener('ended', () => {
    if (armed) { scheduledFired = true; armed = false; scheduledEndAt = 0; }
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
// Deliberately does NOT create or unlock the media element — see
// prepareBackground(). A running AudioContext alone already claims an audio
// session on iOS, which is why the session type is pinned to 'ambient' here.
function init() {
  // 'ambient' mixes with other apps' audio rather than interrupting it, so the
  // in-app bell rings OVER the user's music instead of killing it. Without this
  // iOS resolves 'auto' to a playback-style session and stops their music every
  // time the AudioContext starts. Trade-off: ambient audio is silenced by the
  // physical mute switch.
  setSession('ambient');
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { try { ctx = new AC(); } catch (e) { ctx = null; } }
  }
  if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
  renderBell();
}

// Creating and unlocking the media element is what makes the locked-screen bell
// possible — and is ALSO what interrupts other audio, since a media element
// claims a playback session even for 0.05s of silence. So it happens only when
// the user has actually opted into the background bell. Must run in a gesture.
function prepareBackground() {
  ensureAudioEl();
  unlock();
}

// Foreground ring, through the ambient session so other apps' audio is untouched.
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
  // visibilitychange and pagehide can BOTH fire for a single backgrounding.
  // Re-arming for the same rest would restart the audio and churn the blob for
  // no reason, so treat it as a no-op.
  if (armed && scheduledEndAt === endAt) return true;
  const lead = Math.max(0, (endAt - Date.now()) / 1000);
  release();
  scheduledFired = false;
  const gen = ++scheduleGen;
  try {
    blobUrl = URL.createObjectURL(new Blob([wavBytes(buffer, lead)], { type: 'audio/wav' }));
    audioEl.src = blobUrl;
    setSession('playback');
    setMetadata();
    armed = true;
    scheduledEndAt = endAt;
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => {
      // A newer scheduleAt already took over — reassigning src rejects the
      // previous play() promise, and this stale rejection must not clear the
      // newer call's armed flag.
      if (gen !== scheduleGen) return;
      armed = false;
      setSession('ambient');
    });
    return true;
  } catch (e) {
    armed = false;
    setSession('ambient');
    return false;
  }
}

// Stops a pending background bell and gives the audio session back, so the
// user's music can resume.
function cancel() {
  armed = false;
  scheduledFired = false;
  scheduledEndAt = 0;
  if (audioEl) { try { audioEl.pause(); } catch (e) {} }
  release();
  setSession('ambient');
}

function didFireScheduled() { return scheduledFired; }

function test() { init(); renderBell().then(ring); }

window.Bell = { init, prepareBackground, ring, scheduleAt, cancel, didFireScheduled, test, wavBytes, renderBell };

})();
