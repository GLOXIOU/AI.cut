// Curates the music pack (FreePD public-domain tracks mirrored on archive.org) and the sticker pack
// (Google Noto animated emoji — Lottie, CC BY 4.0 — and Microsoft Fluent 3D emoji — PNG, MIT).
// Output: scripts/packs/music.json and scripts/packs/stickers.json (catalogs used by scripts/fetch-packs.mjs).
//   node scripts/packs/curate-media.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const getJson = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': 'AI.cut pack curation' } }); if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`); return r.json(); };
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ------------------------------------------------------------------ music (FreePD, CC0)
export const FREEPD_MOODS = {
  upbeat: ['joyeux', 'happy', 'upbeat', 'entrainant', 'energique', 'positif', 'vlog', 'pop', 'fun', 'dynamique'],
  electronic: ['electro', 'electronic', 'edm', 'synth', 'tech', 'moderne', 'gaming', 'beat'],
  comedy: ['drole', 'funny', 'comedie', 'comedy', 'quirky', 'cartoon', 'decale', 'humour', 'leger'],
  epic: ['epique', 'epic', 'trailer', 'action', 'orchestral', 'puissant', 'heroique', 'cinematique', 'cinematic'],
  scoring: ['cinema', 'film', 'fond', 'background', 'documentaire', 'documentary', 'ambiance', 'narration', 'cinematic'],
  romantic: ['romantique', 'romantic', 'doux', 'emotion', 'emotional', 'tendre', 'triste', 'sad', 'calme'],
  horror: ['horreur', 'horror', 'suspense', 'peur', 'dark', 'sombre', 'tension', 'angoisse', 'mystere'],
  world: ['monde', 'world', 'voyage', 'travel', 'ethnique', 'exotique', 'culture', 'folk'],
  featured: ['selection', 'featured', 'chill', 'relax'],
  misc: ['divers', 'misc'],
  Page2: [],
};
const PICK = { featured: 4, upbeat: 8, electronic: 6, comedy: 6, epic: 6, scoring: 5, romantic: 4, horror: 4, world: 4 };

