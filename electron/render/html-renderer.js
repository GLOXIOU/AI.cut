// Offscreen Chromium renderer: turns HTML layers (motion graphics, subtitles) into alpha video / PNG frames.
// Frame-exact: each frame is seeked by the page runtime, and a colour "tag" row below the visible area
// guarantees the captured paint corresponds to the requested frame.
import { BrowserWindow, screen } from 'electron';
import { spawnTracked } from '../core/proc.js';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { requireFfmpeg } from '../media/ffmpeg.js';
import { log } from '../core/log.js';
import { sleep } from '../core/util.js';

function pickScale(W, H) {
  let wa = { width: 1920, height: 1040 };
  try { wa = screen.getPrimaryDisplay().workAreaSize; } catch { /* before ready */ }
  const maxW = Math.max(640, wa.width - 60), maxH = Math.max(480, wa.height - 60);
  let k = 1;
  while ((W / k > maxW || (H + k) / k > maxH) && k < 6) k++;
  return k;
}

export class OffscreenPage {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.k = pickScale(W, H);
    this.win = null;
    this.waiter = null;
  }

  async open() {
    const k = this.k;
    // show: false — a visible offscreen window is an empty native window on the user's screen that only says
    // "No content under offscreen mode"; offscreen rendering paints the same when the window is never shown.
    this.win = new BrowserWindow({
      width: Math.ceil(this.W / k), height: Math.ceil((this.H + k) / k), useContentSize: true, show: false,
      transparent: true, frame: false, skipTaskbar: true, focusable: false, resizable: true,
      webPreferences: { offscreen: { deviceScaleFactor: k }, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.wc = this.win.webContents;
    this.wc.setAudioMuted(true);
    this.wc.setFrameRate(240);
    this.wc.on('paint', (e, dirty, img) => { if (this.waiter) this.waiter(img); });
    this.wc.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 3) log.debug('[html layer]', e.message);
    });
    return this;
  }

  async setSize(W, H) {
    this.W = W; this.H = H;
    const k = this.k;
    this.win.setContentSize(Math.ceil(W / k), Math.ceil((H + k) / k));
    await sleep(60);
  }

  async load(url, { timeout = 25000 } = {}) {
    await this.wc.loadURL(url);
    this.wc.setZoomFactor(1 / this.k);
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const ok = await this.wc.executeJavaScript('window.__aicutReady === true').catch(() => false);
      if (ok) return true;
      await sleep(40);
    }
    log.warn('HTML layer not ready after timeout:', url);
    return false;
  }

  eval(js) { return this.wc.executeJavaScript(js); }

  /** Capture the frame at local time t. Returns {bmp, width} (BGRA premultiplied, full paint width). */
  async capture(t, tag) {
    const H = this.H;
    for (let attempt = 0; attempt < 4; attempt++) {
      const got = new Promise((resolve) => {
        const timer = setTimeout(() => { this.waiter = null; resolve(null); }, 2000);
        this.waiter = (img) => {
          const size = img.getSize();
          if (size.height <= H || size.width < this.W) return;
          const px = img.crop({ x: 2, y: H, width: 1, height: 1 }).toBitmap();
          if (px[2] !== (tag & 255) || px[1] !== ((tag >> 8) & 255) || px[0] !== 255) return;
          clearTimeout(timer);
          this.waiter = null;
          resolve({ bmp: img.toBitmap(), width: size.width, img });
        };
      });
      await this.wc.executeJavaScript(`window.__aicutFrame(${Number(t).toFixed(6)}, ${tag})`);
      this.wc.invalidate();
      const r = await got;
      if (r) return r;
    }
    throw new Error(`HTML frame capture timed out at t=${t}`);
  }

  /** W×H BGRA buffer from a capture. */
  extract(cap) {
    const { W, H } = this;
    if (cap.width === W) return cap.bmp.subarray(0, W * H * 4);
    const out = Buffer.allocUnsafe(W * H * 4);
    const stride = cap.width * 4;
    for (let y = 0; y < H; y++) cap.bmp.copy(out, y * W * 4, y * stride, y * stride + W * 4);
    return out;
  }

  async errors() {
    return this.wc.executeJavaScript('window.__aicutErrors ? window.__aicutErrors() : []').catch(() => []);
  }

  close() {
    try { this.win?.destroy(); } catch { /* ignore */ }
    this.win = null;
  }
}

