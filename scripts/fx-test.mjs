// Export test of the effects added on 2026-11-13 (grade, adjustment layers + masks, tracking follow, audio DSP).
// Runs under Electron (the audio mixer uses the app's ffmpeg helpers):  npx electron scripts/fx-test.mjs <outDir>
import { app } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildVideoGraph, expandWindow } from '../electron/export/graph.js';
import { renderAudioMix } from '../electron/export/audio-mix.js';
import { normalizeProject, makeClip } from '../electron/project/schema.js';
import { projectDuration } from '../shared/timeline.js';
import { LOOKS } from '../shared/grade.js';

app.on('window-all-closed', () => {});
const outDir = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('.mjs')) || 'fx-test-out');
fs.mkdirSync(outDir, { recursive: true });
const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });

async function main() {
  const vid = path.join(outDir, 'src.mp4'), music = path.join(outDir, 'music.wav');
  if (!fs.existsSync(vid)) ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vid]);
  if (!fs.existsSync(music)) ff(['-f', 'lavfi', '-i', 'sine=f=220:d=3,volume=0.5', music]);
  const tracking = { id: 'trk1', name: 'test', mediaId: 'mV', kind: 'object', points: [] };
  for (let i = 0; i <= 80; i++) tracking.points.push([i / 10, 0.2 + 0.6 * (i / 80), 0.5 + 0.2 * Math.sin(i / 8), 0.15, 0.2, 1]);
  const p = normalizeProject({
    settings: { width: 1280, height: 720, fps: 30, background: '#000000' },
    media: [
      { id: 'mV', name: 'src.mp4', type: 'video', path: vid, duration: 8, width: 1280, height: 720, hasAudio: true, fps: 30 },
      { id: 'mM', name: 'music.wav', type: 'audio', path: music, duration: 3, hasAudio: true },
    ],
    tracks: [
      { id: 'v1', type: 'video', name: 'V1' }, { id: 'v2', type: 'video', name: 'V2' }, { id: 'v3', type: 'video', name: 'V3' }, { id: 'v4', type: 'video', name: 'V4' },
      { id: 'a1', type: 'audio', name: 'A1', afx: [{ type: 'echo', delay: 250, feedback: 0.4, mix: 0.4 }], pan: -0.5 },
    ],
    clips: [
      makeClip({ id: 'c1', type: 'video', trackId: 'v1', mediaId: 'mV', start: 0, duration: 8, color: { ...LOOKS['teal-orange'].color }, afx: [{ type: 'pitch', semitones: 5 }] }),
      makeClip({ id: 'adj1', type: 'adjust', trackId: 'v2', start: 1, duration: 2, fx: { blur: 14 }, mask: { shape: 'ellipse', cx: 0.5, cy: 0.5, w: 0.4, h: 0.5, feather: 40 } }),
      makeClip({ id: 'adj2', type: 'adjust', trackId: 'v2', start: 4, duration: 3, fx: { pixelate: 24 }, mask: { shape: 'rect', cx: 0.5, cy: 0.5, w: 0.2, h: 0.25, feather: 8, follow: { tracking: 'trk1', clip: 'c1' } } }),
      makeClip({ id: 'adj3', type: 'adjust', trackId: 'v3', start: 6, duration: 2, color: { brightness: 0.35 }, mask: { shape: 'ellipse', cx: 0.3, cy: 0.5, w: 0.25, h: 0.4, feather: 30, invert: true } }),
      makeClip({ id: 'col', type: 'color', trackId: 'v4', start: 4, duration: 4, fill: '#ff2266', scale: 0.08, follow: { tracking: 'trk1', clip: 'c1', anchor: 'top', offsetY: -40 } }),
      makeClip({ id: 'm1', type: 'audio', trackId: 'a1', mediaId: 'mM', start: 1, duration: 2, afx: [{ type: 'reverb', size: 0.8, mix: 0.4 }] }),
    ],
    trackings: [tracking],
  });
  const total = projectDuration(p);
  const [e0, e1] = expandWindow(p, 0, total);
  const g = buildVideoGraph(p, e0, e1, { width: 1280, height: 720, fps: 30, htmlLayers: new Map(), subtitles: null });
  fs.writeFileSync(path.join(outDir, 'video.txt'), g.filter);
  let r = ff([...g.inputs.flat(), '-/filter_complex', path.join(outDir, 'video.txt'), '-map', `[${g.out}]`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', path.join(outDir, 'video.mp4')]);
  console.log('video exit', r.status, (r.stderr || '').slice(-1500));
  r = ff(['-i', path.join(outDir, 'video.mp4'), '-vf', "select='not(mod(n\\,20))',scale=320:-2,tile=4x3", '-frames:v', '1', path.join(outDir, 'sheet.jpg')]);
  const a = await renderAudioMix(p, 0, total, path.join(outDir, 'audio.wav'), {});
  console.log('audio', JSON.stringify(a));
  r = spawnSync('ffmpeg', ['-hide_banner', '-i', path.join(outDir, 'audio.wav'), '-af', 'astats=metadata=0:reset=0,ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /Overall[\s\S]*?Peak level dB:\s*(-?[\d.]+)/.exec(r.stderr);
  console.log('audio peak dB', m?.[1]);
  for (const [t0, t1] of [[0, 1], [1, 3], [3, 4.5], [7, 8]]) {
    const rr = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(t0), '-t', String(t1 - t0), '-i', path.join(outDir, 'audio.wav'), '-af', 'astats=metadata=0', '-f', 'null', '-'], { encoding: 'utf8' });
    const ch = [...rr.stderr.matchAll(/RMS level dB:\s*(-?[\d.inf]+)/g)].map((x) => x[1]);
    console.log(`rms ${t0}-${t1}s L/R/all`, ch.join(' / '));
  }
}

app.whenReady().then(main).catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => app.exit(process.exitCode || 0));
