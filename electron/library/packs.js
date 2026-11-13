// Bundled content packs (resources/packs, built by scripts/fetch-packs.mjs):
//   sfx      real recorded sound effects (Freesound, CC0) — some replace weak synthesized built-ins (same id)
//   music    background music without credit (FreePD, CC0 / public domain)
//   stickers emoji stickers: animated (Google Noto, Lottie, CC BY 4.0) and 3D (Microsoft Fluent, PNG, MIT)
import fs from 'node:fs';
import path from 'node:path';
import { RESOURCES_DIR } from '../core/paths.js';

export const PACKS_DIR = path.join(RESOURCES_DIR, 'packs');
let manifest = null;

export function packManifest() {
  if (!manifest) {
    try { manifest = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, 'manifest.json'), 'utf8')); } catch { manifest = {}; }
    manifest.sfx = (manifest.sfx || []).filter((s) => fs.existsSync(path.join(PACKS_DIR, s.file)));
    manifest.music = (manifest.music || []).filter((s) => fs.existsSync(path.join(PACKS_DIR, s.file)));
    manifest.stickers = manifest.stickers || [];
  }
  return manifest;
}
export function reloadPacks() { manifest = null; }
export const packPath = (rel) => path.join(PACKS_DIR, rel);

/** Real recording replacing a synthesized built-in sound (same id), if any. */
export function packReplacement(builtinId) {
  const s = packManifest().sfx.find((x) => x.replaces === builtinId);
  return s ? packPath(s.file) : null;
}
export const packSfx = () => packManifest().sfx;
export const packMusic = () => packManifest().music;
export const packStickers = () => packManifest().stickers;
export const stickerById = (id) => packStickers().find((s) => s.id === id || s.glyph === id) || null;

export const MUSIC_CATEGORIES = [
  ['featured', 'Sélection', 'Featured'], ['upbeat', 'Joyeux / vlog', 'Upbeat'], ['electronic', 'Électro', 'Electronic'],
  ['comedy', 'Drôle', 'Comedy'], ['epic', 'Épique', 'Epic'], ['scoring', 'Cinéma / fond', 'Film score'],
  ['romantic', 'Émotion', 'Emotional'], ['horror', 'Suspense / horreur', 'Suspense'], ['world', 'Monde / voyage', 'World'],
  ['misc', 'Divers', 'Misc'], ['Page2', 'Autres', 'More'],
];

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Search stickers. opts: { query, animated (true = only animated), limit } */
export function searchStickers({ query = '', animated = null, limit = 60, category = null } = {}) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const out = [];
  for (const s of packStickers()) {
    if (animated === true && !s.lottie) continue;
    if (animated === false && !s.png) continue;
    if (category && s.cat !== category && s.catFr !== category) continue;
    const text = norm(`${s.fr} ${s.en} ${s.tags.join(' ')} ${s.glyph}`);
    let score = 0;
    if (!words.length) score = 1;
    else if (query.trim() === s.glyph) score = 10;
    else {
      for (const w of words) if (text.includes(w)) score += norm(s.fr).includes(w) || norm(s.en).includes(w) ? 2 : 1;
      if (score < words.length) score = 0;
    }
    if (score) out.push({ s, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map(({ s }) => s);
}
