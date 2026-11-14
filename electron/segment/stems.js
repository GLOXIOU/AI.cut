// Voice / music separation ("stems"): the clip's audio goes through an MDX-Net vocal model (UVR Kim_Vocal_2,
// downloaded on first use) in the native ML worker; music = mix − voice. Both stems are written as WAV files,
// imported and laid on audio tracks aligned with the clip, whose own sound is muted.
import fs from 'node:fs';
import path from 'node:path';
import { requireFfmpeg } from '../media/ffmpeg.js';
import { spawnTracked } from '../core/proc.js';
import { exists, uid, safeFileName } from '../core/util.js';
import { log } from '../core/log.js';
import { store } from '../project/store.js';
import { jobs } from '../core/jobs.js';
import { importPaths, waitForProbe } from '../media/service.js';
import { clipById, mediaById, r4 } from '../../shared/timeline.js';
import { MDX_MODELS, mdxGeometry } from '../../shared/mdx.js';
import { OPS } from '../project/ops.js';
import { NativeML, ensureModel, modelFile } from './mlwindow.js';

const MAX_SECONDS = 20 * 60;

function decodePcm(file, a, d, sr) {
  return new Promise((resolve, reject) => {
    const proc = spawnTracked(requireFfmpeg(), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(a), '-t', String(d), '-i', file,
      '-vn', '-ac', '2', '-ar', String(sr), '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { err = (err + c).slice(-800); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`audio decode failed: ${err.trim()}`));
      const b = Buffer.concat(chunks);
      const x = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
      const n = x.length / 2, L = new Float32Array(n), R = new Float32Array(n);
      for (let i = 0; i < n; i++) { L[i] = x[2 * i]; R[i] = x[2 * i + 1]; }
      resolve([L, R]);
    });
  });
}

