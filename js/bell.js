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
    .then((b) => { buffer = b; rendering = null; return b; })
    .catch(() => { rendering = null; return null; });
  return rendering;
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

window.Bell = { wavBytes, renderBell };

})();
