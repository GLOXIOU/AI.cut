// Clip animations shared by the preview player (CSS) and the exporter (ffmpeg expressions).
//
//   clip.anim = {
//     in:   { type, duration }                          entrance over the first `duration` seconds
//     out:  { type, duration }                          exit over the last `duration` seconds
//     loop: { type, amount, speed, offset, span }       continuous motion over the whole clip
//   }
//
// Every curve is described once and evaluated either in JS (preview) or turned into an ffmpeg expression (export),
// so both renderers produce the same motion.
// Props: dx / dy (px, added), s (uniform scale), sx / sy (axis scale), r (degrees, added), o (opacity), b (blur px, added).
// Loops: "inner" ones (Ken Burns / pan) move the picture INSIDE the clip frame (zoom z, pan pu/pv as fractions of the frame);
// "outer" ones (cloud, wind, float, sway…) gently move the frame itself — the "animated still image" look.
// loop.amount is an intensity multiplier (1 = default, 0.5 = subtler, 2 = stronger); loop.speed multiplies the tempo.

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const TAU = Math.PI * 2;

export const EASE = {
  linear: (p) => p,
  inCubic: (p) => p * p * p,
  outCubic: (p) => 1 - Math.pow(1 - p, 3),
  inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(2 - 2 * p, 3) / 2),
  inOutSine: (p) => (1 - Math.cos(Math.PI * p)) / 2,
  outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  inExpo: (p) => (p <= 0 ? 0 : Math.pow(2, 10 * p - 10)),
  outBack: (p) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2),
  inBack: (p) => 2.70158 * p * p * p - 1.70158 * p * p,
  outElastic: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * (TAU / 3)) + 1),
  outBounce: (p) => {
    if (p < 1 / 2.75) return 7.5625 * p * p;
    if (p < 2 / 2.75) return 7.5625 * Math.pow(p - 1.5 / 2.75, 2) + 0.75;
    if (p < 2.5 / 2.75) return 7.5625 * Math.pow(p - 2.25 / 2.75, 2) + 0.9375;
    return 7.5625 * Math.pow(p - 2.625 / 2.75, 2) + 0.984375;
  },
};

const n = (x) => {
  const v = Number(x);
  if (!Number.isFinite(v)) return '0';
  return Math.abs(v) < 1e-9 ? '0' : String(Math.round(v * 1e6) / 1e6);
};

/** ffmpeg expression of an easing applied to P (an expression already clamped to [0, 1]). */
export function easeExpr(name, P) {
  switch (name) {
    case 'inCubic': return `pow(${P},3)`;
    case 'outCubic': return `(1-pow(1-${P},3))`;
    case 'inOutCubic': return `if(lt(${P},0.5),4*pow(${P},3),1-pow(2-2*${P},3)/2)`;
    case 'inOutSine': return `((1-cos(PI*${P}))/2)`;
    case 'outExpo': return `if(gte(${P},1),1,1-pow(2,-10*${P}))`;
    case 'inExpo': return `if(lte(${P},0),0,pow(2,10*${P}-10))`;
    case 'outBack': return `(1+2.70158*pow(${P}-1,3)+1.70158*pow(${P}-1,2))`;
    case 'inBack': return `(2.70158*pow(${P},3)-1.70158*pow(${P},2))`;
    case 'outElastic': return `if(lte(${P},0),0,if(gte(${P},1),1,pow(2,-10*${P})*sin((${P}*10-0.75)*2.0943951024)+1))`;
    case 'outBounce':
      return `if(lt(${P},0.3636363636),7.5625*pow(${P},2),if(lt(${P},0.7272727273),7.5625*pow(${P}-0.5454545455,2)+0.75,` +
        `if(lt(${P},0.9090909091),7.5625*pow(${P}-0.8181818182,2)+0.9375,7.5625*pow(${P}-0.9545454545,2)+0.984375)))`;
    default: return P;
  }
}