function writeWav(file, L, R, sr) {
  return new Promise((resolve, reject) => {
    const proc = spawnTracked(requireFfmpeg(), ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', 'pipe:0', '-c:a', 'pcm_s24le', file], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (c) => { err = (err + c).slice(-800); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`wav write failed: ${err.trim()}`))));
    const n = L.length, block = 1 << 16;
    let i = 0;
    const pump = () => {
      while (i < n) {
        const m = Math.min(block, n - i);
        const o = new Float32Array(2 * m);
        for (let k = 0; k < m; k++) { o[2 * k] = L[i + k]; o[2 * k + 1] = R[i + k]; }
        i += m;
        if (!proc.stdin.write(Buffer.from(o.buffer))) { proc.stdin.once('drain', pump); return; }
      }
      proc.stdin.end();
    };
    pump();
  });
}

/**
 * a: { clipId, keep: 'both' | 'voice' | 'music' (what is laid on the timeline), place?: true }
 * Returns a job; result { voiceMediaId, musicMediaId, voiceClipId, musicClipId }.
 */
export function separateStems(a, meta = {}) {
  const p = store.requireOpen();
  const clip = clipById(p, a.clipId);
  if (!clip || (clip.type !== 'audio' && clip.type !== 'video')) throw new Error('Choose an audio or video clip.');
  const m = mediaById(p, clip.mediaId);
  if (!m?.path || !exists(m.path)) throw new Error('Media file missing');
  if (!m.hasAudio) throw new Error('This clip has no sound.');
  const cfg = MDX_MODELS['kim-vocal-2'];
  const SR = cfg.sampleRate;
  const s0 = Math.max(0, clip.in - 0.5);
  const s1 = Math.min(m.duration || Infinity, clip.in + clip.duration * clip.speed + 0.5);
  if (s1 - s0 > MAX_SECONDS) throw new Error('Separation is limited to 20 minutes of audio per clip.');
  return jobs.create('stems', `Séparer voix / musique ${clip.name}`, async ({ progress, signal }) => {
    progress(0.01, 'model');
    await ensureModel('mdx', (r) => progress(0.01 + 0.1 * r, 'model download'), signal);
    progress(0.12, 'audio');
    const [xL, xR] = await decodePcm(m.path, s0, s1 - s0, SR);
    const n = xL.length;
    const ml = new NativeML();
    try {
      await ml.open();
      const info = await ml.request('mdxInit', { model: modelFile('mdx'), cfg }, 180000);
      const { trim, chunk, gen } = mdxGeometry(cfg);
      const pad = (gen - (n % gen)) % gen;
      const total = trim + n + pad + trim;
      const PL = new Float32Array(total), PR = new Float32Array(total);
      PL.set(xL, trim); PR.set(xR, trim);
      const vL = new Float32Array(n + pad), vR = new Float32Array(n + pad);
      const chunks = Math.max(1, (total - chunk) / gen + 1);
      const t1 = Date.now();
      let ep = info.ep;
      for (let i = 0, k = 0; i + chunk <= total; i += gen, k++) {
        if (signal.aborted) throw new Error('Aborted');
        const r = await ml.request('mdxChunk', { L: PL.slice(i, i + chunk), R: PR.slice(i, i + chunk) }, 300000);
        ep = r.ep;
        vL.set(r.L.subarray(trim, trim + gen), k * gen);
        vR.set(r.R.subarray(trim, trim + gen), k * gen);
        progress(0.15 + 0.75 * ((k + 1) / chunks), `${k + 1}/${Math.round(chunks)} (${ep})`);
      }
      log.info(`stems ${clip.name}: ${(n / SR).toFixed(1)} s in ${((Date.now() - t1) / 1000).toFixed(1)} s on ${ep}`);
      const voiceL = new Float32Array(n), voiceR = new Float32Array(n), musicL = new Float32Array(n), musicR = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        voiceL[i] = vL[i] * cfg.compensate; voiceR[i] = vR[i] * cfg.compensate;
        musicL[i] = xL[i] - voiceL[i]; musicR[i] = xR[i] - voiceR[i];
      }
      progress(0.92, 'write');
      const dir = path.join(store.dir, 'media', 'stems');
      fs.mkdirSync(dir, { recursive: true });
      const base = `${safeFileName(clip.name || m.name, 40)}_${uid('s', 4)}`;
      const voiceFile = path.join(dir, `${base}_voix.wav`), musicFile = path.join(dir, `${base}_musique.wav`);
      await writeWav(voiceFile, voiceL, voiceR, SR);
      await writeWav(musicFile, musicL, musicR, SR);
      const [voiceMediaId, musicMediaId] = importPaths([voiceFile, musicFile], { source: meta.source || 'system' }).map((x) => x.id);
      await Promise.all([waitForProbe(voiceMediaId), waitForProbe(musicMediaId)]);
      const placed = a.place === false ? null : placeStems(clip.id, s0, { voice: a.keep !== 'music' ? voiceMediaId : null, music: a.keep !== 'voice' ? musicMediaId : null }, meta);
      return { voiceMediaId, musicMediaId, ...(placed || {}), backend: ep, seconds: r4(n / SR) };
    } finally {
      ml.close();
    }
  }, { queue: 'render', meta: { kind: 'stems' } });
}

/** Lay the stems under the clip (aligned to its source range) and mute the clip's own sound. */
function placeStems(clipId, s0, ids, meta) {
  const { result } = store.transaction('separate voice / music', (draft, ctx) => {
    const c = draft.clips.find((x) => x.id === clipId);
    if (!c) throw new Error('The original clip is gone.');
    const out = {};
    const base = { start: c.start, in: r4(c.in - s0), duration: c.duration, speed: c.speed, fadeIn: c.fadeIn, fadeOut: c.fadeOut, mode: 'auto' };
    if (ids.voice) out.voiceClipId = OPS.addClip(draft, { ...base, mediaId: ids.voice, track: 'auto', name: `🎙 ${c.name} (voix)`, volume: c.volume }, ctx).id;
    if (ids.music) out.musicClipId = OPS.addClip(draft, { ...base, mediaId: ids.music, track: 'auto', name: `🎵 ${c.name} (musique)`, volume: c.volume }, ctx).id;
    c.muted = true;
    return out;
  }, { ...meta, label: 'separate stems' });
  return result;
}
