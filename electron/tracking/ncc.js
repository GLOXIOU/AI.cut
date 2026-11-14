// Single-object visual tracker: zero-mean normalized cross-correlation (NCC) template matching on grayscale frames.
// - works on a reduced copy of the frame so the template stays ~40 px (speed independent of the object size)
// - constant-velocity prediction, search window around the prediction, sub-pixel peak (parabola fit)
// - scale adaptation (±4 %) checked around the peak, slow template update anchored to the first template (no drift)
// - lost / recovered detection with a wider search
// Pure JS, no dependency (runs in the main process).

const TEMPLATE_MAX = 40;

/** Box-average downscale of a gray frame (Uint8Array, W×H) by factor k (≤ 1). */
export function downscale(src, W, H, k) {
  if (k >= 0.999) {
    const out = new Float32Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = src[i];
    return { img: out, w: W, h: H };
  }
  const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
  const out = new Float32Array(w * h);
  const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let s = 0;
      for (let yy = y0; yy < y1; yy++) { const row = yy * W; for (let xx = x0; xx < x1; xx++) s += src[row + xx]; }
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return { img: out, w, h };
}

/** Bilinear sample of a patch centred on (cx, cy) of size (pw, ph) resampled to (tw, th). */
function samplePatch(img, w, h, cx, cy, pw, ph, tw, th) {
  const out = new Float32Array(tw * th);
  const x0 = cx - pw / 2, y0 = cy - ph / 2;
  for (let j = 0; j < th; j++) {
    const fy = Math.min(h - 1.001, Math.max(0, y0 + ((j + 0.5) * ph) / th - 0.5));
    const iy = Math.floor(fy), dy = fy - iy;
    for (let i = 0; i < tw; i++) {
      const fx = Math.min(w - 1.001, Math.max(0, x0 + ((i + 0.5) * pw) / tw - 0.5));
      const ix = Math.floor(fx), dx = fx - ix;
      const a = img[iy * w + ix], b = img[iy * w + ix + 1], c = img[(iy + 1) * w + ix], d = img[(iy + 1) * w + ix + 1];
      out[j * tw + i] = a + (b - a) * dx + (c - a) * dy + (a - b - c + d) * dx * dy;
    }
  }
  return out;
}

/** Zero-mean template + its norm. */
function prepare(t) {
  let m = 0;
  for (let i = 0; i < t.length; i++) m += t[i];
  m /= t.length;
  const z = new Float32Array(t.length);
  let n = 0;
  for (let i = 0; i < t.length; i++) { z[i] = t[i] - m; n += z[i] * z[i]; }
  return { z, norm: Math.sqrt(n) || 1 };
}

/** Integral images (sum, sum of squares) of a float image. */
function integrals(img, w, h) {
  const S = new Float64Array((w + 1) * (h + 1)), Q = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rq = 0;
    for (let x = 0; x < w; x++) {
      const v = img[y * w + x];
      rs += v; rq += v * v;
      const k = (y + 1) * (w + 1) + x + 1;
      S[k] = S[k - (w + 1)] + rs;
      Q[k] = Q[k - (w + 1)] + rq;
    }
  }
  return { S, Q, W1: w + 1 };
}

/** NCC of template tz (tw×th, zero-mean) at top-left (x, y) of img. */
function nccAt(img, w, ii, tz, tnorm, tw, th, x, y) {
  const { S, Q, W1 } = ii;
  const a = y * W1 + x, b = a + tw, c = (y + th) * W1 + x, d = c + tw;
  const n = tw * th;
  const sum = S[d] - S[b] - S[c] + S[a];
  const sq = Q[d] - Q[b] - Q[c] + Q[a];
  const varw = sq - (sum * sum) / n;
  if (varw < 1e-3 * n) return -1;
  let dot = 0;
  for (let j = 0; j < th; j++) {
    const row = (y + j) * w + x, trow = j * tw;
    for (let i = 0; i < tw; i++) dot += tz[trow + i] * img[row + i];
  }
  return dot / (tnorm * Math.sqrt(varw));
}