// ------------------------------------------------------------------------------------------------ entrances / exits
// A track is either [prop, from, to, ease, a, b] (a..b = portion of the animation, from/to may be functions of ctx)
// or { prop, js: (p, ctx) => value, ff: (P, ctx) => expression } for custom curves.
// ctx = { W, H, w, h, x, y }: frame size, displayed clip box size and centre offset (base geometry at clip start).
const offRight = (c) => c.W / 2 - c.x + c.w / 2 + 24;
const offLeft = (c) => -(c.W / 2 + c.x + c.w / 2 + 24);
const offBottom = (c) => c.H / 2 - c.y + c.h / 2 + 24;
const offTop = (c) => -(c.H / 2 + c.y + c.h / 2 + 24);
const k1080 = (c) => Math.min(c.W, c.H) / 1080;

/** Decaying oscillation: amp · (1 - p)^2 · sin(freq · p · 2π). Value 0 at p = 1. */
const osc = (prop, amp, freq) => ({
  prop,
  js: (p, c) => val(amp, c) * Math.pow(1 - p, 2) * Math.sin(freq * TAU * p),
  ff: (P, c) => `(${n(val(amp, c))}*pow(1-${P},2)*sin(${n(freq * TAU)}*${P}))`,
});

export const ANIM_IN = {
  'fade-scale': { label: 'Fondu + zoom léger', en: 'Soft fade', tracks: [['o', 0, 1, 'outCubic'], ['s', 0.92, 1, 'outCubic']] },
  fade: { label: 'Fondu', en: 'Fade', tracks: [['o', 0, 1, 'outCubic']] },
  pop: { label: 'Pop', en: 'Pop', tracks: [['s', 0.4, 1, 'outBack'], ['o', 0, 1, 'outCubic', 0, 0.4]] },
  'bounce-in': { label: 'Rebond', en: 'Bounce', tracks: [['s', 0.3, 1, 'outBounce'], ['o', 0, 1, 'outCubic', 0, 0.25]] },
  elastic: { label: 'Élastique', en: 'Elastic', tracks: [['s', 0.05, 1, 'outElastic'], ['o', 0, 1, 'outCubic', 0, 0.2]] },
  'zoom-in': { label: 'Zoom avant', en: 'Zoom in', tracks: [['s', 0.55, 1, 'outExpo'], ['o', 0, 1, 'outCubic', 0, 0.5]] },
  'zoom-out': { label: 'Zoom arrière', en: 'Zoom out', tracks: [['s', 1.45, 1, 'outExpo'], ['o', 0, 1, 'outCubic', 0, 0.5]] },
  'zoom-blur': { label: 'Zoom flou', en: 'Zoom blur', tracks: [['s', 1.6, 1, 'outExpo'], ['b', 30, 0, 'outExpo'], ['o', 0, 1, 'outCubic', 0, 0.4]] },
  'slide-left': { label: 'Glisse ←', en: 'Slide ←', tracks: [['dx', offRight, 0, 'outExpo']] },
  'slide-right': { label: 'Glisse →', en: 'Slide →', tracks: [['dx', offLeft, 0, 'outExpo']] },
  'slide-up': { label: 'Glisse ↑', en: 'Slide ↑', tracks: [['dy', offBottom, 0, 'outExpo']] },
  'slide-down': { label: 'Glisse ↓', en: 'Slide ↓', tracks: [['dy', offTop, 0, 'outExpo']] },
  'slide-blur-left': { label: 'Glisse flou ←', en: 'Motion-blur slide ←', tracks: [['dx', offRight, 0, 'outExpo'], ['b', 26, 0, 'outExpo']] },
  'slide-blur-right': { label: 'Glisse flou →', en: 'Motion-blur slide →', tracks: [['dx', offLeft, 0, 'outExpo'], ['b', 26, 0, 'outExpo']] },
  peek: { label: 'Surgit du bas', en: 'Peek up', tracks: [['dy', offBottom, 0, 'outBack']] },
  rise: { label: 'Montée douce', en: 'Rise', tracks: [['dy', (c) => c.H * 0.06, 0, 'outCubic'], ['o', 0, 1, 'outCubic', 0, 0.7]] },
  drop: { label: 'Chute rebond', en: 'Drop', tracks: [['dy', offTop, 0, 'outBounce'], ['o', 0, 1, 'linear', 0, 0.12]] },
  tilt: { label: 'Carte inclinée', en: 'Tilt in', tracks: [['r', 9, 0, 'outBack'], ['dy', (c) => c.H * 0.05, 0, 'outCubic'], ['s', 0.9, 1, 'outCubic'], ['o', 0, 1, 'outCubic', 0, 0.5]] },
  spin: { label: 'Tourbillon', en: 'Spin', tracks: [['r', -120, 0, 'outBack'], ['s', 0.3, 1, 'outCubic'], ['o', 0, 1, 'outCubic', 0, 0.4]] },
  swing: { label: 'Balancier', en: 'Swing', tracks: [['r', -14, 0, 'outElastic'], ['o', 0, 1, 'outCubic', 0, 0.3]] },
  'flip-h': { label: 'Retournement H', en: 'Flip horizontal', tracks: [['sx', 0.02, 1, 'outBack'], ['o', 0, 1, 'linear', 0, 0.2]] },
  'flip-v': { label: 'Retournement V', en: 'Flip vertical', tracks: [['sy', 0.02, 1, 'outBack'], ['o', 0, 1, 'linear', 0, 0.2]] },
  unfold: { label: 'Déroulé', en: 'Unfold', tracks: [['sy', 0.02, 1, 'outExpo'], ['sx', 1.08, 1, 'outCubic'], ['o', 0, 1, 'linear', 0, 0.15]] },
  stretch: { label: 'Étirement', en: 'Squash & stretch', tracks: [['sx', 1.45, 1, 'outElastic'], ['sy', 0.55, 1, 'outElastic'], ['o', 0, 1, 'outCubic', 0, 0.25]] },
  'shake-in': { label: 'Secousse', en: 'Shake in', tracks: [osc('dx', (c) => 26 * k1080(c), 4.5), osc('r', 4, 3.2), ['o', 0, 1, 'outCubic', 0, 0.2]] },
  glitch: { label: 'Glitch', en: 'Glitch', tracks: [osc('dx', (c) => 60 * k1080(c), 9.5), osc('dy', (c) => 14 * k1080(c), 7.3), ['sx', 1.12, 1, 'outExpo'], ['o', 0, 1, 'linear', 0, 0.3]] },
  blur: { label: 'Flou', en: 'Blur', tracks: [['b', 36, 0, 'outCubic'], ['o', 0, 1, 'outCubic', 0, 0.6], ['s', 1.08, 1, 'outCubic']] },
  whip: { label: 'Whip', en: 'Whip', tracks: [['dx', (c) => c.W * 0.35, 0, 'outExpo'], ['b', 28, 0, 'outExpo'], ['o', 0, 1, 'outCubic', 0, 0.3]] },
};

