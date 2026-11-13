// Streaming audio analysis: loudness envelope, adaptive silence detection, tempo/beat tracking, loudness (LUFS).
import fs from 'node:fs';
import path from 'node:path';
import { requireFfmpeg, runFfmpeg } from '../media/ffmpeg.js';
import { spawnTracked } from '../core/proc.js';

const SR = 16000;
const RMS_FRAME = 320; // 20 ms
const FFT_N = 1024;
const HOP = 256; // 16 ms

function fftMag(re, im) {
  // in-place iterative radix-2 FFT
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** Decode and compute dB envelope (50/s) and optional spectral flux + low-band (< 160 Hz, kick / bass) level (62.5/s).
 * Flux frame j is the change between two FFT windows; it is centred at j / fluxRate + fluxOffset seconds. */
export function audioEnvelope(file, { flux = false, signal } = {}) {
  const bin = requireFfmpeg();
  return new Promise((resolve, reject) => {
    const proc = spawnTracked(bin, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], {}, { lowPriority: true });
    const db = [];
    const fl = [];
    const low = [];
    let acc = 0, n = 0;
    let carry = Buffer.alloc(0);
    const win = new Float32Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
    const ring = new Float32Array(FFT_N);
    let ringPos = 0, sinceHop = 0, filled = 0;
    let prevMag = null;
    const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
    proc.stdout.on('data', (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      carry = buf.subarray(usable);
      for (let o = 0; o < usable; o += 4) {
        const v = buf.readFloatLE(o);
        acc += v * v;
        if (++n === RMS_FRAME) { db.push(10 * Math.log10(acc / RMS_FRAME + 1e-12)); acc = 0; n = 0; }
        if (flux) {
          ring[ringPos] = v; ringPos = (ringPos + 1) % FFT_N; filled++;
          if (++sinceHop === HOP && filled >= FFT_N) {
            sinceHop = 0;
            for (let i = 0; i < FFT_N; i++) { re[i] = ring[(ringPos + i) % FFT_N] * win[i]; im[i] = 0; }
            fftMag(re, im);
            const half = FFT_N / 2;
            const mag = new Float32Array(half);
            let s = 0, lo = 0;
            for (let k = 1; k < half; k++) {
              const a = Math.hypot(re[k], im[k]);
              if (k <= 10) lo += a * a; // bins of 15.6 Hz: up to ~160 Hz
              mag[k] = Math.log1p(100 * a);
              if (prevMag) { const d = mag[k] - prevMag[k]; if (d > 0) s += d; }
            }
            prevMag = mag;
            fl.push(s);
            low.push(10 * Math.log10(lo + 1e-9));
          } else if (sinceHop === HOP) sinceHop = 0;
        }
      }
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Aborted'));
      if (code !== 0 && !db.length) return reject(new Error('audio decode failed: ' + err.slice(-300)));
      resolve({
        db: Float32Array.from(db), dbRate: SR / RMS_FRAME, flux: Float32Array.from(fl), low: Float32Array.from(low), fluxRate: SR / HOP,
        // a flux frame compares the window ending at sample FFT_N + j·HOP with the previous one; its peak comes one hop
        // after the window centre (measured on a click track: centre alone gave beats 15 ms early)
        fluxOffset: (FFT_N / 2 + HOP) / SR, duration: (db.length * RMS_FRAME) / SR,
      });
    });
  });
}

function percentile(arr, p) {
  const a = Array.from(arr).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return -100;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}

/**
 * Adaptive silence detection on the dB envelope.
 * Returns { floorDb, speechDb, thresholdDb, silences:[{start,end}] }
 */
export function detectSilences(env, { minSilence = 0.35, thresholdDb = null } = {}) {
  const { db, dbRate } = env;
  const floor = percentile(db, 0.1);
  const speech = percentile(db, 0.9);
  const thr = thresholdDb ?? Math.max(-60, Math.min(speech - 12, floor + Math.max(6, (speech - floor) * 0.3)));
  const out = [];
  let runStart = -1;
  for (let i = 0; i <= db.length; i++) {
    const quiet = i < db.length && db[i] < thr;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      const s = runStart / dbRate, e = i / dbRate;
      if (e - s >= minSilence) out.push({ start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 });
      runStart = -1;
    }
  }
  return { floorDb: Math.round(floor * 10) / 10, speechDb: Math.round(speech * 10) / 10, thresholdDb: Math.round(thr * 10) / 10, silences: out };
}

export const BEATS_VERSION = 2;

