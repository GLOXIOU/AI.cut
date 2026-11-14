// Motion tracking data + "follow": clips (text, arrow callouts, images, stickers…) and adjustment-layer masks attached
// to a tracked object / face. Trackings are stored in SOURCE coordinates of a media (time in seconds of the media,
// box normalized to the media frame), so they stay valid when the clip is moved, trimmed, split or reframed.
//
//   project.trackings[] = { id, name, mediaId, kind: 'object' | 'face', points: [[t, cx, cy, w, h, conf], …] }
//   clip.follow         = { tracking, clip?, anchor?, offsetX?, offsetY?, scale? }
//   clip.mask.follow    = { tracking, clip?, anchor?, offsetX?, offsetY?, size? }
//
// bakeProject() turns every follow into plain keyframes (x / y / scale) and mask paths, evaluated once per frame and
// simplified; the preview and the export both render the baked project, so they move identically.
import { clipVisualAt, mediaById, clamp, r4 } from './timeline.js';

const ANCHOR_UV = {
  center: [0, 0], top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0],
  'top-left': [-1, -1], 'top-right': [1, -1], 'bottom-left': [-1, 1], 'bottom-right': [1, 1],
};

export function trackingById(project, id) {
  return (project.trackings || []).find((t) => t.id === id) || null;
}

/** Tracked box at source time s: { cx, cy, w, h, conf } normalized (held before the first / after the last point). */
export function trackingBoxAt(tr, s) {
  const P = tr?.points;
  if (!P?.length) return null;
  const box = (p) => ({ cx: p[1], cy: p[2], w: p[3], h: p[4], conf: p[5] ?? 1 });
  if (s <= P[0][0]) return { ...box(P[0]), outside: s < P[0][0] - 0.05 };
  const last = P[P.length - 1];
  if (s >= last[0]) return { ...box(last), outside: s > last[0] + 0.05 };
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid][0] <= s) lo = mid; else hi = mid; }
  const a = P[lo], b = P[hi];
  const k = (s - a[0]) / Math.max(1e-9, b[0] - a[0]);
  return { cx: a[1] + (b[1] - a[1]) * k, cy: a[2] + (b[2] - a[2]) * k, w: a[3] + (b[3] - a[3]) * k, h: a[4] + (b[4] - a[4]) * k, conf: Math.min(a[5] ?? 1, b[5] ?? 1) };
}

/** Source-time range covered by a tracking. */
export function trackingRange(tr) {
  const P = tr?.points;
  return P?.length ? [P[0][0], P[P.length - 1][0]] : null;
}

