// Adjustment layers (Premiere's "adjustment layer"): a clip of type "adjust" on a video track modifies everything
// drawn BELOW it (lower tracks) while it is active: colour grade (clip.color, incl. the tone grade of shared/grade.js),
// blur and pixelation (clip.fx), optionally inside a mask (clip.mask: rectangle / ellipse, feathered, inverted, and
// able to follow a tracked object — see shared/follow.js). Opacity and video fades blend the effect in / out.
//
// Preview: a full-frame element with backdrop-filter + CSS mask-image. Export: the composite is split, processed,
// masked (alphamerge) and overlaid back. Both use the formulas below (same mask coverage, same filter values).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const n = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

export const FX_DEFAULTS = { blur: 0, pixelate: 0 };

/** { blur (px, gaussian σ like CSS blur()), pixelate (block size px) } or null. */
export function normalizeFx(fx) {
  if (!fx || typeof fx !== 'object') return null;
  const out = {
    blur: Math.round(clamp(n(fx.blur), 0, 300) * 100) / 100,
    pixelate: Math.round(clamp(n(fx.pixelate), 0, 400)),
  };
  if (out.pixelate === 1) out.pixelate = 0;
  return out.blur > 0 || out.pixelate > 1 ? out : null;
}

export const MASK_SHAPES = ['rect', 'ellipse'];
export const ANCHORS = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * Mask in normalized FRAME coordinates: { shape, cx, cy, w, h (0..1 of the project frame), feather (px), invert,
 * follow?: { tracking, clip?, anchor?, offsetX?, offsetY? } }. `_path` is added by bakeProject (frame px, see follow.js).
 */
export function normalizeMask(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {
    shape: MASK_SHAPES.includes(m.shape) ? m.shape : 'ellipse',
    cx: Math.round(clamp(n(m.cx, 0.5), -1, 2) * 1e5) / 1e5,
    cy: Math.round(clamp(n(m.cy, 0.5), -1, 2) * 1e5) / 1e5,
    w: Math.round(clamp(n(m.w, 0.3), 0.005, 3) * 1e5) / 1e5,
    h: Math.round(clamp(n(m.h, 0.3), 0.005, 3) * 1e5) / 1e5,
    feather: Math.round(clamp(n(m.feather, 20), 0, 1000)),
    invert: !!m.invert,
  };
  if (m.follow && typeof m.follow === 'object' && m.follow.tracking) {
    out.follow = { tracking: String(m.follow.tracking) };
    if (m.follow.clip) out.follow.clip = String(m.follow.clip);
    if (ANCHORS.includes(m.follow.anchor)) out.follow.anchor = m.follow.anchor;
    if (m.follow.offsetX) out.follow.offsetX = n(m.follow.offsetX);
    if (m.follow.offsetY) out.follow.offsetY = n(m.follow.offsetY);
    if (m.follow.size) out.follow.size = true; // the mask resizes with the tracked box
  }
  return out;
}

/** Mask geometry in frame px at clip-local time: { cx, cy, w, h, feather, shape, invert }. */
export function maskAt(clip, local, W, H) {
  const m = clip.mask;
  if (!m) return null;
  let cx = m.cx * W, cy = m.cy * H, w = m.w * W, h = m.h * H;
  const path = m._path;
  if (path?.length) {
    const p = samplePath(path, local);
    cx = p.x; cy = p.y;
    if (p.w) { w = p.w; h = p.h; }
  }
  return { cx, cy, w, h, feather: m.feather || 0, shape: m.shape, invert: !!m.invert };
}

