// Debug helper: build the video graph of a saved .aicut project for a window and run it with ffmpeg (HTML layers are
// replaced by a transparent still). node scripts/graph-debug.mjs <project.aicut> <t0> <t1> <out.mp4|jpg>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildVideoGraph, expandWindow, htmlClipsInWindow } from '../electron/export/graph.js';
import { normalizeProject } from '../electron/project/schema.js';

const [file, a, b, out] = process.argv.slice(2);
const p = normalizeProject(JSON.parse(fs.readFileSync(file, 'utf8')));
const [e0, e1] = expandWindow(p, Number(a), Number(b));
const W = p.settings.width, H = p.settings.height, fps = p.settings.fps;
const still = path.join(path.dirname(out), 'transparent.png');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H},format=rgba`, '-frames:v', '1', still]);
const layers = new Map(htmlClipsInWindow(p, e0, e1).map((x) => [x.clip.id, { file: still, still: true, t0: 0 }]));
const g = buildVideoGraph(p, e0, e1, { width: W, height: H, fps, htmlLayers: layers, subtitles: null, outWidth: 960, outHeight: Math.round(960 * H / W / 2) * 2 });
const gf = out + '.graph.txt';
fs.writeFileSync(gf, g.filter);
const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...g.inputs.flat(), '-/filter_complex', gf, '-map', `[${g.out}]`, ...(/\.jpe?g$/i.test(out) ? ['-frames:v', '1'] : ['-c:v', 'libx264', '-preset', 'veryfast']), out], { encoding: 'utf8' });
console.log('exit', r.status, r.stderr.slice(-2500), '\ngraph:', gf);
