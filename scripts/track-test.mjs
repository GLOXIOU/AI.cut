// Tracking test (plain Node): node scripts/track-test.mjs <video> <t0> <cx> <cy> <w> <h> <outDir> [face] [cascadeDir]
// Tracks the box from t0 to t0+6 s (and back 3 s) and writes a contact sheet with the tracked boxes drawn.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackCore } from '../electron/tracking/core.js';
import { parseCascade } from '../electron/tracking/haar.js';

const [video, t0s, cx, cy, w, h, outDir, faceArg, casDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const t0 = Number(t0s);
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video], { encoding: 'utf8' }).stdout.trim().split(',').map(Number);
const W = 512, H = Math.round((W * probe[1]) / probe[0] / 2) * 2;
const face = faceArg === 'face';
const cas = face ? { front: parseCascade(fs.readFileSync(path.join(casDir, 'haar_front.xml'), 'utf8')), prof: null } : null;
const started = Date.now();
const pts = await trackCore({ ffmpeg: 'ffmpeg', src: video, W, H, fps: 30, t0, from: Math.max(0, t0 - 3), to: t0 + 6, box: { cx: +cx, cy: +cy, w: +w, h: +h }, face, cas, onProgress: () => {} });
console.log(`points ${pts.length} in ${Date.now() - started} ms, low conf ${pts.filter((p) => p[5] < 0.35).length}`);
console.log('first', JSON.stringify(pts[0]), 'mid', JSON.stringify(pts[Math.floor(pts.length / 2)]), 'last', JSON.stringify(pts[pts.length - 1]));
// contact sheet: 12 frames with the box
const times = Array.from({ length: 12 }, (_, i) => pts[0][0] + ((pts[pts.length - 1][0] - pts[0][0]) * i) / 11);
const tiles = [];
times.forEach((t, i) => {
  const p = pts.reduce((b, x) => (Math.abs(x[0] - t) < Math.abs(b[0] - t) ? x : b), pts[0]);
  const out = path.join(outDir, `t${i}.jpg`);
  const bx = Math.round((p[1] - p[3] / 2) * 480), by = Math.round((p[2] - p[4] / 2) * (480 * H / W)), bw = Math.round(p[3] * 480), bh = Math.round(p[4] * (480 * H / W));
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, p[0] - 0.05)), '-i', video, '-frames:v', '1', '-vf', `scale=480:-2,drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=red:t=3,drawtext=text='${p[0].toFixed(2)} c${p[5]}':x=5:y=5:fontcolor=yellow:fontsize=18`, out]);
  tiles.push(out);
});
spawnSync('ffmpeg', ['-v', 'error', '-y', ...tiles.flatMap((f) => ['-i', f]), '-filter_complex', `${tiles.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=12:layout=0_0|w0_0|w0+w1_0|w0+w1+w2_0|0_h0|w0_h0|w0+w1_h0|w0+w1+w2_h0|0_h0+h4|w0_h0+h4|w0+w1_h0+h4|w0+w1+w2_h0+h4`, path.join(outDir, 'track_sheet.jpg')]);
console.log('sheet', path.join(outDir, 'track_sheet.jpg'));
