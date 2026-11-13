// Subtitle styles + canvas renderer shared by the preview player and the export renderer.
// Sizes are expressed for a 1080 px short side and scaled to the real project size.
//
// Display modes (style.mode):
//   all       every word (classic)
//   emphasis  every word, the important ones get the keyword style (colour, size, font, box, animation)
//   keywords  ONLY the important words are shown, one punchy group at a time
// Important words come from word.k (1 / 0, set by the AI or the user) or, when absent, from the automatic score
// (word.s, see shared/keywords.js) thresholded by style.kwDensity.
import { scoreWords, pickKeywords, emojiFor } from './keywords.js';

export const SUBTITLE_CATEGORIES = [
  ['shorts', 'Réseaux sociaux', 'Social'],
  ['keywords', 'Mots-clés IA', 'AI keywords'],
  ['pro', 'Long format', 'Long form'],
  ['fun', 'Créatif', 'Creative'],
];

export const SUBTITLE_PRESETS = {
  // ---------------------------------------------------------------- social / shorts
  bold: {
    label: 'Bold TikTok', cat: 'shorts', font: 'Montserrat', weight: 900, size: 78, uppercase: true, color: '#FFFFFF',
    strokeColor: '#000000', strokeWidth: 9, shadowColor: 'rgba(0,0,0,0.55)', shadowBlur: 14, shadowX: 0, shadowY: 5,
    highlight: 'color', highlightColor: '#FFE14D', animation: 'pop', animDuration: 0.16, wordReveal: false,
    position: 'bottom', offsetY: 0.22, maxWidth: 0.82, maxWords: 3, maxChars: 22, maxLines: 2, lineHeight: 1.12,
  },
  punch: {
    label: 'Punch couleurs', hint: 'style Hormozi', cat: 'shorts', mode: 'emphasis', font: 'Montserrat', weight: 900, size: 80, uppercase: true,
    color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 9, shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 12, shadowY: 5,
    highlight: 'none', animation: 'pop', animDuration: 0.15, kwColors: ['#FACC15', '#4ADE80', '#F87171'], kwScale: 1.18, kwAnim: 'pop',
    kwDensity: 0.3, position: 'bottom', offsetY: 0.24, maxWidth: 0.84, maxWords: 3, maxChars: 22, maxLines: 2, lineHeight: 1.1,
  },
  highlight: {
    label: 'Boîte mot actif', cat: 'shorts', font: 'Poppins', weight: 800, size: 70, uppercase: true, color: '#FFFFFF',
    strokeColor: '#000000', strokeWidth: 6, shadowColor: 'rgba(0,0,0,0.45)', shadowBlur: 10, shadowY: 4,
    highlight: 'box', highlightColor: '#FFFFFF', highlightBoxColor: '#2563EB', highlightBoxRadius: 14,
    animation: 'bounce', animDuration: 0.18, position: 'bottom', offsetY: 0.24, maxWidth: 0.82, maxWords: 3,
    maxChars: 22, maxLines: 2, lineHeight: 1.18,
  },
  pill: {
    label: 'Surligneur mobile', cat: 'shorts', font: 'Poppins', weight: 800, size: 68, uppercase: false, color: '#FFFFFF',
    strokeColor: '#000000', strokeWidth: 0, shadowColor: 'rgba(0,0,0,0.7)', shadowBlur: 14, shadowY: 3,
    highlight: 'pill', highlightColor: '#FFFFFF', highlightBoxColor: '#EF4444', highlightBoxRadius: 16,
    animation: 'none', position: 'bottom', offsetY: 0.22, maxWidth: 0.84, maxWords: 4, maxChars: 26, maxLines: 2, lineHeight: 1.28,
  },
  bubble: {
    label: 'Bulles', cat: 'shorts', font: 'Poppins', weight: 800, size: 64, uppercase: false, color: '#111111', strokeWidth: 0,
    background: { color: '#FFFFFF', padding: 14, radius: 18, mode: 'word' }, shadowColor: 'rgba(0,0,0,0.25)', shadowBlur: 0,
    highlight: 'color', highlightColor: '#E11D48', animation: 'pop', animDuration: 0.16, position: 'bottom', offsetY: 0.22,
    maxWidth: 0.86, maxWords: 3, maxChars: 24, maxLines: 2, lineHeight: 1.45,
  },
  beast: {
    label: 'Beast', cat: 'shorts', font: 'Luckiest Guy', weight: 400, size: 92, uppercase: true, color: '#FFFFFF',
    strokeColor: '#000000', strokeWidth: 12, shadowColor: '#000000', shadowBlur: 0, shadowX: 0, shadowY: 8,
    highlight: 'color', highlightColor: '#FF3B3B', animation: 'bounce', animDuration: 0.16, position: 'center',
    offsetY: 0.18, maxWidth: 0.85, maxWords: 2, maxChars: 16, maxLines: 2, lineHeight: 1.05,
  },
  reveal: {
    label: 'Mot par mot', cat: 'shorts', font: 'Anton', weight: 400, size: 96, uppercase: true, color: '#FFFFFF',
    strokeColor: '#000000', strokeWidth: 8, shadowColor: 'rgba(0,0,0,0.5)', shadowBlur: 12, shadowY: 6,
    highlight: 'color', highlightColor: '#4ADE80', animation: 'pop', animDuration: 0.14, wordReveal: true,
    position: 'center', offsetY: 0.12, maxWidth: 0.8, maxWords: 3, maxChars: 18, maxLines: 2, lineHeight: 1.05,
  },
  karaoke: {
    label: 'Karaoké', cat: 'shorts', font: 'Montserrat', weight: 800, size: 66, uppercase: false, color: 'rgba(255,255,255,0.55)',
    strokeColor: '#000000', strokeWidth: 6, highlight: 'karaoke', highlightColor: '#22D3EE', animation: 'fade',
    animDuration: 0.12, position: 'bottom', offsetY: 0.14, maxWidth: 0.86, maxWords: 7, maxChars: 34, maxLines: 2,
    lineHeight: 1.2,
  },
  glow: {
    label: 'Lueur', cat: 'shorts', font: 'Inter', weight: 800, size: 70, uppercase: false, color: '#FFFFFF', strokeWidth: 0,
    shadowColor: 'rgba(0,0,0,0.65)', shadowBlur: 16, shadowY: 3, highlight: 'glow', highlightColor: '#FDE047',
    animation: 'rise', animDuration: 0.22, position: 'bottom', offsetY: 0.2, maxWidth: 0.84, maxWords: 4, maxChars: 26,
    maxLines: 2, lineHeight: 1.15,
  },
  // ---------------------------------------------------------------- AI keywords
  keywords: {
    label: 'Mots-clés seuls', cat: 'keywords', mode: 'keywords', font: 'Anton', weight: 400, size: 132, uppercase: true,
    color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 10, shadowColor: 'rgba(0,0,0,0.55)', shadowBlur: 18, shadowY: 8,
    highlight: 'none', animation: 'zoom', animDuration: 0.2, kwColors: ['#FFFFFF', '#FACC15'], kwScale: 1, kwDensity: 0.22,
    emojis: true, position: 'center', offsetY: 0.16, maxWidth: 0.86, maxWords: 3, maxChars: 18, maxLines: 2, lineHeight: 1.02,
  },
  'keywords-pop': {
    label: 'Mots-clés + emoji', cat: 'keywords', mode: 'keywords', font: 'Luckiest Guy', weight: 400, size: 112, uppercase: true,
    color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 11, shadowColor: '#000000', shadowBlur: 0, shadowY: 7,
    highlight: 'none', animation: 'pop', animDuration: 0.18, kwColors: ['#FFFFFF', '#4ADE80', '#FACC15', '#60A5FA'], kwDensity: 0.25,
    emojis: true, tilt: 3, position: 'center', offsetY: 0.12, maxWidth: 0.86, maxWords: 3, maxChars: 18, maxLines: 2, lineHeight: 1.04,
  },
  emphasis: {
    label: 'Mots importants', cat: 'keywords', mode: 'emphasis', font: 'Inter', weight: 800, size: 64, uppercase: false,
    color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 5, shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 10, shadowY: 3,
    highlight: 'none', animation: 'fade', animDuration: 0.12, kwColor: '#FACC15', kwScale: 1.12, kwAnim: 'pop', kwDensity: 0.25,
    position: 'bottom', offsetY: 0.12, maxWidth: 0.84, maxWords: 6, maxChars: 30, maxLines: 2, lineHeight: 1.2,
  },
  editorial: {
    label: 'Éditorial mixte', cat: 'keywords', mode: 'emphasis', font: 'Inter', weight: 700, size: 60, uppercase: false,
    color: '#FFFFFF', strokeWidth: 0, shadowColor: 'rgba(0,0,0,0.75)', shadowBlur: 14, shadowY: 2,
    highlight: 'none', animation: 'rise', animDuration: 0.2, kwFont: 'DM Serif Display', kwWeight: 400, kwColor: '#FDE68A',
    kwScale: 1.3, kwDensity: 0.22, position: 'bottom', offsetY: 0.14, maxWidth: 0.82, maxWords: 5, maxChars: 28, maxLines: 2, lineHeight: 1.22,
  },
  podcast: {
    label: 'Podcast', cat: 'keywords', mode: 'emphasis', font: 'Space Grotesk', weight: 700, size: 58, uppercase: false,
    color: '#FFFFFF', strokeWidth: 0, shadowColor: 'rgba(0,0,0,0.7)', shadowBlur: 12, shadowY: 2,
    highlight: 'dim', animation: 'none', kwColor: '#38BDF8', kwScale: 1.06, kwDensity: 0.22,
    position: 'bottom', offsetY: 0.12, maxWidth: 0.84, maxWords: 7, maxChars: 34, maxLines: 2, lineHeight: 1.22,
  },
  // ---------------------------------------------------------------- long form / pro
  classic: {
    label: 'Classique', cat: 'pro', font: 'Inter', weight: 600, size: 52, uppercase: false, color: '#FFFFFF',
    strokeColor: '#000000', strokeWidth: 4, shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 6, shadowX: 0, shadowY: 2,
    highlight: 'none', animation: 'fade', animDuration: 0.12, position: 'bottom', offsetY: 0.08,
    maxWidth: 0.86, maxWords: 12, maxChars: 42, maxLines: 2, lineHeight: 1.2,
  },
  streaming: {
    label: 'Streaming', cat: 'pro', font: 'Roboto', weight: 500, size: 48, uppercase: false, color: '#FFFFFF', strokeWidth: 0,
    shadowColor: 'rgba(0,0,0,0.9)', shadowBlur: 8, shadowY: 2, highlight: 'none', animation: 'none', position: 'bottom',
    offsetY: 0.07, maxWidth: 0.8, maxWords: 14, maxChars: 42, maxLines: 2, lineHeight: 1.25,
  },
  minimal: {
    label: 'Minimal', cat: 'pro', font: 'Inter', weight: 500, size: 44, uppercase: false, color: '#FFFFFF', strokeWidth: 0,
    shadowColor: 'rgba(0,0,0,0.85)', shadowBlur: 10, shadowY: 2, highlight: 'none', animation: 'fade',
    animDuration: 0.15, position: 'bottom', offsetY: 0.07, maxWidth: 0.8, maxWords: 12, maxChars: 48, maxLines: 2,
    lineHeight: 1.25,
  },
  box: {
    label: 'Boîte', cat: 'pro', font: 'Inter', weight: 700, size: 54, uppercase: false, color: '#FFFFFF', strokeWidth: 0,
    background: { color: 'rgba(0,0,0,0.72)', padding: 18, radius: 14, mode: 'line' },
    highlight: 'color', highlightColor: '#7DD3FC', animation: 'fade', animDuration: 0.12,
    position: 'bottom', offsetY: 0.1, maxWidth: 0.84, maxWords: 8, maxChars: 34, maxLines: 2, lineHeight: 1.35,
  },
  documentary: {
    label: 'Documentaire', cat: 'pro', font: 'Inter', weight: 500, size: 46, uppercase: false, color: '#F5F5F5', strokeWidth: 0,
    letterSpacing: 0.4, background: { color: 'rgba(0,0,0,0.55)', padding: 22, radius: 0, mode: 'band' },
    highlight: 'none', animation: 'fade', animDuration: 0.2, position: 'bottom', offsetY: 0.06, maxWidth: 0.84, maxWords: 12,
    maxChars: 44, maxLines: 2, lineHeight: 1.3,
  },
  underline: {
    label: 'Soulignement', cat: 'pro', font: 'Inter', weight: 800, size: 60, uppercase: false, color: '#FFFFFF', strokeWidth: 0,
    shadowColor: 'rgba(0,0,0,0.7)', shadowBlur: 12, shadowY: 3, highlight: 'underline', highlightColor: '#F59E0B',
    animation: 'none', position: 'bottom', offsetY: 0.12, maxWidth: 0.84, maxWords: 6, maxChars: 30, maxLines: 2, lineHeight: 1.3,
  },
  cascade: {
    label: 'Cascade', cat: 'pro', font: 'Montserrat', weight: 700, size: 62, uppercase: false, color: '#FFFFFF', strokeWidth: 4,
    strokeColor: '#000000', shadowColor: 'rgba(0,0,0,0.5)', shadowBlur: 10, shadowY: 3, highlight: 'none',
    animation: 'stagger', animDuration: 0.22, position: 'bottom', offsetY: 0.12, maxWidth: 0.84, maxWords: 6, maxChars: 30,
    maxLines: 2, lineHeight: 1.18,
  },
  cinematic: {
    label: 'Cinéma', cat: 'pro', font: 'Playfair Display', weight: 700, size: 50, uppercase: false, color: '#F5F5F4',
    strokeWidth: 0, shadowColor: 'rgba(0,0,0,0.7)', shadowBlur: 16, shadowY: 3, letterSpacing: 1.5,
    highlight: 'none', animation: 'fade', animDuration: 0.3, position: 'bottom', offsetY: 0.09, maxWidth: 0.78,
    maxWords: 10, maxChars: 44, maxLines: 2, lineHeight: 1.3,
  },
  typewriter: {
    label: 'Machine à écrire', cat: 'pro', font: 'Roboto Mono', weight: 700, size: 52, uppercase: false, color: '#FFFFFF',
    background: { color: 'rgba(17,17,17,0.85)', padding: 14, radius: 6, mode: 'block' }, strokeWidth: 0,
    highlight: 'none', animation: 'typewriter', animDuration: 0.1, position: 'bottom', offsetY: 0.1,
    maxWidth: 0.82, maxWords: 9, maxChars: 36, maxLines: 2, lineHeight: 1.3,
  },
  // ---------------------------------------------------------------- creative
  neon: {
    label: 'Néon', cat: 'fun', font: 'Poppins', weight: 700, size: 64, uppercase: false, color: '#F0ABFC',
    strokeColor: '#FFFFFF', strokeWidth: 0, shadowColor: '#E879F9', shadowBlur: 28, shadowX: 0, shadowY: 0,
    highlight: 'color', highlightColor: '#FFFFFF', animation: 'slide', animDuration: 0.2, position: 'bottom',
    offsetY: 0.15, maxWidth: 0.84, maxWords: 6, maxChars: 30, maxLines: 2, lineHeight: 1.2,
  },
  gaming: {
    label: 'Gaming', cat: 'fun', font: 'Bangers', weight: 400, size: 98, uppercase: true, color: '#FDE047', strokeColor: '#111827',
    strokeWidth: 10, shadowColor: '#000000', shadowBlur: 0, shadowY: 7, highlight: 'scale', highlightColor: '#FFFFFF', highlightScale: 1.2,
    animation: 'drop', animDuration: 0.28, tilt: 3, position: 'center', offsetY: 0.2, maxWidth: 0.86, maxWords: 3, maxChars: 18,
    maxLines: 2, lineHeight: 1.05,
  },
  comic: {
    label: 'BD', cat: 'fun', font: 'Bangers', weight: 400, size: 84, uppercase: true, color: '#111111', strokeWidth: 0,
    background: { color: '#FDE047', padding: 18, radius: 6, mode: 'block' }, shadowColor: 'rgba(0,0,0,0)', highlight: 'color',
    highlightColor: '#DC2626', animation: 'pop', animDuration: 0.16, tilt: -2.5, position: 'bottom', offsetY: 0.2,
    maxWidth: 0.82, maxWords: 4, maxChars: 22, maxLines: 2, lineHeight: 1.1,
  },
  wave: {
    label: 'Vague', cat: 'fun', font: 'Lilita One', weight: 400, size: 84, uppercase: false, color: '#FFFFFF', strokeColor: '#000000',
    strokeWidth: 7, shadowColor: 'rgba(0,0,0,0.5)', shadowBlur: 8, shadowY: 5, highlight: 'color', highlightColor: '#22D3EE',
    animation: 'wave', animDuration: 0.2, position: 'bottom', offsetY: 0.2, maxWidth: 0.84, maxWords: 4, maxChars: 24,
    maxLines: 2, lineHeight: 1.15,
  },
  marker: {
    label: 'Surligneur', cat: 'fun', font: 'Poppins', weight: 800, size: 64, uppercase: false, color: '#FFFFFF', strokeColor: '#000000',
    strokeWidth: 5, shadowColor: 'rgba(0,0,0,0.4)', shadowBlur: 8, shadowY: 3, highlight: 'marker', highlightColor: '#111111',
    highlightBoxColor: '#FDE047', animation: 'none', position: 'bottom', offsetY: 0.18, maxWidth: 0.84, maxWords: 4, maxChars: 26,
    maxLines: 2, lineHeight: 1.3,
  },
  split: {
    label: 'Deux tons', cat: 'fun', font: 'Montserrat', weight: 900, size: 72, uppercase: true, color: '#FFFFFF', secondLineColor: '#FACC15',
    strokeColor: '#000000', strokeWidth: 7, shadowColor: 'rgba(0,0,0,0.5)', shadowBlur: 10, shadowY: 4, highlight: 'none',
    animation: 'pop', animDuration: 0.15, position: 'bottom', offsetY: 0.2, maxWidth: 0.8, maxWords: 4, maxChars: 14, maxLines: 2,
    lineHeight: 1.08,
  },
  outline: {
    label: 'Contour', cat: 'fun', font: 'Montserrat', weight: 900, size: 84, uppercase: true, color: 'rgba(255,255,255,0)',
    strokeColor: '#FFFFFF', strokeWidth: 2.5, shadowColor: 'rgba(0,0,0,0)', highlight: 'color', highlightColor: '#FFFFFF',
    animation: 'none', position: 'center', offsetY: 0.18, maxWidth: 0.84, maxWords: 3, maxChars: 18, maxLines: 2, lineHeight: 1.08,
  },
  retro: {
    label: 'Rétro VHS', cat: 'fun', font: 'Roboto Mono', weight: 700, size: 58, uppercase: true, color: '#E0F2FE', strokeWidth: 0,
    shadowColor: '#FF00AA', shadowBlur: 0, shadowX: 4, shadowY: 0, highlight: 'color', highlightColor: '#67E8F9',
    animation: 'none', letterSpacing: 2, position: 'bottom', offsetY: 0.12, maxWidth: 0.84, maxWords: 5, maxChars: 26,
    maxLines: 2, lineHeight: 1.25,
  },
};

