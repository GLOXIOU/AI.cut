// Media import pipeline: register → probe → thumbnail / filmstrip / peaks → ready → (auto) analysis.
// Heavy work that needs every frame decoded (preview proxy + shot detection, in ONE pass, on the GPU when possible)
// runs afterwards in its own queue, one file at a time; media Chromium can play stay usable meanwhile.
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../project/store.js';
import { jobs } from '../core/jobs.js';
import { log } from '../core/log.js';
import { uid, exists } from '../core/util.js';
import { getSettings } from '../core/settings.js';
import { probeMedia, needsProxy, canPlayNatively, guessKind } from './probe.js';
import { makeThumbnail, makeFilmstrip, makePeaks, makeProxy, videoPass } from './ingest.js';
import { bus } from '../core/bus.js';

const SUPPORTED = /\.(mp4|mov|m4v|mkv|webm|avi|wmv|flv|mpg|mpeg|ts|mts|m2ts|3gp|gif|mp3|wav|m4a|aac|flac|ogg|opus|wma|aif|aiff|png|jpe?g|webp|bmp|tiff?|avif|heic|svg|html?|json|lottie)$/i;

const probeWaiters = new Map(); // mediaId -> promise
const videoPasses = new Map(); // mediaId -> 'proxy' job (proxy + shots)
let hevcSupported = false;
export function setRendererCaps(caps) { hevcSupported = !!caps?.hevc; }

function listFiles(p, out = []) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) if (!f.startsWith('.')) listFiles(path.join(p, f), out);
    } else if (SUPPORTED.test(p)) out.push(p);
  } catch { /* ignore */ }
  return out;
}

/**
 * Import files/folders. Returns the created media records (status "processing").
 * opts: { source: 'ui'|'ai', client, sourceInfo: {kind, url, license, author, title}, name }
 */
export function importPaths(paths, opts = {}) {
  store.requireOpen();
  const files = paths.flatMap((p) => listFiles(p));
  if (!files.length) throw new Error('No supported media files found.');
  const existing = new Map(store.project.media.map((m) => [path.normalize(m.path || '').toLowerCase(), m]));
  const records = [];
  const reused = [];
  for (const f of files) {
    const known = existing.get(path.normalize(f).toLowerCase());
    if (known && !opts.forceNew) { reused.push(known); continue; }
    records.push({
      id: uid('m'),
      name: opts.name && files.length === 1 ? opts.name : path.basename(f),
      path: f,
      type: guessKind(f),
      status: 'processing',
      addedAt: new Date().toISOString(),
      duration: 0,
      source: opts.sourceInfo || { kind: 'import' },
      analysis: { transcript: 'none', scenes: 'none' },
      tags: [],
      notes: '',
    });
  }
  if (records.length) {
    store.transaction(records.length === 1 ? `import ${records[0].name}` : `import ${records.length} files`, (draft) => {
      for (const r of records) draft.media.push(r);
    }, { source: opts.source, client: opts.client });
    for (const r of records) startIngest(r);
  }
  return [...records, ...reused];
}

function startIngest(media) {
  let resolveProbe, rejectProbe;
  const probed = new Promise((res, rej) => { resolveProbe = res; rejectProbe = rej; });
  probed.catch(() => {});
  probeWaiters.set(media.id, probed);
  const projectDir = store.dir;
  const projectId = store.project?.id;
  jobs.create('ingest', `Import ${media.name}`, async (ctx) => {
    const cache = path.join(projectDir, '.aicut-cache', 'media', media.id);
    fs.mkdirSync(cache, { recursive: true });
    let info;
    try {
      ctx.progress(0.05, 'probe');
      info = await probeMedia(media.path);
      const patch = {
        type: info.type, duration: info.duration, width: info.width, height: info.height, fps: info.fps,
        hasAudio: info.hasAudio, hasVideo: info.hasVideo, codec: info.codec, audioCodec: info.audioCodec,
        size: info.size, rotation: info.rotation, hasAlpha: !!info.hasAlpha, sampleRate: info.sampleRate, channels: info.channels,
      };
      if (info.type === 'html' || info.type === 'lottie') patch.status = 'ready';
      store.setDerived(media.id, patch);
      resolveProbe({ ...media, ...patch });
    } catch (e) {
      store.setDerived(media.id, { status: 'error', error: e.message });
      rejectProbe(e);
      throw e;
    }
    if (info.type === 'html' || info.type === 'lottie') return { ok: true };
    const s = getSettings();
    try {
      if (info.hasVideo) {
        ctx.progress(0.15, 'thumbnail');
        const thumb = await makeThumbnail(media.path, info, path.join(cache, 'thumb.jpg'), { signal: ctx.signal });
        store.setDerived(media.id, { thumb });
      }
      if (info.type === 'video') {
        ctx.progress(0.3, 'filmstrip');
        const fsInfo = await makeFilmstrip(media.path, info, path.join(cache, 'filmstrip.jpg'), { signal: ctx.signal }).catch((e) => { if (ctx.signal.aborted) throw e; log.warn('filmstrip', e.message); return null; });
        if (fsInfo) store.setDerived(media.id, { filmstrip: fsInfo });
      }
      if (info.hasAudio) {
        ctx.progress(0.5, 'waveform');
        const pk = await makePeaks(media.path, path.join(cache, 'audio.peaks'), { signal: ctx.signal }).catch((e) => { if (ctx.signal.aborted) throw e; log.warn('peaks', e.message); return null; });
        if (pk) store.setDerived(media.id, { peaks: pk.path, peaksRate: pk.rate });
      }
      const wantProxy = needsProxy(info, media.path, { hevcSupported, mode: s.proxyMode });
      if (wantProxy && info.type === 'video' && !info.hasAlpha) {
        // the original stays usable while the proxy is built, as long as Chromium can play it
        const playable = canPlayNatively(info, media.path, { hevcSupported });
        store.setDerived(media.id, playable ? { status: 'ready', proxyPending: true } : { proxyPending: true });
        startVideoPass(media, info, cache, projectId);
      } else {
        if (wantProxy) {
          ctx.progress(0.6, 'proxy');
          const ext = info.type === 'audio' ? 'm4a' : info.type === 'image' ? 'png' : 'webm';
          const out = path.join(cache, `proxy.${ext}`);
          await makeProxy(media.path, info, out, { signal: ctx.signal, onProgress: (r) => ctx.progress(0.6 + 0.4 * r, 'proxy') });
          store.setDerived(media.id, { proxy: out });
        }
        store.setDerived(media.id, { status: 'ready' });
      }
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      log.error('ingest failed', media.path, e);
      store.setDerived(media.id, { status: 'ready', warning: e.message });
    }
    bus.emit('media:ready', media.id);
    return { ok: true };
  }, { queue: 'ingest', meta: { mediaId: media.id }, projectId });
}

