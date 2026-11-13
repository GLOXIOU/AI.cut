// YouTube (and 1000+ sites) search & download through yt-dlp. The binary is fetched from the official
// GitHub releases on first use and stored in the app data folder.
import { spawnTracked, killTree } from '../core/proc.js';
import fs from 'node:fs';
import path from 'node:path';
import { toolsBinDir } from '../core/paths.js';
import { getSettings, tr } from '../core/settings.js';
import { download, exists, which } from '../core/util.js';
import { ffmpegPath } from '../media/ffmpeg.js';
import { log } from '../core/log.js';

function assetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

export function ytdlpPath() {
  const s = getSettings();
  if (s.ytdlpPath && exists(s.ytdlpPath)) return s.ytdlpPath;
  const local = path.join(toolsBinDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (exists(local)) return local;
  return which('yt-dlp');
}

export async function ensureYtdlp({ onProgress, signal } = {}) {
  const p = ytdlpPath();
  if (p) return p;
  const dest = path.join(toolsBinDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  log.info('downloading yt-dlp');
  await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`, dest, { signal, onProgress: (r, t) => onProgress?.(t ? r / t : 0) });
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  return dest;
}

/**
 * YouTube needs a JavaScript runtime to solve its player challenges (otherwise downloads fail with HTTP 403 or
 * "format not available"). Deno is used when installed; otherwise Electron's own binary runs as Node
 * (ELECTRON_RUN_AS_NODE) — always present, recent, and independent of whatever Node the user may have.
 */
function jsRuntime() {
  if (which('deno')) return { args: [], env: {} };
  if (process.versions.electron && process.execPath) return { args: ['--js-runtimes', `node:${process.execPath}`], env: { ELECTRON_RUN_AS_NODE: '1' } };
  if (which('node')) return { args: ['--js-runtimes', 'node'], env: {} };
  return { args: [], env: {} };
}

function baseArgs(extra = []) {
  const args = ['--no-warnings', '--no-color', '--ignore-config', '--retries', '5', '--fragment-retries', '5', '--extractor-retries', '3'];
  const ff = ffmpegPath();
  if (ff) args.push('--ffmpeg-location', path.dirname(ff));
  args.push(...jsRuntime().args, ...extra);
  return args;
}

function run(args, { signal, onLine, timeoutMs = 0, extra = [] } = {}) {
  return new Promise(async (resolve, reject) => {
    let bin;
    try { bin = await ensureYtdlp({ signal }); } catch (e) { reject(e); return; }
    const proc = spawnTracked(bin, [...baseArgs(extra), ...args], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...jsRuntime().env } }, { tree: true });
    let out = '', err = '', buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      out += d;
      if (onLine) {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
      }
    });
    let ebuf = '';
    proc.stderr.on('data', (d) => {
      err = (err + d).slice(-8000);
      if (onLine) {
        ebuf += d;
        let i;
        while ((i = ebuf.indexOf('\n')) >= 0) { onLine(ebuf.slice(0, i).trim()); ebuf = ebuf.slice(i + 1); }
      }
    });
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => killTree(proc), timeoutMs);
    const onAbort = () => killTree(proc);
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Aborted'));
      if (code === 0) resolve(out);
      else reject(new Error(`yt-dlp failed: ${(err.trim().split('\n').filter((l) => /ERROR|error/.test(l)).pop() || err.trim().split('\n').pop() || `code ${code}`).slice(0, 500)}`));
    });
  });
}

const CC_FILTER = 'EgIwAQ%253D%253D'; // YouTube "Creative Commons" search filter

/** Search YouTube. Returns [{id, url, title, channel, duration, views, thumbnail}] */
export async function searchYoutube(query, { limit = 10, creativeCommons = false, signal } = {}) {
  const n = Math.max(1, Math.min(50, limit));
  const target = creativeCommons
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${CC_FILTER}`
    : `ytsearch${n}:${query}`;
  const out = await run(['--flat-playlist', '-J', '--playlist-end', String(n), target], { signal, timeoutMs: 60000 });
  const data = JSON.parse(out);
  return (data.entries || []).slice(0, n).map((e) => ({
    id: e.id,
    url: e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title,
    channel: e.channel || e.uploader || null,
    duration: e.duration || null,
    views: e.view_count || null,
    thumbnail: e.thumbnails?.length ? e.thumbnails[e.thumbnails.length - 1].url : null,
    creativeCommons: !!creativeCommons,
  }));
}

/** Metadata of one video (title, duration, license, chapters…). */
export async function videoInfo(url, { signal } = {}) {
  const out = await run(['-J', '--no-playlist', '--skip-download', url], { signal, timeoutMs: 90000 });
  const d = JSON.parse(out);
  return {
    id: d.id, url: d.webpage_url || url, title: d.title, channel: d.channel || d.uploader, duration: d.duration,
    license: d.license || null, description: (d.description || '').slice(0, 1500), chapters: d.chapters || [],
    thumbnail: d.thumbnail, extractor: d.extractor_key, width: d.width, height: d.height,
  };
}

/**
 * Download audio or video. opts: { mode: 'audio'|'video', start, end, maxHeight, audioFormat: 'mp3'|'m4a'|'wav', dir }
 * Returns { file, info }.
 */
export async function downloadMedia(url, { mode = 'audio', start = null, end = null, maxHeight = 1080, audioFormat = 'mp3', dir, signal, onProgress } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const args = ['--no-playlist', '--newline', '--progress', '--windows-filenames', '--no-mtime', '-o', path.join(dir, '%(title).80B [%(id)s].%(ext)s'),
    '--print', 'before_dl:AICUTINFO %(.{id,title,uploader,channel,license,duration,webpage_url})j', '--print', 'after_move:AICUTFILE %(filepath)s'];
  if (mode === 'audio') {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', audioFormat, '--audio-quality', '0');
  } else {
    const h = Math.max(144, Math.min(4320, maxHeight || 1080));
    args.push('-f', `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mp4');
  }
  if (start != null || end != null) {
    const s = start != null ? Number(start) : 0;
    const e = end != null ? Number(end) : 'inf';
    args.push('--download-sections', `*${s}-${e}`, '--force-keyframes-at-cuts');
  }
  args.push(url);
  let info = null, file = null;
  const onLine = (line) => {
    if (line.startsWith('AICUTINFO ')) { try { info = JSON.parse(line.slice(10)); } catch { /* */ } return; }
    if (line.startsWith('AICUTFILE ')) { file = line.slice(10).trim(); return; }
    const m = /\[download\]\s+([\d.]+)%/.exec(line);
    if (m) onProgress?.(Number(m[1]) / 100);
  };
  // YouTube regularly rejects some stream URLs (HTTP 403): the URL is bound to the IP used for the extraction
  // (IPv6 vs IPv4 on dual-stack connections) or to a player client that needs a PO token. Retry with IPv4 forced,
  // then with other player clients, then after updating yt-dlp.
  const attempts = [[], ['--force-ipv4'], ['--force-ipv4', '--extractor-args', 'youtube:player_client=tv,mweb,web_safari'], 'update'];
  let lastErr = null;
  for (const extra of attempts) {
    if (signal?.aborted) throw new Error('Aborted');
    if (extra === 'update') {
      try { await updateYtdlp(); } catch (e) { log.warn('yt-dlp update failed', e.message); break; }
    }
    try {
      await run(args, { signal, onLine, extra: extra === 'update' ? ['--force-ipv4'] : extra });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted || !/403|Forbidden|not available|Sign in to confirm|PO Token|nsig|challenge|HTTP Error 4/i.test(e.message)) break;
      log.warn(`yt-dlp attempt failed (${extra === 'update' ? 'after update' : extra.join(' ') || 'default'}): ${e.message}`);
      onProgress?.(0);
    }
  }
  if (lastErr) {
    if (/403|Forbidden/i.test(lastErr.message)) throw new Error(tr(`YouTube a refusé le téléchargement (HTTP 403) malgré plusieurs tentatives. Réessaie dans quelques minutes, ou essaie une autre vidéo. Détail : ${lastErr.message}`, `YouTube refused the download (HTTP 403) after several attempts. Try again in a few minutes, or try another video. Details: ${lastErr.message}`));
    throw lastErr;
  }
  if (!file || !exists(file)) {
    // fallback: newest file in dir
    const files = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => !f.endsWith('.part') && fs.statSync(f).isFile()).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    file = files[0];
  }
  if (!file) throw new Error('Download finished but the output file was not found');
  return { file, info };
}

export async function ytdlpVersion() {
  try { return (await run(['--version'], { timeoutMs: 20000 })).trim(); } catch { return null; }
}

export async function updateYtdlp() {
  return (await run(['-U'], { timeoutMs: 120000 })).trim();
}