// Exits: `mirror` replays an entrance backwards (value(p) = entrance(1 - p)); `tracks` are defined forward (identity → target).
export const ANIM_OUT = {
  'fade-scale': { label: 'Fondu + zoom léger', en: 'Soft fade', mirror: 'fade-scale' },
  fade: { label: 'Fondu', en: 'Fade', mirror: 'fade' },
  pop: { label: 'Pop', en: 'Pop', mirror: 'pop' },
  'zoom-in': { label: 'Zoom avant', en: 'Zoom in', mirror: 'zoom-out' },
  'zoom-out': { label: 'Zoom arrière', en: 'Zoom out', mirror: 'zoom-in' },
  'zoom-blur': { label: 'Zoom flou', en: 'Zoom blur', tracks: [['s', 1, 1.6, 'inExpo'], ['b', 0, 30, 'inExpo'], ['o', 1, 0, 'inCubic', 0.6, 1]] },
  'slide-left': { label: 'Glisse ←', en: 'Slide ←', mirror: 'slide-right' },
  'slide-right': { label: 'Glisse →', en: 'Slide →', mirror: 'slide-left' },
  'slide-up': { label: 'Glisse ↑', en: 'Slide ↑', mirror: 'slide-down' },
  'slide-down': { label: 'Glisse ↓', en: 'Slide ↓', mirror: 'slide-up' },
  'slide-blur-left': { label: 'Glisse flou ←', en: 'Motion-blur slide ←', mirror: 'slide-blur-right' },
  'slide-blur-right': { label: 'Glisse flou →', en: 'Motion-blur slide →', mirror: 'slide-blur-left' },
  sink: { label: 'Descend', en: 'Sink', tracks: [['dy', 0, offBottom, 'inBack']] },
  rise: { label: 'Montée douce', en: 'Rise', tracks: [['dy', 0, (c) => -c.H * 0.06, 'inCubic'], ['o', 1, 0, 'inCubic', 0.3, 1]] },
  drop: { label: 'Chute', en: 'Fall', tracks: [['dy', 0, offBottom, 'inBack'], ['o', 1, 0, 'linear', 0.85, 1]] },
  tilt: { label: 'Carte inclinée', en: 'Tilt out', mirror: 'tilt' },
  spin: { label: 'Tourbillon', en: 'Spin', mirror: 'spin' },
  'flip-h': { label: 'Retournement H', en: 'Flip horizontal', tracks: [['sx', 1, 0.02, 'inBack'], ['o', 1, 0, 'linear', 0.8, 1]] },
  'flip-v': { label: 'Retournement V', en: 'Flip vertical', tracks: [['sy', 1, 0.02, 'inBack'], ['o', 1, 0, 'linear', 0.8, 1]] },
  fold: { label: 'Repli', en: 'Fold', mirror: 'unfold' },
  glitch: { label: 'Glitch', en: 'Glitch', mirror: 'glitch' },
  blur: { label: 'Flou', en: 'Blur', mirror: 'blur' },
  whip: { label: 'Whip', en: 'Whip', tracks: [['dx', 0, (c) => -c.W * 0.35, 'inExpo'], ['b', 0, 28, 'inExpo'], ['o', 1, 0, 'inCubic', 0.7, 1]] },
};