/**
 * Tempo, beats, bar grid and song sections.
 *  1. onset strength = spectral flux minus its *centred* local mean (v1 used a trailing mean: every beat came out
 *     ~0.22 s late), timed at the centre of its FFT window;
 *  2. tempo by autocorrelation, beats by Ellis-style dynamic programming;
 *  3. constant-tempo grid fitted on the whole track (period and phase refined against the onsets): no drift, even
 *     after minutes — the DP beats are kept when the tempo really varies;
 *  4. bars (downbeat phase) and sections / drops from the loudness and the low band (kick + bass) per bar.
 */
export function detectBeats(env) {
  const { flux, fluxRate: rate } = env;
  const off = env.fluxOffset ?? 0;
  if (!flux || flux.length < rate * 4) return null;
  const n = flux.length;
  // onset strength: flux minus its centred mean over ±0.25 s, rectified, unit variance
  const w = Math.round(rate * 0.25);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + flux[i];
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1);
    x[i] = Math.max(0, flux[i] - (pre[hi] - pre[lo]) / (hi - lo));
  }
  const sd = Math.sqrt(x.reduce((a, v) => a + v * v, 0) / n) || 1;
  for (let i = 0; i < n; i++) x[i] /= sd;
  const T = (fr) => fr / rate + off; // frame → seconds
  // autocorrelation over 60..200 bpm
  const minLag = Math.floor((60 * rate) / 200), maxLag = Math.ceil((60 * rate) / 60);
  const N = Math.min(n, Math.round(rate * 120));
  let best = -1, bestLag = minLag;
  const ac = new Float32Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    if (lag > 0 && lag < minLag - 1) continue;
    let s = 0;
    for (let i = 0; i + lag < N; i++) s += x[i] * x[i + lag];
    ac[lag] = s;
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * rate) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const v = ac[lag] * prior;
    if (v > best) { best = v; bestLag = lag; }
  }
  const a0 = ac[bestLag - 1] || 0, b0 = ac[bestLag], c0 = ac[bestLag + 1] || 0;
  const denom = a0 - 2 * b0 + c0;
  const period = denom !== 0 ? bestLag + Math.max(-0.5, Math.min(0.5, (0.5 * (a0 - c0)) / denom)) : bestLag;
  // DP beat tracking
  const alpha = 100;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestPrev = 0, bestIdx = -1;
    const lo = Math.max(0, Math.round(i - 2 * period)), hi = Math.round(i - period / 2);
    for (let j = lo; j <= hi && j < i; j++) {
      const r = Math.log((i - j) / period);
      const v = score[j] - alpha * r * r;
      if (bestIdx < 0 || v > bestPrev) { bestPrev = v; bestIdx = j; }
    }
    score[i] = x[i] + (bestIdx >= 0 ? bestPrev : 0);
    back[i] = bestIdx;
  }
  let end = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > score[end]) end = i;
  const idx = [];
  for (let i = end; i >= 0; i = back[i]) idx.push(i);
  idx.reverse();
  const xAt = (fr) => { if (fr < 0 || fr > n - 1) return 0; const i = Math.floor(fr), f = fr - i; return x[i] * (1 - f) + (x[i + 1] ?? 0) * f; };
  // smoothed onset curve for the grid fit (tolerant to ±1 frame)
  const xs = new Float32Array(n);
  for (let i = 0; i < n; i++) xs[i] = 0.25 * (x[i - 1] || 0) + 0.5 * x[i] + 0.25 * (x[i + 1] || 0);
  const xsAt = (fr) => { if (fr < 0 || fr > n - 1) return 0; const i = Math.floor(fr), f = fr - i; return xs[i] * (1 - f) + (xs[i + 1] ?? 0) * f; };
  // constant-tempo grid: least squares on the DP beats, then period / phase refined on the onsets of the whole track
  let P = period, ph = idx.length ? idx[0] : 0;
  if (idx.length >= 8) {
    // beat numbers by rounding (the DP may skip or add a beat in a break: plain indices would bend the line)
    const k = [0];
    for (let i = 1; i < idx.length; i++) k.push(k[i - 1] + Math.max(1, Math.round((idx[i] - idx[i - 1]) / period)));
    const m = idx.length;
    const mk = k.reduce((a, v) => a + v, 0) / m, mt = idx.reduce((a, v) => a + v, 0) / m;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < m; i++) { sxy += (k[i] - mk) * (idx[i] - mt); sxx += (k[i] - mk) ** 2; }
    if (sxx > 0 && Math.abs(sxy / sxx - period) < period * 0.05) { P = sxy / sxx; ph = mt - P * mk; }
  }
  const gridScore = (p, p0) => { let s = 0; for (let fr = p0 - Math.floor(p0 / p) * p; fr < n; fr += p) s += xsAt(fr); return s; };
  let bestG = -1, bestP = P, bestPh = ph;
  for (let dp = -0.004; dp <= 0.004 + 1e-9; dp += 0.0002) {
    const p = P * (1 + dp);
    for (let d0 = -2; d0 <= 2 + 1e-9; d0 += 0.25) {
      const v = gridScore(p, ph + d0);
      if (v > bestG) { bestG = v; bestP = p; bestPh = ph + d0; }
    }
  }
  P = bestP; ph = bestPh - Math.floor(bestPh / P) * P; // first grid beat ≥ 0
  {
    let bv = -1, bp = ph; // fine phase: ±1 frame in 1/8 frame steps
    for (let d = -1; d <= 1 + 1e-9; d += 0.125) { const v = gridScore(P, ph + d); if (v > bv) { bv = v; bp = ph + d; } }
    ph = bp < 0 ? bp + P : bp;
  }
  const gridIdx = [];
  for (let fr = ph; fr < n; fr += P) gridIdx.push(fr);
  // constant tempo? Slide over the track 16 beats at a time and find the phase shift (±80 ms) that best fits the onsets
  // there: on a constant-tempo track every window agrees with the global grid. (The DP beats cannot be the reference:
  // they wander in breaks with few onsets.)
  const shifts = [];
  const maxD = Math.round(0.08 * rate * 4) / 4;
  for (let w0 = 0; w0 + 16 <= gridIdx.length; w0 += 8) {
    let bestV = -1, bestD = 0, sum0 = 0;
    for (let d = -maxD; d <= maxD + 1e-9; d += 0.25) {
      let v = 0;
      for (let k = w0; k < w0 + 16; k++) v += xsAt(gridIdx[k] + d);
      if (Math.abs(d) < 1e-9) sum0 = v;
      if (v > bestV) { bestV = v; bestD = d; }
    }
    if (bestV > 16 * 0.6) shifts.push({ d: Math.abs(bestD) / rate, gain: bestV - sum0 }); // windows with real beats only
  }
  const sh = shifts.map((x) => x.d).sort((p, q) => p - q);
  const medRes = sh.length ? sh[Math.floor(sh.length / 2)] : 1;
  const onGrid = sh.length ? sh.filter((d) => d <= 0.025).length / sh.length : 0;
  const constant = sh.length >= 2 && medRes <= 0.02 && onGrid >= 0.8;
  const beatFrames = constant ? gridIdx : idx;
  const beats = beatFrames.map(T);
  // downbeat phase (4/4): onsets + rises of the low band (kick / bass coming in) on the bar starts
  const low = env.low;
  const lowAt = (t) => { if (!low?.length) return 0; const i = Math.max(0, Math.min(low.length - 1, Math.round((t - off) * rate))); return low[i]; };
  const phaseScore = [0, 0, 0, 0];
  beatFrames.forEach((fr, i) => {
    const t = T(fr);
    const rise = Math.max(0, lowAt(t + 0.05) - lowAt(t - 0.25));
    phaseScore[i % 4] += xAt(fr) + 0.15 * rise;
  });
  const phase = phaseScore.indexOf(Math.max(...phaseScore));
  const downbeats = beats.filter((_, i) => i % 4 === phase);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const bpm = (60 * rate) / P;
  const out = {
    version: BEATS_VERSION,
    bpm: Math.round(bpm * 100) / 100,
    beats: beats.map(r3),
    downbeats: downbeats.map(r3),
    confidence: Math.round(Math.min(1, best / (ac[0] || best || 1)) * 100) / 100,
    grid: {
      constant, bpm: Math.round(bpm * 1000) / 1000, beatSec: Math.round((P / rate) * 1e6) / 1e6, beatsPerBar: 4,
      firstBeat: r3(beats[0] ?? 0), firstDownbeat: r3(downbeats[0] ?? 0), medianErrorMs: Math.round(medRes * 1000),
    },
  };
  Object.assign(out, musicSections(env, downbeats, bpm));
  return out;
}