export const SUBTITLE_DEFAULT_PRESET = 'bold';

export const SUBTITLE_STYLE_KEYS = [
  'font', 'weight', 'size', 'uppercase', 'letterSpacing', 'lineHeight', 'color', 'strokeColor', 'strokeWidth',
  'shadowColor', 'shadowBlur', 'shadowX', 'shadowY', 'highlight', 'highlightColor', 'highlightBoxColor',
  'highlightBoxRadius', 'highlightScale', 'background', 'position', 'offsetY', 'maxWidth', 'align', 'animation',
  'animDuration', 'wordReveal', 'maxWords', 'maxChars', 'maxLines',
  // smart subtitles
  'mode', 'kwDensity', 'kwColor', 'kwColors', 'kwScale', 'kwFont', 'kwWeight', 'kwUppercase', 'kwBox', 'kwBoxColor', 'kwAnim',
  'kwHold', 'emojis', 'emojiScale', 'tilt', 'secondLineColor', 'stripPunct',
];

export const SUBTITLE_MODES = ['all', 'emphasis', 'keywords'];
export const SUBTITLE_HIGHLIGHTS = ['none', 'color', 'box', 'pill', 'karaoke', 'scale', 'underline', 'glow', 'dim', 'marker'];
export const SUBTITLE_ANIMATIONS = ['none', 'pop', 'bounce', 'fade', 'slide', 'rise', 'zoom', 'blur', 'drop', 'wave', 'stagger', 'swipe', 'typewriter'];
export const KEYWORD_ANIMATIONS = ['none', 'pop', 'shake', 'wiggle', 'glow'];
export const SUBTITLE_BACKGROUNDS = ['line', 'block', 'word', 'band'];

