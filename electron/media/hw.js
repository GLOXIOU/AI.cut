// GPU-accelerated decoding for the import / analysis pipeline.
//  - 'cuda'  : NVIDIA — NVDEC decode + scale_cuda on the GPU, only small frames come back to the CPU (~70× less CPU on 4K HEVC)
//  - 'hwdec' : any other GPU — hardware decode (d3d11va on Windows, videotoolbox on macOS), CPU scaling
//  - 'sw'    : plain CPU decoding, always the last resort
// Every pass is tried in that order and silently falls back to the next mode if ffmpeg fails (unsupported profile,
// resolution beyond the decoder limits, driver issue…).
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, detectEncoders } from './ffmpeg.js';
import { tempDir } from '../core/paths.js';
import { log } from '../core/log.js';

export const HWDEC = process.platform === 'win32' ? 'd3d11va' : process.platform === 'darwin' ? 'videotoolbox' : 'auto';

let capsPromise = null;

async function makeSample() {
  const out = path.join(tempDir(), 'hw_probe_sample.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  const src = ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=0.4:r=25'];
  try {
    await runFfmpeg([...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { quiet: true });
  } catch {
    await runFfmpeg([...src, '-c:v', 'mpeg2video', out.replace(/\.mp4$/, '.mpg')], { quiet: true });
    return out.replace(/\.mp4$/, '.mpg');
  }
  return out;
}

async function works(args) {
  try { await runFfmpeg(args, { quiet: true }); return true; } catch { return false; }
}

/** { modes: ['cuda'|'hwdec'|'sw', …], encoder: hardware H.264 encoder usable for proxies or null } */
export function hwCaps() {
  if (!capsPromise) {
    capsPromise = (async () => {
      const modes = [];
      let encoder = null;
      try {
        const enc = await detectEncoders();
        encoder = enc.h264_nvenc ? 'h264_nvenc' : enc.h264_qsv ? 'h264_qsv' : enc.h264_amf ? 'h264_amf' : null;
        const sample = await makeSample();
        if (await works(['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', sample, '-vf', 'scale_cuda=160:90:format=nv12,hwdownload,format=nv12', '-f', 'null', '-'])) modes.push('cuda');
        if (await works(['-hwaccel', HWDEC, '-i', sample, '-f', 'null', '-'])) modes.push('hwdec');
      } catch (e) {
        log.warn('hardware decode detection failed', e.message);
      }
      modes.push('sw');
      log.info('video decode modes', modes.join(' → '), 'proxy encoder', encoder || 'libx264');
      return { modes, encoder };
    })();
  }
  return capsPromise;
}

/** Input options for a decode mode (placed before -i). */
export function decodeArgs(mode) {
  if (mode === 'cuda') return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'];
  if (mode === 'hwdec') return ['-hwaccel', HWDEC];
  return [];
}

/**
 * Display-matrix rotation (ffprobe value, e.g. -90 for a portrait phone clip) → filters that orient the picture.
 * Rotation is applied *after* downscaling (cheaper, and GPU frames cannot be rotated by ffmpeg's auto-rotate),
 * so every pass runs with -noautorotate.
 */
export function orientFilters(rotation = 0) {
  const theta = ((Math.round(-Number(rotation) || 0) % 360) + 360) % 360;
  if (theta === 90) return ['transpose=clock'];
  if (theta === 180) return ['hflip', 'vflip'];
  if (theta === 270) return ['transpose=cclock'];
  return [];
}
export const isQuarterTurn = (rotation) => Math.abs(Math.round(Number(rotation) || 0)) % 180 === 90;

/**
 * Filter chain: decoded frame → software frame of size (w, h) in *coded* orientation, then oriented.
 * w/h are ffmpeg scale expressions. keepOnGpu (cuda only, no rotation): stays a CUDA frame for NVENC.
 */
export function scaleChain(mode, w, h, { rotation = 0, flags = 'bicubic', keepOnGpu = false, fmt = 'nv12' } = {}) {
  const orient = orientFilters(rotation);
  const f = [];
  if (mode === 'cuda') {
    f.push(`scale_cuda=${w}:${h}:format=${fmt}`);
    if (keepOnGpu && !orient.length) return f;
    f.push(`hwdownload,format=${fmt}`);
  } else {
    f.push(`scale=${w}:${h}:flags=${flags}`);
  }
  f.push(...orient);
  if (orient.length) f.push('sidedata=mode=delete:type=DISPLAYMATRIX');
  return f;
}

/**
 * Run an ffmpeg pass with the best decode mode, falling back to the next one on failure.
 * build(mode) → ffmpeg args. Returns { mode, result }.
 */
export async function runWithDecodeFallback(build, opts = {}, { modes: only } = {}) {
  const { modes } = await hwCaps();
  const list = only ? modes.filter((m) => only.includes(m)) : modes;
  let lastErr = null;
  for (const mode of list) {
    if (opts.signal?.aborted) throw new Error('Aborted');
    try {
      const result = await runFfmpeg(build(mode), opts);
      return { mode, result };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastErr = e;
      if (mode !== 'sw') log.warn(`ffmpeg ${mode} pass failed, retrying with the next decode mode:`, e.message.slice(0, 300));
    }
  }
  throw lastErr || new Error('ffmpeg failed');
}
