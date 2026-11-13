import { protocol } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { RESOURCES_DIR, SHARED_DIR, DIST_DIR } from '../core/paths.js';
import { log } from '../core/log.js';

export const SCHEME = 'aicut';

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
  '.peaks': 'application/octet-stream', '.ico': 'image/x-icon',
};
export const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
const HTML_CSP = "default-src * data: blob: aicut: 'unsafe-inline' 'unsafe-eval'; img-src * data: blob: aicut:; media-src * data: blob: aicut:; font-src * data: aicut:";

/** Must be called before app 'ready'. */
export function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

/** Helpers to build URLs for the renderer. */
export const fileUrl = (absPath, rev) => `${SCHEME}://file/${encodeURIComponent(absPath)}${rev ? `?v=${rev}` : ''}`;
export const resUrl = (rel) => `${SCHEME}://res/${rel.replace(/\\/g, '/')}`;

const renderDocs = new Map(); // token -> {html, expires}
export function registerRenderDoc(token, html, ttlMs = 30 * 60 * 1000) {
  renderDocs.set(token, { html, expires: Date.now() + ttlMs });
  for (const [k, v] of renderDocs) if (v.expires < Date.now()) renderDocs.delete(k);
  return `${SCHEME}://render/${token}`;
}
export function unregisterRenderDoc(token) { renderDocs.delete(token); }

async function serveFile(file, req, extra = {}) {
  let stat;
  try { stat = await fsp.stat(file); } catch { return new Response('Not found', { status: 404, headers: CORS }); }
  if (!stat.isFile()) return new Response('Not found', { status: 404, headers: CORS });
  const size = stat.size;
  const type = mimeOf(file);
  const range = req.headers.get('range');
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ...CORS, ...extra };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = 0, end = size - 1;
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
    }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: { ...base, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...base, 'Content-Length': String(size) } });
}

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel));
  if (!p.startsWith(path.normalize(root))) return null;
  return p;
}

/**
 * Install the protocol handler. `hooks`:
 *  - isAllowedFile(absPath) → boolean
 *  - htmlForClip(clipId, searchParams) → string | null   (live preview documents)
 */
export function installProtocol(hooks) {
  protocol.handle(SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      switch (u.host) {
        case 'file': {
          const abs = decodeURIComponent(u.pathname.slice(1));
          if (!hooks.isAllowedFile(abs)) return new Response('Forbidden', { status: 403, headers: CORS });
          return serveFile(abs, req);
        }
        case 'res': {
          const p = safeJoin(RESOURCES_DIR, rel);
          return p ? serveFile(p, req) : new Response('Bad path', { status: 400 });
        }
        case 'shared': {
          const p = safeJoin(SHARED_DIR, rel);
          return p ? serveFile(p, req) : new Response('Bad path', { status: 400 });
        }
        case 'app': {
          const p = safeJoin(DIST_DIR, rel || 'index.html');
          return p ? serveFile(p, req) : new Response('Bad path', { status: 400 });
        }
        case 'html': {
          const html = await hooks.htmlForClip(rel, u.searchParams);
          if (html == null) return new Response('<!doctype html><html><body></body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
          return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': HTML_CSP, ...CORS } });
        }
        case 'render': {
          const doc = renderDocs.get(rel);
          if (!doc) return new Response('expired', { status: 404 });
          return new Response(doc.html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': HTML_CSP, ...CORS } });
        }
        default:
          return new Response('Unknown host', { status: 404 });
      }
    } catch (e) {
      log.error('protocol error', req.url, e);
      return new Response(String(e?.message || e), { status: 500 });
    }
  });
}