// ------------------------------------------------------------------------------------------------ continuous motion
// inner: Ken Burns kind ('in' | 'out' | 'left' | 'right' | 'up' | 'down') with zoom = base `zoom` × amount.
// outer: components [prop, amplitude, period (s), phase, unit] summed as amp·sin(2π·t/period + phase);
//   unit 'k' = fraction of the frame's short side, 'deg', 'x' = scale fraction. Periods are divided by `speed`.
export const ANIM_LOOP = {
  cloud: {
    label: 'Nuage (image vivante)', en: 'Cloud (living still)', still: true,
    outer: [['dy', 0.0065, 4.6, 0, 'k'], ['dx', 0.0042, 7.3, 1.1, 'k'], ['r', 0.65, 5.9, 0.4, 'deg'], ['s', 0.012, 6.7, 2.2, 'x']],
  },
  wind: {
    label: 'Vent', en: 'Wind', still: true,
    outer: [['r', 0.8, 2.3, 0, 'deg'], ['r', 0.35, 0.97, 1.7, 'deg'], ['dx', 0.004, 2.3, 0.3, 'k'], ['sx', 0.008, 1.9, 0.9, 'x'], ['dy', 0.002, 3.1, 2, 'k']],
  },
  living: {
    label: 'Photo vivante (zoom + nuage)', en: 'Living photo (zoom + cloud)', still: true, inner: 'in', zoom: 0.07,
    outer: [['dy', 0.004, 5.2, 0, 'k'], ['r', 0.45, 6.8, 0.8, 'deg'], ['dx', 0.003, 8.1, 2.1, 'k']],
  },
  dream: {
    label: 'Rêverie', en: 'Dreamy', still: true,
    outer: [['s', 0.02, 8, 0, 'x'], ['r', 0.9, 11, 1, 'deg'], ['dy', 0.004, 6.3, 0.5, 'k']],
  },
  jelly: {
    label: 'Gelée', en: 'Jelly', still: true,
    outer: [['sx', 0.012, 1.6, 0, 'x'], ['sy', 0.012, 1.6, Math.PI, 'x'], ['dy', 0.002, 1.6, 0.5, 'k']],
  },
  'kenburns-in': { label: 'Zoom lent avant', en: 'Slow zoom in', inner: 'in', zoom: 0.12 },
  'kenburns-out': { label: 'Zoom lent arrière', en: 'Slow zoom out', inner: 'out', zoom: 0.12 },
  'pan-left': { label: 'Panoramique ←', en: 'Pan ←', inner: 'left', zoom: 0.14 },
  'pan-right': { label: 'Panoramique →', en: 'Pan →', inner: 'right', zoom: 0.14 },
  'pan-up': { label: 'Panoramique ↑', en: 'Pan ↑', inner: 'up', zoom: 0.14 },
  'pan-down': { label: 'Panoramique ↓', en: 'Pan ↓', inner: 'down', zoom: 0.14 },
  float: { label: 'Flottement', en: 'Float', outer: [['dy', 0.012, 3.2, 0, 'k']] },
  breathe: { label: 'Respiration', en: 'Breathe', outer: [['s', 0.025, 4, 0, 'x']] },
  sway: { label: 'Balancement', en: 'Sway', outer: [['r', 2.2, 3.6, 0, 'deg']] },
  drift: { label: 'Dérive', en: 'Drift', outer: [['dx', 0.018, 7, 0, 'k'], ['dy', 0.011, 5.1, 1.3, 'k']] },
  shake: { label: 'Caméra à l\'épaule', en: 'Handheld', outer: [['dx', 0.0036, 1.11, 0, 'k'], ['dx', 0.0024, 0.43, 1, 'k'], ['dy', 0.0036, 0.77, 2, 'k'], ['dy', 0.0024, 0.32, 0, 'k'], ['r', 0.24, 1.43, 0.5, 'deg']] },
  pulse: { label: 'Pulsation', en: 'Pulse', pulse: 0.035, period: 1.2 },
};

