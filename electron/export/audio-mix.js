// Export audio mixer. Each clip is decoded and processed by its own small ffmpeg (speed, volume / keyframes, voice
// effects, fades → raw float PCM), and the clips are summed here, sample-exact, into blocks streamed to a final
// ffmpeg (master volume, loudness normalisation, limiter → WAV).
//
// Why not one big ffmpeg filter graph: with ffmpeg 8, a graph with many inputs placed by adelay / concat / amix
// stopped producing audio part-way (adelay now shifts timestamps instead of inserting silence; amix ended with its
// first undelayed input; large concat graphs went silent after ~80 s) — a 20 min export came out 20 s long, then
// mostly silent. Here every position is a sample count, nothing depends on timestamps, and only the clips playing at
// a given moment are being decoded (memory stays small for any length).
import fs from 'node:fs';
import { once } from 'node:events';
import { requireFfmpeg } from '../media/ffmpeg.js';
import { spawnTracked } from '../core/proc.js';
import { audioSpans, kfExpr, sourceRangeFor, atempoChain } from './graph.js';
import { audioFxFilters } from '../../shared/audiofx.js';
import { AfxChain } from '../../shared/dsp.js';
import { log } from '../core/log.js';

const SR = 48000;
const BLOCK = SR / 2; // frames per mixing block (0.5 s)
const PREFETCH = SR * 2; // clip decoders start 2 s before they are needed
const HIGH_WATER = 4 << 20; // bytes buffered per clip decoder before pausing it

const f = (x) => {
  const v = Number(x);
  if (!Number.isFinite(v)) return '0';
  return Math.abs(v) < 1e-9 ? '0' : String(Math.round(v * 1e6) / 1e6);
};