async function music() {
  const meta = await getJson('https://archive.org/metadata/freepd');
  const files = (meta.files || []).filter((f) => /\.mp3$/i.test(f.name) && f.name.includes('/'));
  const out = [];
  for (const [cat, n] of Object.entries(PICK)) {
    const list = files.filter((f) => f.name.startsWith(`${cat}/`))
      .filter((f) => Number(f.length) >= 75 && Number(f.length) <= 260 && Number(f.size) < 10e6)
      .filter((f) => !/terrible|test|demo|ringtone|\blive\b/i.test(f.name))
      // titles that reuse famous copyrighted compositions or are politically loaded
      .filter((f) => !/cornfield chase|putin|ussr|anthem|hymne/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    // evenly spread picks across the (alphabetical) list
    const step = list.length / n;
    for (let i = 0; i < n && i * step < list.length; i++) {
      const f = list[Math.floor(i * step + step / 2)] || list[Math.floor(i * step)];
      const title = f.name.slice(cat.length + 1).replace(/\.mp3$/i, '');
      out.push({
        id: `freepd-${slug(title)}`, title, cat, tags: FREEPD_MOODS[cat], duration: Math.round(Number(f.length)), size: Number(f.size),
        url: `https://archive.org/download/freepd/${f.name.split('/').map(encodeURIComponent).join('/')}`,
        author: 'FreePD.com (Kevin MacLeod et al.)', license: 'CC0 1.0 (domaine public)', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        landing: 'https://archive.org/details/freepd',
      });
    }
  }
  fs.writeFileSync(path.join(here, 'music.json'), JSON.stringify({ tracks: out }, null, 1));
  console.log(`music: ${out.length} tracks, ${(out.reduce((s, x) => s + x.size, 0) / 1e6).toFixed(0)} MB`);
}

// ------------------------------------------------------------------ stickers (emoji)
const MUST = '💀🔥💯👀🤡🎉👏🙏💪👍👎❤️💔✨⭐⚡💥🚀💰💸🏆🎯✅❌⚠️❓❗🤫🫡🤝👋🤔🙄😎🥶🥵🤯😱😭😂🤣😡🤬😴🤮🥺😍🤩🥳😬😳🫣🤑🧠💡📈📉🎁🍿🌈🎵🔔📸🎬👻💩🙈😈🤖👽🦄🐐🫶🤌👑💎🍕☕🎂🌍🌙☀️💤💦🫠🥲🤞✌️👌🤙';
const STATIC_EXTRA = '🗿🧢🚩💅🎮📱💻🎧📢🔊🛑🆕🆓🔝⏰📅🧐🤓🍔🍟🥤🎤🎸📚✏️📌🔑🔒🧩🎲⚽🏀🚗✈️🏠🍷🧃🥇🥈🥉🎟️💯📦🛒💳🧾📍🗺️⌛📣💬💭🗯️🔍🔗📝';
const CAT_FR = {
  'Smileys and emotions': 'Émotions', People: 'Personnes', 'Animals and nature': 'Animaux & nature', 'Food and drink': 'Nourriture',
  'Travel and places': 'Voyage', 'Activities and events': 'Fête & activités', Objects: 'Objets', Symbols: 'Symboles', Flags: 'Drapeaux',
};
const FLUENT_GROUP_CAT = {
  'Smileys & Emotion': 'Smileys and emotions', 'People & Body': 'People', 'Animals & Nature': 'Animals and nature', 'Food & Drink': 'Food and drink',
  'Travel & Places': 'Travel and places', Activities: 'Activities and events', Objects: 'Objects', Symbols: 'Symbols', Flags: 'Flags',
};
const cpOf = (g) => [...g].map((c) => c.codePointAt(0).toString(16)).filter((h) => h !== 'fe0f').join('_');
const glyphOfNoto = (cp) => String.fromCodePoint(...cp.split('_').map((h) => parseInt(h, 16)));

async function stickers() {
  const [noto, fr, en, tree] = await Promise.all([
    getJson('https://googlefonts.github.io/noto-emoji-animation/data/api.json'),
    getJson('https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-full/annotations/fr/annotations.json'),
    getJson('https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-full/annotations/en/annotations.json'),
    getJson('https://api.github.com/repos/microsoft/fluentui-emoji/git/trees/main?recursive=1'),
  ]);
  const A_FR = fr.annotations.annotations, A_EN = en.annotations.annotations;
  const ann = (A, g) => A[g] || A[g.replace(/️/g, '')] || null;
  // Fluent: folder (lower-cased) → 3D png path (default skin tone)
  const pngs = new Map();
  for (const t of tree.tree) {
    const m = /^assets\/([^/]+)\/(?:Default\/)?3D\/[^/]+\.png$/.exec(t.path);
    if (m && (!t.path.includes('/Default/') || t.path.endsWith('_default.png'))) pngs.set(m[1].toLowerCase(), t.path);
  }
  const fluentPath = (g) => {
    const name = ann(A_EN, g)?.tts?.[0];
    return name ? pngs.get(name.toLowerCase().replace(/[:"]/g, '')) || null : null;
  };
  const notoBy = new Map(noto.icons.map((x) => [cpOf(glyphOfNoto(x.codepoint)), x]));
  const order = noto.icons.slice().sort((a, b) => b.popularity - a.popularity).filter((x) => !(x.categories || []).includes('Flags')).slice(0, 140);
  const wanted = new Map();
  for (const x of order) wanted.set(cpOf(glyphOfNoto(x.codepoint)), glyphOfNoto(x.codepoint));
  for (const g of [...MUST.matchAll(/\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*/gu)].map((m) => m[0])) wanted.set(cpOf(g), g);
  for (const g of [...STATIC_EXTRA.matchAll(/\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*/gu)].map((m) => m[0])) if (!wanted.has(cpOf(g))) wanted.set(cpOf(g), g);
  const out = [];
  for (const [cp, g] of wanted) {
    const n = notoBy.get(cp);
    const fp = fluentPath(g);
    if (!n && !fp) continue;
    const f = ann(A_FR, g), e = ann(A_EN, g);
    const nameEn = e?.tts?.[0] || n?.tags?.[0]?.replace(/:/g, '') || cp;
    const cat = n?.categories?.[0] || 'Symbols';
    out.push({
      id: slug(nameEn), glyph: g, cp, fr: f?.tts?.[0] || nameEn, en: nameEn, cat, catFr: CAT_FR[cat] || cat,
      tags: [...new Set([...(f?.default || []), ...(e?.default || []), ...(n?.tags || []).map((t) => t.replace(/:/g, '').replace(/[-_]/g, ' '))])].slice(0, 16),
      ...(n ? { lottie: `https://fonts.gstatic.com/s/e/notoemoji/latest/${n.codepoint}/lottie.json` } : {}),
      ...(fp ? { png: `https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/${fp.split('/').map(encodeURIComponent).join('/')}` } : {}),
    });
  }
  // unique ids
  const seen = new Map();
  for (const s of out) { const k = s.id; const c = seen.get(k) || 0; seen.set(k, c + 1); if (c) s.id = `${k}-${c + 1}`; }
  fs.writeFileSync(path.join(here, 'stickers.json'), JSON.stringify({
    licenses: {
      lottie: { name: 'Noto Animated Emoji (Google)', license: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Animated emoji: Google Noto Emoji Animation, CC BY 4.0' },
      png: { name: 'Fluent Emoji (Microsoft)', license: 'MIT', url: 'https://github.com/microsoft/fluentui-emoji/blob/main/LICENSE' },
    },
    stickers: out,
  }, null, 1));
  console.log(`stickers: ${out.length} (${out.filter((x) => x.lottie).length} animated, ${out.filter((x) => x.png).length} 3D png)`);
}

await music();
await stickers();
