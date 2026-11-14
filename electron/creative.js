// Creative services built on trackings, adjustment layers and requests (UI + MCP share them).
import { store } from './project/store.js';
import fs from 'node:fs';
import path from 'node:path';
import { startTracking, detectFaces } from './tracking/tracker.js';
import { jobs } from './core/jobs.js';
import { runFfmpeg } from './media/ffmpeg.js';
import { importPaths, waitForProbe } from './media/service.js';
import { trackingById, trackingRange, followPointAt, trackingInfo } from '../shared/follow.js';
import { clipById, mediaById, r4, clipGeometry } from '../shared/timeline.js';
import { requestContext } from './ai/proposals.js';
import * as copilot from './ai/copilot.js';
import { tr } from './core/settings.js';
import { bus } from './core/bus.js';

const fail = (m) => { throw new Error(m); };

export function trackObject(a, meta = {}) { return startTracking(a, meta); }

/** Faces at a time: clipId + timeline time, or mediaId + source time. */
export async function facesAt({ clipId, mediaId, time }) {
  const p = store.requireOpen();
  let m, s = time ?? 0;
  if (clipId) {
    const c = clipById(p, clipId);
    if (!c) fail(`Unknown clip ${clipId}`);
    m = mediaById(p, c.mediaId);
    s = c.in + (Math.min(c.start + c.duration, Math.max(c.start, time ?? c.start)) - c.start) * c.speed;
  } else m = mediaById(p, mediaId);
  if (!m || m.type !== 'video') fail('Need a video clip or video media');
  return { mediaId: m.id, sourceTime: r4(s), faces: await detectFaces(m, s) };
}

/** Timeline intervals where a tracking is visible: [{clipId, start, end}] (start/end = timeline seconds). */
export function trackingSpans(p, tr) {
  const range = trackingRange(tr);
  if (!range) return [];
  const out = [];
  for (const c of p.clips) {
    if (c.mediaId !== tr.mediaId || c.type !== 'video') continue;
    const s0 = c.in, s1 = c.in + c.duration * c.speed;
    const a = Math.max(s0, range[0]), b = Math.min(s1, range[1]);
    if (b - a < 0.05) continue;
    out.push({ clipId: c.id, start: r4(c.start + (a - c.in) / c.speed), end: r4(c.start + (b - c.in) / c.speed) });
  }
  const pref = tr.source?.clipId;
  return out.sort((x, y) => (x.clipId === pref ? -1 : y.clipId === pref ? 1 : x.start - y.start));
}

function needTracking(p, id) {
  const tr = trackingById(p, id);
  if (!tr) fail(`Unknown tracking ${id}. list_trackings shows them.`);
  return tr;
}

/** Default timing of something attached to a tracking: the first (or referenced) visible span. */
function spanFor(p, tr, a) {
  const spans = trackingSpans(p, tr);
  if (!spans.length) fail(`Tracking "${tr.name}" is not visible on the timeline (no clip of its media covers the tracked range).`);
  const sp = (a.clipId && spans.find((x) => x.clipId === a.clipId)) || spans[0];
  const start = a.start ?? sp.start;
  const end = a.end ?? (a.duration != null ? start + a.duration : sp.end);
  return { clipId: sp.clipId, start: r4(start), duration: r4(Math.max(0.1, end - start)) };
}

/**
 * Attach existing clips, or a new element, to a tracking. a: { tracking, clipIds?, anchor?, offsetX?, offsetY?, scale?,
 *   label? (adds a track-label), template? + params?, mediaId? (image / video / sticker media), start?, end?, duration? }
 */
export function attachToTracking(a, meta = {}) {
  const p = store.requireOpen();
  const tr = needTracking(p, a.tracking);
  const follow = { tracking: tr.id, ...(a.anchor ? { anchor: a.anchor } : {}), ...(a.offsetX ? { offsetX: a.offsetX } : {}), ...(a.offsetY ? { offsetY: a.offsetY } : {}), ...(a.scale ? { scale: true } : {}) };
  if (a.clipIds?.length) {
    const sp = trackingSpans(p, tr)[0];
    return store.apply('updateClips', { items: a.clipIds.map((id) => ({ id, follow: { ...follow, clip: sp?.clipId } })) }, { ...meta, label: `attach to ${tr.name}` });
  }
  const t = spanFor(p, tr, a);
  follow.clip = t.clipId;
  let add;
  if (a.mediaId) add = { mediaId: a.mediaId, scale: a.size ?? 0.3, fit: 'contain', ...(a.props || {}) };
  else if (a.template) add = { template: a.template, params: a.params || {} };
  else add = { template: 'track-label', params: { label: a.label ?? 'Lui !', ...(a.params || {}) } };
  return store.apply('addClip', { ...add, start: t.start, duration: t.duration, track: a.track || 'overlay', mode: 'auto', follow, name: a.name || (a.label ? `↪ ${a.label}` : undefined) }, { ...meta, label: `attach to ${tr.name}` });
}

