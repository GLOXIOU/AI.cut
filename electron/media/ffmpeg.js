import { spawn } from 'node:child_process';
import { spawnTracked } from '../core/proc.js';
import path from 'node:path';
import { getSettings, tr } from '../core/settings.js';
import { which, exists } from '../core/util.js';
import { toolsBinDir } from '../core/paths.js';
import { log } from '../core/log.js';

const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);

export function ffmpegPath() {
  const s = getSettings();
  if (s.ffmpegPath && exists(s.ffmpegPath)) return s.ffmpegPath;
  const local = path.join(toolsBinDir(), exe('ffmpeg'));
  if (exists(local)) return local;
  return which('ffmpeg');
}

export function ffprobePath() {
  const s = getSettings();
  if (s.ffprobePath && exists(s.ffprobePath)) return s.ffprobePath;
  const ff = ffmpegPath();
  if (ff) {
    const sib = path.join(path.dirname(ff), exe('ffprobe'));
    if (exists(sib)) return sib;
  }
  const local = path.join(toolsBinDir(), exe('ffprobe'));
  if (exists(local)) return local;
  return which('ffprobe');
}

export function requireFfmpeg() {
  const p = ffmpegPath();
  if (!p) throw new Error(tr('ffmpeg introuvable. Installe ffmpeg (winget install Gyan.FFmpeg) ou ajoute-le au PATH.', 'ffmpeg not found. Install ffmpeg (winget install Gyan.FFmpeg) or add it to your PATH.'));
  return p;
}

function parseProgress(line, st) {
  const m = line.match(/^(\w+)=(.*)$/);
  if (!m) return false;
  const [, k, v] = m;
  if (k === 'out_time_us' || k === 'out_time_ms') {
    const us = Number(v);
    if (Number.isFinite(us) && us >= 0) st.time = us / 1e6;
    return true;
  }
  if (k === 'speed') { st.speed = parseFloat(v) || st.speed; return true; }
  if (k === 'progress' || k === 'frame' || k === 'fps' || k === 'bitrate' || k === 'total_size' || k === 'out_time' || k === 'dup_frames' || k === 'drop_frames' || k.startsWith('stream_')) return true;
  return false;
}

/**
 * Run ffmpeg. Options:
 *  - duration: expected output duration (s) for progress ratio
 *  - onProgress(ratio, {time, speed})
 *  - signal: AbortSignal
 *  - stdin: true to keep stdin open (returns proc via onSpawn)
 *  - stdout: 'ignore' | 'pipe' (pipe → collected into Buffer unless onStdout given)
 *  - priority: 'low' for background work (import, analysis) so the UI keeps the CPU when it needs it
 */
export function runFfmpeg(args, opts = {}) {
  const bin = requireFfmpeg();
  const { duration = 0, onProgress, signal, cwd, stdin = false, stdout = 'ignore', onSpawn, onStdout, quiet = false, priority } = opts;
  const full = ['-hide_banner', '-y'];
  if (!stdin) full.push('-nostdin');
  full.push('-loglevel', 'error', '-progress', 'pipe:2', '-stats_period', '0.3', ...args);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const proc = spawnTracked(bin, full, { cwd, stdio: [stdin ? 'pipe' : 'ignore', stdout === 'pipe' ? 'pipe' : 'ignore', 'pipe'] }, { lowPriority: priority === 'low' });
    if (!quiet) log.debug('ffmpeg', full.join(' ').slice(0, 4000));
    onSpawn?.(proc);
    const st = { time: 0, speed: 0 };
    let errTail = '';
    let buf = '';
    const outChunks = [];
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (parseProgress(line, st)) {
          if (onProgress && duration > 0) onProgress(Math.min(1, st.time / duration), st);
        } else {
          errTail = (errTail + line + '\n').slice(-6000);
        }
      }
    });
    if (stdout === 'pipe') {
      proc.stdout.on('data', (d) => { if (onStdout) onStdout(d); else outChunks.push(d); });
    }
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Aborted'));
      if (code === 0) resolve({ code, stderr: errTail, stdout: outChunks.length ? Buffer.concat(outChunks) : null });
      else {
        const err = new Error(`ffmpeg failed (code ${code}): ${errTail.trim().split('\n').slice(-6).join(' | ')}`);
        err.stderr = errTail;
        err.args = full;
        reject(err);
      }
    });
  });
}

export function runFfprobe(args, { timeoutMs = 60000 } = {}) {
  const bin = ffprobePath();
  if (!bin) return Promise.reject(new Error('ffprobe not found'));
  return new Promise((resolve, reject) => {
    const proc = spawnTracked(bin, ['-hide_banner', '-v', 'error', ...args]);
    const out = [];
    let err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`ffprobe failed: ${err.trim().slice(-500)}`));
    });
  });
}

let encoderCache = null;
/** Detect usable encoders (hardware NVENC/QSV/AMF are probed with a 1-frame test). */
export async function detectEncoders() {
  if (encoderCache) return encoderCache;
  const result = { libx264: false, libx265: false, h264_nvenc: false, hevc_nvenc: false, h264_qsv: false, h264_amf: false, libvpx_vp9: false, prores_ks: false, libmp3lame: false, libopus: false };
  try {
    const bin = requireFfmpeg();
    const list = await new Promise((resolve) => {
      const p = spawn(bin, ['-hide_banner', '-encoders'], { windowsHide: true });
      let s = '';
      p.stdout.on('data', (d) => { s += d; });
      p.on('close', () => resolve(s));
      p.on('error', () => resolve(''));
    });
    for (const k of Object.keys(result)) {
      const name = k.replace('libvpx_vp9', 'libvpx-vp9');
      result[k] = new RegExp(`\\s${name.replace(/[-]/g, '\\-')}\\s`).test(list);
    }
    for (const hw of ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'h264_amf']) {
      if (!result[hw]) continue;
      try {
        await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-frames:v', '1', '-c:v', hw, '-f', 'null', '-'], { quiet: true });
      } catch {
        result[hw] = false;
      }
    }
  } catch (e) {
    log.warn('encoder detection failed', e.message);
  }
  encoderCache = result;
  return result;
}

/** Escape a path for use inside an ffmpeg filter argument (e.g. movie=, subtitles=). */
export function ffEscapePath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
