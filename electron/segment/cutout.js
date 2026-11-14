// Subject cutout ("détourage"). Every frame of a clip goes through a model in the hidden ML window (WebGPU, else
// wasm): Robust Video Matting for PEOPLE, or SlimSAM guided by a tracking box for any OBJECT. The alpha mattes are
// merged with the ORIGINAL pixels into a WebM VP9 + alpha video, imported as a media and laid on a track above the
// clip, frame-aligned: anything placed between the two tracks (text, photo, motion…) appears BEHIND the subject.
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { requireFfmpeg } from '../media/ffmpeg.js';
import { spawnTracked } from '../core/proc.js';
import { exists, uid, safeFileName } from '../core/util.js';
import { log } from '../core/log.js';
import { store } from '../project/store.js';
import { jobs } from '../core/jobs.js';
import { importPaths, waitForProbe } from '../media/service.js';
import { clipById, mediaById, r4 } from '../../shared/timeline.js';
import { trackingById, trackingBoxAt } from '../../shared/follow.js';
import { OPS } from '../project/ops.js';
import { MLWindow, NativeML, ensureModel, modelReady, modelFile } from './mlwindow.js';
import { startTracking } from '../tracking/tracker.js';

let lastEp = null;

export function cutoutStatus() {
  return { model: modelReady('rvm'), objectModel: modelReady('samEncoder') && modelReady('samDecoder'), backend: lastEp };
}

// ------------------------------------------------------------------------------------------- job
/**
 * a: { clipId, from?, to? (timeline s, default the whole clip), place?: true, quality?: 'fast' | 'high',
 *      tracking? | box? {x, y, w, h} + time? → OBJECT mode (SlimSAM follows the tracked box) }
 */
