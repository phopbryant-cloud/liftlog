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

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