export const ANIM_IN_IDS = Object.keys(ANIM_IN);
export const ANIM_OUT_IDS = Object.keys(ANIM_OUT);
export const ANIM_LOOP_IDS = Object.keys(ANIM_LOOP);
export const STILL_LOOP_IDS = ANIM_LOOP_IDS.filter((k) => ANIM_LOOP[k].still);
export const DEFAULT_IN_DURATION = 0.45;
export const DEFAULT_OUT_DURATION = 0.4;

const PROPS = ['dx', 'dy', 's', 'sx', 'sy', 'r', 'o', 'b'];
const ID = { dx: 0, dy: 0, s: 1, sx: 1, sy: 1, r: 0, o: 1, b: 0 };
const MUL = new Set(['s', 'sx', 'sy', 'o']);
const val = (v, ctx) => (typeof v === 'function' ? v(ctx) : v);
const propOf = (tr) => (Array.isArray(tr) ? tr[0] : tr.prop);

/** Effective in/out durations (clamped so that in + out never exceed the clip). */
export function animDurations(clip) {
  const a = clip.anim || {};
  const D = Math.max(1e-3, clip.duration || 0);
  let din = a.in?.type && ANIM_IN[a.in.type] ? Math.max(0.04, Number(a.in.duration) || DEFAULT_IN_DURATION) : 0;
  let dout = a.out?.type && ANIM_OUT[a.out.type] ? Math.max(0.04, Number(a.out.duration) || DEFAULT_OUT_DURATION) : 0;
  if (din + dout > D) { const k = D / (din + dout); din *= k; dout *= k; }
  return { din, dout, D };
}

function outTracks(type) {
  const def = ANIM_OUT[type];
  if (!def) return [];
  if (def.mirror) return (ANIM_IN[def.mirror]?.tracks || []).map((t) => ({ t, mirror: true }));
  return def.tracks.map((t) => ({ t, mirror: false }));
}

