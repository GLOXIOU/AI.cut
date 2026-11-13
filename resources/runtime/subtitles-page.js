// Offscreen subtitle renderer page (export). Uses the exact same drawing code as the preview player.
import { drawSubtitles, subtitleSignature, subtitleFontSpecs, subtitleBand } from 'aicut://shared/subtitles.js';

const cfg = window.AICUT_SUBS || { cues: [], style: {}, width: 1920, height: 1080, fps: 30 };
const { cues, style, width: W, height: H } = cfg;
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const cache = new Map();
const TAG = 16;
let band = { y: 0, h: H };

function sizeCanvas() {
  canvas.width = W;
  canvas.height = band.h + TAG;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${band.h + TAG}px`;
}

async function init() {
  try { await Promise.all(subtitleFontSpecs(style).map((s) => document.fonts.load(s))); } catch (e) { /* ignore */ }
  try { await document.fonts.ready; } catch (e) { /* ignore */ }
  band = subtitleBand(ctx, cues, style, W, H);
  sizeCanvas();
  window.__aicutBand = band;
  window.__aicutReady = true;
}

window.__aicutSignatures = (t0, count, fps) => {
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = subtitleSignature(cues, style, t0 + i / fps, fps);
  return out;
};

window.__aicutFrame = (t, tag) => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.translate(0, -band.y);
  drawSubtitles(ctx, cues, style, t, W, H, cache);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (tag != null) {
    ctx.fillStyle = `rgb(${tag & 255},${(tag >> 8) & 255},255)`;
    ctx.fillRect(0, band.h, W, TAG);
  }
  return new Promise((r) => requestAnimationFrame(() => r(true)));
};

init();
