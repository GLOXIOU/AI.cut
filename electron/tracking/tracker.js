// Tracking service (main process): face detection on single frames, tracking jobs run in a utility process
// (worker.js → core.js), results stored in project.trackings (source coordinates, see shared/follow.js).
import fs from 'node:fs';
import path from 'node:path';
import { utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { requireFfmpeg } from '../media/ffmpeg.js';
import { spawnTracked } from '../core/proc.js';
import { modelsDir } from '../core/paths.js';
import { download, exists, uid } from '../core/util.js';
import { log } from '../core/log.js';
import { store } from '../project/store.js';
import { jobs } from '../core/jobs.js';
import { parseCascade } from './haar.js';
import { streamFrames, facesSync, MAX_SPAN } from './core.js';
import { clipById, mediaById, r4 } from '../../shared/timeline.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function mediaDims(m) {
  const w = m.width || 1920, h = m.height || 1080;
  const rot = Math.abs(m.rotation || 0) % 180 === 90;
  return rot ? [h, w] : [w, h];
}

/** Analysis size for a media (even, ~aw wide, same aspect as the media). */
function analysisSize(m, aw) {
  const [w, h] = mediaDims(m);
  const W = Math.min(aw, w);
  const H = Math.max(2, Math.round((W * h) / w / 2) * 2);
  return [W, H];
}
const srcOf = (m) => (m.proxy && exists(m.proxy) ? m.proxy : m.path);

/** One gray frame at source time t. */
export async function grabFrame(m, t, aw = 640) {
  const [W, H] = analysisSize(m, aw);
  let out = null;
  await streamFrames({ ffmpeg: requireFfmpeg(), src: srcOf(m), a: Math.max(0, t), b: t + 0.5, fps: 30, W, H, spawnFn: spawnTracked, onFrame: (f) => { out = f; return false; } });
  if (!out) throw new Error(`No frame at ${t}s`);
  return { frame: out, W, H };
}

// ------------------------------------------------------------------------------------------- faces
const CASCADES = {
  frontal: 'https://raw.githubusercontent.com/opencv/opencv/4.x/data/haarcascades/haarcascade_frontalface_default.xml',
  profile: 'https://raw.githubusercontent.com/opencv/opencv/4.x/data/haarcascades/haarcascade_profileface.xml',
};
/** Local path of a cascade (downloaded from the OpenCV repository on first use). */
async function cascadeFile(kind) {
  const file = path.join(modelsDir(), `haarcascade_${kind}.xml`);
  if (!exists(file) || fs.statSync(file).size < 10000) {
    log.info('downloading face cascade', kind);
    await download(CASCADES[kind], `${file}.part`);
    fs.renameSync(`${file}.part`, file);
  }
  return file;
}
const parsed = new Map();
async function loadCascades() {
  const get = async (kind) => {
    if (!parsed.has(kind)) parsed.set(kind, parseCascade(fs.readFileSync(await cascadeFile(kind), 'utf8')));
    return parsed.get(kind);
  };
  const front = await get('frontal');
  let prof = null;
  try { prof = await get('profile'); } catch (e) { log.warn('profile cascade unavailable', e.message); }
  return { front, prof };
}

/** Faces of a media at source time t, normalized to the frame (top-left x/y + centre). */
export async function detectFaces(m, t) {
  const { frame, W, H } = await grabFrame(m, t, 640);
  const faces = facesSync(await loadCascades(), frame, W, H);
  return faces.map((f, i) => ({
    index: i, x: r4((f.cx - f.w / 2) / W), y: r4((f.cy - f.h / 2) / H), w: r4(f.w / W), h: r4(f.h / H), cx: r4(f.cx / W), cy: r4(f.cy / H), view: f.view, strength: f.score,
  }));
}