const BASE_STYLE = {
  font: 'Inter', weight: 700, size: 60, uppercase: false, letterSpacing: 0, lineHeight: 1.2, color: '#FFFFFF',
  strokeColor: '#000000', strokeWidth: 0, shadowColor: 'rgba(0,0,0,0)', shadowBlur: 0, shadowX: 0, shadowY: 0,
  highlight: 'none', highlightColor: '#FFE14D', highlightBoxColor: '#2563EB', highlightBoxRadius: 12,
  highlightScale: 1.14, background: null, position: 'bottom', offsetY: 0.1, maxWidth: 0.84, align: 'center',
  animation: 'none', animDuration: 0.15, wordReveal: false, maxWords: 6, maxChars: 32, maxLines: 2,
  mode: 'all', kwDensity: 0.25, kwColor: '#FACC15', kwColors: null, kwScale: 1.12, kwFont: '', kwWeight: 0, kwUppercase: null,
  kwBox: false, kwBoxColor: '#EF4444', kwAnim: 'none', kwHold: 0.35, emojis: false, emojiScale: 1.15, tilt: 0, secondLineColor: '',
  stripPunct: null, // null = automatic: social styles (keywords mode or uppercase) drop trailing . , ; :
};

export function resolveSubtitleStyle(style) {
  const preset = SUBTITLE_PRESETS[style?.preset] || SUBTITLE_PRESETS[SUBTITLE_DEFAULT_PRESET];
  const st = { ...BASE_STYLE, ...preset, ...(style || {}) };
  if (!SUBTITLE_MODES.includes(st.mode)) st.mode = 'all';
  return st;
}