function spawnEncoder(W, H, fps, out) {
  const ff = requireFfmpeg();
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${W}x${H}`, '-r', String(fps),
    '-i', 'pipe:0', '-vf', 'unpremultiply=inplace=1', '-c:v', 'qtrle', '-pix_fmt', 'argb', out];
  const proc = spawnTracked(ff, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`HTML layer encode failed: ${err.trim().slice(-400)}`))));
  });
  proc.stdin.on('error', () => { /* handled by close */ });
  return { proc, done };
}

/**
 * Render an HTML page (served at `url`) to a QuickTime RLE video with alpha.
 * Local times [t0, t1) at fps. Negative times are clamped to 0.
 */
export async function renderHtmlToVideo({ url, width, height, fps, t0 = 0, t1, out, signal, onProgress }) {
  const page = await new OffscreenPage(width, height).open();
  try {
    await page.load(url);
    const n = Math.max(1, Math.round((t1 - t0) * fps));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const enc = spawnEncoder(width, height, fps, out);
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) { enc.proc.kill('SIGKILL'); throw new Error('Aborted'); }
      const t = Math.max(0, t0 + i / fps);
      const cap = await page.capture(t, (i % 250) + 1);
      const buf = page.extract(cap);
      if (!enc.proc.stdin.write(Buffer.from(buf))) await once(enc.proc.stdin, 'drain');
      if (onProgress && (i % 5 === 0 || i === n - 1)) onProgress((i + 1) / n);
    }
    enc.proc.stdin.end();
    await enc.done;
    return { out, frames: n, errors: await page.errors() };
  } finally {
    page.close();
  }
}

/** Render a single frame of an HTML page to PNG. */
export async function renderHtmlFrame({ url, width, height, time, out }) {
  const page = await new OffscreenPage(width, height).open();
  try {
    await page.load(url);
    const cap = await page.capture(Math.max(0, time), 7);
    const png = cap.img.crop({ x: 0, y: 0, width, height }).toPNG();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, png);
    return { out, errors: await page.errors() };
  } finally {
    page.close();
  }
}

/**
 * Render the subtitle layer for [t0, t1) as a sparse PNG sequence + ffmpeg concat list (only frames whose visual
 * state changes are rendered). Returns { list, band: {y, h} } or null when there is nothing to draw.
 */
export async function renderSubtitleSequence({ url, width, height, fps, t0, t1, outDir, signal, onProgress }) {
  const page = await new OffscreenPage(width, height).open();
  try {
    await page.load(url);
    const band = await page.eval('window.__aicutBand');
    await page.setSize(width, band.h);
    const n = Math.max(1, Math.round((t1 - t0) * fps));
    const sigs = await page.eval(`window.__aicutSignatures(${t0}, ${n}, ${fps})`);
    if (!sigs.some((s) => s !== 'none')) return null;
    fs.mkdirSync(outDir, { recursive: true });
    const files = new Map(); // signature -> png path
    const runs = []; // [{file, frames}]
    let tag = 1;
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new Error('Aborted');
      const sig = sigs[i];
      let file = files.get(sig);
      if (!file) {
        file = path.join(outDir, `s${String(files.size).padStart(5, '0')}.png`);
        const cap = await page.capture(t0 + i / fps, tag);
        tag = (tag % 250) + 1;
        fs.writeFileSync(file, cap.img.crop({ x: 0, y: 0, width, height: band.h }).toPNG());
        files.set(sig, file);
      }
      const last = runs[runs.length - 1];
      if (last && last.file === file) last.frames++;
      else runs.push({ file, frames: 1 });
      if (onProgress && i % 30 === 0) onProgress(i / n);
    }
    const lines = ['ffconcat version 1.0'];
    for (const r of runs) {
      lines.push(`file '${r.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
      lines.push(`duration ${(r.frames / fps).toFixed(6)}`);
    }
    // concat demuxer ignores the last duration unless the last file is repeated
    const lastRun = runs[runs.length - 1];
    lines.push(`file '${lastRun.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    const list = path.join(outDir, 'list.ffconcat');
    fs.writeFileSync(list, lines.join('\n') + '\n');
    onProgress?.(1);
    return { list, band, unique: files.size, frames: n };
  } finally {
    page.close();
  }
}
