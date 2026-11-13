// Meme bank: real internet memes, fetched on demand and cached in the user data folder (never bundled in the app).
//   sounds  MyInstants (vine boom, bruh, MLG air horn, sad violin, anime wow…) — search + all-time best lists
//   images  Imgflip's 100 most used meme templates (Drake, Distracted Boyfriend, Two Buttons…)
//   videos  green-screen meme clips found on YouTube (downloaded with yt-dlp, keyed out on the timeline)
// These are copyrighted works commonly reused as memes: the UI and the AI tools always show where they come from.
import fs from 'node:fs';
import path from 'node:path';
import { libraryDir } from '../core/paths.js';
import { download, readJson, writeJson, exists, safeFileName } from '../core/util.js';
import { log } from '../core/log.js';
import { jobs } from '../core/jobs.js';
import { tr } from '../core/settings.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MI = 'https://www.myinstants.com';
const dir = (...p) => { const d = path.join(libraryDir(), 'memes', ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const cacheFile = (name) => path.join(dir(), name);

async function getText(url, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let fetchFn = globalThis.fetch;
    try { const { net } = await import('electron'); if (net?.fetch) fetchFn = net.fetch.bind(net); } catch { /* plain node */ }
    const r = await fetchFn(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const decode = (s) => String(s).replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).trim();

// ------------------------------------------------------------------ sounds (MyInstants)
function parseInstants(html) {
  const out = [];
  const seen = new Set();
  const re = /play\('([^']+\.mp3)'[\s\S]*?class="instant-link[^"]*"[^>]*>([^<]*)</g;
  let m;
  while ((m = re.exec(html))) {
    const p = m[1];
    if (seen.has(p) || !p.startsWith('/media/sounds/')) continue;
    seen.add(p);
    out.push(soundItem(p, decode(m[2]) || path.basename(p, '.mp3')));
  }
  return out;
}
function soundItem(p, title) {
  const file = p.replace('/media/sounds/', '');
  return { id: `myinstants:${file}`, kind: 'meme-sound', title, url: `${MI}${p}`, source: 'MyInstants', landing: `${MI}${p}` };
}

/** Meme sounds: best of all time (US + FR) when no query, else a MyInstants search. Cached. */
export async function memeSounds({ query = '', page = 1 } = {}) {
  const q = String(query).trim().toLowerCase();
  const key = q ? `s_${safeFileName(q, 40)}_${page}` : `best_${page}`;
  const file = cacheFile('sounds-index.json');
  const idx = readJson(file, {}) || {};
  const hit = idx[key];
  if (hit && Date.now() - hit.at < (q ? 86400e3 : 3 * 86400e3)) return hit.items;
  let items = [];
  try {
    if (q) items = parseInstants(await getText(`${MI}/en/search/?name=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`));
    else {
      const [us, fr] = await Promise.all([
        getText(`${MI}/en/best_of_all_time/us/${page > 1 ? `?page=${page}` : ''}`).then(parseInstants).catch(() => []),
        getText(`${MI}/fr/best_of_all_time/fr/${page > 1 ? `?page=${page}` : ''}`).then(parseInstants).catch(() => []),
      ]);
      const seen = new Set();
      for (const it of [...us, ...fr]) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    }
  } catch (e) {
    if (hit) return hit.items;
    throw new Error(`MyInstants indisponible (${e.message})`);
  }
  idx[key] = { at: Date.now(), items };
  writeJson(file, idx, false);
  return items;
}

// ------------------------------------------------------------------ images (Imgflip templates)
let imgflip = null;
export async function memeImages({ query = '' } = {}) {
  if (!imgflip) {
    const file = cacheFile('imgflip.json');
    const cached = readJson(file);
    if (cached && Date.now() - cached.at < 7 * 86400e3) imgflip = cached.items;
    else {
      try {
        const d = JSON.parse(await getText('https://api.imgflip.com/get_memes'));
        imgflip = (d.data?.memes || []).map((x) => ({
          id: `imgflip:${x.id}`, kind: 'meme-image', title: x.name, url: x.url, width: x.width, height: x.height,
          source: 'Imgflip', landing: `https://imgflip.com/meme/${x.id}`,
        }));
        writeJson(file, { at: Date.now(), items: imgflip }, false);
      } catch (e) {
        imgflip = cached?.items || [];
        if (!imgflip.length) throw new Error(`Imgflip indisponible (${e.message})`);
      }
    }
  }
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return imgflip.filter((x) => words.every((w) => x.title.toLowerCase().includes(w))).map((x) => ({ ...x, local: localFile(x) }));
}

// ------------------------------------------------------------------ GIFs (Imgflip animated templates, served as small MP4s)
let gifs = null;
export async function memeGifs({ query = '' } = {}) {
  if (!gifs) {
    const file = cacheFile('imgflip-gifs.json');
    const cached = readJson(file);
    if (cached && Date.now() - cached.at < 7 * 86400e3) gifs = cached.items;
    else {
      const pages = await Promise.all([1, 2, 3, 4, 5].map((p) => getText(`https://imgflip.com/gif-templates${p > 1 ? `?page=${p}` : ''}`).catch(() => '')));
      const seen = new Set();
      const list = [];
      const re = /<h3 class="mt-title">\s*<a title="[^"]*" href="\/memetemplate\/(\d+)\/[^"]*">([^<]*)<\/a>[\s\S]*?src="\/\/i\.imgflip\.com\/2\/([a-z0-9]+)\.jpg"/g;
      for (const h of pages) {
        let m;
        while ((m = re.exec(h))) {
          if (seen.has(m[3])) continue;
          seen.add(m[3]);
          list.push({
            id: `imgflipgif:${m[3]}`, kind: 'meme-gif', title: decode(m[2]).replace(/\s*gif$/i, ''), thumb: `https://i.imgflip.com/2/${m[3]}.jpg`,
            url: `https://i.imgflip.com/${m[3]}.mp4`, source: 'Imgflip', landing: `https://imgflip.com/memetemplate/${m[1]}`,
          });
        }
      }
      if (list.length) { gifs = list; writeJson(file, { at: Date.now(), items: gifs }, false); }
      else { gifs = cached?.items || []; if (!gifs.length) throw new Error('Imgflip GIF indisponible'); }
    }
  }
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return gifs.filter((x) => words.every((w) => x.title.toLowerCase().includes(w))).map((x) => ({ ...x, local: localFile(x) }));
}

// ------------------------------------------------------------------ green-screen meme videos (memescreens.com)
const MS = 'https://memescreens.com';
const MS_MEDIA = 'https://media.memescreens.com/';
/** Clip objects embedded in a memescreens page (Next.js RSC payload). */
function parseMemeScreens(html) {
  const text = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const out = new Map();
  let i = 0;
  for (;;) {
    i = text.indexOf('"clip":{"id":"', i);
    if (i < 0) break;
    const start = text.indexOf('{', i);
    let depth = 0, j = start, inStr = false;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (ch === '\\') j++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (!depth) break; }
    }
    try {
      const c = JSON.parse(text.slice(start, j + 1));
      if (c.file_key && c.status !== 'rejected' && !out.has(c.id)) {
        out.set(c.id, {
          id: `memescreens:${c.id}`, kind: 'meme-video', title: decode(c.title || c.slug || 'meme'), category: c.category || '',
          tags: String(c.tags || '').split(',').map((x) => x.trim()).filter(Boolean), description: c.description || '',
          duration: Number(c.duration_seconds) || null, thumb: c.thumbnail_key ? MS_MEDIA + c.thumbnail_key : null,
          url: MS_MEDIA + c.file_key.split('/').map(encodeURIComponent).join('/'), landing: `${MS}/clips/${c.slug}`, source: 'MemeScreens',
          score: (Number(c.download_count) || 0) + 3 * (Number(c.upvote_count) || 0),
        });
      }
    } catch { /* malformed object */ }
    i = j;
  }
  return [...out.values()];
}

