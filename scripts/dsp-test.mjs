// Smoke test of shared/dsp.js: every effect on a 1 s stereo tone + 2 s of silence (peak, tail, NaN, speed).
// node scripts/dsp-test.mjs
import { AfxChain, AFX, AFX_PRESETS, normalizeAfx, expandAfx } from '../shared/dsp.js';

const SR = 48000, N = SR * 3;
let bad = 0;
for (const type of Object.keys(AFX)) {
  const ch = new AfxChain(normalizeAfx([{ type }]), SR);
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let i = 0; i < SR; i++) { L[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR); R[i] = 0.5 * Math.sin(2 * Math.PI * 330 * i / SR); }
  const t0 = performance.now();
  for (let p = 0; p < N; p += 128) ch.process(L.subarray(p, p + 128), R.subarray(p, p + 128), Math.min(128, N - p));
  const ms = performance.now() - t0;
  let peak = 0, peakTail = 0, nan = 0, rms = 0;
  for (let i = 0; i < N; i++) {
    const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (!(v === v)) nan++;
    peak = Math.max(peak, v);
    if (i < SR) rms += L[i] * L[i];
    if (i > SR * 1.5) peakTail = Math.max(peakTail, v);
  }
  rms = Math.sqrt(rms / SR);
  if (nan || peak > 4 || peak < 0.01) bad++;
  console.log(type.padEnd(11), 'peak', peak.toFixed(3), 'rms', rms.toFixed(3), 'tail', peakTail.toFixed(4), 'nan', nan, `${(ms / 3).toFixed(1)} ms per s`, 'tailSec', ch.tail.toFixed(2));
}
for (const id of Object.keys(AFX_PRESETS)) if (!normalizeAfx(expandAfx([id]))) { console.log('bad preset', id); bad++; }
console.log(bad ? `${bad} problem(s)` : 'all effects OK');
process.exitCode = bad ? 1 : 0;
