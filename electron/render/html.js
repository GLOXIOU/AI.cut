// Composition of HTML documents for HTML clips (motion templates, AI-written HTML, Lottie, text) and subtitles.
import fs from 'node:fs';
import path from 'node:path';
import { RESOURCES_DIR } from '../core/paths.js';
import { userTemplates, userTemplate, userTemplateFile, dirBaseUrl } from '../library/motion-library.js';

const MOTION_DIR = path.join(RESOURCES_DIR, 'motion');
let manifest = null;
const sourceCache = new Map();

function builtinTemplates() {
  if (!manifest) {
    manifest = JSON.parse(fs.readFileSync(path.join(MOTION_DIR, 'templates.json'), 'utf8')).templates;
  }
  return manifest;
}

/** Built-in templates + the user's imported animations (category "user"). */
export function motionTemplates() {
  let user = [];
  try { user = userTemplates(); } catch { /* userData not ready */ }
  return [...builtinTemplates(), ...user];
}

export function reloadTemplates() { manifest = null; sourceCache.clear(); }

export function getTemplate(id) {
  if (typeof id === 'string' && id.startsWith('user:')) {
    const u = userTemplate(id);
    if (!u) return null;
    const file = userTemplateFile(u);
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch { src = `<div style="color:#f55;font:40px sans-serif;padding:40px">Missing file: ${escapeHtml(file)}</div>`; }
    return { ...u, source: src, baseUrl: dirBaseUrl(path.dirname(file)) };
  }
  const t = builtinTemplates().find((x) => x.id === id);
  if (!t) return null;
  let src = sourceCache.get(id);
  if (src == null) {
    src = fs.readFileSync(path.join(MOTION_DIR, t.file || `${id}.html`), 'utf8');
    sourceCache.set(id, src);
  }
  return { ...t, source: src };
}

export function templateDefaults(t) {
  const out = {};
  for (const p of t?.params || []) out[p.name] = p.default;
  return out;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function substitute(src, params) {
  return src
    .replace(/\{\{\{\s*([\w.-]+)\s*\}\}\}/g, (m, k) => String(params[k] ?? ''))
    .replace(/\{\{\s*([\w.-]+)(?:\s*\|\s*(\w+))?\s*\}\}/g, (m, k, f) => {
      const v = params[k] ?? '';
      if (f === 'js' || f === 'json') return JSON.stringify(v).replace(/</g, '\\u003c');
      if (f === 'raw') return String(v);
      if (f === 'attr') return escapeHtml(String(v));
      return escapeHtml(String(v)).replace(/\n/g, '<br>');
    });
}

function baseHead({ W, H, fps, duration, config, baseUrl }) {
  const cfg = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<meta charset="utf-8">${baseUrl ? `\n<base href="${escapeHtml(baseUrl)}">` : ''}
<link rel="stylesheet" href="aicut://res/fonts/fonts.css">
<style id="__aicut_base">:root{--w:${W}px;--h:${H}px;--k:${Math.min(W, H)}px;--dur:${duration}s;--fps:${fps}}
html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;background:transparent!important}
*,*::before,*::after{animation-play-state:paused!important;animation-fill-mode:both!important}</style>
<script>window.AICUT_CONFIG=${cfg};</script>
<script src="aicut://res/runtime/aicut-runtime.js"></script>`;
}

function wrapDocument(body, head) {
  if (/<html[\s>]/i.test(body)) {
    if (/<head[^>]*>/i.test(body)) return body.replace(/<head[^>]*>/i, (m) => `${m}\n${head}\n`);
    return body.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  }
  return `<!doctype html>\n<html><head>${head}</head><body>\n${body}\n</body></html>`;
}

/**
 * Resolve the params used by an html clip (template defaults merged with clip params).
 */
/** Metadata (params) declared by an imported HTML file. */
function fileMeta(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const m = /<script[^>]*id=["']aicut-template["'][^>]*>([\s\S]*?)<\/script>/i.exec(src);
    return { src, meta: m ? JSON.parse(m[1]) : {} };
  } catch (e) {
    return { src: `<div style="color:#f55;font:40px sans-serif;padding:40px">Cannot read ${escapeHtml(file)}: ${escapeHtml(e.message)}</div>`, meta: {} };
  }
}

export function htmlClipParams(clip) {
  const h = clip.html || {};
  if (h.template) {
    const t = getTemplate(h.template);
    return { ...templateDefaults(t), ...(h.params || {}) };
  }
  if (h.file) return { ...templateDefaults(fileMeta(h.file).meta), ...(h.params || {}) };
  return { ...(h.params || {}) };
}

/**
 * Full HTML document for an html clip. mode: 'preview' | 'render'
 * Imported / custom animations get a virtual clock (requestAnimationFrame, timers, performance.now, GSAP, anime.js,
 * Lottie are driven by the timeline) so that animations written for the web render frame-exactly.
 */
export function composeHtmlClip(clip, project, { mode = 'preview' } = {}) {
  const { width: W, height: H, fps } = project.settings;
  const h = clip.html || {};
  const params = htmlClipParams(clip);
  let body = '';
  let baseUrl = null;
  let virtualTime = false;
  if (h.template) {
    const t = getTemplate(h.template);
    if (!t) body = `<div style="color:#f55;font:40px sans-serif;padding:40px">Unknown template: ${escapeHtml(h.template)}</div>`;
    else body = substitute(t.source, params);
    if (t?.user) { baseUrl = t.baseUrl; virtualTime = true; }
  } else if (h.file) {
    body = substitute(fileMeta(h.file).src, params);
    baseUrl = dirBaseUrl(path.dirname(h.file));
    virtualTime = true;
  } else if (h.code) {
    const c = h.code;
    body = c.html && /<html[\s>]/i.test(c.html)
      ? c.html
      : `${c.css ? `<style>\n${c.css}\n</style>\n` : ''}${c.html || ''}${c.js ? `\n<script>\n${c.js}\n</script>` : ''}`;
    virtualTime = true;
  }
  const config = { params, duration: clip.duration, width: W, height: H, fps, mode, clipId: clip.id, virtualTime };
  return wrapDocument(body, baseHead({ W, H, fps, duration: clip.duration, config, baseUrl }));
}

/** Subtitle render page (export). The page draws with shared/subtitles.js. */
export function composeSubtitleDoc(project, { cues, style }) {
  const { width: W, height: H, fps } = project.settings;
  const cfg = JSON.stringify({ cues, style, width: W, height: H, fps }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="aicut://res/fonts/fonts.css">
<style>html,body{margin:0;padding:0;background:transparent!important;overflow:hidden}canvas{position:fixed;left:0;top:0}</style>
<script>window.AICUT_SUBS=${cfg};</script>
</head><body><canvas id="c"></canvas>
<script type="module" src="aicut://res/runtime/subtitles-page.js"></script>
</body></html>`;
}