/** Proxy + shot detection: one decode of the whole file, one file at a time (queue 'video'). */
function startVideoPass(media, info, cache, projectId) {
  const prev = videoPasses.get(media.id);
  if (prev && !prev.endedAt) jobs.cancel(prev.id);
  const job = jobs.create('proxy', `Proxy ${media.name}`, async (ctx) => {
    const current = () => store.project?.id === projectId;
    ctx.progress(0, 'proxy');
    // leftovers of a pass interrupted by closing the app
    try { for (const f of fs.readdirSync(cache)) if (/^scenes_\d+\.txt$/.test(f)) fs.rmSync(path.join(cache, f), { force: true }); } catch { /* ignore */ }
    try {
      const r = await videoPass(media.path, info, {
        proxyOut: path.join(cache, 'proxy.mp4'),
        scenesFile: path.join(cache, `scenes_${Date.now()}.txt`),
        signal: ctx.signal,
        onProgress: (p) => ctx.progress(p, 'proxy'),
      });
      if (current()) {
        store.setDerived(media.id, { proxy: r.proxy, proxyPending: false, status: 'ready' });
        bus.emit('media:shots', { mediaId: media.id, projectId, shots: r.shots });
      }
      return { ok: true, decoder: r.mode };
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      log.error('proxy failed', media.path, e);
      if (current()) {
        store.setDerived(media.id, { proxyPending: false, status: 'ready', warning: e.message });
        bus.emit('media:shots', { mediaId: media.id, projectId, shots: null, error: e.message });
      }
      throw e;
    }
  }, { queue: 'video', meta: { mediaId: media.id }, projectId });
  videoPasses.set(media.id, job);
  return job;
}

/** Is a proxy/shot pass queued or running for this media? (its shot list will arrive with 'media:shots') */
export function videoPassPending(mediaId) {
  const j = videoPasses.get(mediaId);
  return !!j && !j.endedAt;
}

// Imports interrupted by closing the app (or the project) are resumed when the project is opened again.
bus.on('project:opened', (project) => {
  const stuck = (project?.media || []).filter((m) => !m.offline && m.path && !['html', 'lottie'].includes(guessKind(m.path))
    && (m.status === 'processing' || (m.proxyPending && !m.proxy)));
  if (stuck.length) log.info(`resuming import of ${stuck.length} media`);
  for (const m of stuck) startIngest(m);
});

// Closing a project stops its background work (decoding 4K for a project nobody looks at is wasted CPU).
bus.on('project:closed', (info) => {
  if (!info?.id) return;
  jobs.cancelWhere((j) => j.projectId === info.id && ['ingest', 'video', 'analysis'].includes(j.queue));
});

/** Wait until media metadata (duration etc.) is known. */
export async function waitForProbe(mediaId, timeoutMs = 60000) {
  const m = store.project?.media.find((x) => x.id === mediaId);
  if (m && m.duration > 0 && m.status !== 'processing') return m;
  const w = probeWaiters.get(mediaId);
  if (!w) return m;
  await Promise.race([w, new Promise((r) => setTimeout(r, timeoutMs))]);
  return store.project?.media.find((x) => x.id === mediaId);
}

export function relinkMedia(mediaId, newPath) {
  if (!exists(newPath)) throw new Error('File not found');
  store.apply('updateMedia', { id: mediaId, path: newPath }, { label: 'relink media' });
  const m = store.project.media.find((x) => x.id === mediaId);
  startIngest(m);
  return m;
}

/** Copy a file into the project media folder (used for downloads / generated assets). */
export function projectMediaPath(fileName, sub = '') {
  const dir = path.join(store.dir, 'media', sub);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}
