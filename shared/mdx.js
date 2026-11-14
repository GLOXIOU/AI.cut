// Voice / music separation with an MDX-Net model (UVR "Kim_Vocal_2", ONNX): STFT → model → inverse STFT.
// No imports: used by the hidden ML page (resources/runtime/segment.html) and by Node tests alike.
//
// The model sees spectrogram chunks [1, 4, dimF, dimT] = (L re, L im, R re, R im) × frequency bins × frames with
// torch.stft conventions (periodic Hann window, center=True with reflect padding, hop 1024). Chunks are taken with
// overlap `trim` (= nFft / 2) on both sides; only their centre is kept (same scheme as UVR).

export const MDX_MODELS = {
  'kim-vocal-2': {
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
    file: 'Kim_Vocal_2.onnx', size: 66759214, nFft: 7680, hop: 1024, dimF: 3072, dimT: 256, compensate: 1.009, sampleRate: 44100,
  },
};

// ------------------------------------------------------------------------------------------------ FFT
/** In-place radix-2 complex FFT (n power of two). */
function fft2(re, im, inverse = false) {
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
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Arbitrary-size DFT via Bluestein (chirp-z) on power-of-two FFTs. Plans are cached per size. */
const plans = new Map();
function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const cr = new Float64Array(n), ci = new Float64Array(n); // chirp w_k = exp(-i π k² / n)
  for (let k = 0; k < n; k++) { const a = (Math.PI * ((k * k) % (2 * n))) / n; cr[k] = Math.cos(a); ci[k] = -Math.sin(a); }
  const br = new Float64Array(m), bi = new Float64Array(m); // conj chirp, wrapped
  br[0] = cr[0]; bi[0] = -ci[0];
  for (let k = 1; k < n; k++) { br[k] = br[m - k] = cr[k]; bi[k] = bi[m - k] = -ci[k]; }
  fft2(br, bi);
  p = { n, m, cr, ci, br, bi, ar: new Float64Array(m), ai: new Float64Array(m) };
  plans.set(n, p);
  return p;
}

/** Forward (sign -1) or inverse (sign +1, unscaled) DFT of complex input (xr, xi) of length n into (or, oi). */
export function dft(xr, xi, or, oi, inverse = false) {
  const n = xr.length;
  if ((n & (n - 1)) === 0) {
    or.set(xr); oi.set(xi);
    const r = Float64Array.from(or), i = Float64Array.from(oi);
    fft2(r, i, inverse);
    or.set(r); oi.set(i);
    return;
  }
  const p = plan(n);
  const { m, cr, ci, br, bi, ar, ai } = p;
  ar.fill(0); ai.fill(0);
  const s = inverse ? -1 : 1; // inverse = conj(DFT(conj x))
  for (let k = 0; k < n; k++) {
    const x = xr[k], y = s * xi[k];
    ar[k] = x * cr[k] - y * ci[k]; ai[k] = x * ci[k] + y * cr[k];
  }
  fft2(ar, ai);
  for (let k = 0; k < m; k++) { const x = ar[k] * br[k] - ai[k] * bi[k]; ai[k] = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = x; }
  fft2(ar, ai, true);
  for (let k = 0; k < n; k++) {
    const x = ar[k] / m, y = ai[k] / m;
    or[k] = x * cr[k] - y * ci[k];
    oi[k] = s * (x * ci[k] + y * cr[k]);
  }
}

// ------------------------------------------------------------------------------------------------ STFT
const hann = new Map();
function window(n) { // periodic Hann (torch.hann_window default)
  let w = hann.get(n);
  if (!w) { w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); hann.set(n, w); }
  return w;
}

/**
 * STFT of a mono signal (center=True, reflect padding) → { re, im } as Float32Array [bins × frames] (bin-major).
 * Two channels are transformed at once (L + iR) to halve the cost: returns [{re, im}, {re, im}].
 */
