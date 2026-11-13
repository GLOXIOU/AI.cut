// Audio synchronisation between two recordings of the same sound (multicam, external mic, phone rush ↔ clean music).
// Coarse: cross-correlation of onset envelopes (100 / s, robust to room acoustics, phone mics and level differences),
// computed with an FFT over the whole files. Fine: parabolic peak interpolation, then a waveform correlation (8 kHz)
// around the coarse lag when the two signals are similar enough to make it meaningful.
import { requireFfmpeg } from '../media/ffmpeg.js';
import { spawnTracked } from '../core/proc.js';

const SR = 8000;
const ENV_HOP = 80; // 10 ms
const ENV_RATE = SR / ENV_HOP;
const ENV_FFT = 256;

/** Decode mono PCM float32 at `sr` Hz. start / duration in seconds (optional). */
export function decodeMono(file, { sr = SR, start = 0, duration = null, signal } = {}) {
  const bin = requireFfmpeg();
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', String(start));
  if (duration) args.push('-t', String(duration));
  args.push('-i', file, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', 'pipe:1');
  return new Promise((resolve, reject) => {
    const proc = spawnTracked(bin, args, {}, { lowPriority: true });
    const chunks = [];
    let len = 0, err = '';
    proc.stdout.on('data', (d) => { chunks.push(d); len += d.length; });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Aborted'));
      if (!len && code !== 0) return reject(new Error(`audio decode failed: ${err.trim().slice(-300)}`));
      const buf = Buffer.concat(chunks, len - (len % 4));
      resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice());
    });
  });
}

/** In-place iterative radix-2 complex FFT (inverse = true for the unscaled inverse). */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const br = re[b] * cr - im[b] * ci, bi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - br; im[b] = im[a] - bi;
        re[a] += br; im[a] += bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// band edges (Hz) of the loudness envelopes: they carry the arrangement (bass / voice / hats), which tells apart two
// repetitions of the same loop that the onsets alone cannot (an EDM chorus repeats every 16 bars)
const BANDS = [[90, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 3900]];

const zscore = (y) => {
  const n = y.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += y[i];
  m /= n || 1;
  let v = 0;
  for (let i = 0; i < n; i++) { y[i] -= m; v += y[i] * y[i]; }
  const sd = Math.sqrt(v / (n || 1)) || 1;
  for (let i = 0; i < n; i++) y[i] /= sd;
  return y;
};

/**
 * Features at 100 values / s: onset strength (positive log-spectral flux minus its ±0.5 s mean) and the log energy
 * of a few frequency bands. Every feature has zero mean and unit variance.
 */
export function audioFeatures(x) {
  const n = Math.max(0, Math.floor((x.length - ENV_FFT) / ENV_HOP) + 1);
  const flux = new Float32Array(n);
  const bands = BANDS.map(() => new Float32Array(n));
  const bin = (hz) => Math.max(1, Math.min(ENV_FFT / 2 - 1, Math.round((hz * ENV_FFT) / SR)));
  const edges = BANDS.map(([a, b]) => [bin(a), Math.max(bin(a) + 1, bin(b))]);
  const win = new Float64Array(ENV_FFT);
  for (let i = 0; i < ENV_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / ENV_FFT);
  const re = new Float64Array(ENV_FFT), im = new Float64Array(ENV_FFT);
  const half = ENV_FFT / 2;
  let prev = new Float32Array(half), mag = new Float32Array(half), first = true;
  for (let f = 0; f < n; f++) {
    const o = f * ENV_HOP;
    for (let i = 0; i < ENV_FFT; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let s = 0;
    for (let k = 1; k < half; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      mag[k] = Math.log1p(1000 * Math.sqrt(p));
      if (!first) { const d = mag[k] - prev[k]; if (d > 0) s += d; }
    }
    for (let b = 0; b < edges.length; b++) {
      let e = 0;
      for (let k = edges[b][0]; k < edges[b][1]; k++) e += re[k] * re[k] + im[k] * im[k];
      bands[b][f] = Math.log10(e + 1e-9);
    }
    flux[f] = s;
    first = false;
    const t = prev; prev = mag; mag = t;
  }
  const w = 50;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + flux[i];
  const onset = new Float32Array(n);
  for (let i = 0; i < n; i++) { const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1); onset[i] = Math.max(0, flux[i] - (pre[hi] - pre[lo]) / (hi - lo)); }
  // bands: light smoothing (±50 ms), the absolute level matters less than its shape over time
  const smooth = (y) => { const out = new Float32Array(y.length); for (let i = 0; i < y.length; i++) { let a = 0, c = 0; for (let j = i - 5; j <= i + 5; j++) if (j >= 0 && j < y.length) { a += y[j]; c++; } out[i] = a / c; } return out; };
  return { onset: zscore(onset), bands: bands.map((b) => zscore(smooth(b))) };
}