let msCatalog = null;
let msCrawl = null;
async function crawlMemeScreens(fromPage, known, toPage = 60) {
  for (let p = fromPage; p <= toPage; p++) {
    let added = 0;
    try {
      for (const c of parseMemeScreens(await getText(`${MS}/browse?sort=trending&page=${p}`))) if (!known.has(c.id)) { known.set(c.id, c); added++; }
    } catch (e) { log.debug('memescreens page', p, e.message); break; }
    if (!added) break;
  }
  return known;
}
/** Green-screen meme videos: the whole memescreens catalogue (~800 clips), crawled once and cached for 3 days. */
export async function memeScreens({ query = '', category = '' } = {}) {
  const file = cacheFile('memescreens.json');
  if (!msCatalog) {
    const cached = readJson(file);
    if (cached?.items?.length) msCatalog = cached.items;
    if (!cached || Date.now() - cached.at > 3 * 86400e3) {
      // first run: answer with the first pages; the full catalogue is (re)crawled in the background
      // into a fresh map (a page that brings nothing new ends the crawl) and replaces the cache at the end
      let fresh = new Map();
      if (!msCatalog) { await crawlMemeScreens(1, fresh, 3).catch(() => {}); msCatalog = [...fresh.values()]; }
      else fresh = new Map();
      if (!msCrawl) {
        const from = fresh.size ? 4 : 1;
        msCrawl = crawlMemeScreens(from, fresh).then((m) => {
          if (m.size >= (msCatalog?.length || 0)) msCatalog = [...m.values()];
          if (msCatalog.length) writeJson(file, { at: Date.now(), items: msCatalog }, false);
        }).catch(() => {}).finally(() => { msCrawl = null; });
      }
    }
  }
  if (!msCatalog?.length) throw new Error('memescreens.com indisponible');
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = norm(query).split(/\s+/).filter(Boolean);
  const cat = norm(category);
  return msCatalog
    .filter((c) => !cat || norm(c.category) === cat)
    .map((c) => {
      if (!words.length) return [c, c.score];
      const title = norm(c.title), rest = norm(`${c.tags.join(' ')} ${c.category} ${c.description}`);
      let s = 0;
      for (const w of words) s += title.includes(w) ? 3 : rest.includes(w) ? 1 : -10;
      return [c, s > 0 ? s * 1000 + c.score : -1];
    })
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => ({ ...c, local: localFile(c) }));
}