function trackValue(track, p, ctx) {
  if (!Array.isArray(track)) return track.js(clamp01(p), ctx);
  const [, from, to, ease, a = 0, b = 1] = track;
  const q = clamp01((p - a) / Math.max(1e-6, b - a));
  const f = val(from, ctx), g = val(to, ctx);
  return f + (g - f) * (EASE[ease] || EASE.linear)(q);
}

function loopParams(clip) {
  const l = clip.anim?.loop;
  if (!l?.type || !ANIM_LOOP[l.type]) return null;
  const amt = Number(l.amount);
  return {
    type: l.type, def: ANIM_LOOP[l.type],
    amount: Number.isFinite(amt) ? Math.max(0, amt) : 1,
    speed: Math.max(0.05, Number(l.speed) || 1),
    offset: Number(l.offset) || 0,
    span: Number(l.span) > 0 ? Number(l.span) : Math.max(1e-3, clip.duration || 1),
  };
}

/** Which parts of the clip's transform are driven by animations (for the exporter). */
export function animUsage(clip) {
  const u = { dx: false, dy: false, s: false, sx: false, sy: false, r: false, o: false, b: false, inner: false, any: false };
  const a = clip.anim;
  if (!a) return u;
  const mark = (prop) => { u[prop] = true; u.any = true; };
  if (a.in?.type && ANIM_IN[a.in.type]) for (const t of ANIM_IN[a.in.type].tracks) mark(propOf(t));
  if (a.out?.type && ANIM_OUT[a.out.type]) for (const { t } of outTracks(a.out.type)) mark(propOf(t));
  const L = loopParams(clip);
  if (L) {
    if (L.def.inner) { u.inner = true; u.any = true; }
    for (const c of L.def.outer || []) mark(c[0]);
    if (L.def.pulse) mark('s');
  }
  return u;
}

/** Inner (Ken Burns / pan) state: zoom z ≥ 1 and pan pu/pv as fractions of the frame. */
function innerAt(L, t) {
  const u = clamp01((t + L.offset) / L.span);
  const e = EASE.inOutSine(u);
  const A = Math.max(0, (L.def.zoom || 0.12) * L.amount);
  const kind = L.def.inner;
  if (kind === 'in') return { z: 1 + A * e, pu: 0, pv: 0 };
  if (kind === 'out') return { z: 1 + A * (1 - e), pu: 0, pv: 0 };
  const R = (A / 2) * 0.96;
  const s = R - 2 * R * e; // +R → -R
  if (kind === 'left') return { z: 1 + A, pu: s, pv: 0 };
  if (kind === 'right') return { z: 1 + A, pu: -s, pv: 0 };
  if (kind === 'up') return { z: 1 + A, pu: 0, pv: s };
  return { z: 1 + A, pu: 0, pv: -s };
}

const unitScale = (unit, ctx) => (unit === 'k' ? Math.min(ctx.W, ctx.H) : 1);

/**
 * Animation state at clip-local time t (seconds from clip start, clamped by the caller to [0, duration]).
 * Returns { dx, dy, s, sx, sy, r, o, b, z, pu, pv }.
 */
export function animStateAt(clip, t, ctx) {
  const out = { ...ID, z: 1, pu: 0, pv: 0 };
  const a = clip.anim;
  if (!a) return out;
  const { din, dout, D } = animDurations(clip);
  const apply = (prop, v) => { if (MUL.has(prop)) out[prop] *= v; else out[prop] += v - ID[prop]; };
  if (din > 0) {
    const p = clamp01(t / din);
    for (const tr of ANIM_IN[a.in.type].tracks) apply(propOf(tr), trackValue(tr, p, ctx));
  }
  if (dout > 0) {
    const p = clamp01((t - (D - dout)) / dout);
    for (const { t: tr, mirror } of outTracks(a.out.type)) apply(propOf(tr), trackValue(tr, mirror ? 1 - p : p, ctx));
  }
  const L = loopParams(clip);
  if (L) {
    if (L.def.inner) Object.assign(out, innerAt(L, t));
    const tt = t + L.offset;
    for (const [prop, amp, period, ph, unit] of L.def.outer || []) {
      const v = amp * L.amount * unitScale(unit, ctx) * Math.sin((TAU * L.speed * tt) / period + ph);
      if (MUL.has(prop)) out[prop] *= 1 + v; else out[prop] += v;
    }
    if (L.def.pulse) out.s *= 1 + L.def.pulse * L.amount * (0.5 - 0.5 * Math.cos((TAU * L.speed * tt) / L.def.period));
  }
  out.o = clamp01(out.o);
  out.b = Math.max(0, out.b);
  return out;
}