/** Binary search the cue active at time t. Cues must be sorted by start. */
export function activeCueIndex(cues, t) {
  let lo = 0, hi = cues.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found >= 0 && t < cues[found].end) return found;
  return -1;
}

export function cueWords(cue) {
  if (cue.words && cue.words.length) return cue.words;
  // Distribute words evenly when there is no word timing (manual cue).
  const parts = String(cue.text || '').split(/\s+/).filter(Boolean);
  const d = (cue.end - cue.start) / Math.max(1, parts.length);
  return parts.map((w, i) => ({ text: w, start: cue.start + i * d, end: cue.start + (i + 1) * d }));
}

// ------------------------------------------------------------------------------------------------ smart subtitles
const kwCache = new WeakMap(); // cues array → Map(density → Map(cueId → bool[]))

/** Keyword flags for every cue (bool per word): explicit word.k first, else automatic scores × density. */
export function keywordFlags(cues, density = 0.25) {
  let byD = kwCache.get(cues);
  if (!byD) { byD = new Map(); kwCache.set(cues, byD); }
  const key = Math.round(density * 100);
  if (byD.has(key)) return byD.get(key);
  const all = [];
  for (const q of cues) cueWords(q).forEach((w, i) => all.push({ q, i, w }));
  const words = all.map((x) => x.w);
  const missing = words.some((w) => !Number.isFinite(w.s));
  const scores = missing ? scoreWords(words) : words.map((w) => w.s);
  const auto = all.filter((x) => x.w.k !== 0 && x.w.k !== 1);
  const autoIdx = new Map(auto.map((x, j) => [x, j]));
  const picked = pickKeywords(auto.map((x) => x.w), auto.map((x) => scores[all.indexOf(x)]), { density });
  const out = new Map();
  for (const q of cues) out.set(q.id, []);
  for (const x of all) {
    const flag = x.w.k === 1 ? true : x.w.k === 0 ? false : picked.has(autoIdx.get(x));
    out.get(x.q.id)[x.i] = flag;
  }
  byD.set(key, out);
  return out;
}

const dispCache = new WeakMap(); // cues → Map(signature → list)

/**
 * Cues as displayed: in "keywords" mode, groups of consecutive keywords become their own short cues
 * (held at least kwHold seconds, never overlapping the next group). Each display cue carries `flags`.
 */
export function displayCues(cues, st) {
  if (!cues?.length) return [];
  const sig = `${st.mode}|${Math.round((st.kwDensity ?? 0.25) * 100)}|${st.kwHold}`;
  let m = dispCache.get(cues);
  if (!m) { m = new Map(); dispCache.set(cues, m); }
  if (m.has(sig)) return m.get(sig);
  let list;
  if (st.mode === 'all') list = cues.map((q) => ({ ...q, flags: null, src: q }));
  else {
    const flags = keywordFlags(cues, st.kwDensity ?? 0.25);
    if (st.mode === 'emphasis') list = cues.map((q) => ({ ...q, flags: flags.get(q.id), src: q }));
    else {
      list = [];
      for (const q of cues) {
        const ws = cueWords(q), fl = flags.get(q.id) || [];
        let group = null, first = true;
        const flush = () => { if (group) { list.push(group); group = null; } };
        ws.forEach((w, i) => {
          if (!fl[i]) { flush(); return; }
          if (group && (w.start - group.words[group.words.length - 1].end > 0.3 || group.words.length >= 3)) flush();
          if (!group) {
            group = { id: `${q.id}~${i}`, start: w.start, end: w.end, words: [], text: '', src: q, emoji: first ? q.emoji || null : null };
            first = false;
          }
          group.words.push(w);
          group.end = w.end;
        });
        flush();
      }
      const hold = Math.max(0.15, st.kwHold ?? 0.35);
      list.forEach((g, j) => {
        const next = list[j + 1];
        g.end = Math.max(g.end, g.start + hold, g.end + 0.12);
        if (next && g.end > next.start) g.end = next.start;
        g.text = g.words.map((w) => w.text).join(' ');
        g.flags = g.words.map(() => true);
      });
    }
  }
  m.set(sig, list);
  return list;
}

// ------------------------------------------------------------------------------------------------ layout
const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
const famOf = (f) => (/[\s,]/.test(f) ? `"${f}"` : f);
function fontString(st, scale, kw = false) {
  const family = kw && st.kwFont ? st.kwFont : st.font;
  const weight = kw && st.kwWeight ? st.kwWeight : st.weight;
  const mul = kw && st.mode !== 'all' ? st.kwScale || 1 : 1;
  return `${weight} ${Math.round(st.size * scale * mul)}px ${famOf(family)}, "Segoe UI", Arial, sans-serif`;
}
const upperOf = (st, kw) => (kw && st.kwUppercase !== null && st.kwUppercase !== undefined ? !!st.kwUppercase : !!st.uppercase);
/** Displayed text of a word: case + (social styles) without the trailing . , ; : that look amateurish on screen. */
export function wordLabel(st, text, kw = false) {
  let s = upperOf(st, kw) ? String(text).toUpperCase() : String(text);
  const strip = st.stripPunct ?? (st.mode === 'keywords' || !!st.uppercase);
  if (strip) { const t = s.replace(/[.,;:…]+$/u, ''); if (t) s = t; }
  return s;
}

