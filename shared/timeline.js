// Pure timeline helpers shared by the Electron main process (ops, export) and the renderer (player, timeline UI).
// All times are in seconds (floats). Tracks: video tracks are listed bottom → top (V1 is the base layer).
import { animStateAt, animContext } from './anim.js';
import { GRADE_DEFAULTS, ffGradeFilter } from './grade.js';

export const EPS = 1e-4;
export const r4 = (x) => Math.round((Number(x) || 0) * 10000) / 10000;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const VISUAL_TYPES = new Set(['video', 'image', 'html', 'color', 'adjust']);
export const isVisual = (c) => VISUAL_TYPES.has(c.type);
export const clipEnd = (c) => r4(c.start + c.duration);
export const sortByStart = (a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id));

export function mediaById(project, id) {
  if (!id) return null;
  const list = project.media || [];
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
export function trackById(project, id) {
  return (project.tracks || []).find((t) => t.id === id) || null;
}
export function clipById(project, id) {
  return (project.clips || []).find((c) => c.id === id) || null;
}
export const videoTracks = (p) => p.tracks.filter((t) => t.type === 'video');
export const audioTracks = (p) => p.tracks.filter((t) => t.type === 'audio');
export const trackClips = (p, trackId) => p.clips.filter((c) => c.trackId === trackId).sort(sortByStart);

export function projectDuration(p) {
  let d = 0;
  for (const c of p.clips) d = Math.max(d, c.start + c.duration);
  return r4(d);
}

/** Does the clip produce sound? */
export function isAudible(clip, media) {
  if (clip.muted) return false;
  if (clip.type === 'audio') return !!media && media.hasAudio !== false;
  if (clip.type === 'video') return !!media && !!media.hasAudio;
  return false;
}

/** Source time (in the media) for a timeline time inside the clip. */
export const sourceTimeAt = (clip, t) => (clip.in || 0) + (t - clip.start) * (clip.speed || 1);

/** Max timeline duration a clip can have given its media length. */
export function maxClipDuration(clip, media) {
  if (!media || clip.type === 'image' || clip.type === 'html' || clip.type === 'color' || clip.type === 'adjust') return Infinity;
  if (media.type === 'image') return Infinity;
  const d = media.duration || 0;
  return Math.max(0, (d - (clip.in || 0)) / (clip.speed || 1));
}

// ----------------------------------------------------------------------------------------------
// Easing + keyframes (identical math used by the CSS preview and the ffmpeg expression builder)
// ----------------------------------------------------------------------------------------------
export const EASINGS = {
  linear: (p) => p,
  'ease-in': (p) => p * p * p,
  'ease-out': (p) => 1 - Math.pow(1 - p, 3),
  'ease-in-out': (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  hold: () => 0,
};
export const EASING_NAMES = Object.keys(EASINGS);
export const KEYFRAME_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'];

export function evalKeyframes(kfs, t, base) {
  if (!kfs || !kfs.length) return base;
  const k = kfs.length === 1 ? kfs : [...kfs].sort((a, b) => a.t - b.t);
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1];
    if (t >= a.t && t < b.t) {
      const span = b.t - a.t;
      const p = span > 0 ? (t - a.t) / span : 1;
      const e = (EASINGS[a.ease] || EASINGS.linear)(p);
      return a.v + (b.v - a.v) * e;
    }
  }
  return last.v;
}

/** Animated transform of a clip at local time (seconds from clip.start). */
export function clipTransformAt(clip, local) {
  const kf = clip.keyframes || {};
  return {
    x: evalKeyframes(kf.x, local, clip.x || 0),
    y: evalKeyframes(kf.y, local, clip.y || 0),
    scale: evalKeyframes(kf.scale, local, clip.scale ?? 1),
    rotation: evalKeyframes(kf.rotation, local, clip.rotation || 0),
    opacity: clamp(evalKeyframes(kf.opacity, local, clip.opacity ?? 1), 0, 1),
  };
}

export function hasAnimatedTransform(clip) {
  const kf = clip.keyframes || {};
  return ['x', 'y', 'scale', 'rotation', 'opacity'].some((p) => kf[p] && kf[p].length > 1);
}

// ----------------------------------------------------------------------------------------------
// Geometry
// ----------------------------------------------------------------------------------------------
export const FITS = ['contain', 'cover', 'stretch', 'none'];

/** Intrinsic (pixel) size of the clip content before fit. */
export function contentSize(clip, media, W, H) {
  if (clip.type === 'html' || clip.type === 'color' || clip.type === 'adjust') return [W, H];
  const mw = media?.width || W;
  const mh = media?.height || H;
  return [mw, mh];
}