// ------------------------------------------------------------------ local cache
function localName(it) {
  if (it.id.startsWith('memescreens:')) return path.join(dir('videos'), `${safeFileName(it.id.slice(12), 40)}${path.extname(new URL(it.url).pathname) || '.mp4'}`);
  if (it.id.startsWith('myinstants:')) return path.join(dir('sounds'), safeFileName(it.id.slice(11), 120));
  if (it.id.startsWith('imgflipgif:')) return path.join(dir('gifs'), `${safeFileName(it.id.slice(11), 40)}.mp4`);
  const ext = path.extname(new URL(it.url).pathname) || '.jpg';
  return path.join(dir('images'), `${safeFileName(it.id.replace(':', '_'), 60)}${ext}`);
}
function localFile(it) { const f = localName(it); return exists(f) ? f : null; }

const known = new Map(); // id → item (from listings)
export function rememberItems(items) { for (const it of items) known.set(it.id, it); return items; }

/** Item for an id even without a previous listing (ids are stable). */
export async function memeItem(id) {
  if (known.has(id)) return known.get(id);
  if (id.startsWith('myinstants:')) return soundItem(`/media/sounds/${id.slice(11)}`, id.slice(11).replace(/\.mp3$/, '').replace(/[-_]+/g, ' '));
  if (id.startsWith('imgflip:')) { const all = await memeImages({}); const it = all.find((x) => x.id === id); if (it) return it; }
  if (id.startsWith('imgflipgif:')) { const all = await memeGifs({}); const it = all.find((x) => x.id === id); if (it) return it; }
  if (id.startsWith('memescreens:')) { const all = await memeScreens({}); const it = all.find((x) => x.id === id); if (it) return it; }
  throw new Error(`Unknown meme ${id} (search the meme bank first)`);
}

/** Download (once) and return the local file of a meme sound / image. */
export async function memeFile(id, { signal } = {}) {
  const it = await memeItem(id);
  const f = localName(it);
  // each CDN expects its own site as referer (hotlink protection)
  const referer = id.startsWith('memescreens:') ? `${MS}/` : id.startsWith('imgflip') ? 'https://imgflip.com/' : `${MI}/`;
  if (!exists(f) || fs.statSync(f).size < 200) await download(it.url, f, { signal, headers: { 'User-Agent': UA, Referer: referer } });
  return { file: f, item: it };
}

/** Pre-download the starter bank (top sounds + all templates) in the background, once a week. */
let starterJob = null;
export function ensureStarterBank() {
  const marker = cacheFile('starter.json');
  const m = readJson(marker);
  if (m && Date.now() - m.at < 7 * 86400e3) return null;
  if (starterJob && !starterJob.endedAt) return starterJob;
  starterJob = jobs.create('download', tr('Banque de mèmes (sons + images)', 'Meme bank (sounds + images)'), async (ctx) => {
    const sounds = rememberItems(await memeSounds({}).catch(() => []));
    const images = rememberItems(await memeImages({}).catch(() => []));
    const gifList = rememberItems(await memeGifs({}).catch(() => []));
    const all = [...sounds.slice(0, 72), ...images, ...gifList.slice(0, 80)];
    let done = 0, ok = 0;
    const queue = [...all];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const it = queue.shift();
        if (ctx.signal.aborted) return;
        try { await memeFile(it.id, { signal: ctx.signal }); ok++; } catch (e) { log.debug('meme download', it.id, e.message); }
        ctx.progress(++done / all.length, it.title);
      }
    }));
    writeJson(marker, { at: Date.now(), ok, total: all.length }, false);
    return { downloaded: ok, total: all.length };
  }, { queue: 'download' });
  return starterJob;
}