/** Onset envelope only (see audioFeatures). */
export function onsetEnvelope(x) { return audioFeatures(x).onset; }

function prefix(y) {
  const s = new Float64Array(y.length + 1), s2 = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) { s[i + 1] = s[i] + y[i]; s2[i + 1] = s2[i] + y[i] * y[i]; }
  return { s, s2 };
}

/**
 * Cross-correlation c[lag] = Σ a[i + lag]·b[i] for lag in [-(nb - 1), na - 1], via FFT.
 * Returns { c: Float64Array, zero } where c[zero + lag] is the value for `lag`.
 */
function xcorr(a, b) {
  const na = a.length, nb = b.length;
  let size = 1;
  while (size < na + nb) size <<= 1;
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  // A · conj(B)
  for (let k = 0; k < size; k++) {
    const r = ar[k] * br[k] + ai[k] * bi[k], i = ai[k] * br[k] - ar[k] * bi[k];
    ar[k] = r; ai[k] = i;
  }
  fft(ar, ai, true);
  const c = new Float64Array(na + nb - 1);
  for (let lag = -(nb - 1); lag <= na - 1; lag++) c[lag + nb - 1] = ar[(lag + size) % size] / size;
  return { c, zero: nb - 1 };
}

/**
 * Offset of `other` relative to `ref`: other's time 0 sits at ref time `offset` (refTime = otherTime + offset).
 * opts: maxOffset (s, default unlimited), minOverlap (s). Returns { offset, confidence (z-score of the peak),
 * strength (0–1 normalised correlation), overlap (s), method }.
 */
export function findOffset(refPcm, otherPcm, { maxOffset = Infinity, minOverlap = null } = {}) {
  const FA = audioFeatures(refPcm), FB = audioFeatures(otherPcm);
  const A = FA.onset, B = FB.onset;
  if (A.length < ENV_RATE * 2 || B.length < ENV_RATE * 2) throw new Error('Audio too short to synchronise (need at least 2 s).');
  // normalised cross-correlation (Pearson r over the overlap of each lag) of the onsets (precise) and of the band
  // envelopes (which repetition of the music it is). Per-lag means / variances: silence matched with silence does not
  // count as similarity, and partial overlaps are not favoured.
  const feats = [[A, B, 1], ...FA.bands.map((band, i) => [band, FB.bands[i], 0.6])];
  const parts = feats.map(([a, b, w]) => ({ ...xcorr(a, b), a, b, w, pa: prefix(a), pb: prefix(b) }));
  const zero = parts[0].zero;
  const nccAt = (P, lag) => {
    const i0 = Math.max(0, lag), i1 = Math.min(P.a.length, lag + P.b.length); // overlap in a
    const n = i1 - i0;
    if (n < 2) return 0;
    const j0 = i0 - lag, j1 = i1 - lag; // overlap in b
    const sa = P.pa.s[i1] - P.pa.s[i0], sa2 = P.pa.s2[i1] - P.pa.s2[i0];
    const sb = P.pb.s[j1] - P.pb.s[j0], sb2 = P.pb.s2[j1] - P.pb.s2[j0];
    const va = sa2 - (sa * sa) / n, vb = sb2 - (sb * sb) / n;
    if (va <= 1e-9 || vb <= 1e-9) return 0;
    return (P.c[zero + lag] - (sa * sb) / n) / Math.sqrt(va * vb);
  };
  const totalW = parts.reduce((k, P) => k + P.w, 0);
  const shorter = Math.min(A.length, B.length);
  const minOv = Math.max(ENV_RATE * 1.5, Math.min(ENV_RATE * (minOverlap ?? 6), shorter * 0.3));
  const lagMin = Math.max(-(B.length - 1), Math.ceil(-maxOffset * ENV_RATE)), lagMax = Math.min(A.length - 1, Math.floor(maxOffset * ENV_RATE));
  let best = -Infinity, bestLag = 0;
  let sum = 0, sum2 = 0, cnt = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const ov = Math.min(A.length, lag + B.length) - Math.max(0, lag);
    if (ov < minOv) continue;
    let v = 0;
    for (const P of parts) v += P.w * nccAt(P, lag);
    v = (v / totalW) * Math.min(1, Math.sqrt(ov / (ENV_RATE * 10))); // little overlap = weaker evidence
    sum += v; sum2 += v * v; cnt++;
    if (v > best) { best = v; bestLag = lag; }
  }
  if (!cnt) throw new Error('The two recordings do not overlap enough for the allowed offset range.');
  const mean = sum / cnt, sd = Math.sqrt(Math.max(1e-12, sum2 / cnt - mean * mean));
  const co = parts[0].c;
  // the band envelopes are smooth: the exact frame comes from the onsets alone, within ±40 ms of the combined peak
  const onsetAt = (lag) => (zero + lag >= 0 && zero + lag < co.length ? nccAt(parts[0], lag) : -Infinity);
  const coarse = bestLag;
  for (let lag = coarse - 4; lag <= coarse + 4; lag++) if (onsetAt(lag) > onsetAt(bestLag)) bestLag = lag;
  // sub-frame peak (parabola through the 3 points of the onset correlation)
  const y0 = onsetAt(bestLag - 1), y1 = onsetAt(bestLag), y2 = onsetAt(bestLag + 1);
  let frac = 0;
  if (Number.isFinite(y0) && Number.isFinite(y2)) { const d = y0 - 2 * y1 + y2; if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)); }
  let offset = (bestLag + frac) / ENV_RATE;
  const overlap = (Math.min(A.length, bestLag + B.length) - Math.max(0, bestLag)) / ENV_RATE;
  let method = 'onset-envelope';
  // fine: waveform correlation (±25 ms) on the loudest 12 s of the overlap — kept only if clearly better defined
  const fine = refineWaveform(refPcm, otherPcm, offset, overlap);
  if (fine) { offset = fine.offset; method = 'waveform'; }
  return {
    offset: Math.round(offset * 10000) / 10000,
    confidence: Math.round(((best - mean) / sd) * 10) / 10,
    strength: Math.round(Math.max(0, best) * 1000) / 1000,
    overlap: Math.round(overlap * 10) / 10,
    method,
  };
}