export class NccTracker {
  /**
   * frame: Uint8Array gray W×H. box: { cx, cy, w, h } in frame px.
   */
  constructor(frame, W, H, box) {
    this.W = W; this.H = H;
    this.k = Math.min(1, TEMPLATE_MAX / Math.max(box.w, box.h, 1));
    const lv = downscale(frame, W, H, this.k);
    this.lw = lv.w; this.lh = lv.h;
    this.kx = lv.w / W; this.ky = lv.h / H;
    this.cx = box.cx * this.kx; this.cy = box.cy * this.ky;
    this.bw = Math.max(6, box.w * this.kx); this.bh = Math.max(6, box.h * this.ky);
    this.tw = Math.max(6, Math.round(this.bw)); this.th = Math.max(6, Math.round(this.bh));
    const t0 = samplePatch(lv.img, lv.w, lv.h, this.cx, this.cy, this.bw, this.bh, this.tw, this.th);
    this.t0 = t0;
    this.t = Float32Array.from(t0);
    this.vx = 0; this.vy = 0;
    this.lostFrames = 0;
    this.score = 1;
  }

  get box() { return { cx: this.cx / this.kx, cy: this.cy / this.ky, w: this.bw / this.kx, h: this.bh / this.ky }; }

  /** Re-anchor on a new box (e.g. a face re-detection). */
  reset(frame, box, blend = 1) {
    const lv = downscale(frame, this.W, this.H, this.k);
    const nb = { cx: box.cx * this.kx, cy: box.cy * this.ky, w: box.w * this.kx, h: box.h * this.ky };
    this.cx += (nb.cx - this.cx) * blend; this.cy += (nb.cy - this.cy) * blend;
    this.bw += (nb.w - this.bw) * blend; this.bh += (nb.h - this.bh) * blend;
    const p = samplePatch(lv.img, lv.w, lv.h, this.cx, this.cy, this.bw, this.bh, this.tw, this.th);
    for (let i = 0; i < p.length; i++) { this.t[i] = this.t[i] * (1 - blend) + p[i] * blend; this.t0[i] = this.t0[i] * (1 - blend * 0.5) + p[i] * blend * 0.5; }
    this.lostFrames = 0;
  }