export function stftStereo(L, R, nFft, hop, frames) {
  const bins = nFft / 2 + 1, half = nFft / 2, w = window(nFft);
  const N = L.length;
  const reflect = (x, i) => { if (i < 0) i = -i; if (i >= N) i = 2 * (N - 1) - i; return x[Math.max(0, Math.min(N - 1, i))]; };
  const out = [{ re: new Float32Array(bins * frames), im: new Float32Array(bins * frames) }, { re: new Float32Array(bins * frames), im: new Float32Array(bins * frames) }];
  const xr = new Float64Array(nFft), xi = new Float64Array(nFft), yr = new Float64Array(nFft), yi = new Float64Array(nFft);
  for (let f = 0; f < frames; f++) {
    const s = f * hop - half;
    for (let i = 0; i < nFft; i++) { xr[i] = reflect(L, s + i) * w[i]; xi[i] = reflect(R, s + i) * w[i]; }
    dft(xr, xi, yr, yi);
    for (let b = 0; b < bins; b++) {
      const nb = (nFft - b) % nFft;
      // separate the two real spectra: X = (Y[b] + conj(Y[N-b])) / 2, Z = (Y[b] - conj(Y[N-b])) / 2i
      const ar = yr[b], ai = yi[b], cr = yr[nb], ci = -yi[nb];
      out[0].re[b * frames + f] = (ar + cr) / 2; out[0].im[b * frames + f] = (ai + ci) / 2;
      out[1].re[b * frames + f] = (ai - ci) / 2; out[1].im[b * frames + f] = -(ar - cr) / 2;
    }
  }
  return out;
}

/** Inverse STFT (center=True) of two channels at once, overlap-add with window² normalisation → [L, R] of length. */
export function istftStereo(specL, specR, nFft, hop, frames, length) {
  const bins = nFft / 2 + 1, half = nFft / 2, w = window(nFft);
  const total = (frames - 1) * hop + nFft;
  const oL = new Float64Array(total), oR = new Float64Array(total), norm = new Float64Array(total);
  const xr = new Float64Array(nFft), xi = new Float64Array(nFft), yr = new Float64Array(nFft), yi = new Float64Array(nFft);
  for (let f = 0; f < frames; f++) {
    // Y = X + iZ with Hermitian X, Z: Y[b] = X[b] + i Z[b], Y[N-b] = conj(X[b]) + i conj(Z[b])
    for (let b = 0; b < bins; b++) {
      const k = b * frames + f;
      const Xr = specL.re[k], Xi = specL.im[k], Zr = specR.re[k], Zi = specR.im[k];
      xr[b] = Xr - Zi; xi[b] = Xi + Zr;
      if (b > 0 && b < nFft - b) { const nb = nFft - b; xr[nb] = Xr + Zi; xi[nb] = -Xi + Zr; }
    }
    dft(xr, xi, yr, yi, true);
    const s = f * hop;
    for (let i = 0; i < nFft; i++) {
      const v = w[i] / nFft;
      oL[s + i] += yr[i] * v; oR[s + i] += yi[i] * v;
      norm[s + i] += w[i] * w[i];
    }
  }
  const L = new Float32Array(length), R = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const j = i + half, n = norm[j] > 1e-8 ? norm[j] : 1;
    L[i] = oL[j] / n; R[i] = oR[j] / n;
  }
  return [L, R];
}

/** Chunk geometry of a model. */
export function mdxGeometry(cfg) {
  const trim = cfg.nFft / 2;
  const chunk = cfg.hop * (cfg.dimT - 1);
  return { trim, chunk, gen: chunk - 2 * trim };
}

/** Model input [1, 4, dimF, dimT] for one chunk (L, R of length `chunk`). */
export function mdxInput(cfg, L, R) {
  const { dimF, dimT, nFft, hop } = cfg;
  const [sl, sr] = stftStereo(L, R, nFft, hop, dimT);
  const plane = dimF * dimT;
  const x = new Float32Array(4 * plane);
  x.set(sl.re.subarray(0, plane), 0); x.set(sl.im.subarray(0, plane), plane);
  x.set(sr.re.subarray(0, plane), 2 * plane); x.set(sr.im.subarray(0, plane), 3 * plane);
  return x;
}

/** Waveform [L, R] (length `chunk`) of a model output [1, 4, dimF, dimT] (missing high bins = 0). */
export function mdxOutput(cfg, y) {
  const { dimF, dimT, nFft, hop } = cfg;
  const bins = nFft / 2 + 1, plane = dimF * dimT;
  const spec = () => ({ re: new Float32Array(bins * dimT), im: new Float32Array(bins * dimT) });
  const a = spec(), b = spec();
  a.re.set(y.subarray(0, plane)); a.im.set(y.subarray(plane, 2 * plane));
  b.re.set(y.subarray(2 * plane, 3 * plane)); b.im.set(y.subarray(3 * plane, 4 * plane));
  return istftStereo(a, b, nFft, hop, dimT, hop * (dimT - 1));
}