/** Reads exact byte counts from a child's stdout, with backpressure. */
class PcmSource {
  constructor(args, label) {
    this.label = label;
    this.proc = spawnTracked(requireFfmpeg(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.chunks = [];
    this.len = 0;
    this.ended = false;
    this.err = '';
    this.wake = null;
    const out = this.proc.stdout;
    out.on('data', (d) => {
      this.chunks.push(d);
      this.len += d.length;
      if (this.len > HIGH_WATER) out.pause();
      this.wake?.();
    });
    out.on('end', () => { this.ended = true; this.wake?.(); });
    this.proc.stderr.on('data', (d) => { this.err = (this.err + d).slice(-2000); });
    this.proc.on('error', (e) => { this.err += e.message; this.ended = true; this.wake?.(); });
    this.proc.on('close', () => { this.ended = true; this.wake?.(); });
  }

  /** Exactly `bytes` bytes (zero-filled if the decoder ended early). */
  async read(bytes) {
    while (this.len < bytes && !this.ended) await new Promise((r) => { this.wake = r; });
    this.wake = null;
    const out = Buffer.alloc(bytes);
    let off = 0;
    while (off < bytes && this.chunks.length) {
      const c = this.chunks[0];
      const take = Math.min(c.length, bytes - off);
      c.copy(out, off, 0, take);
      off += take;
      if (take === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(take);
      this.len -= take;
    }
    if (this.len < HIGH_WATER / 2 && this.proc.stdout.isPaused()) this.proc.stdout.resume();
    if (off < bytes && !this.warned) { this.warned = true; log.warn(`audio clip ${this.label} ended ${((bytes - off) / 8 / SR).toFixed(3)} s early`, this.err.trim().slice(-300)); }
    return out;
  }

  close() { try { this.proc.kill('SIGKILL'); } catch { /* */ } }
}

/** One clip's decode + processing args (raw float stereo 48 kHz, exactly n frames). */
function clipJob(project, s, w0, w1) { // eslint-disable-line complexity
  const a = Math.max(s.start, w0), b = Math.min(s.end, w1);
  if (b - a < 0.005) return null;
  const { clip, media, track } = s;
  if (!media?.path) return null;
  const la = a - clip.start, lb = b - clip.start;
  const r = sourceRangeFor(clip, media, la, lb);
  if (r.b - r.a < 0.005) return null;
  const at = (t) => Math.round((t - w0) * SR);
  let s0 = at(a);
  let n = at(b) - s0;
  // part of the clip before the start of its media (slow motion / trimmed before 0): silent
  const pre = Math.min(n, Math.round(r.pre * SR));
  s0 += pre; n -= pre;
  if (n < 16) return null;
  const p = pre / SR; // chain time 0 = clip local time la + p
  const chain = ['asetpts=PTS-STARTPTS', ...atempoChain(r.speed), 'aresample=48000', 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    `apad=whole_len=${n}`, `atrim=end_sample=${n}`, 'asetpts=N/SR/TB'];
  const tv = `(t+${f(la + p)})`;
  chain.push((clip.keyframes?.volume?.length > 1)
    ? `volume='(${kfExpr(clip.keyframes.volume, tv, clip.volume ?? 1)})*${f(track.volume ?? 1)}':eval=frame`
    : `volume=${f((clip.keyframes?.volume?.[0]?.v ?? clip.volume ?? 1) * (track.volume ?? 1))}`);
  chain.push(...audioFxFilters(clip.audioFx));
  const fade = (type, st, d, curve) => {
    if (!(d > 0)) return;
    const st2 = st - p;
    if (st2 + d <= 0 && type === 'in') return;
    chain.push(`afade=t=${type}:st=${f(Math.max(0, st2))}:d=${f(d)}${curve ? `:curve=${curve}` : ''}`);
  };
  if (clip.fadeIn > 0 && la < clip.fadeIn) fade('in', Math.max(0, -la), clip.fadeIn);
  if (clip.fadeOut > 0 && lb > clip.duration - clip.fadeOut) fade('out', Math.max(0, clip.duration - clip.fadeOut - la), clip.fadeOut);
  if (s.xin > 0 && a <= s.start + 0.001) fade('in', 0, s.xin, 'qsin');
  if (s.xout > 0 && b >= s.end - 0.001) fade('out', Math.max(0, b - a - s.xout), s.xout, 'qsin');
  chain.push(`apad=whole_len=${n}`, `atrim=end_sample=${n}`);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', f(r.a), '-t', f(r.b - r.a + 0.05), '-i', media.path,
    '-vn', '-sn', '-dn', '-af', chain.join(','), '-f', 'f32le', '-ac', '2', '-ar', String(SR), 'pipe:1'];
  // clip insert effects (shared/dsp.js, same code as the preview): their tail (reverb, echo…) rings past the clip end
  let afx = null, tailN = 0;
  if (clip.afx?.length) {
    afx = new AfxChain(clip.afx, SR);
    if (afx.active) {
      afx.setPosition(Math.round((la + p) * SR));
      tailN = Math.round(afx.tail * SR);
    } else afx = null;
  }
  const end = Math.min(Math.round((w1 - w0) * SR), s0 + n + tailN);
  return { s0, s1: s0 + n, end, args, afx, trackId: track.id, label: `${clip.name} @${a.toFixed(2)}s` };
}

/** Track buses: effect chain + pan of each track (timeline-positioned, so LFOs match the preview). */
function trackBuses(project, w0) {
  const buses = new Map();
  for (const t of project.tracks) {
    if (t.muted) continue;
    const chain = new AfxChain(t.afx || [], SR, { pan: t.pan || 0 });
    if (!chain.active) continue;
    chain.setPosition(Math.round(w0 * SR));
    buses.set(t.id, { chain, L: null, R: null });
  }
  return buses;
}

/**
 * Render the timeline audio of [w0, w1) to a 48 kHz stereo 16-bit WAV.
 * opts: { signal, onProgress(ratio), normalize }
 */
export async function renderAudioMix(project, w0, w1, out, { signal, onProgress, normalize } = {}) {
  const total = Math.round((w1 - w0) * SR);
  const jobs = audioSpans(project).map((s) => clipJob(project, s, w0, w1)).filter(Boolean).sort((x, y) => x.s0 - y.s0);
  const master = project.settings.masterVolume ?? 1;
  const tail = [];
  if (master !== 1) tail.push(`volume=${f(master)}`);
  if (normalize || project.settings.normalizeLoudness) tail.push('loudnorm=I=-14:TP=-1.5:LRA=11');
  tail.push('aresample=48000', 'alimiter=limit=0.98:level=0:latency=1', `apad=whole_len=${total}`, `atrim=end_sample=${total}`);
  const enc = spawnTracked(requireFfmpeg(), ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', 'pipe:0',
    '-af', tail.join(','), '-c:a', 'pcm_s16le', '-ar', String(SR), out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let encErr = '';
  enc.stderr.on('data', (d) => { encErr = (encErr + d).slice(-3000); });
  enc.stdin.on('error', () => { /* reported by close */ });
  const encDone = new Promise((resolve, reject) => {
    enc.on('error', reject);
    enc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`audio encode failed: ${encErr.trim().slice(-400)}`))));
  });
  const active = [];
  let next = 0;
  const buses = trackBuses(project, w0);
  const mL = new Float32Array(BLOCK), mR = new Float32Array(BLOCK);
  const tL = new Float32Array(BLOCK), tR = new Float32Array(BLOCK);
  for (const b of buses.values()) { b.L = new Float32Array(BLOCK); b.R = new Float32Array(BLOCK); }
  try {
    for (let pos = 0; pos < total; pos += BLOCK) {
      if (signal?.aborted) throw new Error('Aborted');
      const n = Math.min(BLOCK, total - pos);
      while (next < jobs.length && jobs[next].s0 < pos + n + PREFETCH) {
        const j = jobs[next++];
        active.push({ ...j, src: new PcmSource(j.args, j.label) });
      }
      mL.fill(0, 0, n); mR.fill(0, 0, n);
      for (const b of buses.values()) { b.L.fill(0, 0, n); b.R.fill(0, 0, n); }
      for (let i = active.length - 1; i >= 0; i--) {
        const it = active[i];
        const a = Math.max(pos, it.s0), b = Math.min(pos + n, it.end);
        if (b > a) {
          const len = b - a;
          const dec = Math.max(0, Math.min(b, it.s1) - a); // decoded samples in this block (the rest is effect tail)
          if (dec > 0 && !it.src.closed) {
            const buf = await it.src.read(dec * 8);
            const v = new Float32Array(buf.buffer, buf.byteOffset, dec * 2);
            for (let k = 0; k < dec; k++) { tL[k] = v[2 * k]; tR[k] = v[2 * k + 1]; }
          }
          tL.fill(0, dec, len); tR.fill(0, dec, len);
          if (it.s1 <= b && !it.src.closed) { it.src.close(); it.src.closed = true; }
          if (it.afx) it.afx.process(tL.subarray(0, len), tR.subarray(0, len), len);
          const bus = buses.get(it.trackId);
          const L = bus ? bus.L : mL, R = bus ? bus.R : mR;
          const o = a - pos;
          for (let k = 0; k < len; k++) { L[o + k] += tL[k]; R[o + k] += tR[k]; }
        }
        if (it.end <= pos + n) { if (!it.src.closed) it.src.close(); active.splice(i, 1); }
      }
      for (const bus of buses.values()) {
        bus.chain.process(bus.L.subarray(0, n), bus.R.subarray(0, n), n);
        for (let k = 0; k < n; k++) { mL[k] += bus.L[k]; mR[k] += bus.R[k]; }
      }
      const mix = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) { mix[2 * k] = mL[k]; mix[2 * k + 1] = mR[k]; }
      if (!enc.stdin.write(Buffer.from(mix.buffer))) await once(enc.stdin, 'drain');
      if (onProgress && (pos / BLOCK) % 20 === 0) onProgress(pos / total);
    }
    enc.stdin.end();
    await encDone;
  } catch (e) {
    try { enc.kill('SIGKILL'); } catch { /* */ }
    throw e;
  } finally {
    for (const it of active) if (!it.src.closed) it.src.close();
  }
  onProgress?.(1);
  return { out, clips: jobs.length, seconds: total / SR, size: fs.statSync(out).size };
}
