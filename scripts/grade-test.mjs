// Parity test: shared/grade.js JS tables vs ffmpeg lutrgb output on a 256-step gray ramp. node scripts/grade-test.mjs
import { spawnSync } from 'node:child_process';
import { ffGradeFilter, gradeTables, LOOKS } from '../shared/grade.js';
const ramp = Buffer.alloc(256 * 3);
for (let i = 0; i < 256; i++) ramp[i * 3] = ramp[i * 3 + 1] = ramp[i * 3 + 2] = i;
let worst = 0;
for (const [id, look] of Object.entries(LOOKS)) {
  const flt = ffGradeFilter(look.color);
  if (!flt) continue;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '256x1', '-i', 'pipe:0', '-vf', flt, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: ramp });
  if (r.status !== 0) { console.log(id, 'FFMPEG ERROR', r.stderr.toString().slice(-400)); process.exitCode = 1; continue; }
  const t = gradeTables(look.color);
  let d = 0;
  for (let i = 0; i < 256; i++) for (const [ch, k] of [[0, 'r'], [1, 'g'], [2, 'b']]) d = Math.max(d, Math.abs(r.stdout[i * 3 + ch] - Math.round(t[k][i] * 255)));
  worst = Math.max(worst, d);
  console.log(id.padEnd(12), 'max diff', d);
}
console.log('worst', worst);