/** Size unit: style sizes are px for a 1080 px short side (so vertical 1080×1920 and 1920×1080 match). */
export const subtitleScale = (W, H) => Math.min(W, H) / 1080;

export function layoutCue(ctx, cue, st, W, H) {
  const scale = subtitleScale(W, H);
  const flags = cue.flags || null;
  let kwi = 0;
  const words = cueWords(cue).map((w, i, arr) => {
    const kw = !!flags?.[i];
    const o = { ...w, i, kw, label: wordLabel(st, w.text, kw) };
    // a number written in groups ("10 000") keeps a single keyword colour
    if (kw) o.kwi = i > 0 && flags?.[i - 1] && /\d$/.test(String(arr[i - 1].text)) && /^\d{3}\b/.test(String(w.text)) ? kwi - 1 : kwi++;
    return o;
  });
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(st.letterSpacing || 0) * scale}px`;
  ctx.font = fontString(st, scale);
  const boxy = st.highlight === 'box' || st.highlight === 'pill' || st.highlight === 'marker' || st.background?.mode === 'word' || st.kwBox;
  const extra = boxy ? 0.42 : st.highlight === 'scale' || st.animation === 'bounce' ? 0.12 : 0;
  const space = ctx.measureText(' ').width + extra * st.size * scale;
  for (const w of words) { ctx.font = fontString(st, scale, w.kw); w.font = ctx.font; w.w = ctx.measureText(w.label).width; }
  const maxW = st.maxWidth * W;
  const lines = [];
  let cur = { words: [], width: 0 };
  for (const w of words) {
    const add = cur.words.length ? space + w.w : w.w;
    if (cur.words.length && cur.width + add > maxW) { lines.push(cur); cur = { words: [], width: 0 }; }
    cur.words.push(w);
    cur.width += cur.words.length > 1 ? space + w.w : w.w;
  }
  if (cur.words.length) lines.push(cur);
  const fontPx = st.size * scale;
  const lh = fontPx * st.lineHeight;
  const kwMul = st.mode !== 'all' ? Math.max(1, st.kwScale || 1) : 1;
  for (const ln of lines) ln.lh = lh * (ln.words.some((w) => w.kw) ? 1 + (kwMul - 1) * 0.85 : 1);
  const blockH = lines.reduce((s, l) => s + l.lh, 0);
  let top;
  if (st.position === 'top') top = st.offsetY * H;
  else if (st.position === 'center') top = H / 2 - blockH / 2 + (st.offsetY || 0) * H; // offsetY = shift down
  else top = H - st.offsetY * H - blockH;
  let y = top;
  lines.forEach((ln, li) => {
    let x;
    if (st.align === 'left') x = (W - maxW) / 2;
    else if (st.align === 'right') x = (W + maxW) / 2 - ln.width;
    else x = (W - ln.width) / 2;
    ln.y = y + ln.lh / 2; // vertical centre of the line
    ln.x = x;
    ln.index = li;
    for (const w of ln.words) { w.x = x; w.cy = ln.y; w.line = li; x += w.w + space; }
    y += ln.lh;
  });
  return { lines, words: lines.flatMap((l) => l.words), fontPx, lh, space, top, blockH, scale };
}

// ------------------------------------------------------------------------------------------------ drawing helpers
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeOutBack = (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeOutBounce = (p) => {
  if (p < 1 / 2.75) return 7.5625 * p * p;
  if (p < 2 / 2.75) return 7.5625 * Math.pow(p - 1.5 / 2.75, 2) + 0.75;
  if (p < 2.5 / 2.75) return 7.5625 * Math.pow(p - 2.25 / 2.75, 2) + 0.9375;
  return 7.5625 * Math.pow(p - 2.625 / 2.75, 2) + 0.984375;
};

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function activeWordIndex(words, t) {
  let idx = -1;
  for (let i = 0; i < words.length; i++) if (t >= words[i].start) idx = i;
  return idx;
}

const REVEAL_ANIMS = new Set(['rise', 'zoom', 'blur', 'drop']);
const CUE_ANIMS = new Set(['fade', 'slide', 'stagger', 'swipe']);

/** Does the frame at t change from one frame to the next (needs a unique render)? */
function isAnimating(cue, words, wi, st, t) {
  const ad = Math.max(0.01, st.animDuration || 0.15);
  const sinceCue = t - cue.start, untilEnd = cue.end - t;
  if (st.animation === 'typewriter' || st.highlight === 'karaoke' || st.animation === 'wave') return true;
  if (st.mode !== 'all' && (st.kwAnim === 'shake' || st.kwAnim === 'wiggle') && cue.flags?.some(Boolean)) return true;
  if ((st.animation === 'fade' || st.animation === 'slide' || st.animation === 'swipe') && (sinceCue < ad * 1.6 || untilEnd < ad)) return true;
  if (st.animation === 'stagger' && sinceCue < 0.06 * words.length + ad) return true;
  const recent = (w) => t - w.start >= -1e-6 && t - w.start < ad * 2.2;
  if (words.some(recent) && st.animation !== 'none' && !CUE_ANIMS.has(st.animation)) return true;
  if ((st.highlight === 'pill' || st.highlight === 'underline' || st.highlight === 'marker') && wi >= 0 && t - words[wi].start < 0.2) return true;
  if (st.mode !== 'all' && st.kwAnim !== 'none' && words.some((w) => w.kw && recent(w))) return true;
  if (st.emojis && words.some((w) => w.kw && t - w.start >= 0 && t - w.start < 0.3)) return true;
  if (cue.emoji && sinceCue < 0.3) return true;
  return false;
}

function cueEmoji(cue, words, st) {
  if (cue.emoji) return { emoji: cue.emoji, w: words.find((w) => w.kw) || words[0] };
  if (!st.emojis) return null;
  for (const w of words) if (w.kw) { const e = emojiFor(w.text); if (e) return { emoji: e, w }; }
  return null;
}

/**
 * Visual state signature at time t — identical signatures produce identical frames,
 * which lets the exporter skip re-rendering static subtitle frames.
 */
export function subtitleSignature(cues, style, t, fps) {
  const st = resolveSubtitleStyle(style);
  const list = displayCues(cues, st);
  const i = activeCueIndex(list, t);
  if (i < 0) return 'none';
  const cue = list[i];
  const words = cueWords(cue).map((w, k) => ({ ...w, kw: !!cue.flags?.[k] }));
  const wi = activeWordIndex(words, t);
  const phase = isAnimating(cue, words, wi, st, t) ? `f${Math.round(t * fps)}` : 's';
  return `${cue.id}|${wi}|${phase}`;
}

/**
 * Draw the subtitles at time t on a canvas context sized W×H (project pixels; caller may pre-scale ctx).
 * `cache` is a Map used to memoize layouts.
 */
export function drawSubtitles(ctx, cues, style, t, W, H, cache) {
  const st = resolveSubtitleStyle(style);
  const list = displayCues(cues, st);
  const ci = activeCueIndex(list, t);
  if (ci < 0) return false;
  const cue = list[ci];
  const key = `${cue.id}|${cue.text}|${cue.start}|${cue.end}|${W}x${H}|${(cue.flags || []).map((f) => (f ? 1 : 0)).join('')}|${JSON.stringify(st)}`;
  let lay = cache && cache.get(key);
  if (!lay) {
    lay = layoutCue(ctx, cue, st, W, H);
    if (cache) { if (cache.size > 400) cache.clear(); cache.set(key, lay); }
  }
  const { lines, words, fontPx, scale } = lay;
  const wi = activeWordIndex(words, t);
  const ad = Math.max(0.01, st.animDuration || 0.15);
  const sinceCue = t - cue.start;
  const untilEnd = cue.end - t;
  const reveal = st.wordReveal || REVEAL_ANIMS.has(st.animation) || st.animation === 'typewriter';
  const emph = st.mode !== 'all';

  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(st.letterSpacing || 0) * scale}px`;

  // cue-level animation
  let cueAlpha = 1, cueDy = 0;
  if (st.animation === 'fade' || st.animation === 'slide') {
    cueAlpha = Math.min(1, sinceCue / ad, untilEnd / ad);
    if (st.animation === 'slide') cueDy = (1 - easeOut(Math.min(1, sinceCue / ad))) * 26 * scale;
  } else if (st.animation === 'swipe') cueAlpha = Math.min(1, untilEnd / ad);
  ctx.globalAlpha = clamp01(cueAlpha);
  ctx.translate(0, cueDy);
  // tilt: alternate the angle from cue to cue
  if (st.tilt) {
    const cx = W / 2, cy = lay.top + lay.blockH / 2;
    ctx.translate(cx, cy);
    ctx.rotate(((ci % 2 ? 1 : -1) * st.tilt * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  if (st.animation === 'swipe') {
    const p = easeOut(clamp01(sinceCue / (ad * 1.6)));
    let minX = Infinity, maxX = -Infinity;
    for (const ln of lines) { minX = Math.min(minX, ln.x); maxX = Math.max(maxX, ln.x + ln.width); }
    const pad = fontPx;
    ctx.beginPath();
    ctx.rect(minX - pad, lay.top - pad * 2, (maxX - minX + pad * 2) * p, lay.blockH + pad * 4);
    ctx.clip();
  }

  // typewriter: how many characters are visible
  const typeVisible = (w) => {
    if (st.animation !== 'typewriter') return w.label.length;
    if (t >= w.end) return w.label.length;
    if (t < w.start) return 0;
    const p = (t - w.start) / Math.max(0.01, w.end - w.start);
    return Math.max(1, Math.ceil(p * w.label.length));
  };
  const staggerAt = (idx) => cue.start + idx * 0.06;
  const visibleWord = (w, idx) => {
    if (st.animation === 'stagger') return t >= staggerAt(idx);
    if (reveal) return idx <= wi;
    return true;
  };

  // background boxes
  const bg = st.background;
  if (bg && bg.color) {
    const pad = (bg.padding ?? 16) * scale;
    const rad = (bg.radius ?? 10) * scale;
    ctx.fillStyle = bg.color;
    if (bg.mode === 'block' || bg.mode === 'band') {
      let minX = Infinity, maxX = -Infinity;
      for (const ln of lines) { minX = Math.min(minX, ln.x); maxX = Math.max(maxX, ln.x + ln.width); }
      const y0 = lines[0].y - lines[0].lh / 2, y1 = lines[lines.length - 1].y + lines[lines.length - 1].lh / 2;
      if (bg.mode === 'band') { ctx.fillRect(-W, y0 - pad * 0.5, W * 3, y1 - y0 + pad); }
      else { roundRect(ctx, minX - pad, y0 - pad * 0.4, maxX - minX + pad * 2, y1 - y0 + pad * 0.8, rad); ctx.fill(); }
    } else if (bg.mode === 'word') {
      words.forEach((w, idx) => {
        if (!visibleWord(w, idx)) return;
        const s = wordScaleAt(w, idx);
        const lhW = lines[w.line].lh;
        ctx.save();
        ctx.translate(w.x + w.w / 2, w.cy);
        ctx.scale(s, s);
        roundRect(ctx, -w.w / 2 - pad * 0.7, -lhW * 0.42, w.w + pad * 1.4, lhW * 0.84, rad);
        ctx.fill();
        ctx.restore();
      });
    } else {
      for (const ln of lines) {
        const vis = ln.words.filter((w) => visibleWord(w, words.indexOf(w)));
        if (!vis.length) continue;
        const x0 = vis[0].x, x1 = vis[vis.length - 1].x + vis[vis.length - 1].w;
        roundRect(ctx, x0 - pad, ln.y - ln.lh / 2 + pad * 0.15, x1 - x0 + pad * 2, ln.lh - pad * 0.3, rad);
        ctx.fill();
      }
    }
  }

  function wordScaleAt(w, idx) {
    const isActive = idx === wi && t < cue.end;
    const since = t - w.start;
    let s = 1;
    if (st.animation === 'pop' && since >= 0 && since < ad) s = 0.55 + 0.45 * easeOutBack(since / ad);
    if (st.animation === 'pop' && !reveal && idx > wi) s = 1;
    if (st.animation === 'bounce' && isActive && since >= 0 && since < ad * 2) s = 1 + (st.highlightScale - 1) * Math.sin((since / (ad * 2)) * Math.PI);
    else if (st.highlight === 'scale' && isActive) s = st.highlightScale;
    if (st.animation === 'zoom' && since >= 0 && since < ad) s *= 1.6 - 0.6 * easeOut(since / ad);
    if (emph && w.kw && st.kwAnim === 'pop' && since >= 0 && since < ad * 1.5) s *= 1 + 0.25 * Math.sin((since / (ad * 1.5)) * Math.PI);
    return s;
  }

  // moving highlight box ("pill") behind the active word, sliding from the previous one
  if (st.highlight === 'pill' && wi >= 0 && t < cue.end && visibleWord(words[wi], wi)) {
    const a = words[wi], b = words[wi - 1];
    const p = b && b.line === a.line ? easeOut(clamp01((t - a.start) / 0.12)) : 1;
    const ax = b && b.line === a.line ? b.x + (a.x - b.x) * p : a.x;
    const aw = b && b.line === a.line ? b.w + (a.w - b.w) * p : a.w;
    const padX = 0.2 * fontPx, padY = 0.12 * fontPx;
    ctx.fillStyle = st.highlightBoxColor;
    roundRect(ctx, ax - padX, a.cy - fontPx * 0.55 - padY, aw + padX * 2, fontPx * 1.1 + padY * 2, st.highlightBoxRadius * scale);
    ctx.fill();
  }

  words.forEach((w, idx) => {
    if (!visibleWord(w, idx)) return;
    const isActive = idx === wi && t < cue.end;
    const since = t - w.start;
    let s = wordScaleAt(w, idx);
    let dy = 0, alpha = 1, blur = 0, rot = 0;
    if (st.animation === 'rise' && since < ad) { const p = clamp01(since / ad); dy = (1 - easeOut(p)) * 0.45 * fontPx; alpha = p; }
    if (st.animation === 'zoom' && since < ad) alpha = clamp01(since / ad);
    if (st.animation === 'blur' && since < ad) { const p = clamp01(since / ad); blur = (1 - p) * 14 * scale; alpha = p; }
    if (st.animation === 'drop' && since < ad * 1.6) { const p = clamp01(since / (ad * 1.6)); dy = -(1 - easeOutBounce(p)) * 0.9 * fontPx; alpha = Math.min(1, p * 4); }
    if (st.animation === 'stagger') { const p = clamp01((t - staggerAt(idx)) / ad); dy = (1 - easeOut(p)) * 0.3 * fontPx; alpha = p; }
    if (st.animation === 'wave') dy += Math.sin(t * 6.2 + idx * 0.8) * 0.07 * fontPx;
    if (emph && w.kw && st.kwAnim === 'shake') { dy += Math.sin(t * 47 + idx) * 0.02 * fontPx; rot = Math.sin(t * 31 + idx * 2) * 2.2; }
    if (emph && w.kw && st.kwAnim === 'wiggle') rot = Math.sin(t * 5.5 + idx) * 4;
    if (st.highlight === 'dim' && !isActive && !(emph && w.kw)) alpha *= 0.42;

    const label = st.animation === 'typewriter' ? w.label.slice(0, typeVisible(w)) : w.label;
    const cx = w.x + w.w / 2;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha = clamp01(cueAlpha) * alpha;
    ctx.translate(cx, w.cy + dy);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    if (s !== 1) ctx.scale(s, s);
    if (blur > 0.2 && 'filter' in ctx) ctx.filter = `blur(${blur}px)`;
    ctx.font = w.font;
    const x = -w.w / 2;
    const px = emph && w.kw ? fontPx * (st.kwScale || 1) : fontPx;

    // fills
    let fill = st.color;
    if (st.secondLineColor && w.line % 2 === 1) fill = st.secondLineColor;
    if (emph && w.kw) {
      const pal = Array.isArray(st.kwColors) && st.kwColors.length ? st.kwColors : null;
      fill = pal ? pal[w.kwi % pal.length] : st.kwColor || fill;
    }
    if (isActive && (st.highlight === 'color' || st.highlight === 'box' || st.highlight === 'scale' || st.highlight === 'pill' || st.highlight === 'marker' || st.highlight === 'glow')) {
      if (st.highlight !== 'glow') fill = st.highlightColor || fill;
    }
    // per-word boxes
    if (emph && w.kw && st.kwBox) {
      const padX = 0.18 * px, padY = 0.08 * px;
      ctx.fillStyle = st.kwBoxColor;
      roundRect(ctx, x - padX, -px * 0.55 - padY, w.w + padX * 2, px * 1.1 + padY * 2, (st.highlightBoxRadius || 12) * scale);
      ctx.fill();
    }
    if (isActive && st.highlight === 'box') {
      const padX = 0.18 * px, padY = 0.08 * px;
      ctx.fillStyle = st.highlightBoxColor;
      roundRect(ctx, x - padX, -px * 0.55 - padY, w.w + padX * 2, px * 1.1 + padY * 2, st.highlightBoxRadius * scale);
      ctx.fill();
    }
    if (isActive && st.highlight === 'marker') {
      const p = easeOut(clamp01((t - w.start) / 0.18));
      const padX = 0.12 * px;
      ctx.save();
      ctx.rotate(-0.025);
      ctx.fillStyle = st.highlightBoxColor;
      roundRect(ctx, x - padX, -px * 0.36, (w.w + padX * 2) * p, px * 0.78, px * 0.08);
      ctx.fill();
      ctx.restore();
    }

    // glow / shadow + stroke + fill
    const glow = (isActive && st.highlight === 'glow') || (emph && w.kw && st.kwAnim === 'glow');
    if (glow) {
      ctx.shadowColor = st.highlight === 'glow' && isActive ? st.highlightColor : fill;
      ctx.shadowBlur = 26 * scale;
      ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    } else if (st.shadowColor && (st.shadowBlur || st.shadowX || st.shadowY)) {
      ctx.shadowColor = st.shadowColor;
      ctx.shadowBlur = (st.shadowBlur || 0) * scale;
      ctx.shadowOffsetX = (st.shadowX || 0) * scale;
      ctx.shadowOffsetY = (st.shadowY || 0) * scale;
    }
    const outlineOnly = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\)$/i.test(String(fill)) || fill === 'transparent';
    if (st.strokeWidth > 0 && st.strokeColor) {
      ctx.lineWidth = st.strokeWidth * 2 * scale * (emph && w.kw ? Math.sqrt(st.kwScale || 1) : 1);
      ctx.strokeStyle = st.strokeColor;
      ctx.strokeText(label, x, 0);
      if (!glow) ctx.shadowColor = 'rgba(0,0,0,0)';
    }
    if (!outlineOnly) {
      ctx.fillStyle = fill;
      ctx.fillText(label, x, 0);
    }
    ctx.shadowColor = 'rgba(0,0,0,0)';
    if (glow) { ctx.fillStyle = fill; ctx.fillText(label, x, 0); }

    if (st.highlight === 'karaoke' && t >= w.start) {
      const p = t >= w.end ? 1 : (t - w.start) / Math.max(0.01, w.end - w.start);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 2, -px, (w.w + 4) * p, px * 2);
      ctx.clip();
      ctx.fillStyle = st.highlightColor;
      ctx.fillText(label, x, 0);
      ctx.restore();
    }
    if (isActive && st.highlight === 'underline') {
      const p = easeOut(clamp01((t - w.start) / 0.15));
      ctx.fillStyle = st.highlightColor;
      roundRect(ctx, x, px * 0.5, w.w * p, Math.max(3, px * 0.09), px * 0.05);
      ctx.fill();
    }
    ctx.restore();
  });

  // emoji above the text block
  const em = cueEmoji(cue, words, st);
  if (em && em.w && t >= em.w.start - 0.02) {
    const size = fontPx * (st.emojiScale || 1.15);
    const p = clamp01((t - Math.max(cue.start, em.w.start)) / 0.25);
    const s = 0.3 + 0.7 * easeOutBack(p);
    const ex = st.mode === 'keywords' ? em.w.x + em.w.w / 2 : W / 2;
    const ey = lay.top - size * 0.62;
    ctx.save();
    ctx.globalAlpha = clamp01(cueAlpha) * clamp01(p * 3);
    ctx.translate(ex, ey);
    ctx.rotate(Math.sin(t * 3) * 0.08);
    ctx.scale(s, s);
    ctx.font = `${Math.round(size)}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.fillText(em.emoji, 0, 0);
    ctx.restore();
  }
  ctx.restore();
  return true;
}

/** Fonts used by a style (for preloading with document.fonts.load). */
export function subtitleFontSpecs(style) {
  const st = resolveSubtitleStyle(style);
  const out = [`${st.weight} 64px ${famOf(st.font)}`];
  if (st.kwFont) out.push(`${st.kwWeight || st.weight} 64px ${famOf(st.kwFont)}`);
  return out;
}

/**
 * Vertical band (in project px) that contains every subtitle frame — the exporter only renders this band.
 * Accounts for keyword scale, emojis, tilt and vertical animations.
 */
export function subtitleBand(ctx, cues, style, W, H) {
  const st = resolveSubtitleStyle(style);
  const list = displayCues(cues, st);
  const k = subtitleScale(W, H);
  let y0 = Infinity, y1 = -Infinity;
  for (const cue of list) {
    const lay = layoutCue(ctx, cue, st, W, H);
    y0 = Math.min(y0, lay.top);
    y1 = Math.max(y1, lay.top + lay.blockH);
  }
  if (!list.length) { y0 = 0; y1 = 2; }
  const fontPx = st.size * k * (st.mode !== 'all' ? Math.max(1, st.kwScale || 1) : 1);
  let mTop = fontPx * 0.6 + ((st.strokeWidth || 0) + (st.shadowBlur || 0) + Math.abs(st.shadowY || 0)) * k + 30 * k + (st.background ? (st.background.padding || 16) * k : 0);
  let mBot = mTop;
  if (st.animation === 'drop') mTop += fontPx;
  if (st.animation === 'rise' || st.animation === 'stagger' || st.animation === 'wave') mBot += fontPx * 0.5;
  if (st.animation === 'zoom' || st.highlight === 'scale' || st.animation === 'bounce' || st.kwAnim === 'pop') { mTop += fontPx * 0.35; mBot += fontPx * 0.35; }
  if (st.emojis || list.some((c) => c.emoji || c.src?.emoji)) mTop += fontPx * (st.emojiScale || 1.15) * 1.3;
  if (st.tilt) { const e = Math.sin((Math.abs(st.tilt) * Math.PI) / 180) * W * st.maxWidth * 0.55; mTop += e; mBot += e; }
  y0 = Math.max(0, Math.floor(y0 - mTop));
  y1 = Math.min(H, Math.ceil(y1 + mBot));
  if ((y1 - y0) % 2) y1 = Math.min(H, y1 + 1);
  if ((y1 - y0) % 2) y0 = Math.max(0, y0 - 1);
  return { y: y0, h: Math.max(2, y1 - y0) };
}

// ----------------------------------------------------------------------------------------------
// Cue building (words → cues) and SRT/VTT
// ----------------------------------------------------------------------------------------------
const PUNCT_END = /[.!?…]$/;
const PUNCT_SOFT = /[,;:]$/;

/**
 * Group timed words into subtitle cues.
 * words: [{text, start, end}] sorted. opts: {maxWords, maxChars, maxDuration, gap}
 */
/**
 * Words Whisper stamps at the same instant (fillers, fast speech: "Euh, alors, c'est" all at 10.88 s) are spread
 * evenly up to the end of the run, so cues and word highlights get a usable duration.
 */
export function spreadStackedWords(words) {
  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i < out.length;) {
    let j = i;
    while (j + 1 < out.length && Math.abs(out[j + 1].start - out[i].start) < 0.02) j++;
    if (j > i) {
      const end = Math.max(...out.slice(i, j + 1).map((w) => w.end), out[i].start + 0.12 * (j - i + 1));
      const limit = j + 1 < out.length ? Math.max(out[i].start + 0.05, Math.min(end, out[j + 1].start)) : end;
      const d = (limit - out[i].start) / (j - i + 1);
      for (let k = i; k <= j; k++) {
        out[k].start = Math.round((out[i].start + d * (k - i)) * 1000) / 1000;
        out[k].end = Math.round((out[i].start + d * (k - i + 1)) * 1000) / 1000;
      }
    }
    i = j + 1;
  }
  return out;
}

const NUM_TAIL = /\d$/;
const NUM_GROUP = /^\d{3}(?:[.,]\d+)?\b/;

export function buildCues(words, opts = {}) {
  const maxWords = opts.maxWords ?? 6;
  const maxChars = (opts.maxChars ?? 32) * (opts.maxLines ?? 2);
  const maxDur = opts.maxDuration ?? 3.2;
  const gapSplit = opts.gap ?? 0.6;
  const cues = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.text).join(' ');
    cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text, words: cur });
    cur = [];
  };
  words = spreadStackedWords(words);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      // never split a number written in groups ("10 000", "1 500 000")
      const glued = NUM_TAIL.test(prev.text) && NUM_GROUP.test(w.text) && w.start - prev.end < gapSplit;
      if (!glued && (w.start - prev.end > gapSplit || cur.length >= maxWords || chars > maxChars || w.end - cur[0].start > maxDur)) flush();
    }
    cur.push(w);
    const next = words[i + 1];
    const numberContinues = next && NUM_TAIL.test(w.text) && NUM_GROUP.test(next.text);
    if (!numberContinues && (PUNCT_END.test(w.text) || (PUNCT_SOFT.test(w.text) && cur.length >= Math.max(2, maxWords / 2)))) flush();
  }
  flush();
  // a cue too short to be read ("Euh, alors," in 0.04 s) is merged into the next one when they touch
  for (let i = 0; i < cues.length - 1; i++) {
    const c = cues[i], n = cues[i + 1];
    if (c.end - c.start < 0.3 && n.start - c.end < 0.3) {
      n.words = [...c.words, ...n.words];
      n.text = n.words.map((w) => w.text).join(' ');
      n.start = c.start;
      cues.splice(i, 1);
      i--;
    }
  }
  // smooth tiny gaps between consecutive cues + enforce a minimum duration
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i], n = cues[i + 1];
    if (n && n.start - c.end < 0.25) c.end = n.start;
    if (c.end - c.start < 0.35) c.end = Math.min(n ? n.start : c.start + 0.35, c.start + 0.35);
  }
  return cues;
}

const srtTime = (t, sep = ',') => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(Math.min(999, ms), 3)}`;
};
export function cuesToSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}
export function cuesToVtt(cues) {
  return 'WEBVTT\n\n' + cues.map((c) => `${srtTime(c.start, '.')} --> ${srtTime(c.end, '.')}\n${c.text}\n`).join('\n');
}
export function parseSrt(text) {
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
  const toSec = (s) => {
    const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / Math.pow(10, m[4].length);
  };
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '' && l.trim() !== 'WEBVTT');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const txt = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!txt) continue;
    cues.push({ start: toSec(a), end: toSec(z), text: txt });
  }
  return cues;
}