/** Size after "fit" (scale=1). */
export function fittedSize(fit, mw, mh, W, H) {
  switch (fit) {
    case 'cover': { const s = Math.max(W / mw, H / mh); return [mw * s, mh * s]; }
    case 'stretch': return [W, H];
    case 'none': return [mw, mh];
    default: { const s = Math.min(W / mw, H / mh); return [mw * s, mh * s]; }
  }
}

/** Full geometry of a visual clip at local time: displayed box size and center. */
export function clipGeometry(clip, media, W, H, local) {
  const [mw, mh] = contentSize(clip, media, W, H);
  const [fw, fh] = fittedSize(clip.fit || 'contain', mw, mh, W, H);
  const tr = clipTransformAt(clip, local);
  return {
    w: fw * tr.scale,
    h: fh * tr.scale,
    cx: W / 2 + tr.x,
    cy: H / 2 + tr.y,
    rotation: tr.rotation,
    opacity: tr.opacity,
    scale: tr.scale,
    fw, fh, mw, mh,
  };
}

/** Animation context of a clip (base geometry at its first frame). */
export function clipAnimContext(clip, media, W, H) {
  return animContext(W, H, clipGeometry(clip, media, W, H, 0));
}

/**
 * Geometry + clip animations (entrance / exit / continuous motion) at local time.
 * Adds blur (px), inner zoom z and inner pan pu/pv (fractions of the box) to clipGeometry's result.
 */
export function clipVisualAt(clip, media, W, H, local) {
  const g = clipGeometry(clip, media, W, H, local);
  if (!clip.anim) return { ...g, blur: 0, z: 1, pu: 0, pv: 0 };
  const a = animStateAt(clip, clamp(local, 0, clip.duration), clipAnimContext(clip, media, W, H));
  return {
    ...g,
    w: g.w * a.s * a.sx,
    h: g.h * a.s * a.sy,
    cx: g.cx + a.dx,
    cy: g.cy + a.dy,
    rotation: g.rotation + a.r,
    opacity: g.opacity * a.o,
    scale: g.scale * a.s,
    blur: a.b,
    z: a.z,
    pu: a.pu,
    pv: a.pv,
  };
}

// ----------------------------------------------------------------------------------------------
// Frame look: rounded corners, border, drop shadow (preview CSS + export filters share these values)
//   radius / border.width are px in the clip's fitted space (they scale with the clip);
//   shadow { blur, x, y, opacity, color } is in frame px.
// ----------------------------------------------------------------------------------------------
export function clipFrameLook(clip) {
  const radius = Math.max(0, Number(clip.radius) || 0);
  const b = clip.border;
  const border = b && Number(b.width) > 0 ? { width: Number(b.width), color: b.color || '#ffffff' } : null;
  const s = clip.shadow;
  const shadow = s && (Number(s.opacity ?? 0.5) > 0) && (Number(s.blur) > 0 || Number(s.x) || Number(s.y))
    ? { blur: Math.max(0, Number(s.blur) || 0), x: Number(s.x) || 0, y: Number(s.y) || 0, opacity: clamp(Number(s.opacity ?? 0.5), 0, 1), color: s.color || '#000000' }
    : null;
  return { radius, border, shadow, any: radius > 0 || !!border || !!shadow };
}

/** Parse #rgb / #rrggbb / rgb()/rgba() → [r, g, b, a(0-1)]. */
export function parseColor(c, fallback = [0, 0, 0, 1]) {
  if (!c) return fallback;
  const s = String(c).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1].split('').map((x) => parseInt(x + x, 16)), 1];
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) {
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4]);
    if (!Number.isFinite(a)) a = 1;
    return [Number(m[1]), Number(m[2]), Number(m[3]), clamp(a, 0, 1)];
  }
  return fallback;
}

// ----------------------------------------------------------------------------------------------
// Color adjustments: CSS filter functions in the preview, equivalent ffmpeg filters in the export.
// ----------------------------------------------------------------------------------------------
export const COLOR_DEFAULTS = { brightness: 1, contrast: 1, saturation: 1, hue: 0, grayscale: 0, sepia: 0, invert: 0, blur: 0, ...GRADE_DEFAULTS };

export function normalizedColor(c) {
  return { ...COLOR_DEFAULTS, ...(c || {}) };
}
export function isNeutralColor(c) {
  if (!c) return true;
  const n = normalizedColor(c);
  return Object.keys(COLOR_DEFAULTS).every((k) => Math.abs(n[k] - COLOR_DEFAULTS[k]) < 1e-6);
}