// ------------------------------------------------------------------------------------------- worker
let worker = null;
const pendingRuns = new Map();
function getWorker() {
  if (worker) return worker;
  worker = utilityProcess.fork(path.join(here, 'worker.js'), [], { serviceName: 'AI.cut tracking', stdio: 'pipe' });
  worker.stderr?.on('data', (d) => log.warn('[tracking worker]', String(d).trim().slice(0, 500)));
  worker.on('message', (msg) => {
    const run = pendingRuns.get(msg.id);
    if (!run) return;
    if (msg.type === 'progress') run.onProgress?.(msg.p);
    else if (msg.type === 'result') { pendingRuns.delete(msg.id); run.resolve(msg.points); }
    else if (msg.type === 'error') { pendingRuns.delete(msg.id); run.reject(new Error(msg.message)); }
  });
  worker.on('exit', () => {
    worker = null;
    for (const [id, run] of pendingRuns) { pendingRuns.delete(id); run.reject(new Error('tracking worker stopped')); }
  });
  return worker;
}
export function stopTrackingWorker() { try { worker?.kill(); } catch { /* */ } worker = null; }

/**
 * Track a region of a media in the worker. opts: { media, time (source s), box {cx, cy, w, h} normalized, from, to,
 *   face, signal, onProgress } → points [[t, cx, cy, w, h, conf]]
 */
export async function trackMedia(opts) {
  const m = opts.media;
  const face = !!opts.face;
  const [W, H] = analysisSize(m, face ? 640 : 512);
  const fps = Math.min(30, Math.max(5, Math.round(opts.fps || m.fps || 30)));
  const dur = m.duration || opts.time + 1;
  const cascades = face ? { front: await cascadeFile('frontal'), profile: await cascadeFile('profile').catch(() => null) } : null;
  const id = uid('trk', 8);
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pendingRuns.set(id, { resolve, reject, onProgress: opts.onProgress });
    opts.signal?.addEventListener('abort', () => w.postMessage({ type: 'cancel', id }), { once: true });
    w.postMessage({ type: 'track', id, opts: {
      ffmpeg: requireFfmpeg(), src: srcOf(m), W, H, fps, t0: opts.time, from: Math.max(0, opts.from ?? opts.time), to: Math.min(dur, opts.to ?? dur, opts.time + MAX_SPAN),
      box: opts.box, face, cascades,
    } });
  });
}

// ------------------------------------------------------------------------------------------- job API
/**
 * Start a tracking job. a: { clipId | mediaId, time (timeline s if clipId, else source s), box {x, y, w, h} normalized
 *   (top-left) or {cx, cy, w, h}, face?: bool | faceIndex?: n | near?: {x, y}, name?, from?, to? (timeline s with clipId) }
 * With face mode and no box, the face is detected automatically (biggest, or faceIndex, or nearest to `near`).
 */
