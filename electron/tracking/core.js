// Tracking core (no Electron import): frame decoding + face detection + forward / backward NCC tracking.
// Runs in a utility process (worker.js) so the editor never freezes while a long shot is tracked.
import { spawn } from 'node:child_process';
import { NccTracker, smoothPoints, iou } from './ncc.js';
import { detect } from './haar.js';

const r4 = (x) => Math.round((Number(x) || 0) * 10000) / 10000;
export const MAX_SPAN = 600; // seconds tracked per run
export const MAX_BACKWARD = 120; // seconds decoded in memory for backward tracking

/**
 * Stream gray frames of [a, b) source seconds of `src`: onFrame(Uint8Array, index, t) (return false to stop).
 * opts: { ffmpeg, src, a, b, fps, W, H, onFrame, signal, spawnFn }
 */
export async function streamFrames({ ffmpeg, src, a, b, fps, W, H, onFrame, signal, spawnFn = spawn }) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(Math.max(0, a)), '-t', String(Math.max(0.05, b - a)), '-i', src,
    '-an', '-sn', '-vf', `fps=${fps},scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'];
  const proc = spawnFn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const size = W * H;
  let pending = Buffer.alloc(0), idx = 0, stopped = false, err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
  const abort = () => { stopped = true; try { proc.kill('SIGKILL'); } catch { /* */ } };
  signal?.addEventListener('abort', abort, { once: true });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      if (stopped) return;
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= size && !stopped) {
        const frame = new Uint8Array(pending.subarray(0, size));
        pending = pending.subarray(size);
        if (onFrame(frame, idx, a + idx / fps) === false) abort();
        idx++;
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => (stopped || code === 0 ? resolve() : reject(new Error(`frame decode failed: ${err.trim().slice(-300)}`))));
  });
  signal?.removeEventListener('abort', abort);
  if (signal?.aborted) throw new Error('Aborted');
  return idx;
}

function flipH(frame, W, H) {
  const out = new Uint8Array(frame.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = frame[y * W + W - 1 - x];
  return out;
}

/** Faces in a gray frame → [{cx, cy, w, h, score, view}] px, biggest first. cas = { front, prof } parsed cascades. */
export function facesSync(cas, frame, W, H, { profile = true, minSize } = {}) {
  const opts = { minSize: minSize || Math.max(24, Math.round(Math.min(W, H) * 0.06)), minNeighbors: 3 };
  const faces = detect(cas.front, frame, W, H, opts).map((f) => ({ cx: f.x + f.w / 2, cy: f.y + f.h / 2, w: f.w, h: f.h, score: f.n, view: 'front' }));
  if (profile && cas.prof) {
    const add = (list, view) => { for (const f of list) { const b = { cx: f.cx, cy: f.cy, w: f.w, h: f.h, score: f.n, view }; if (!faces.some((x) => iou(x, b) > 0.3)) faces.push(b); } };
    add(detect(cas.prof, frame, W, H, opts).map((f) => ({ ...f, cx: f.x + f.w / 2, cy: f.y + f.h / 2 })), 'profile-left');
    add(detect(cas.prof, flipH(frame, W, H), W, H, opts).map((f) => ({ ...f, cx: W - (f.x + f.w / 2), cy: f.y + f.h / 2 })), 'profile-right');
  }
  return faces.sort((a, b) => b.w * b.h - a.w * a.h);
}

/**
 * Track a region. o: { ffmpeg, src, W, H, fps, t0, from, to (source s), box {cx, cy, w, h} normalized, face, cas, signal, onProgress }
 * Returns points [[t, cx, cy, w, h, conf]] normalized, sorted by time.
 */
export async function trackCore(o) {
  const { W, H, fps, face, cas } = o;
  const t0 = Math.max(0, o.t0);
  const from = Math.max(0, Math.min(o.from ?? t0, t0)), to = Math.max(t0, Math.min(o.to, t0 + MAX_SPAN));
  const box0 = { cx: o.box.cx * W, cy: o.box.cy * H, w: Math.max(8, o.box.w * W), h: Math.max(8, o.box.h * H) };
  const total = Math.max(1e-3, (to - t0) + Math.min(MAX_BACKWARD, t0 - from));
  let doneSec = 0;
  const report = () => o.onProgress?.(Math.min(0.99, doneSec / total));
  const redetectEvery = Math.max(1, Math.round(fps * 0.5));

  // one pass: frames are fed one by one, synchronously (the decoder is back-pressured by the pipe)
  const makePass = () => {
    let trk = null, n = 0;
    const pts = [];
    const feed = (frame, t) => {
      if (!trk) {
        trk = new NccTracker(frame, W, H, box0);
        pts.push([t, box0.cx / W, box0.cy / H, box0.w / W, box0.h / H, 1]);
        return;
      }
      const r = trk.update(frame);
      let conf = r.lost ? 0 : Math.max(0, Math.min(1, r.score));
      if (face && cas && (n % redetectEvery === 0 || r.score < 0.5)) {
        const cur = trk.box;
        const faces = facesSync(cas, frame, W, H, { profile: r.score < 0.5, minSize: Math.max(20, Math.round(cur.w * 0.5)) });
        let best = null, bi = 0;
        for (const f of faces) { const v = iou(cur, f); if (v > bi) { bi = v; best = f; } }
        if (!best && r.lost) { // re-acquire: the closest face of a similar size
          let bd = Infinity;
          for (const f of faces) { const d = Math.hypot(f.cx - cur.cx, f.cy - cur.cy); if (d < bd && f.w > cur.w * 0.5 && f.w < cur.w * 2 && d < W * 0.25) { bd = d; best = f; } }
          if (best) bi = 0.3;
        }
        if (best && bi > 0.2) { trk.reset(frame, best, r.score < 0.5 ? 0.8 : 0.4); conf = Math.max(conf, 0.8); }
      }
      const b = trk.box;
      pts.push([t, b.cx / W, b.cy / H, b.w / W, b.h / H, conf]);
      n++;
    };
    return { feed, pts };
  };

  const fp = makePass();
  await streamFrames({ ffmpeg: o.ffmpeg, src: o.src, a: t0, b: to, fps, W, H, signal: o.signal, onFrame: (frame, i, t) => {
    fp.feed(frame, t);
    doneSec = t - t0;
    if (i % 15 === 0) report();
  } });

  let bwd = [];
  const bFrom = Math.max(from, t0 - MAX_BACKWARD);
  if (t0 - bFrom > 1 / fps) {
    const frames = [];
    await streamFrames({ ffmpeg: o.ffmpeg, src: o.src, a: bFrom, b: t0 + 0.5 / fps, fps, W, H, signal: o.signal, onFrame: (frame, i, t) => { frames.push([frame, t]); } });
    const bp = makePass();
    for (let i = frames.length - 1; i >= 0; i--) {
      if (o.signal?.aborted) throw new Error('Aborted');
      bp.feed(frames[i][0], frames[i][1]);
      frames[i][0] = null;
      doneSec = (to - t0) + (t0 - frames[i][1]);
      if (i % 15 === 0) report();
    }
    bwd = bp.pts.slice(1).reverse(); // the start frame is in the forward pass
  }
  const points = smoothPoints([...bwd, ...fwd(fp)].sort((a, b) => a[0] - b[0]));
  return points.map((p) => [r4(p[0]), r4(p[1]), r4(p[2]), r4(p[3]), r4(p[4]), Math.round((p[5] ?? 1) * 100) / 100]);
}
const fwd = (pass) => pass.pts;