/** Frame px of a point (u, v normalized in the media) of a clip at clip-local time. */
export function mediaPointToFrame(clip, media, W, H, local, u, v) {
  const g = clipVisualAt(clip, media, W, H, clamp(local, 0, clip.duration));
  let px = (u - 0.5) * g.w, py = (v - 0.5) * g.h;
  if (g.z && g.z !== 1) { px *= g.z; py *= g.z; }
  if (g.pu) px += g.pu * g.w;
  if (g.pv) py += g.pv * g.h;
  if (clip.flipH) px = -px;
  if (clip.flipV) py = -py;
  const r = ((g.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: g.cx + px * c - py * s, y: g.cy + px * s + py * c, scaleW: g.w * (g.z || 1), scaleH: g.h * (g.z || 1) };
}

/** Timeline clip that shows the tracked media at timeline time T (the referenced clip first, then any clip of that media). */
function targetAt(project, tr, prefId, T) {
  const covers = (c) => c && c.mediaId === tr.mediaId && T >= c.start - 1e-4 && T < c.start + c.duration + 1e-4;
  const pref = prefId ? project.clips.find((c) => c.id === prefId) : null;
  if (covers(pref)) return pref;
  let best = null;
  for (const c of project.clips) {
    if (!covers(c) || c.type !== 'video') continue;
    if (!best || (pref && c.trackId === pref.trackId && best.trackId !== pref.trackId)) best = c;
  }
  return best;
}

/** Where the followed point is at timeline time T: { x, y, bw, bh } in frame px (bw / bh = tracked box size), or null. */
export function followPointAt(project, follow, T, W, H) {
  const tr = trackingById(project, follow.tracking);
  if (!tr) return null;
  const tgt = targetAt(project, tr, follow.clip, T);
  if (!tgt) return null;
  const media = mediaById(project, tgt.mediaId);
  const local = T - tgt.start;
  const s = (tgt.in || 0) + local * (tgt.speed || 1);
  const b = trackingBoxAt(tr, s);
  if (!b) return null;
  const [ax, ay] = ANCHOR_UV[follow.anchor] || ANCHOR_UV.center;
  const p = mediaPointToFrame(tgt, media, W, H, local, b.cx + (ax * b.w) / 2, b.cy + (ay * b.h) / 2);
  return { x: p.x + (Number(follow.offsetX) || 0), y: p.y + (Number(follow.offsetY) || 0), bw: b.w * p.scaleW, bh: b.h * p.scaleH, outside: b.outside };
}

/** Ramer–Douglas–Peucker on samples [{t, …keys}] for the listed keys with per-key tolerances. */
function simplify(samples, keys, tol) {
  if (samples.length <= 2) return samples;
  const keep = new Uint8Array(samples.length);
  keep[0] = keep[samples.length - 1] = 1;
  const stack = [[0, samples.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, wi = -1;
    const A = samples[a], B = samples[b];
    for (let i = a + 1; i < b; i++) {
      const k = (samples[i].t - A.t) / Math.max(1e-9, B.t - A.t);
      let e = 0;
      for (const key of keys) e = Math.max(e, Math.abs(samples[i][key] - (A[key] + (B[key] - A[key]) * k)) / tol[key]);
      if (e > worst) { worst = e; wi = i; }
    }
    if (worst > 1 && wi > 0) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return samples.filter((_, i) => keep[i]);
}

function sampleTimes(duration, fps) {
  const step = 1 / Math.max(1, Math.min(60, fps || 30));
  const n = Math.min(20000, Math.max(1, Math.ceil(duration / step)));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(Math.min(duration, i * step));
  return out;
}

/** Baked copy of a following clip: keyframes x / y (+ scale) replacing its own. */
export function bakeFollow(project, clip, W, H) {
  const f = clip.follow;
  const fps = project.settings?.fps || 30;
  const samples = [];
  let ref = null;
  for (const lt of sampleTimes(clip.duration, fps)) {
    const p = followPointAt(project, f, clip.start + lt, W, H);
    if (!p) continue;
    if (!ref) ref = p;
    samples.push({ t: r4(lt), x: p.x - W / 2, y: p.y - H / 2, s: (clip.scale ?? 1) * (ref.bw > 0 ? p.bw / ref.bw : 1) });
  }
  if (!samples.length) return clip;
  const keys = f.scale ? ['x', 'y', 's'] : ['x', 'y'];
  const kept = simplify(samples, keys, { x: 0.5, y: 0.5, s: 0.002 });
  const kf = { ...(clip.keyframes || {}) };
  kf.x = kept.map((p) => ({ t: p.t, v: Math.round(p.x * 100) / 100 }));
  kf.y = kept.map((p) => ({ t: p.t, v: Math.round(p.y * 100) / 100 }));
  if (f.scale) kf.scale = kept.map((p) => ({ t: p.t, v: Math.round(p.s * 10000) / 10000 }));
  return { ...clip, x: kf.x[0].v, y: kf.y[0].v, keyframes: kf };
}

/** Baked copy of a mask that follows a tracking: mask._path = [{t, x, y, (w, h)}] in frame px. */
export function bakeMask(project, clip, W, H) {
  const m = clip.mask;
  const f = m.follow;
  const fps = project.settings?.fps || 30;
  const samples = [];
  let ref = null;
  for (const lt of sampleTimes(clip.duration, fps)) {
    const p = followPointAt(project, f, clip.start + lt, W, H);
    if (!p) continue;
    if (!ref) ref = p;
    const o = { t: r4(lt), x: p.x, y: p.y };
    if (f.size) { o.w = (m.w * W) * (ref.bw > 0 ? p.bw / ref.bw : 1); o.h = (m.h * H) * (ref.bh > 0 ? p.bh / ref.bh : 1); }
    samples.push(o);
  }
  if (!samples.length) return clip;
  const keys = f.size ? ['x', 'y', 'w', 'h'] : ['x', 'y'];
  const path = simplify(samples, keys, { x: 0.5, y: 0.5, w: 1, h: 1 }).map((p) => {
    const o = { t: p.t, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
    if (p.w != null) { o.w = Math.round(p.w * 100) / 100; o.h = Math.round(p.h * 100) / 100; }
    return o;
  });
  return { ...clip, mask: { ...m, _path: path } };
}

/** Project copy where every follow is baked (no-op copy-free when nothing follows a tracking). */
export function bakeProject(project) {
  if (!project?.trackings?.length || !project.clips.some((c) => c.follow || c.mask?.follow)) return project;
  const W = project.settings.width, H = project.settings.height;
  const clips = project.clips.map((c) => {
    let o = c;
    if (c.follow && trackingById(project, c.follow.tracking)) o = bakeFollow(project, o, W, H);
    if (c.mask?.follow && trackingById(project, c.mask.follow.tracking)) o = bakeMask(project, o, W, H);
    return o;
  });
  return { ...project, clips };
}

/** Compact tracking summary for the AI / UI. */
export function trackingInfo(tr) {
  const r = trackingRange(tr);
  const P = tr.points || [];
  const lost = P.filter((p) => (p[5] ?? 1) < 0.35).length;
  return { id: tr.id, name: tr.name, kind: tr.kind, mediaId: tr.mediaId, from: r ? r4(r[0]) : null, to: r ? r4(r[1]) : null, points: P.length, lowConfidence: lost };
}