// ------------------------------------------------------------------------------------------------ ffmpeg expressions
function trackExpr(track, P, ctx) {
  if (!Array.isArray(track)) return track.ff(P, ctx);
  const [, from, to, ease, a = 0, b = 1] = track;
  const q = a === 0 && b === 1 ? P : `clip((${P}-${n(a)})/${n(b - a)},0,1)`;
  const f = val(from, ctx), g = val(to, ctx);
  return `(${n(f)}+(${n(g - f)})*${easeExpr(ease, q)})`;
}

/**
 * ffmpeg expressions (strings) for each animated component, tv = clip-local time expression (e.g. "(t+1.5)").
 * Components that are not animated are null. Same math as animStateAt (s/sx/sy/o are multipliers).
 */
export function animExprs(clip, ctx, tv) {
  const parts = Object.fromEntries(PROPS.map((p) => [p, []]));
  const res = { dx: null, dy: null, s: null, sx: null, sy: null, r: null, o: null, b: null, z: null, pu: null, pv: null };
  const a = clip.anim;
  if (!a) return res;
  const { din, dout, D } = animDurations(clip);
  const push = (prop, e) => parts[prop].push(MUL.has(prop) ? e : `(${e}-(${n(ID[prop])}))`);
  if (din > 0) {
    const P = `clip(${tv}/${n(din)},0,1)`;
    for (const tr of ANIM_IN[a.in.type].tracks) push(propOf(tr), trackExpr(tr, P, ctx));
  }
  if (dout > 0) {
    const P = `clip((${tv}-${n(D - dout)})/${n(dout)},0,1)`;
    for (const { t: tr, mirror } of outTracks(a.out.type)) push(propOf(tr), trackExpr(tr, mirror ? `(1-${P})` : P, ctx));
  }
  const L = loopParams(clip);
  if (L) {
    if (L.def.inner) {
      const U = `clip((${tv}+${n(L.offset)})/${n(L.span)},0,1)`;
      const E = easeExpr('inOutSine', U);
      const A = Math.max(0, (L.def.zoom || 0.12) * L.amount);
      const R = (A / 2) * 0.96;
      const kind = L.def.inner;
      if (kind === 'in') res.z = `(1+${n(A)}*${E})`;
      else if (kind === 'out') res.z = `(1+${n(A)}*(1-${E}))`;
      else {
        res.z = n(1 + A);
        const s = `(${n(R)}-${n(2 * R)}*${E})`;
        if (kind === 'left') res.pu = s;
        else if (kind === 'right') res.pu = `(-${s})`;
        else if (kind === 'up') res.pv = s;
        else res.pv = `(-${s})`;
      }
    }
    const tt = `(${tv}+${n(L.offset)})`;
    for (const [prop, amp, period, ph, unit] of L.def.outer || []) {
      const A = amp * L.amount * unitScale(unit, ctx);
      const e = `(${n(A)}*sin(${n((TAU * L.speed) / period)}*${tt}${ph ? `+${n(ph)}` : ''}))`;
      parts[prop].push(MUL.has(prop) ? `(1+${e})` : e);
    }
    if (L.def.pulse) parts.s.push(`(1+${n(L.def.pulse * L.amount)}*(0.5-0.5*cos(${n((TAU * L.speed) / L.def.period)}*${tt})))`);
  }
  for (const k of PROPS) {
    if (!parts[k].length) continue;
    res[k] = MUL.has(k) ? parts[k].join('*') : parts[k].join('+');
  }
  if (res.o) res.o = `clip(${res.o},0,1)`;
  return res;
}