export function startCutout(a, meta = {}) {
  const p = store.requireOpen();
  const clip = clipById(p, a.clipId);
  if (!clip) throw new Error(`Unknown clip ${a.clipId}`);
  if (clip.type !== 'video') throw new Error('The cutout works on video clips.');
  const m = mediaById(p, clip.mediaId);
  if (!m?.path || !exists(m.path)) throw new Error('Media file missing');
  const T0 = Math.max(clip.start, a.from ?? clip.start), T1 = Math.min(clip.start + clip.duration, a.to ?? clip.start + clip.duration);
  if (!(T1 - T0 > 0.05)) throw new Error('Empty range');
  const s0 = Math.max(0, clip.in + (T0 - clip.start) * clip.speed - 0.1);
  const s1 = Math.min(m.duration || Infinity, clip.in + (T1 - clip.start) * clip.speed + 0.1);
  const objectMode = !!(a.tracking || a.box);
  if (a.tracking) {
    const tr = trackingById(p, a.tracking);
    if (!tr) throw new Error(`Unknown tracking ${a.tracking}`);
    if (tr.mediaId !== m.id) throw new Error('This tracking belongs to another media.');
  }
  return jobs.create('cutout', `Détourage ${objectMode ? 'objet' : ''} ${clip.name}`.replace('  ', ' '), async ({ progress, signal }) => {
    progress(0.01, 'model');
    let trackingId = a.tracking || null;
    if (objectMode) {
      if (!trackingId) { // track the box first, then cut it out frame by frame
        progress(0.01, 'tracking');
        const tj = startTracking({ clipId: clip.id, time: a.time ?? T0, box: a.box, from: T0, to: T1, name: a.name || 'Objet' }, meta);
        signal.addEventListener('abort', () => jobs.cancel(tj.id), { once: true });
        trackingId = (await tj.promise).trackingId;
      }
      await ensureModel('samEncoder', (r) => progress(0.02 + 0.03 * r, 'model download'), signal);
      await ensureModel('samDecoder', (r) => progress(0.05 + 0.03 * r, 'model download'), signal);
    } else {
      await ensureModel('rvm', (r) => progress(0.01 + 0.07 * r, 'model download'), signal);
    }
    const tr = trackingId ? trackingById(store.project, trackingId) : null;
    const fps = Math.min(60, Math.max(10, Math.round(m.fps || 30)));
    const [mw, mh] = (Math.abs(m.rotation || 0) % 180 === 90) ? [m.height, m.width] : [m.width || 1920, m.height || 1080];
    const quality = objectMode ? 1024 : a.quality === 'fast' ? 768 : 1280;
    const W = Math.max(64, Math.round(Math.min(quality, mw) / 16) * 16);
    const H = Math.max(64, Math.round((W * mh) / mw / 16) * 16);
    const OW = Math.round(Math.min(1920, mw) / 2) * 2, OH = Math.round((OW * mh) / mw / 2) * 2;
    const ratio = Math.min(1, Math.max(0.125, 512 / Math.max(W, H)));
    const out = path.join(store.dir, 'media', 'cutouts', `${safeFileName(clip.name || m.name, 40)}_cutout_${uid('c', 4)}.webm`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const seg = objectMode ? new NativeML() : new MLWindow();
    let dec = null, enc = null;
    const kill = () => { for (const pr of [dec, enc]) try { pr?.kill('SIGKILL'); } catch { /* */ } };
    signal.addEventListener('abort', kill, { once: true });
    try {
      progress(0.09, 'GPU');
      await seg.open();
      const info = objectMode
        ? await seg.request('samInit', { encoder: modelFile('samEncoder'), decoder: modelFile('samDecoder') }, 180000)
        : await seg.request('init', { model: fs.readFileSync(modelFile('rvm')), width: W, height: H, downsample: ratio }, 120000);
      lastEp = info.ep;
      log.info(`cutout ${objectMode ? 'object' : 'person'} ${clip.name}: ${W}x${H} → ${OW}x${OH} @${fps} on ${info.ep}`);
      const dur = s1 - s0;
      const total = Math.max(1, Math.round(dur * fps));
      const ff = requireFfmpeg();
      enc = spawnTracked(ff, ['-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(s0), '-t', String(dur), '-i', m.path,
        '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-framerate', String(fps), '-i', 'pipe:0',
        '-filter_complex', `[0:v]fps=${fps},scale=${OW}:${OH}:flags=bicubic,setsar=1,format=yuv420p[v];[1:v]scale=${OW}:${OH}:flags=bicubic,format=gray[a];[v][a]alphamerge,format=yuva420p[o]`,
        '-map', '[o]', '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', objectMode ? '18' : '24', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-auto-alt-ref', '0', '-g', String(fps),
        out], { stdio: ['pipe', 'ignore', 'pipe'] });
      let encErr = '';
      enc.stderr.on('data', (d) => { encErr = (encErr + d).slice(-2000); });
      enc.stdin.on('error', () => {});
      const encDone = new Promise((resolve, reject) => enc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`cutout encode failed: ${encErr.trim().slice(-300)}`)))));
      dec = spawnTracked(ff, ['-hide_banner', '-loglevel', 'error', '-ss', String(s0), '-t', String(dur), '-i', m.path, '-an', '-sn',
        '-vf', `fps=${fps},scale=${W}:${H}:flags=area,format=rgb24`, '-f', 'rawvideo', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const size = W * H * 3;
      let buf = Buffer.alloc(0), ended = false, wake = null;
      const frames = [];
      dec.stdout.on('data', (d) => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        while (buf.length >= size) { frames.push(new Uint8Array(buf.subarray(0, size))); buf = buf.subarray(size); }
        if (frames.length > 4) dec.stdout.pause();
        wake?.();
      });
      dec.on('close', () => { ended = true; wake?.(); });
      let n = 0;
      const t1 = Date.now();
      for (;;) {
        if (signal.aborted) throw new Error('Aborted');
        if (!frames.length) {
          if (ended) break;
          await new Promise((r) => { wake = r; });
          wake = null;
          continue;
        }
        const f = frames.shift();
        if (frames.length < 2 && dec.stdout.isPaused()) dec.stdout.resume();
        const ts = s0 + n / fps; // source time of this frame
        let res;
        if (objectMode) {
          const b = trackingBoxAt(tr, ts);
          res = await seg.request('samFrame', { rgb: f, W, H, box: [(b.cx - b.w / 2) * W, (b.cy - b.h / 2) * H, (b.cx + b.w / 2) * W, (b.cy + b.h / 2) * H] });
        } else res = await seg.request('frame', f);
        const { alpha, ep } = res;
        info.ep = ep;
        if (!enc.stdin.write(Buffer.from(alpha.buffer, alpha.byteOffset, alpha.byteLength))) await once(enc.stdin, 'drain');
        n++;
        if (n % 5 === 0) {
          const fpsNow = n / ((Date.now() - t1) / 1000);
          progress(0.1 + 0.85 * Math.min(1, n / total), `${n}/${total} · ${fpsNow.toFixed(1)} img/s (${info.ep})`);
        }
      }
      enc.stdin.end();
      await encDone;
      if (!n) throw new Error('No frame decoded');
      progress(0.96, 'import');
      const [mediaId] = importPaths([out], { source: meta.source || 'system' }).map((x) => x.id);
      const cm = await waitForProbe(mediaId);
      let placed = null;
      if (a.place !== false && cm) placed = placeCutout(clip.id, mediaId, s0, T0, T1, meta);
      return { mediaId, clipId: placed?.id || null, track: placed?.track || null, frames: n, backend: info.ep, mode: objectMode ? 'object' : 'person', trackingId, seconds: r4(dur), file: out, fps: r4(n / ((Date.now() - t1) / 1000)) };
    } finally {
      kill();
      seg.close();
    }
  }, { queue: 'render', meta: { kind: 'cutout' } });
}

