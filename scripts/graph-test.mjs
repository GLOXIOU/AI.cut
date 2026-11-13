// Headless test of the export graph builder (no Electron): node scripts/graph-test.mjs <mediaDir> <outDir>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildVideoGraph, buildAudioGraph, expandWindow } from '../electron/export/graph.js';
import { projectDuration } from '../shared/timeline.js';

const [mediaDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const M = (id, file, extra) => ({ id, name: file, path: path.join(mediaDir, file), ...extra });
const base = { in: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, opacity: 1, x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false, fit: 'contain', crop: null, color: null, chromaKey: null, vignette: 0, transition: null, videoFadeIn: 0, videoFadeOut: 0, keyframes: null };
const project = {
  settings: { width: 1280, height: 720, fps: 30, background: '#101018', masterVolume: 1 },
  media: [
    M('mA', 'clipA.mp4', { type: 'video', duration: 8, width: 1920, height: 1080, hasAudio: true }),
    M('mB', 'clipB.mp4', { type: 'video', duration: 6, width: 1280, height: 720, hasAudio: true }),
    M('mI', 'image.png', { type: 'image', duration: 0, width: 800, height: 800 }),
    M('mM', 'music.mp3', { type: 'audio', duration: 20, hasAudio: true }),
  ],
  tracks: [
    { id: 'v1', type: 'video', name: 'V1' }, { id: 'v2', type: 'video', name: 'V2' },
    { id: 'a1', type: 'audio', name: 'A1', volume: 1 },
  ],
  clips: [
    { ...base, id: 'c1', type: 'video', trackId: 'v1', mediaId: 'mA', start: 0, duration: 4, in: 1, color: { saturation: 1.6, contrast: 1.2 } },
    { ...base, id: 'c2', type: 'video', trackId: 'v1', mediaId: 'mB', start: 4, duration: 4, in: 0.5, transition: { type: 'slideleft', duration: 1 } },
    { ...base, id: 'c3', type: 'video', trackId: 'v1', mediaId: 'mA', start: 8, duration: 2, in: 5, speed: 1.5, transition: { type: 'circleopen', duration: 0.8 }, vignette: 0.7 },
    { ...base, id: 'c4', type: 'image', trackId: 'v2', mediaId: 'mI', start: 1, duration: 5, scale: 0.35, x: 380, y: -180, rotation: 8, crop: { top: 0.1, right: 0, bottom: 0, left: 0.2 },
      keyframes: { scale: [{ t: 0, v: 0.2, ease: 'ease-out' }, { t: 1, v: 0.35 }], opacity: [{ t: 0, v: 0 }, { t: 0.5, v: 1 }], x: [{ t: 0, v: 600 }, { t: 1, v: 380, ease: 'ease-in-out' }] } },
    { ...base, id: 'c5', type: 'color', trackId: 'v2', start: 7, duration: 2, fill: '#ff0066', scale: 0.25, opacity: 0.8, transition: { type: 'fade', duration: 0.5 } },
    { ...base, id: 'c6', type: 'audio', trackId: 'a1', mediaId: 'mM', start: 0, duration: 10, fadeIn: 1, fadeOut: 2, volume: 0.6 },
  ],
  subtitles: { enabled: false, cues: [] },
};
const total = projectDuration(project);
const [e0, e1] = expandWindow(project, 0, total);
const vg = buildVideoGraph(project, e0, e1, { width: 1280, height: 720, fps: 30, htmlLayers: new Map(), subtitles: null });
fs.writeFileSync(path.join(outDir, 'video.txt'), vg.filter);
let r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...vg.inputs.flat(), '-/filter_complex', path.join(outDir, 'video.txt'), '-map', `[${vg.out}]`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', path.join(outDir, 'video.mp4')], { encoding: 'utf8' });
console.log('video exit', r.status, (r.stderr || '').slice(-1500));
const ag = buildAudioGraph(project, 0, total);
fs.writeFileSync(path.join(outDir, 'audio.txt'), ag.filter);
r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...ag.inputs.flat(), '-/filter_complex', path.join(outDir, 'audio.txt'), '-map', `[${ag.out}]`, '-c:a', 'pcm_s16le', path.join(outDir, 'audio.wav')], { encoding: 'utf8' });
console.log('audio exit', r.status, (r.stderr || '').slice(-1500));
r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,nb_frames,duration', '-of', 'compact', path.join(outDir, 'video.mp4')], { encoding: 'utf8' });
console.log('video probe', r.stdout.trim());
r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'compact', path.join(outDir, 'audio.wav')], { encoding: 'utf8' });
console.log('audio probe', r.stdout.trim(), 'expected', total);
// contact sheet of frames for visual check
r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(outDir, 'video.mp4'), '-vf', "select='not(mod(n\\,15))',scale=320:-2,tile=5x4", '-frames:v', '1', path.join(outDir, 'sheet.jpg')], { encoding: 'utf8' });
console.log('sheet exit', r.status, r.stderr.slice(-300));