/** Context (frame + base geometry at clip start) used by direction-dependent animations. */
export function animContext(W, H, geo) {
  return { W, H, w: geo.w, h: geo.h, x: geo.cx - W / 2, y: geo.cy - H / 2 };
}

/** Time ranges (clip-local) where the opacity is animated. */
export function animOpacityRanges(clip) {
  const a = clip.anim;
  if (!a) return [];
  const { din, dout, D } = animDurations(clip);
  const out = [];
  if (din > 0 && ANIM_IN[a.in.type].tracks.some((t) => propOf(t) === 'o')) out.push([0, din]);
  if (dout > 0 && outTracks(a.out.type).some(({ t }) => propOf(t) === 'o')) out.push([D - dout, D]);
  return out;
}

/** Normalize clip.anim (returns null when empty). Accepts string shorthands ({ in: 'pop' }). */
export function normalizeAnim(a) {
  if (!a || typeof a !== 'object') return null;
  const pick = (v) => (typeof v === 'string' ? { type: v } : v);
  const ain = pick(a.in), aout = pick(a.out), aloop = pick(a.loop);
  const out = {};
  const dur = (v, d) => Math.round(Math.min(10, Math.max(0.04, Number(v) || d)) * 1000) / 1000;
  if (ain && ANIM_IN[ain.type]) out.in = { type: ain.type, duration: dur(ain.duration, DEFAULT_IN_DURATION) };
  if (aout && ANIM_OUT[aout.type]) out.out = { type: aout.type, duration: dur(aout.duration, DEFAULT_OUT_DURATION) };
  if (aloop && ANIM_LOOP[aloop.type]) {
    const l = { type: aloop.type };
    const amt = Number(aloop.amount);
    l.amount = Number.isFinite(amt) ? Math.round(Math.min(5, Math.max(0, amt)) * 1000) / 1000 : 1;
    if (Number(aloop.speed) > 0 && Number(aloop.speed) !== 1) l.speed = Math.round(Math.min(10, Number(aloop.speed)) * 1000) / 1000;
    if (Number(aloop.offset) > 0) l.offset = Math.round(Number(aloop.offset) * 10000) / 10000;
    if (Number(aloop.span) > 0) l.span = Math.round(Number(aloop.span) * 10000) / 10000;
    out.loop = l;
  }
  return Object.keys(out).length ? out : null;
}

/** Split support: left part keeps `in`, right part keeps `out`, the loop continues seamlessly across the cut. */
export function splitAnim(anim, leftDur, totalDur) {
  if (!anim) return [null, null];
  const left = { ...(anim.in ? { in: { ...anim.in } } : {}) };
  const right = { ...(anim.out ? { out: { ...anim.out } } : {}) };
  if (anim.loop) {
    const span = anim.loop.span || totalDur;
    const off = anim.loop.offset || 0;
    left.loop = { ...anim.loop, span, offset: off };
    right.loop = { ...anim.loop, span, offset: off + leftDur };
  }
  return [normalizeAnim(left), normalizeAnim(right)];
}

/** Catalogue for UIs and the AI (ids, labels, kind). */
export function animCatalog(lang = 'fr') {
  const lab = (d) => (lang === 'en' ? d.en : d.label);
  return {
    in: ANIM_IN_IDS.map((id) => ({ id, label: lab(ANIM_IN[id]) })),
    out: ANIM_OUT_IDS.map((id) => ({ id, label: lab(ANIM_OUT[id]) })),
    loop: ANIM_LOOP_IDS.map((id) => ({ id, label: lab(ANIM_LOOP[id]), still: !!ANIM_LOOP[id].still, inner: !!ANIM_LOOP[id].inner })),
  };
}