/**
 * Blur / pixelate / spotlight a tracked object or head: an adjustment layer whose mask follows the tracking.
 * a: { tracking, mode: 'blur' | 'pixelate' | 'spotlight' | 'darken', amount?, padding? (0.25), shape?, start?, end? }
 */
export function effectOnTracking(a, meta = {}) {
  const p = store.requireOpen();
  const tr = needTracking(p, a.tracking);
  const t = spanFor(p, tr, a);
  const W = p.settings.width, H = p.settings.height;
  const pt = followPointAt(p, { tracking: tr.id, clip: t.clipId }, t.start + 0.01, W, H);
  if (!pt) fail('Could not place the mask (tracking outside the clip).');
  const pad = 1 + (a.padding ?? (tr.kind === 'face' ? 0.55 : 0.2)); // face boxes cover the features, not the whole head
  const mode = a.mode || 'blur';
  const spot = mode === 'spotlight' || mode === 'darken';
  const mask = {
    shape: a.shape || 'ellipse', cx: pt.x / W, cy: pt.y / H, w: (pt.bw * pad * (spot ? 1.3 : 1)) / W, h: (pt.bh * pad * (spot ? 1.5 : 1)) / H,
    feather: a.feather ?? Math.round(Math.max(8, pt.bw * (spot ? 0.4 : 0.12))), invert: spot,
    follow: { tracking: tr.id, clip: t.clipId, size: true },
  };
  const fx = mode === 'pixelate' ? { pixelate: Math.round(a.amount ?? Math.max(10, pt.bw / 9)) } : mode === 'blur' ? { blur: a.amount ?? Math.max(12, pt.bw / 10) } : null;
  const color = spot ? { brightness: a.amount ?? 0.4, saturation: mode === 'spotlight' ? 0.7 : 1 } : null;
  return store.apply('addAdjustmentLayer', {
    start: t.start, duration: t.duration, fx, color, mask, name: `${mode === 'pixelate' ? 'Pixelisation' : mode === 'blur' ? 'Flou' : 'Projecteur'} · ${tr.name}`,
  }, { ...meta, label: `${mode} ${tr.name}` });
}

export function listTrackings() {
  const p = store.requireOpen();
  return (p.trackings || []).map((t) => ({ ...trackingInfo(t), onTimeline: trackingSpans(p, t), attached: p.clips.filter((c) => c.follow?.tracking === t.id || c.mask?.follow?.tracking === t.id).map((c) => c.id) }));
}

/** Tracked box at a timeline time (for the AI to place things precisely). */
export function trackingAt(id, time) {
  const p = store.requireOpen();
  const tr = needTracking(p, id);
  const pt = followPointAt(p, { tracking: tr.id }, time, p.settings.width, p.settings.height);
  if (!pt) return null;
  return { x: r4(pt.x), y: r4(pt.y), boxWidth: r4(pt.bw), boxHeight: r4(pt.bh), frame: `${p.settings.width}x${p.settings.height}` };
}

// ------------------------------------------------------------------------------------------- "ask the AI here"
/**
 * a: { text, time, end?, trackId?, clipId?, target: 'copilot' | 'mcp' | 'auto' }
 * The request is pinned on the timeline; the built-in copilot handles it at once, connected MCP AIs see it in
 * their next tool result (and in list_requests).
 */
export function askAiHere(a, meta = {}) {
  const { result: req } = store.apply('addRequest', a, { ...meta, label: 'ask AI' });
  const p = store.project;
  const st = copilot.state();
  const useCopilot = a.target === 'copilot' || (a.target !== 'mcp' && st.available);
  if (useCopilot) {
    try {
      copilot.send(`${a.text}\n\n[Request ${req.id} pinned on the timeline ${requestContext(p, req)}. Make the change precisely there, then call resolve_request with id "${req.id}" and a one-line reply.]`, {});
      store.apply('updateRequest', { id: req.id, status: 'working' }, { source: 'system', label: 'request sent' });
    } catch (e) {
      bus.emit('toast', { level: 'warning', message: e.message });
    }
  } else {
    bus.emit('toast', { level: 'info', message: tr('📌 Demande épinglée : l\'IA connectée la verra à sa prochaine action.', '📌 Request pinned: the connected AI will see it on its next action.') });
  }
  return { request: req, sentTo: useCopilot ? 'copilot' : 'mcp' };
}

// ------------------------------------------------------------------------------------------- auto reframe
/**
 * Auto Reframe (Premiere-style): keep the tracked subject (a face by default) in the frame when the clip is wider
 * than the project (vertical shorts from horizontal footage): the clip is set to "cover" and its x (and y) are
 * keyframed so the subject stays near the centre, with smoothed camera-like motion.
 * a: { clipId, tracking? (else a face is tracked first), smooth? (s, default 0.7), offsetX? (fraction, -0.5..0.5) }
 */
