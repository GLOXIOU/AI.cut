import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyz';
/** Short readable ids, e.g. clip_k3f9qz */
export function uid(prefix = 'id', len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${s}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
export const clone = (o) => structuredClone(o);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic JSON write (write temp + rename). */
export function writeJson(file, data, pretty = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export async function writeJsonAsync(file, data, pretty = true) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  await fsp.rename(tmp, file);
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** Find an executable on PATH (Windows aware). */
export function which(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + (cmd.toLowerCase().endsWith(e.toLowerCase()) ? '' : e.toLowerCase()));
      if (exists(p)) return p;
      const p2 = path.join(d, cmd + e);
      if (exists(p2)) return p2;
    }
  }
  return null;
}

export function safeFileName(name, max = 80) {
  return String(name || 'file')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'file';
}

/** Returns a path that does not exist yet by appending " (n)". */
export function uniquePath(p) {
  if (!exists(p)) return p;
  const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
  for (let i = 2; i < 10000; i++) {
    const c = path.join(dir, `${base} (${i})${ext}`);
    if (!exists(c)) return c;
  }
  return p;
}

/**
 * Download a URL to a file with progress. Uses Electron's net.fetch when available (system proxy aware).
 * onProgress(received, total)
 */
export async function download(url, dest, { onProgress, signal, headers } = {}) {
  let fetchFn = globalThis.fetch;
  try {
    const { net } = await import('electron');
    if (net?.fetch) fetchFn = net.fetch.bind(net);
  } catch { /* plain node */ }
  const res = await fetchFn(url, { signal, headers: { 'User-Agent': 'AI.cut/0.1 (video editor)', ...(headers || {}) }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let received = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (onProgress && now - last > 150) { last = now; onProgress(received, total); }
  });
  await pipeline(body, fs.createWriteStream(tmp), { signal });
  onProgress?.(received, total || received);
  await fsp.rename(tmp, dest);
  return { path: dest, size: received, contentType: res.headers.get('content-type') || '' };
}

export async function fetchJson(url, { signal, headers, timeoutMs = 20000 } = {}) {
  let fetchFn = globalThis.fetch;
  try {
    const { net } = await import('electron');
    if (net?.fetch) fetchFn = net.fetch.bind(net);
  } catch { /* plain node */ }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetchFn(url, { signal: ctl.signal, headers: { 'User-Agent': 'AI.cut/0.1 (video editor)', Accept: 'application/json', ...(headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function round(x, d = 3) {
  const k = Math.pow(10, d);
  return Math.round((Number(x) || 0) * k) / k;
}

export function fmtDuration(s) {
  s = Math.max(0, Number(s) || 0);
  const m = Math.floor(s / 60), r = s - m * 60;
  return m ? `${m}m${r.toFixed(1).padStart(4, '0')}s` : `${r.toFixed(2)}s`;
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  return (...a) => {
    const now = Date.now();
    pending = a;
    if (now - last >= ms) { last = now; fn(...a); pending = null; return; }
    if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); if (pending) fn(...pending); pending = null; }, ms - (now - last));
  };
}
