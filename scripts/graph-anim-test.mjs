// Export test for clip animations / rounded corners / border / shadow (no Electron):
// node scripts/graph-anim-test.mjs <mediaDir with talk.mp4, broll.mp4, photo.png> <outDir>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildVideoGraph, expandWindow } from '../electron/export/graph.js';
import { projectDuration } from '../shared/timeline.js';
import { normalizeAnim } from '../shared/anim.js';

const [mediaDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const M = (id, file, extra) => ({ id, name: file, path: path.join(mediaDir, file), ...extra });
const base = { in: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, opacity: 1, x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false, fit: 'contain', crop: null, color: null, chromaKey: null, vignette: 0, transition: null, videoFadeIn: 0, videoFadeOut: 0, keyframes: null, radius: 0, border: null, shadow: null, anim: null };
const A = (a) => normalizeAnim(a);
const project = {
  settings: { width: 1280, height: 720, fps: 30, background: '#101018', masterVolume: 1 },
  media: [
    M('mA', 'talk.mp4', { type: 'video', duration: 12, width: 1920, height: 1080, hasAudio: true }),
    M('mB', 'broll.mp4', { type: 'video', duration: 8, width: 1920, height: 1080, hasAudio: false }),
    M('mI', 'photo.png', { type: 'image', duration: 0, width: 1600, height: 1000 }),
  ],
  tracks: [{ id: 'v1', type: 'video', name: 'V1' }, { id: 'v2', type: 'video', name: 'V2' }, { id: 'v3', type: 'video', name: 'V3' }],
  clips: [
    { ...base, id: 'c1', type: 'video', trackId: 'v1', mediaId: 'mA', start: 0, duration: 6, anim: A({ loop: { type: 'kenburns-in', amount: 1.5 } }) },
    // rounded PIP b-roll with border + shadow, pop in / slide out, cloud loop
    { ...base, id: 'c2', type: 'video', trackId: 'v2', mediaId: 'mB', start: 0.5, duration: 3, scale: 0.45, x: 300, y: -140, radius: 60, border: { width: 10, color: '#ffffff' }, shadow: { blur: 40, x: 0, y: 18, opacity: 0.6, color: '#000000' }, anim: A({ in: { type: 'pop', duration: 0.5 }, out: { type: 'slide-right', duration: 0.5 }, loop: { type: 'cloud', amount: 2 } }) },
    // living still image: inner zoom + outer cloud, blur entrance, flip exit
    { ...base, id: 'c3', type: 'image', trackId: 'v3', mediaId: 'mI', start: 3, duration: 3, scale: 0.5, x: -280, y: 100, radius: 40, anim: A({ in: { type: 'zoom-blur', duration: 0.6 }, out: { type: 'flip-h', duration: 0.5 }, loop: { type: 'living', amount: 1.5 } }) },
    // fade-scale entrance with opacity < 1 and crop
    { ...base, id: 'c4', type: 'image', trackId: 'v2', mediaId: 'mI', start: 4, duration: 2, scale: 0.3, x: 420, y: -200, opacity: 0.85, crop: { top: 0.1, right: 0.1, bottom: 0, left: 0 }, radius: 30, anim: A({ in: { type: 'glitch', duration: 0.6 }, loop: { type: 'wind', amount: 2 } }) },
  ],
  subtitles: { enabled: false, cues: [] },
};
const total = projectDuration(project);
const [e0, e1] = expandWindow(project, 0, total);
const t0 = Date.now();
const vg = buildVideoGraph(project, e0, e1, { width: 1280, height: 720, fps: 30, htmlLayers: new Map(), subtitles: null });
fs.writeFileSync(path.join(outDir, 'anim_video.txt'), vg.filter);
const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...vg.inputs.flat(), '-/filter_complex', path.join(outDir, 'anim_video.txt'), '-map', `[${vg.out}]`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', path.join(outDir, 'anim_video.mp4')], { encoding: 'utf8' });
console.log('video exit', r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`, (r.stderr || '').slice(-2000));
const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames:format=duration', '-of', 'compact', path.join(outDir, 'anim_video.mp4')], { encoding: 'utf8' });
console.log('probe', p.stdout.trim(), 'expected', total);
const times = [0.2, 0.6, 1.2, 2.4, 3.2, 3.5, 4.2, 4.6, 5.0, 5.8];
const sel = times.map((t) => `eq(n\\,${Math.round(t * 30)})`).join('+');
const s = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(outDir, 'anim_video.mp4'), '-vf', `select='${sel}',scale=480:-2,tile=5x2`, '-frames:v', '1', path.join(outDir, 'anim_sheet.jpg')], { encoding: 'utf8' });
console.log('sheet exit', s.status, s.stderr.slice(-300));