  /** Track into the next frame. Returns { box (frame px), score, lost }. */
  update(frame) {
    const lv = downscale(frame, this.W, this.H, this.k);
    const { img, w, h } = lv;
    const ii = integrals(img, w, h);
    const { tw, th } = this;
    const lost = this.lostFrames > 8;
    const R = Math.round(Math.max(6, 0.45 * Math.max(tw, th)) * (lost ? 3 : 1));
    const pcx = this.cx + this.vx, pcy = this.cy + this.vy;
    const T = prepare(this.t);
    // template is matched at its own size; the box can be resized by the scale step below
    let best = -2, bx = 0, by = 0;
    const scores = new Map();
    const x0 = Math.round(pcx - tw / 2), y0 = Math.round(pcy - th / 2);
    const step = lost ? 2 : 1;
    for (let dy = -R; dy <= R; dy += step) {
      const y = y0 + dy;
      if (y < 0 || y + th > h) continue;
      for (let dx = -R; dx <= R; dx += step) {
        const x = x0 + dx;
        if (x < 0 || x + tw > w) continue;
        const s = nccAt(img, w, ii, T.z, T.norm, tw, th, x, y);
        scores.set(y * 65536 + x, s);
        if (s > best) { best = s; bx = x; by = y; }
      }
    }
    if (best < -1) return { box: this.box, score: 0, lost: true };
    // lost for a while: look for the object anywhere in the frame with its FIRST template (re-acquisition)
    if (lost && best < 0.55 && (this.lostFrames % 6 === 0)) {
      const T0 = prepare(this.t0);
      let gb = -2, gx = 0, gy = 0;
      for (let y = 0; y + th <= h; y += 2) for (let x = 0; x + tw <= w; x += 2) {
        const s = nccAt(img, w, ii, T0.z, T0.norm, tw, th, x, y);
        if (s > gb) { gb = s; gx = x; gy = y; }
      }
      if (gb > 0.62) {
        this.cx = gx + tw / 2; this.cy = gy + th / 2; this.vx = 0; this.vy = 0; this.lostFrames = 0;
        this.t.set(this.t0);
        return { box: this.box, score: gb, lost: false, reacquired: true };
      }
    }
    if (step > 1) { // refine the coarse search
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x + tw > w || y + th > h || scores.has(y * 65536 + x)) continue;
        const s = nccAt(img, w, ii, T.z, T.norm, tw, th, x, y);
        scores.set(y * 65536 + x, s);
        if (s > best) { best = s; bx = x; by = y; }
      }
    }
    // sub-pixel peak
    const sc = (x, y) => scores.get(y * 65536 + x) ?? nccAt(img, w, ii, T.z, T.norm, tw, th, x, y);
    let ox = 0, oy = 0;
    if (bx > 0 && bx + tw < w) { const l = sc(bx - 1, by), r = sc(bx + 1, by), d = l - 2 * best + r; if (d < -1e-6) ox = Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d))); }
    if (by > 0 && by + th < h) { const u = sc(bx, by - 1), dn = sc(bx, by + 1), d = u - 2 * best + dn; if (d < -1e-6) oy = Math.max(-0.5, Math.min(0.5, (u - dn) / (2 * d))); }
    const ncx = bx + ox + tw / 2, ncy = by + oy + th / 2;
    this.score = best;
    if (best < 0.35) {
      this.lostFrames++;
      // hold position (coast on a damped velocity)
      this.vx *= 0.8; this.vy *= 0.8;
      this.cx += this.vx; this.cy += this.vy;
      return { box: this.box, score: Math.max(0, best), lost: this.lostFrames > 8 };
    }
    if (lost && best < 0.55) { this.lostFrames++; return { box: this.box, score: best, lost: true }; }
    this.lostFrames = 0;
    this.vx = 0.6 * this.vx + 0.4 * (ncx - this.cx);
    this.vy = 0.6 * this.vy + 0.4 * (ncy - this.cy);
    this.cx = ncx; this.cy = ncy;
    // scale: compare the current window with windows 4 % smaller / larger (resampled to the template size)
    if (best > 0.5) {
      let bs = 1, bsc = best;
      for (const s of [0.96, 1.04]) {
        const p = prepare(samplePatch(img, w, h, this.cx, this.cy, this.bw * s, this.bh * s, tw, th));
        let dot = 0;
        for (let i = 0; i < p.z.length; i++) dot += p.z[i] * T.z[i];
        const v = dot / (p.norm * T.norm);
        if (v > bsc + 0.012) { bsc = v; bs = s; }
      }
      if (bs !== 1) { this.bw = Math.max(4, Math.min(w, this.bw * (1 + (bs - 1) * 0.6))); this.bh = Math.max(4, Math.min(h, this.bh * (1 + (bs - 1) * 0.6))); }
    }
    // template update, anchored on the first template
    if (best > 0.7) {
      const p = samplePatch(img, w, h, this.cx, this.cy, this.bw, this.bh, tw, th);
      for (let i = 0; i < p.length; i++) this.t[i] = this.t[i] * 0.86 + p[i] * 0.09 + this.t0[i] * 0.05;
    }
    return { box: this.box, score: best, lost: false };
  }
}

/** Centered moving average of tracked points (in place on [t, cx, cy, w, h, conf]). */
export function smoothPoints(points, rPos = 2, rSize = 5) {
  const n = points.length;
  if (n < 3) return points;
  const src = points.map((p) => p.slice());
  for (let i = 0; i < n; i++) {
    for (const [k, r] of [[1, rPos], [2, rPos], [3, rSize], [4, rSize]]) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) { const wgt = (src[j][5] ?? 1) > 0.3 ? 1 : 0.2; s += src[j][k] * wgt; c += wgt; }
      points[i][k] = s / c;
    }
  }
  return points;
}

export function iou(a, b) {
  const x0 = Math.max(a.cx - a.w / 2, b.cx - b.w / 2), x1 = Math.min(a.cx + a.w / 2, b.cx + b.w / 2);
  const y0 = Math.max(a.cy - a.h / 2, b.cy - b.h / 2), y1 = Math.min(a.cy + a.h / 2, b.cy + b.h / 2);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}
