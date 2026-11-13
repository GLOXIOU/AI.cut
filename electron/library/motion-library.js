// User motion library: HTML animation files imported once and reusable in every project ("Mes animations").
// Each item is a folder userData/motion-library/<id>/ containing the HTML file and the local assets it references.
// Optional metadata inside the HTML (makes the animation configurable like the built-in templates):
//   <script type="application/json" id="aicut-template">
//     { "name": "Mon titre", "defaultDuration": 4, "category": "text",
//       "params": [{ "name": "title", "type": "text", "default": "Hello" }] }
//   </script>
// and {{title}} placeholders in the HTML / CSS / JS.
import fs from 'node:fs';
import path from 'node:path';
import { userDir } from '../core/paths.js';
import { readJson, writeJson, exists, uid, safeFileName } from '../core/util.js';
import { log } from '../core/log.js';

const ROOT = () => { const d = userDir('motion-library'); fs.mkdirSync(d, { recursive: true }); return d; };
const MANIFEST = () => path.join(ROOT(), 'library.json');
let cache = null;

function load() {
  if (!cache) cache = readJson(MANIFEST(), { items: [] }) || { items: [] };
  return cache;
}
function save() { writeJson(MANIFEST(), load()); }

export const libraryRoot = ROOT;

/** Parse the optional <script id="aicut-template"> metadata of an HTML animation. */
export function parseTemplateMeta(html) {
  const m = /<script[^>]*id=["']aicut-template["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch (e) { log.warn('aicut-template metadata is not valid JSON', e.message); return {}; }
}

/** Local relative resources referenced by an HTML file (src/href/url()), to copy along. */
function localRefs(html) {
  const refs = new Set();
  const add = (u) => {
    if (!u || /^(?:[a-z]+:|\/\/|#|data:)/i.test(u) || u.includes('{{')) return;
    const clean = u.split(/[?#]/)[0];
    if (clean && !clean.startsWith('/')) refs.add(decodeURIComponent(clean));
  };
  for (const m of html.matchAll(/\b(?:src|href|data-src|poster)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]);
  for (const m of html.matchAll(/fetch\(\s*["']([^"']+)["']/gi)) add(m[1]);
  return [...refs];
}

function titleOf(html, file) {
  const t = /<title>([^<]{1,80})<\/title>/i.exec(html);
  return (t && t[1].trim()) || path.basename(file).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
}

/** Import .html files (or folders containing some). Returns the created library items. */
export function importMotionFiles(paths) {
  const files = [];
  const walk = (p, depth = 0) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { if (depth < 3) for (const f of fs.readdirSync(p)) if (!f.startsWith('.')) walk(path.join(p, f), depth + 1); }
    else if (/\.html?$/i.test(p)) files.push(p);
  };
  for (const p of paths) walk(p);
  if (!files.length) throw new Error('No .html file found.');
  const lib = load();
  const out = [];
  for (const file of files.slice(0, 200)) {
    const html = fs.readFileSync(file, 'utf8');
    const meta = parseTemplateMeta(html);
    const id = uid('u', 8);
    const dir = path.join(ROOT(), id);
    fs.mkdirSync(dir, { recursive: true });
    const main = safeFileName(path.basename(file), 80);
    fs.writeFileSync(path.join(dir, main), html);
    let copied = 0;
    for (const ref of localRefs(html)) {
      const src = path.resolve(path.dirname(file), ref);
      const dst = path.resolve(dir, ref);
      if (!dst.startsWith(dir) || !exists(src)) continue;
      try {
        if (fs.statSync(src).isFile() && fs.statSync(src).size < 200 * 1024 * 1024) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
          copied++;
        }
      } catch { /* skip */ }
    }
    const item = {
      id: `user:${id}`, folder: id, file: main, name: String(meta.name || titleOf(html, file)).slice(0, 80),
      category: 'user', userCategory: meta.category || null, description: meta.description || `Animation importée (${path.basename(file)})`,
      defaultDuration: Number(meta.defaultDuration) > 0 ? Number(meta.defaultDuration) : 5,
      params: Array.isArray(meta.params) ? meta.params.filter((p) => p && p.name) : [],
      source: file, assets: copied, addedAt: new Date().toISOString(), user: true,
    };
    lib.items.unshift(item);
    out.push(item);
  }
  save();
  return out;
}

export function userTemplates() { return load().items; }
export function userTemplate(id) { return load().items.find((x) => x.id === id) || null; }
export function userTemplateFile(item) { return path.join(ROOT(), item.folder, item.file); }

export function updateUserTemplate(id, patch) {
  const it = userTemplate(id);
  if (!it) throw new Error(`Unknown animation ${id}`);
  for (const k of ['name', 'defaultDuration', 'description']) if (patch[k] !== undefined) it[k] = patch[k];
  save();
  return it;
}

export function removeUserTemplate(id) {
  const lib = load();
  const it = lib.items.find((x) => x.id === id);
  if (!it) return false;
  lib.items = lib.items.filter((x) => x.id !== id);
  save();
  try { fs.rmSync(path.join(ROOT(), it.folder), { recursive: true, force: true }); } catch { /* ignore */ }
  return true;
}

/** aicut://file URL of a directory, usable as <base href> (path segments kept so relative URLs resolve). */
export function dirBaseUrl(dir) {
  const p = path.resolve(dir).replace(/\\/g, '/');
  return `aicut://file/${p.split('/').map((s) => encodeURIComponent(s)).join('/')}/`;
}
