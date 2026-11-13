// Visual analysis: shot/scene boundaries, frame extraction and labelled contact sheets for vision models.
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from '../media/ffmpeg.js';
import { extractFrame, videoPass } from '../media/ingest.js';
import { fileUrl, registerRenderDoc, unregisterRenderDoc } from '../media/protocol.js';
import { renderHtmlFrame } from '../render/html-renderer.js';
import { uid } from '../core/util.js';
import { fmtTime } from '../../shared/timeline.js';

/** Scene cuts using ffmpeg scene score on a downscaled stream (GPU decode when available). Returns [{start, end}] shots. */
export async function detectScenes(file, duration, workDir, { threshold = 0.32, rotation = 0, signal, onProgress } = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const scenesFile = path.join(workDir, `scenes_${uid('s', 6)}.txt`);
  const { shots } = await videoPass(file, { duration, rotation, hasAudio: false }, { scenesFile, threshold, signal, onProgress });
  return shots;
}
const round = (x) => Math.round(x * 1000) / 1000;

/** Extract frames at given times. Returns [{time, path}] */
export async function extractFrames(file, times, outDir, { width = 640, signal } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const t of times) {
    const p = path.join(outDir, `f_${Math.round(t * 1000)}_${width}.jpg`);
    if (!fs.existsSync(p)) await extractFrame(file, t, p, { width, signal });
    out.push({ time: t, path: p });
  }
  return out;
}

/** Evenly spaced times in [start, end], at the middle of each slot. */
export function sampleTimes(start, end, count) {
  const n = Math.max(1, count);
  const step = (end - start) / n;
  return Array.from({ length: n }, (_, i) => round(start + step * (i + 0.5)));
}

/**
 * Labelled contact sheet (grid of frames with timestamps) rendered by Chromium for crisp labels.
 * frames: [{time, path, label?}] → PNG/JPG file.
 */
export async function contactSheet(frames, out, { cols = 4, cellWidth = 360, title = '' } = {}) {
  if (!frames.length) throw new Error('No frames for contact sheet');
  const rows = Math.ceil(frames.length / cols);
  const cellH = Math.round(cellWidth * 9 / 16);
  const pad = 8, labelH = 26, titleH = title ? 34 : 0;
  const W = cols * cellWidth + (cols + 1) * pad;
  const H = titleH + rows * (cellH + labelH) + (rows + 1) * pad;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const cells = frames.map((f) => `<div class="c"><div class="im"><img src="${fileUrl(f.path)}"></div><div class="l">${esc(f.label || fmtTime(f.time))}</div></div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#111}body{width:${W}px;height:${H}px;font:600 15px Inter,Segoe UI,Arial,sans-serif;color:#eee}
  .t{height:${titleH}px;line-height:${titleH}px;padding:0 ${pad + 4}px;font-size:17px;color:#a5b4fc}
  .g{display:grid;grid-template-columns:repeat(${cols},${cellWidth}px);gap:${pad}px;padding:${pad}px}
  .im{width:${cellWidth}px;height:${cellH}px;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:4px}
  .im img{max-width:100%;max-height:100%}
  .l{height:${labelH}px;line-height:${labelH}px;text-align:center;color:#fde68a;font-variant-numeric:tabular-nums}
  </style><link rel="stylesheet" href="aicut://res/fonts/fonts.css"></head><body>${title ? `<div class="t">${esc(title)}</div>` : ''}<div class="g">${cells}</div>
  <script>Promise.all([...document.images].map(i=>i.complete?0:new Promise(r=>{i.onload=i.onerror=r}))).then(()=>document.fonts.ready).then(()=>{window.__aicutReady=true});
  let tag=null;window.__aicutFrame=(t,v)=>{if(!tag){tag=document.createElement('div');tag.style.cssText='position:fixed;left:0;top:${H}px;width:${W}px;height:16px';document.body.appendChild(tag)}tag.style.background='rgb('+(v&255)+','+((v>>8)&255)+',255)';return new Promise(r=>requestAnimationFrame(()=>r(true)))};</script></body></html>`;
  const token = uid('sheet', 10);
  const url = registerRenderDoc(token, html);
  try {
    const png = out.replace(/\.(jpe?g)$/i, '.png');
    await renderHtmlFrame({ url, width: W, height: H, time: 0, out: png });
    if (/\.jpe?g$/i.test(out)) {
      await runFfmpeg(['-i', png, '-q:v', '3', out], { quiet: true });
      fs.rm(png, { force: true }, () => {});
    }
    return { path: out, width: W, height: H, cols, rows };
  } finally {
    unregisterRenderDoc(token);
  }
}