/** Lay the cutout media on a new track right above the clip's track, frame-aligned with the clip. */
export function placeCutout(clipId, mediaId, s0, T0, T1, meta = {}) {
  const { result } = store.transaction('cutout', (draft, ctx) => {
    const c = draft.clips.find((x) => x.id === clipId);
    if (!c) throw new Error('The original clip is gone.');
    const vids = draft.tracks.filter((t) => t.type === 'video');
    const idx = vids.findIndex((t) => t.id === c.trackId);
    const t = insertVideoTrack(draft, idx + 1, 'Détourage');
    const copy = ['x', 'y', 'scale', 'rotation', 'flipH', 'flipV', 'fit', 'crop', 'keyframes', 'anim', 'color', 'radius', 'opacity', 'videoFadeIn', 'videoFadeOut'];
    const props = Object.fromEntries(copy.filter((k) => c[k] != null).map((k) => [k, structuredClone(c[k])]));
    const nc = OPS.addClip(draft, {
      mediaId, track: t.id, start: r4(T0), in: r4(c.in + (T0 - c.start) * c.speed - s0), duration: r4(T1 - T0), speed: c.speed, mode: 'overwrite',
      name: `✂ ${c.name}`, ...props, muted: true,
    }, ctx);
    if (c.keyframes && T0 > c.start) { // keyframes are clip-relative: shift them to the cutout's start
      for (const k of Object.keys(nc.keyframes || {})) nc.keyframes[k] = nc.keyframes[k].map((f) => ({ ...f, t: r4(f.t - (T0 - c.start)) }));
    }
    nc.cutoutOf = c.id;
    return { id: nc.id, track: t.name };
  }, { ...meta, label: 'cutout' });
  return result;
}

/** New video track at index (0 = bottom) among the video tracks. */
export function insertVideoTrack(draft, index, name) {
  const vids = draft.tracks.filter((t) => t.type === 'video');
  const auds = draft.tracks.filter((t) => t.type === 'audio');
  const id = uid('v');
  let n = name;
  let k = 2;
  while (draft.tracks.some((t) => t.name === n)) n = `${name} ${k++}`;
  const t = { id, type: 'video', name: n, muted: false, hidden: false, locked: false, solo: false, volume: 1, pan: 0, afx: null };
  vids.splice(Math.max(0, Math.min(vids.length, index)), 0, t);
  draft.tracks = [...vids, ...auds];
  return t;
}

/**
 * "Text / photo behind the subject": needs a cutout above the clip (cutoutClipId) and puts the new element on a
 * track between the clip and its cutout. a: { cutoutClipId, template?, params?, text?, mediaId?, start?, duration?, ...props }
 */
export function placeBehind(a, meta = {}) {
  const { result } = store.transaction('behind subject', (draft, ctx) => {
    const cut = draft.clips.find((x) => x.id === a.cutoutClipId);
    if (!cut?.cutoutOf) throw new Error('cutoutClipId must be a cutout clip (made by cutout_subject).');
    const vids = draft.tracks.filter((t) => t.type === 'video');
    const idx = vids.findIndex((t) => t.id === cut.trackId);
    const t = insertVideoTrack(draft, idx, 'Derrière');
    const { cutoutClipId, text, ...rest } = a;
    const args = { ...rest, track: t.id, start: a.start ?? cut.start, duration: a.duration ?? cut.duration, mode: 'overwrite' };
    if (!args.mediaId && !args.template && !args.htmlCode) { args.template = 'title-stack'; args.params = { text: text || 'TITRE', size: 260, ...(a.params || {}) }; }
    return OPS.addClip(draft, args, ctx);
  }, { ...meta, label: 'behind subject' });
  return result;
}