/**
 * Sections of a song from its bars: loudness (RMS) and low band per bar, change points near phrase boundaries.
 * kind: intro, drop (energy and bass jump up), break (they fall), build (rising run right before a drop), rise, change, outro.
 */
function musicSections(env, downbeats, bpm) {
  const { db, dbRate } = env;
  const low = env.low, lowRate = env.fluxRate, off = env.fluxOffset ?? 0;
  if (downbeats.length < 8) return { bars: downbeats.length, sections: [], drops: [] };
  const barDur = (60 / bpm) * 4;
  const bars = downbeats.map((t, i) => [t, downbeats[i + 1] ?? t + barDur]);
  const mean = (arr, rate, a, b, shift = 0) => {
    const i0 = Math.max(0, Math.floor((a - shift) * rate)), i1 = Math.min(arr.length, Math.ceil((b - shift) * rate));
    if (i1 <= i0) return -100;
    let s = 0;
    for (let i = i0; i < i1; i++) s += Math.pow(10, arr[i] / 10);
    return 10 * Math.log10(s / (i1 - i0) + 1e-12);
  };
  const E = bars.map(([a, b]) => mean(db, dbRate, a, b));
  const L = low?.length ? bars.map(([a, b]) => mean(low, lowRate, a, b, off)) : E;
  const avg = (arr, a, b) => { const s = arr.slice(Math.max(0, a), Math.min(arr.length, b)); return s.length ? s.reduce((p, q) => p + q, 0) / s.length : null; };
  const loud = [...E].sort((p, q) => p - q);
  const loudRef = loud[Math.floor(loud.length * 0.6)];
  // change at each bar: the 4 bars after vs the 4 bars before (loudness + bass), phrase boundaries (every 4 bars) favoured
  const cand = [];
  for (let b = 2; b < bars.length - 1; b++) {
    const e1 = avg(E, b, b + 4), e0 = avg(E, b - 4, b), l1 = avg(L, b, b + 4), l0 = avg(L, b - 4, b);
    if (e1 == null || e0 == null) continue;
    const dE = e1 - e0, dL = l1 - l0;
    cand.push({ b, dE, dL, mag: (Math.abs(dE) + 0.5 * Math.abs(dL)) * (b % 4 === 0 ? 1.25 : 1) });
  }
  cand.sort((p, q) => q.mag - p.mag);
  const picked = [];
  for (const c of cand) {
    if (c.mag < 3) break;
    if (picked.some((p) => Math.abs(p.b - c.b) < 4)) continue;
    picked.push(c);
  }
  picked.sort((p, q) => p.b - q.b);
  const bounds = [0, ...picked.map((p) => p.b), bars.length];
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const sections = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const b0 = bounds[i], b1 = bounds[i + 1];
    const ch = picked.find((p) => p.b === b0);
    const e = avg(E, b0, b1), l = avg(L, b0, b1);
    let kind = i === 0 ? 'intro' : 'change';
    if (ch) {
      if (ch.dE >= 3 && ch.dL >= 3 && e >= loudRef - 1) kind = 'drop';
      else if (ch.dE <= -3 || ch.dL <= -5) kind = 'break';
      else if (ch.dE > 0) kind = 'rise';
    }
    sections.push({ start: r3(bars[b0][0]), end: r3(bars[b1 - 1][1]), bars: b1 - b0, kind, energyDb: Math.round(e * 10) / 10, bassDb: Math.round(l * 10) / 10 });
  }
  // the section right before a drop, when it gets louder bar after bar, is its build-up
  for (let i = 1; i < sections.length; i++) {
    if (sections[i].kind !== 'drop' || sections[i - 1].kind === 'drop' || sections[i - 1].kind === 'intro') continue;
    const s0 = bounds[i - 1], s1 = bounds[i];
    if (s1 - s0 >= 2 && E[s1 - 1] - E[s0] > 1.5) sections[i - 1].kind = 'build';
  }
  const last = sections[sections.length - 1];
  if (last && sections.length > 1 && last.kind !== 'drop' && last.energyDb < sections[sections.length - 2].energyDb - 3) last.kind = 'outro';
  return { bars: bars.length, sections, drops: sections.filter((x) => x.kind === 'drop').map((x) => x.start) };
}

/** Integrated loudness (LUFS), true peak via ffmpeg ebur128 metadata. */
export async function measureLoudness(file, workDir, { signal } = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const out = path.join(workDir, `ebur_${Date.now()}.txt`);
  try {
    await runFfmpeg(['-i', file, '-vn', '-af', `ebur128=metadata=1:peak=true,ametadata=mode=print:key=lavfi.r128.I:file='${out.replace(/\\/g, '/').replace(/:/g, '\\:')}'`, '-f', 'null', '-'], { signal, quiet: true, priority: 'low' });
    const txt = fs.readFileSync(out, 'utf8');
    const m = [...txt.matchAll(/lavfi\.r128\.I=(-?[\d.]+)/g)];
    const lufs = m.length ? Number(m[m.length - 1][1]) : null;
    return { integratedLufs: lufs };
  } catch {
    return { integratedLufs: null };
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}