/** Linear interpolation in a baked path [{t, x, y, w?, h?}] (held before / after). */
export function samplePath(path, t) {
  if (t <= path[0].t) return path[0];
  const last = path[path.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (path[mid].t <= t) lo = mid; else hi = mid; }
  const a = path[lo], b = path[hi];
  const k = (t - a.t) / Math.max(1e-9, b.t - a.t);
  const o = { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  if (a.w != null && b.w != null) { o.w = a.w + (b.w - a.w) * k; o.h = a.h + (b.h - a.h) * k; }
  return o;
}

/**
 * Coverage model shared by preview and export (outer half sizes include half the feather):
 *   ellipse: d = hypot(dx / Rx, dy / Ry), alpha = clip((1 - d) / (1 - p0)), p0 = 1 - feather / min(Rx, Ry)
 *   rect:    alpha = ramp(x) · ramp(y), each ramp rising over `feather` px at both edges of the outer box
 * Inverted masks use 1 - alpha. feather < 1 px is treated as 1 px (anti-aliased edge).
 */
export function maskParams(mk) {
  const f = Math.max(1, mk.feather || 0);
  const Rx = Math.max(1, mk.w / 2 + f / 2), Ry = Math.max(1, mk.h / 2 + f / 2);
  const p0 = clamp(1 - f / Math.min(Rx, Ry), 0, 0.9999);
  return { f, Rx, Ry, p0 };
}

/** JS coverage (tests). */
export function maskCoverage(mk, x, y) {
  const { f, Rx, Ry, p0 } = maskParams(mk);
  let a;
  if (mk.shape === 'rect') {
    const ax = clamp((x - (mk.cx - Rx)) / f, 0, 1) * clamp((mk.cx + Rx - x) / f, 0, 1);
    const ay = clamp((y - (mk.cy - Ry)) / f, 0, 1) * clamp((mk.cy + Ry - y) / f, 0, 1);
    a = ax * ay;
  } else {
    const d = Math.hypot((x - mk.cx) / Rx, (y - mk.cy) / Ry);
    a = clamp((1 - d) / (1 - p0), 0, 1);
  }
  return mk.invert ? 1 - a : a;
}

const px = (v) => `${Math.round(v * 100) / 100}px`;

/** CSS mask properties (frame px, element = the full frame) for the preview. */
export function cssMask(mk) {
  if (!mk) return { image: '', size: '', position: '', composite: '' };
  const { f, Rx, Ry, p0 } = maskParams(mk);
  if (mk.shape === 'rect') {
    const w = 2 * Rx, h = 2 * Ry;
    const gx = `linear-gradient(to right, transparent 0px, #000 ${px(f)}, #000 ${px(w - f)}, transparent ${px(w)})`;
    const gy = `linear-gradient(to bottom, transparent 0px, #000 ${px(f)}, #000 ${px(h - f)}, transparent ${px(h)})`;
    const pos = `${px(mk.cx - Rx)} ${px(mk.cy - Ry)}`;
    const size = `${px(w)} ${px(h)}`;
    if (mk.invert) {
      return { image: `linear-gradient(#000, #000), ${gy}, ${gx}`, size: `100% 100%, ${size}, ${size}`, position: `0px 0px, ${pos}, ${pos}`, composite: 'subtract, intersect, add' };
    }
    return { image: `${gy}, ${gx}`, size: `${size}, ${size}`, position: `${pos}, ${pos}`, composite: 'intersect, add' };
  }
  const a = mk.invert ? 'transparent' : '#000', b = mk.invert ? '#000' : 'transparent';
  return {
    image: `radial-gradient(${px(Rx)} ${px(Ry)} at ${px(mk.cx)} ${px(mk.cy)}, ${a} ${(p0 * 100).toFixed(4)}%, ${b} 100%)`,
    size: '100% 100%', position: '0px 0px', composite: 'add',
  };
}

const f6 = (x) => { const v = Number(x); return Math.abs(v) < 1e-9 ? '0' : String(Math.round(v * 1e6) / 1e6); };

/**
 * ffmpeg geq luma expression (0..255) of the mask coverage for an image whose pixel (X, Y) sits at frame position
 * (X + ox, Y + oy). Commas escaped for use inside a quoted filter option.
 */
export function ffMaskLumExpr(mk, ox = 0, oy = 0) {
  const { f, Rx, Ry, p0 } = maskParams(mk);
  const X = `(X+0.5+${f6(ox)})`, Y = `(Y+0.5+${f6(oy)})`;
  let a;
  if (mk.shape === 'rect') {
    a = `clip((${X}-${f6(mk.cx - Rx)})/${f6(f)},0,1)*clip((${f6(mk.cx + Rx)}-${X})/${f6(f)},0,1)` +
      `*clip((${Y}-${f6(mk.cy - Ry)})/${f6(f)},0,1)*clip((${f6(mk.cy + Ry)}-${Y})/${f6(f)},0,1)`;
  } else {
    a = `clip((1-hypot((${X}-${f6(mk.cx)})/${f6(Rx)},(${Y}-${f6(mk.cy)})/${f6(Ry)}))/${f6(1 - p0)},0,1)`;
  }
  const e = mk.invert ? `255*(1-${a})` : `255*${a}`;
  return e.replace(/,/g, '\\,');
}

/** Pixel box covered by the mask's outer shape (for small moving mask images). */
export function maskBox(mk) {
  const { Rx, Ry } = maskParams(mk);
  const w = Math.max(2, Math.ceil(Rx * 2 / 2) * 2 + 2), h = Math.max(2, Math.ceil(Ry * 2 / 2) * 2 + 2);
  return { w, h };
}

/** SVG filter primitives (as markup) pixelating with blocks of `size` px, aligned on the element origin. */
export function svgPixelateMarkup(size) {
  const s = Math.max(2, Math.round(size));
  const c = Math.floor(s / 2);
  return `<feFlood x="${c}" y="${c}" width="1" height="1" flood-color="#000" flood-opacity="1"/>` +
    `<feComposite width="${s}" height="${s}"/><feTile result="a"/>` +
    `<feComposite in="SourceGraphic" in2="a" operator="in"/><feMorphology operator="dilate" radius="${c}"/>`;
}