export async function autoReframe(a, meta = {}) {
  let p = store.requireOpen();
  const clip = clipById(p, a.clipId);
  if (!clip || clip.type !== 'video') fail('autoReframe needs a video clip');
  let trackingId = a.tracking;
  if (!trackingId) {
    const job = startTracking({ clipId: clip.id, time: a.time ?? clip.start + Math.min(1, clip.duration / 2), face: true, name: 'Reframe' }, meta);
    const res = await job.promise;
    trackingId = res.trackingId;
    p = store.project;
  }
  const W = p.settings.width, H = p.settings.height, fps = p.settings.fps || 30;
  const base = { ...clipById(p, clip.id), fit: 'cover', x: 0, y: 0, scale: Math.max(1, clip.scale ?? 1), keyframes: null, follow: null };
  const probe = { ...p, clips: p.clips.map((c) => (c.id === clip.id ? base : c)) };
  const media = mediaById(p, clip.mediaId);
  const g = clipGeometry(base, media, W, H, 0);
  const maxX = Math.max(0, (g.w - W) / 2), maxY = Math.max(0, (g.h - H) / 2);
  if (maxX < 1 && maxY < 1) fail('The clip already fits the frame: nothing to reframe (use it for vertical exports of horizontal footage).');
  const step = 1 / Math.min(15, fps);
  const raw = [];
  for (let lt = 0; lt <= base.duration + 1e-6; lt += step) {
    const pt = followPointAt(probe, { tracking: trackingId, clip: clip.id }, base.start + lt, W, H);
    if (pt) raw.push({ t: lt, x: pt.x, y: pt.y });
  }
  if (!raw.length) fail('The tracking does not cover this clip.');
  // zero-phase exponential smoothing (forward + backward) = steady, camera-like motion
  const tau = a.smooth ?? 0.7;
  const alpha = 1 - Math.exp(-step / Math.max(0.05, tau));
  const smooth = (key) => {
    const v = raw.map((r) => r[key]);
    for (let i = 1; i < v.length; i++) v[i] = v[i - 1] + alpha * (v[i] - v[i - 1]);
    for (let i = v.length - 2; i >= 0; i--) v[i] = v[i + 1] + alpha * (v[i] - v[i + 1]);
    return v;
  };
  const sx = smooth('x'), sy = smooth('y');
  const off = (a.offsetX ?? 0) * W;
  const kx = [], ky = [];
  let lastX = null, lastY = null;
  raw.forEach((r, i) => {
    const x = Math.max(-maxX, Math.min(maxX, W / 2 + off - sx[i]));
    const y = Math.max(-maxY, Math.min(maxY, H / 2 - sy[i]));
    if (lastX === null || Math.abs(x - lastX) > 1.5 || i === raw.length - 1) { kx.push({ t: r4(r.t), v: Math.round(x) }); lastX = x; }
    if (maxY >= 1 && (lastY === null || Math.abs(y - lastY) > 1.5 || i === raw.length - 1)) { ky.push({ t: r4(r.t), v: Math.round(y) }); lastY = y; }
  });
  const keyframes = { ...(clip.keyframes || {}), x: kx };
  if (ky.length) keyframes.y = ky; else delete keyframes.y;
  return store.apply('updateClip', { id: clip.id, fit: 'cover', x: kx[0].v, ...(ky.length ? { y: ky[0].v } : {}), keyframes }, { ...meta, label: 'auto reframe' });
}

// ------------------------------------------------------------------------------------------- derived renders
/**
 * Render a processed copy of a clip's source range and swap it in: reverse (played backwards, sound too),
 * stabilize (vidstab, two passes), slowmo (smooth slow motion: motion-compensated frame interpolation).
 * a: { clipId, kind: 'reverse' | 'stabilize' | 'slowmo', strength? (stabilize smoothing), factor? (slowmo speed, 0.1–0.9) }
 */