function refineWaveform(ref, other, offset, overlap) {
  const lagS = Math.round(offset * SR); // ref index = other index + lagS
  const span = Math.min(12 * SR, Math.floor(overlap * SR) - 2 * 200);
  if (span < SR * 2) return null;
  // loudest window of `other` inside the overlap
  const o0 = Math.max(0, -lagS) + 200, o1 = Math.min(other.length, ref.length - lagS) - 200 - span;
  if (o1 <= o0) return null;
  let bestStart = o0, bestE = -1;
  const step = SR;
  for (let s = o0; s <= o1; s += step) {
    let e = 0;
    for (let i = s; i < s + span; i += 16) e += other[i] * other[i];
    if (e > bestE) { bestE = e; bestStart = s; }
  }
  const R = 200; // ±25 ms
  const vals = new Float64Array(2 * R + 1);
  let eo = 0;
  for (let i = bestStart; i < bestStart + span; i++) eo += other[i] * other[i];
  let best = -Infinity, bestK = 0, sumAbs = 0;
  for (let k = -R; k <= R; k++) {
    let s = 0, er = 0;
    const base = bestStart + lagS + k;
    for (let i = 0; i < span; i += 2) { const r = ref[base + i]; s += r * other[bestStart + i]; er += r * r; }
    const v = Math.abs(s) / Math.sqrt((er * eo) / 2 + 1e-12);
    vals[k + R] = v;
    sumAbs += v;
    if (v > best) { best = v; bestK = k; }
  }
  const mean = sumAbs / vals.length;
  // a meaningful waveform peak is sharp: well above the average correlation in the ±25 ms window
  if (!(best > 0.2 && best > mean * 2.5)) return null;
  let frac = 0;
  const y0 = vals[bestK + R - 1], y1 = vals[bestK + R], y2 = vals[bestK + R + 1];
  if (y0 !== undefined && y2 !== undefined) { const d = y0 - 2 * y1 + y2; if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)); }
  return { offset: (lagS + bestK + frac) / SR, peak: best };
}

/** Decode both files and find the offset (see findOffset). opts.refRange / otherRange: {start, duration} to limit decoding. */
export async function syncFiles(refFile, otherFile, opts = {}) {
  const [ref, other] = await Promise.all([
    decodeMono(refFile, { ...(opts.refRange || {}), signal: opts.signal }),
    decodeMono(otherFile, { ...(opts.otherRange || {}), signal: opts.signal }),
  ]);
  const r = findOffset(ref, other, opts);
  const r0 = opts.refRange?.start || 0, o0 = opts.otherRange?.start || 0;
  return { ...r, offset: Math.round((r.offset + r0 - o0) * 10000) / 10000 };
}
