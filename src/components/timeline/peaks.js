// Waveform peaks cache (Uint8 per 10 ms) fetched from the main process.
import { call } from '../../app/api.js';

const cache = new Map(); // key -> Uint8Array | Promise
const listeners = new Set();

export function getPeaks(media) {
  if (!media?.peaks) return null;
  const key = `${media.id}|${media.peaks}`;
  const v = cache.get(key);
  if (v instanceof Uint8Array) return v;
  if (!v) {
    const p = call('media:peaks', { mediaId: media.id })
      .then((arr) => { cache.set(key, arr ? new Uint8Array(arr) : new Uint8Array(0)); for (const l of listeners) l(); })
      .catch(() => cache.set(key, new Uint8Array(0)));
    cache.set(key, p);
  }
  return null;
}

export function onPeaks(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Draw a mirrored waveform for source range [t0, t1] (seconds) on a canvas. */
export function drawWave(canvas, peaks, t0, t1, color) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!peaks || !peaks.length || w <= 0) return;
  const rate = 100;
  ctx.fillStyle = color;
  const mid = h / 2;
  const span = Math.max(1e-6, t1 - t0);
  for (let x = 0; x < w; x++) {
    const a = Math.floor((t0 + (x / w) * span) * rate);
    const b = Math.max(a + 1, Math.floor((t0 + ((x + 1) / w) * span) * rate));
    let m = 0;
    for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
    const amp = (m / 255) * (h * 0.48);
    if (amp > 0.4) ctx.fillRect(x, mid - amp, 1, amp * 2);
  }
}