export function deriveClip(a, meta = {}) {
  const p = store.requireOpen();
  const clip = clipById(p, a.clipId);
  if (!clip || clip.type !== 'video') fail('Needs a video clip');
  const m = mediaById(p, clip.mediaId);
  if (!m?.path) fail('Media file missing');
  const kind = a.kind;
  if (!['reverse', 'stabilize', 'slowmo'].includes(kind)) fail('kind: reverse | stabilize | slowmo');
  const s0 = clip.in, len = clip.duration * clip.speed;
  if (kind === 'reverse' && len > 120) fail('Reverse is limited to 2 minutes of source.');
  // slow motion: the clip's own speed if already slowed, else the requested factor
  const factor = kind === 'slowmo' ? Math.min(0.9, Math.max(0.05, Number(a.factor) || (clip.speed < 1 ? clip.speed : 0.5))) : 1;
  if (kind === 'slowmo' && len / factor > 180) fail('Smooth slow motion is limited to 3 minutes of output.');
  const label = { reverse: 'Inverser', stabilize: 'Stabiliser', slowmo: 'Ralenti fluide' }[kind];
  return jobs.create('render', `${label} ${clip.name}`, async ({ progress, signal }) => {
    const dir = store.cacheDir('derived', `${kind}_${Date.now()}`);
    const outDir = path.join(store.dir, 'media', 'derived');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `${(clip.name || m.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}_${kind}_${Date.now() % 100000}.mp4`);
    const enc = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', ...(m.hasAudio ? ['-c:a', 'aac', '-b:a', '256k'] : ['-an'])];
    if (kind === 'reverse') {
      // reversed in 2 s pieces (ffmpeg's reverse filter buffers every frame), concatenated last piece first
      const SEG = 2;
      const parts = [];
      const n = Math.ceil(len / SEG);
      for (let i = 0; i < n; i++) {
        if (signal.aborted) throw new Error('Aborted');
        const a0 = s0 + i * SEG, d = Math.min(SEG, len - i * SEG);
        const f = path.join(dir, `p${String(i).padStart(4, '0')}.mkv`);
        await runFfmpeg(['-ss', String(a0), '-t', String(d), '-i', m.path, '-vf', 'reverse', ...(m.hasAudio ? ['-af', 'areverse', '-c:a', 'pcm_s16le'] : ['-an']), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', f], { signal });
        parts.push(f);
        progress(((i + 1) / n) * 0.85, `${i + 1}/${n}`);
      }
      const list = path.join(dir, 'list.txt');
      fs.writeFileSync(list, parts.reverse().map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
      await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, ...enc, out], { signal, duration: len });
    } else if (kind === 'slowmo') {
      const fps = store.project.settings.fps || 30;
      const tempo = [];
      for (let s = factor; s < 0.5; s /= 0.5) tempo.push('atempo=0.5');
      tempo.push(`atempo=${factor / Math.pow(0.5, tempo.length)}`);
      await runFfmpeg(['-ss', String(s0), '-t', String(len), '-i', m.path,
        '-vf', `scale='min(1920,iw)':-2,setpts=PTS/${factor},minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
        ...(m.hasAudio ? ['-af', tempo.join(',')] : []), ...enc, out], { signal, duration: len / factor, onProgress: (r) => progress(0.95 * r, 'interpolation') });
    } else {
      const trf = path.join(dir, 'transforms.trf');
      const esc = (f) => f.replace(/\\/g, '/').replace(/:/g, '\\:');
      await runFfmpeg(['-ss', String(s0), '-t', String(len), '-i', m.path, '-vf', `vidstabdetect=shakiness=7:accuracy=12:result='${esc(trf)}'`, '-f', 'null', '-'], { signal, duration: len, onProgress: (r) => progress(0.45 * r, 'analyse') });
      const smoothing = Math.round(a.strength ?? 20);
      await runFfmpeg(['-ss', String(s0), '-t', String(len), '-i', m.path, '-vf', `vidstabtransform=input='${esc(trf)}':smoothing=${smoothing}:zoom=3:optzoom=1,unsharp=5:5:0.6:3:3:0.3`, ...enc, out], { signal, duration: len, onProgress: (r) => progress(0.45 + 0.5 * r, 'stabilize') });
    }
    progress(0.96, 'import');
    const [mediaId] = importPaths([out], { source: meta.source || 'system' }).map((x) => x.id);
    await waitForProbe(mediaId);
    const patch = { id: clip.id, mediaId, in: 0, name: `${clip.name} (${{ reverse: 'inversé', stabilize: 'stabilisé', slowmo: `ralenti ×${factor}` }[kind]})` };
    if (kind === 'slowmo') { patch.speed = 1; patch.duration = r4(len / factor); }
    const cur = clipById(store.project, clip.id);
    if (kind === 'reverse' && cur?.keyframes) { // the picture runs backwards: so do its keyframes (reframe, zooms…)
      const d = cur.duration;
      patch.keyframes = Object.fromEntries(Object.entries(cur.keyframes).map(([k, list]) => [k, list.map((f) => ({ t: r4(d - f.t), v: f.v })).sort((x, y) => x.t - y.t)]));
    }
    const res = store.apply('updateClip', patch, { ...meta, label: kind });
    fs.rm(dir, { recursive: true, force: true }, () => {});
    return { clipId: clip.id, mediaId, file: out, ...(res.warnings?.length ? { warnings: res.warnings } : {}) };
  }, { queue: 'render', meta: { kind } });
}
