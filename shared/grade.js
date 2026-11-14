// Lumetri-style colour grade: exposure, white balance, tone ranges, fade and split toning.
//
// The whole grade is a per-channel 1D tone curve y = f_c(x). The preview samples it into SVG feComponentTransfer
// tables (256 entries, exact at every 8-bit value) and the export turns the very same formula into an ffmpeg lutrgb
// expression (lutrgb evaluates it once per 8-bit value), so both renderers produce identical pixels.
// The curve runs BEFORE the basic adjustments of clip.color (brightness, contrast, saturation, hue…).

export const GRADE_DEFAULTS = {
  exposure: 0, // stops (-4..4)
  temperature: 0, // -1 (cool / blue) .. 1 (warm / orange)
  tint: 0, // -1 (green) .. 1 (magenta)
  highlights: 0, // -1..1
  shadows: 0, // -1..1
  whites: 0, // -1..1 (white point)
  blacks: 0, // -1..1 (black point)
  fade: 0, // 0..1 lifted, matte blacks
  splitShadow: 0, // 0..1 colour pushed into the shadows
  splitShadowHue: 200, // degrees
  splitHighlight: 0, // 0..1 colour pushed into the highlights
  splitHighlightHue: 35, // degrees
};
export const GRADE_KEYS = Object.keys(GRADE_DEFAULTS);
const AMOUNT_KEYS = ['exposure', 'temperature', 'tint', 'highlights', 'shadows', 'whites', 'blacks', 'fade', 'splitShadow', 'splitHighlight'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (c, k) => { const v = Number(c?.[k]); return Number.isFinite(v) ? v : GRADE_DEFAULTS[k]; };

/** Does this colour object contain a tone grade (anything the curve would change)? */
export function hasToneGrade(c) {
  return !!c && AMOUNT_KEYS.some((k) => Math.abs(num(c, k)) > 1e-6);
}

/** Fully saturated RGB (0..1) of a hue in degrees. */
export function hueRgb(deg) {
  const h = ((((Number(deg) || 0) % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  if (h < 1) return [1, x, 0];
  if (h < 2) return [x, 1, 0];
  if (h < 3) return [0, 1, x];
  if (h < 4) return [0, x, 1];
  if (h < 5) return [x, 0, 1];
  return [1, 0, x];
}

/** Constants of the curve of channel ch (0 = R, 1 = G, 2 = B). */
function coefs(c, ch) {
  const temp = clamp(num(c, 'temperature'), -1, 1), tint = clamp(num(c, 'tint'), -1, 1);
  const wb = [1 + 0.14 * temp + 0.05 * tint, 1 - 0.12 * tint + 0.01 * temp, 1 - 0.18 * temp + 0.05 * tint][ch];
  const sRgb = hueRgb(num(c, 'splitShadowHue')), hRgb = hueRgb(num(c, 'splitHighlightHue'));
  const sMean = (sRgb[0] + sRgb[1] + sRgb[2]) / 3, hMean = (hRgb[0] + hRgb[1] + hRgb[2]) / 3;
  return {
    G: Math.max(0, wb) * Math.pow(2, clamp(num(c, 'exposure'), -4, 4) / 2.2),
    SH: clamp(num(c, 'shadows'), -1, 1) * 0.3 * 6.75,
    HI: clamp(num(c, 'highlights'), -1, 1) * 0.3 * 6.75,
    WH: clamp(num(c, 'whites'), -1, 1) * 0.25,
    BL: clamp(num(c, 'blacks'), -1, 1) * 0.25,
    FD: clamp(num(c, 'fade'), 0, 1) * 0.2,
    SS: clamp(num(c, 'splitShadow'), 0, 1) * 0.3 * (sRgb[ch] - sMean),
    HH: clamp(num(c, 'splitHighlight'), 0, 1) * 0.3 * (hRgb[ch] - hMean),
  };
}

/** The curve itself (x, y in 0..1). */
function curve(k, x) {
  const a = clamp(x * k.G, 0, 1);
  let y = a + k.SH * a * (1 - a) * (1 - a) + k.HI * a * a * (1 - a) + k.WH * a * a * a + k.BL * (1 - a) * (1 - a) * (1 - a);
  y = k.FD + y * (1 - k.FD);
  y = y + k.SS * (1 - y) * (1 - y) + k.HH * y * y;
  return clamp(y, 0, 1);
}

/** 256-entry tables {r, g, b} (0..1) for the preview, or null when the grade is neutral. */
export function gradeTables(c) {
  if (!hasToneGrade(c)) return null;
  const out = {};
  ['r', 'g', 'b'].forEach((name, ch) => {
    const k = coefs(c, ch);
    const t = new Array(256);
    for (let i = 0; i < 256; i++) t[i] = Math.round(curve(k, i / 255) * 255) / 255;
    out[name] = t;
  });
  return out;
}

/** Same curve evaluated in JS for one channel (tests). */
export function gradeValue(c, ch, x) { return curve(coefs(c, ch), x); }

const f = (x) => {
  const v = Number(x);
  if (!Number.isFinite(v)) return '0';
  return Math.abs(v) < 1e-9 ? '0' : `(${Math.round(v * 1e7) / 1e7})`;
};

/** ffmpeg expression of the curve of one channel for lutrgb (val 0..255 → 0..255). Commas / semicolons escaped. */
function curveExpr(k) {
  const A = 'ld(0)', Y = 'ld(1)';
  const parts = [
    `st(0,clip(val/255*${f(k.G)},0,1))`,
    `st(1,${A}+${f(k.SH)}*${A}*pow(1-${A},2)+${f(k.HI)}*pow(${A},2)*(1-${A})+${f(k.WH)}*pow(${A},3)+${f(k.BL)}*pow(1-${A},3))`,
    `st(1,${f(k.FD)}+${Y}*(1-${f(k.FD)}))`,
    `st(1,${Y}+${f(k.SS)}*pow(1-${Y},2)+${f(k.HH)}*pow(${Y},2))`,
    `floor(clip(${Y},0,1)*255+0.5)`,
  ];
  return parts.join(';').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

/** ffmpeg filter (lutrgb) for the tone grade, or null when neutral. */
export function ffGradeFilter(c) {
  if (!hasToneGrade(c)) return null;
  const [r, g, b] = [0, 1, 2].map((ch) => curveExpr(coefs(c, ch)));
  return `lutrgb=r='${r}':g='${g}':b='${b}'`;
}

// ------------------------------------------------------------------------------------------------ looks
// Ready-made looks: tone grade + basic adjustments (merged into clip.color).
export const LOOKS = {
  natural: { fr: 'Naturel', en: 'Natural', color: { contrast: 1.05, saturation: 1.08, shadows: 0.15, highlights: -0.15 } },
  cinema: { fr: 'Cinéma', en: 'Cinematic', color: { contrast: 1.12, saturation: 0.85, brightness: 0.97, highlights: -0.25, blacks: -0.15, fade: 0.1 } },
  'teal-orange': { fr: 'Teal & orange', en: 'Teal & orange', color: { contrast: 1.1, saturation: 1.05, splitShadow: 0.7, splitShadowHue: 190, splitHighlight: 0.6, splitHighlightHue: 30, highlights: -0.2 } },
  film: { fr: 'Pellicule', en: 'Film', color: { contrast: 1.04, saturation: 0.9, fade: 0.35, temperature: 0.12, splitHighlight: 0.25, splitHighlightHue: 40, blacks: 0.1 } },
  vintage: { fr: 'Vintage', en: 'Vintage', color: { sepia: 0.3, contrast: 0.92, saturation: 0.8, fade: 0.45, temperature: 0.25 } },
  warm: { fr: 'Chaud', en: 'Warm', color: { temperature: 0.45, tint: 0.05, saturation: 1.08, highlights: -0.1 } },
  cold: { fr: 'Froid', en: 'Cold', color: { temperature: -0.45, saturation: 0.92, contrast: 1.05 } },
  'golden-hour': { fr: 'Heure dorée', en: 'Golden hour', color: { temperature: 0.6, exposure: 0.15, splitHighlight: 0.5, splitHighlightHue: 38, shadows: 0.2, saturation: 1.1 } },
  night: { fr: 'Nuit', en: 'Night', color: { temperature: -0.6, exposure: -0.6, saturation: 0.7, contrast: 1.1, splitShadow: 0.5, splitShadowHue: 220 } },
  'bw-contrast': { fr: 'N&B contrasté', en: 'Contrasty B&W', color: { grayscale: 1, contrast: 1.25, blacks: -0.2, whites: 0.15 } },
  faded: { fr: 'Délavé', en: 'Faded', color: { fade: 0.6, saturation: 0.75, contrast: 0.9 } },
  bleach: { fr: 'Sans blanchiment', en: 'Bleach bypass', color: { saturation: 0.45, contrast: 1.3, highlights: 0.15, blacks: -0.2 } },
  cyberpunk: { fr: 'Cyberpunk', en: 'Cyberpunk', color: { splitShadow: 0.8, splitShadowHue: 195, splitHighlight: 0.8, splitHighlightHue: 310, contrast: 1.15, saturation: 1.25, tint: 0.25 } },
  matrix: { fr: 'Matrix', en: 'Matrix', color: { tint: -0.6, saturation: 0.7, contrast: 1.15, splitShadow: 0.4, splitShadowHue: 120 } },
  punchy: { fr: 'Pêchu', en: 'Punchy', color: { contrast: 1.18, saturation: 1.35, shadows: 0.1 } },
  dreamy: { fr: 'Rêveur', en: 'Dreamy', color: { exposure: 0.25, fade: 0.3, highlights: 0.2, saturation: 0.9, splitHighlight: 0.3, splitHighlightHue: 320 } },
};
export const LOOK_IDS = Object.keys(LOOKS);