export function startTracking(a, meta = {}) {
  const p = store.requireOpen();
  let m, clip = null, srcTime, srcFrom, srcTo;
  const fixOf = a.fix ? (p.trackings || []).find((x) => x.id === a.fix) : null;
  if (a.fix && !fixOf) throw new Error(`Unknown tracking ${a.fix}`);
  if (a.clipId) {
    clip = clipById(p, a.clipId);
    if (!clip) throw new Error(`Unknown clip ${a.clipId}`);
    if (clip.type !== 'video') throw new Error('Tracking works on video clips.');
    m = mediaById(p, clip.mediaId);
    const toSrc = (T) => clip.in + (Math.min(clip.start + clip.duration, Math.max(clip.start, T)) - clip.start) * clip.speed;
    srcTime = toSrc(a.time ?? clip.start);
    srcFrom = toSrc(a.from ?? clip.start);
    srcTo = toSrc(a.to ?? clip.start + clip.duration);
  } else {
    m = mediaById(p, a.mediaId);
    if (!m) throw new Error(`Unknown media ${a.mediaId}`);
    if (m.type !== 'video') throw new Error('Tracking works on videos.');
    srcTime = a.time ?? 0;
    srcFrom = a.from ?? 0;
    srcTo = a.to ?? m.duration;
  }
  if (!m?.path) throw new Error('Media file missing');
  const face = !!(a.face || a.faceIndex != null || a.near) || (fixOf?.kind === 'face' && !a.box);
  let box = a.box ? normBox(a.box) : null;
  if (fixOf) {
    // correction: re-track between the neighbouring anchors (the user's previous boxes), keep the rest
    if (fixOf.mediaId !== m.id) throw new Error('This tracking belongs to another media.');
    if (!box) throw new Error('A correction needs the right box at that time.');
    const P = fixOf.points;
    const anchors = [...(fixOf.anchors || (fixOf.source?.time != null ? [{ t: fixOf.source.time }] : []))].sort((x, y) => x.t - y.t);
    const prev = anchors.filter((x) => x.t < srcTime - 0.05).pop(), next = anchors.find((x) => x.t > srcTime + 0.05);
    srcFrom = prev ? prev.t : Math.min(P[0][0], srcTime);
    srcTo = next ? next.t : Math.max(P[P.length - 1][0], srcTime);
  }
  if (!box && !face) throw new Error('Give a box {x, y, w, h} (normalized 0–1, top-left) or face: true.');
  const job = jobs.create('tracking', `Suivi ${a.name || (face ? 'visage' : 'objet')}`, async ({ progress, signal }) => {
    progress(0.01, 'frames');
    if (!box) {
      const faces = await detectFaces(m, srcTime);
      if (!faces.length) throw new Error(`No face found at ${r4(srcTime)}s of ${m.name}. Pass a box instead (look at the frame with view_media_frames / render_frames).`);
      let f = faces[Math.min(faces.length - 1, Math.max(0, a.faceIndex || 0))];
      if (a.near) f = faces.reduce((b, x) => (Math.hypot(x.cx - a.near.x, x.cy - a.near.y) < Math.hypot(b.cx - a.near.x, b.cy - a.near.y) ? x : b), faces[0]);
      box = { cx: f.cx, cy: f.cy, w: f.w, h: f.h };
    }
    const t1 = Date.now();
    const points = await trackMedia({ media: m, time: srcTime, box, from: srcFrom, to: srcTo, face, signal, onProgress: (r) => progress(0.02 + 0.96 * r, 'tracking') });
    if (fixOf) {
      const cur = store.project.trackings.find((x) => x.id === fixOf.id);
      if (!cur) throw new Error('The tracking was deleted meanwhile.');
      const a0 = points[0][0] - 1e-3, a1 = points[points.length - 1][0] + 1e-3;
      const merged = [...cur.points.filter((pt) => pt[0] < a0 || pt[0] > a1), ...points].sort((x, y) => x[0] - y[0]);
      const anchors = [...(cur.anchors || (cur.source?.time != null ? [{ t: cur.source.time, box: cur.source.box }] : [])).filter((x) => Math.abs(x.t - srcTime) > 0.05), { t: r4(srcTime), box }];
      store.apply('updateTracking', { id: cur.id, points: merged, anchors }, { ...meta, label: `fix tracking ${cur.name}` });
      return { trackingId: cur.id, name: cur.name, fixed: true, from: r4(points[0][0]), to: r4(points[points.length - 1][0]), points: merged.length };
    }
    const name = a.name || (face ? 'Visage' : 'Objet');
    const res = store.apply('addTracking', { tracking: { id: a.id, name, mediaId: m.id, kind: face ? 'face' : 'object', points, source: { clipId: clip?.id || null, time: r4(srcTime), box }, anchors: [{ t: r4(srcTime), box }] } }, { ...meta, label: `tracking ${name}` });
    const low = points.filter((x) => x[5] < 0.35).length;
    log.info(`tracking ${name}: ${points.length} points in ${((Date.now() - t1) / 1000).toFixed(1)}s, ${low} low-confidence`);
    return { trackingId: res.result.id, name, points: points.length, from: points[0]?.[0], to: points[points.length - 1]?.[0], lowConfidence: low, clipId: clip?.id || null, mediaId: m.id };
  }, { queue: 'analysis', meta: { kind: 'tracking' } });
  return job;
}

function normBox(b) {
  const w = Number(b.w ?? b.width), h = Number(b.h ?? b.height);
  if (!(w > 0) || !(h > 0)) throw new Error('box needs w and h > 0 (normalized)');
  if (b.cx != null && b.cy != null) return { cx: Number(b.cx), cy: Number(b.cy), w, h };
  return { cx: Number(b.x) + w / 2, cy: Number(b.y) + h / 2, w, h };
}