/** CSS filter string (order matters and is mirrored by ffColorChain). */
export function cssColorFilter(c) {
  if (!c) return '';
  const n = normalizedColor(c);
  const out = [];
  if (n.brightness !== 1) out.push(`brightness(${n.brightness})`);
  if (n.contrast !== 1) out.push(`contrast(${n.contrast})`);
  if (n.saturation !== 1) out.push(`saturate(${n.saturation})`);
  if (n.hue) out.push(`hue-rotate(${n.hue}deg)`);
  if (n.grayscale) out.push(`grayscale(${n.grayscale})`);
  if (n.sepia) out.push(`sepia(${n.sepia})`);
  if (n.invert) out.push(`invert(${n.invert})`);
  if (n.blur) out.push(`blur(${n.blur}px)`);
  return out.join(' ');
}

const f6 = (x) => (Math.abs(x) < 1e-9 ? 0 : Number(x.toFixed(6)));
const mixer = (m) => `colorchannelmixer=rr=${f6(m[0])}:rg=${f6(m[1])}:rb=${f6(m[2])}:gr=${f6(m[3])}:gg=${f6(m[4])}:gb=${f6(m[5])}:br=${f6(m[6])}:bg=${f6(m[7])}:bb=${f6(m[8])}`;

export function saturateMatrix(s) {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
}
export function hueMatrix(deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}
export function grayscaleMatrix(g) {
  const k = 1 - g;
  return [
    0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k,
    0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k,
    0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k,
  ];
}
export function sepiaMatrix(g) {
  const k = 1 - g;
  return [
    0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k,
    0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k,
    0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k,
  ];
}

/** ffmpeg filters (operating on rgba) equivalent to the preview: tone grade (shared/grade.js) then cssColorFilter, in order. */
export function ffColorChain(c) {
  if (!c) return [];
  const n = normalizedColor(c);
  const out = [];
  const grade = ffGradeFilter(c);
  if (grade) out.push(grade);
  if (n.brightness !== 1) out.push(mixer([n.brightness, 0, 0, 0, n.brightness, 0, 0, 0, n.brightness]));
  if (n.contrast !== 1) {
    const e = `clip((val-127.5)*${f6(n.contrast)}+127.5\\,0\\,255)`;
    out.push(`lutrgb=r='${e}':g='${e}':b='${e}'`);
  }
  if (n.saturation !== 1) out.push(mixer(saturateMatrix(n.saturation)));
  if (n.hue) out.push(mixer(hueMatrix(n.hue)));
  if (n.grayscale) out.push(mixer(grayscaleMatrix(n.grayscale)));
  if (n.sepia) out.push(mixer(sepiaMatrix(n.sepia)));
  if (n.invert) {
    const i = f6(n.invert);
    const e = `clip(val*(1-2*${i})+255*${i}\\,0\\,255)`;
    out.push(`lutrgb=r='${e}':g='${e}':b='${e}'`);
  }
  if (n.blur > 0) out.push(`gblur=sigma=${f6(n.blur)}`);
  return out;
}

/**
 * Linear "colour difference" keyer shared by preview (SVG feColorMatrix) and export (colorchannelmixer).
 * alpha = clamp(1 + k*thr - k*G + k/2*R + k/2*B) for green screens (G and B swapped for blue).
 */
export function chromaKeyMatrix(ck) {
  const k = Math.max(0.5, ck?.strength ?? 6);
  const thr = ck?.threshold ?? 0.08;
  const despill = clamp(ck?.despill ?? 0.5, 0, 1);
  const blue = ck?.color === 'blue';
  // rows: R, G, B, A  (each: r, g, b, a, offset)
  const R = [1, 0, 0, 0, 0];
  let G = [0, 1, 0, 0, 0];
  let B = [0, 0, 1, 0, 0];
  let A;
  if (!blue) {
    G = [despill / 2, 1 - despill, despill / 2, 0, 0];
    A = [k / 2, -k, k / 2, 0, 1 + k * thr];
  } else {
    B = [despill / 2, despill / 2, 1 - despill, 0, 0];
    A = [k / 2, k / 2, -k, 0, 1 + k * thr];
  }
  return { R, G, B, A };
}
export function svgChromaMatrixValues(ck) {
  const m = chromaKeyMatrix(ck);
  return [...m.R, ...m.G, ...m.B, ...m.A].map(f6).join(' ');
}
export function ffChromaKey(ck) {
  const m = chromaKeyMatrix(ck);
  // input alpha is 1 for opaque video, so the "a" coefficient acts as the constant offset.
  // colorchannelmixer only accepts coefficients in [-2, 2]: the alpha row is divided by S (power of 2), then the
  // alpha is multiplied back by S with ×2 passes (clamping in between keeps the result exact: clamp(S·clamp(a/S)) =
  // clamp(a)). 16-bit RGBA keeps the soft edges smooth through the passes.
  const maxA = Math.max(Math.abs(m.A[0]), Math.abs(m.A[1]), Math.abs(m.A[2]), Math.abs(m.A[4]));
  const S = maxA > 2 ? Math.pow(2, Math.ceil(Math.log2(maxA / 2))) : 1;
  const mix = `colorchannelmixer=rr=${f6(m.R[0])}:rg=${f6(m.R[1])}:rb=${f6(m.R[2])}` +
    `:gr=${f6(m.G[0])}:gg=${f6(m.G[1])}:gb=${f6(m.G[2])}` +
    `:br=${f6(m.B[0])}:bg=${f6(m.B[1])}:bb=${f6(m.B[2])}` +
    `:ar=${f6(m.A[0] / S)}:ag=${f6(m.A[1] / S)}:ab=${f6(m.A[2] / S)}:aa=${f6(m.A[4] / S)}`;
  if (S === 1) return mix;
  const passes = [];
  for (let s = S; s > 1; s /= 2) passes.push('colorchannelmixer=aa=2');
  return ['format=rgba64le', mix, ...passes, 'format=rgba'].join(',');
}

// ----------------------------------------------------------------------------------------------
// Track spans with transitions (transition = property of the incoming clip, centered on the cut)
// ----------------------------------------------------------------------------------------------
export const ADJACENT_EPS = 0.002;

/**
 * Returns render spans for the visual clips of a track: each span may start earlier / end later than
 * its clip because of transitions (handles). Span = { clip, start, end, tin, tout }.
 */
export function trackSpans(project, track) {
  const clips = trackClips(project, track.id).filter(isVisual);
  const spans = clips.map((c) => ({ clip: c, start: c.start, end: c.start + c.duration, tin: null, tout: null }));
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const tr = s.clip.transition;
    if (!tr || !tr.type || tr.type === 'none' || !(tr.duration > 0)) continue;
    const prev = spans[i - 1];
    if (prev && !prev.tout && Math.abs(prev.clip.start + prev.clip.duration - s.clip.start) < ADJACENT_EPS) {
      const d = Math.max(1 / 120, Math.min(tr.duration, prev.clip.duration, s.clip.duration));
      const a = s.clip.start - d / 2, b = s.clip.start + d / 2;
      prev.end = b; s.start = a;
      const info = { type: tr.type, start: a, end: b, duration: d, from: prev.clip.id, to: s.clip.id };
      prev.tout = info; s.tin = info;
    } else {
      const d = Math.max(1 / 120, Math.min(tr.duration, s.clip.duration));
      s.tin = { type: tr.type, start: s.clip.start, end: s.clip.start + d, duration: d, from: null, to: s.clip.id };
    }
  }
  return spans;
}

/** All visual layers active at time t, bottom → top. */
export function activeVisualLayers(project, t, spansCache) {
  const out = [];
  const tracks = videoTracks(project);
  tracks.forEach((track, ti) => {
    if (track.hidden) return;
    const spans = spansCache?.get(track.id) || trackSpans(project, track);
    for (const s of spans) {
      if (t >= s.start - EPS && t < s.end - EPS) {
        let trans = null;
        if (s.tin && t >= s.tin.start && t < s.tin.end) trans = { ...s.tin, role: 'in', p: (t - s.tin.start) / s.tin.duration };
        else if (s.tout && t >= s.tout.start && t < s.tout.end) trans = { ...s.tout, role: 'out', p: (t - s.tout.start) / s.tout.duration };
        out.push({ track, trackIndex: ti, span: s, clip: s.clip, local: t - s.clip.start, trans });
      }
    }
  });
  return out;
}

/** Audio gain multiplier of a clip at local time (fades + keyframed volume + transition crossfades). */
export function audioGainAt(clip, local, spanInfo) {
  let g = evalKeyframes(clip.keyframes?.volume, local, clip.volume ?? 1);
  const d = clip.duration;
  if (clip.fadeIn > 0 && local < clip.fadeIn) g *= clamp(local / clip.fadeIn, 0, 1);
  if (clip.fadeOut > 0 && local > d - clip.fadeOut) g *= clamp((d - local) / clip.fadeOut, 0, 1);
  if (spanInfo) g *= spanInfo;
  return Math.max(0, g);
}

// ----------------------------------------------------------------------------------------------
// Misc
// ----------------------------------------------------------------------------------------------
export function fmtTime(t, fps) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  if (fps) {
    const f = Math.floor((t - Math.floor(t)) * fps + 1e-6);
    return `${h ? pad(h) + ':' : ''}${pad(m)}:${pad(s)}:${pad(f)}`;
  }
  const ms = Math.floor((t - Math.floor(t)) * 100);
  return `${h ? pad(h) + ':' : ''}${pad(m)}:${pad(s)}.${pad(ms)}`;
}

export function snapToFrame(t, fps) {
  return Math.round(t * fps) / fps;
}
