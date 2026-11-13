import fs from 'node:fs';
import { runFfmpeg, runFfprobe, requireFfmpeg } from './ffmpeg.js';
import { spawnTracked } from '../core/proc.js';
import { hwCaps, decodeArgs, scaleChain, isQuarterTurn, runWithDecodeFallback } from './hw.js';

// Everything here is background work: it runs below normal priority so the editor keeps the CPU when it needs it.
const LOW = 'low';

/** Poster thumbnail (jpg, 320px wide). Videos: only the keyframe at/before the poster time is decoded. */
export async function makeThumbnail(file, info, out, { signal } = {}) {
  const args = [];
  if (info.type === 'video') {
    const t = Math.min(Math.max(0, info.duration * 0.1), 3);
    args.push('-threads', '1', '-skip_frame', 'nokey', '-noaccurate_seek', '-ss', t.toFixed(3));
  }
  args.push('-i', file, '-frames:v', '1', '-vf', 'scale=320:-2:flags=bicubic', '-q:v', '4', out);
  try {
    await runFfmpeg(args, { signal, quiet: true, priority: LOW });
  } catch (e) {
    if (info.type !== 'video' || signal?.aborted) throw e;
    // exotic files: plain (slower) seek
    const t = Math.min(Math.max(0, info.duration * 0.1), 3);
    await runFfmpeg(['-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2:flags=bicubic', '-q:v', '4', out], { signal, quiet: true, priority: LOW });
  }
  return out;
}

/** Largest gap (s) between keyframes in the first seconds of the video stream (demux only, no decoding). */
async function keyframeSpacing(file) {
  const txt = await runFfprobe(['-select_streams', 'v:0', '-read_intervals', '%+6', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file], { timeoutMs: 15000 });
  const keys = txt.split(/\r?\n/).filter((l) => /,K/.test(l)).map((l) => parseFloat(l)).filter(Number.isFinite).sort((a, b) => a - b);
  if (keys.length < 2) return Infinity;
  let max = 0;
  for (let i = 1; i < keys.length; i++) max = Math.max(max, keys[i] - keys[i - 1]);
  return max;
}

/**
 * Filmstrip sprite. When keyframes are dense enough (phones/cameras: one per second) only keyframes are decoded,
 * which is ~60× less work on 60 fps footage; decoding runs on the GPU when available. Returns sprite metadata.
 */
export async function makeFilmstrip(file, info, out, { signal } = {}) {
  const dur = Math.max(0.1, info.duration || 0);
  const count = Math.max(2, Math.min(100, Math.round(dur / 1.5)));
  const interval = dur / count;
  const tileW = 160;
  const tileH = Math.max(2, Math.round((tileW * (info.height || 9)) / (info.width || 16) / 2) * 2);
  const cols = 10;
  const rows = Math.ceil(count / cols);
  const gop = await keyframeSpacing(file).catch(() => Infinity);
  const keyOnly = dur > 240 || gop <= interval * 1.05;
  // info.width/height are display dims; scaling happens before rotation, in coded orientation
  const [cw, ch] = isQuarterTurn(info.rotation) ? [tileH, tileW] : [tileW, tileH];
  // fps filter (not select): with keyframe-only decoding it duplicates the last keyframe so every tile is filled
  const fps = `fps=fps=${(1 / interval).toFixed(6)}:round=near:start_time=0`;
  const tile = `tile=${cols}x${rows}:padding=0:margin=0`;
  await runWithDecodeFallback((mode) => [
    ...(keyOnly ? ['-skip_frame', 'nokey'] : []), '-noautorotate', ...decodeArgs(mode), '-i', file, '-an', '-sn', '-dn',
    '-vf', [fps, ...scaleChain(mode, cw, ch, { rotation: info.rotation, flags: 'fast_bilinear' }), tile].join(','),
    '-frames:v', '1', '-q:v', '5', out,
  ], { signal, quiet: true, priority: LOW });
  return { path: out, cols, rows, count, tileW, tileH, interval };
}

/** Waveform peaks: Uint8 per 10 ms (100/s), max abs amplitude 0..255. */
export async function makePeaks(file, out, { signal } = {}) {
  const bin = requireFfmpeg();
  const RATE = 8000, PER = 80; // 100 peaks/s
  return new Promise((resolve, reject) => {
    const proc = spawnTracked(bin, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], {}, { lowPriority: true });
    const peaks = [];
    let acc = 0, n = 0;
    let carry = null;
    proc.stdout.on('data', (chunk) => {
      let buf = chunk;
      if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
      const len = buf.length - (buf.length % 2);
      if (len < buf.length) carry = buf.subarray(len);
      for (let i = 0; i < len; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > acc) acc = v;
        if (++n === PER) { peaks.push(Math.min(255, Math.round(Math.sqrt(acc / 32768) * 255))); acc = 0; n = 0; }
      }
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Aborted'));
      if (n > 0) peaks.push(Math.min(255, Math.round(Math.sqrt(acc / 32768) * 255)));
      if (code !== 0 && peaks.length === 0) return reject(new Error('peaks failed: ' + err.slice(-300)));
      fs.writeFileSync(out, Buffer.from(peaks));
      resolve({ path: out, rate: 100, length: peaks.length });
    });
  });
}

/** Preview proxy for images, audio and alpha video (small / rare: plain CPU path). */
export async function makeProxy(file, info, out, { signal, onProgress } = {}) {
  let args;
  if (info.type === 'image') {
    args = ['-i', file, '-frames:v', '1', out];
  } else if (info.type === 'audio') {
    args = ['-i', file, '-vn', '-c:a', 'aac', '-b:a', '192k', out];
  } else if (info.hasAlpha) {
    args = ['-i', file, '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '34',
      '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-auto-alt-ref', '0', '-g', '30'];
    if (info.hasAudio) args.push('-c:a', 'libopus', '-b:a', '128k'); else args.push('-an');
    args.push(out);
  } else {
    return (await videoPass(file, info, { proxyOut: out, signal, onProgress })).proxy;
  }
  await runFfmpeg(args, { signal, duration: info.duration, onProgress, priority: LOW });
  return out;
}

const ENCODERS = {
  h264_nvenc: ['-preset', 'p4', '-rc', 'vbr', '-cq', '28', '-b:v', '0', '-maxrate', '6M', '-bufsize', '12M'],
  h264_qsv: ['-preset', 'veryfast', '-global_quality', '27'],
  h264_amf: ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '28'],
  libx264: ['-preset', 'veryfast', '-crf', '23'],
};

function proxyEncoder(mode, hwEncoder) {
  if (mode === 'cuda') return hwEncoder === 'h264_nvenc' ? 'h264_nvenc' : 'libx264';
  if (mode === 'hwdec' && hwEncoder) return hwEncoder;
  return 'libx264'; // last resort is all-CPU: a broken GPU encoder must not make the import fail
}

const escFilterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** Shot list from ffmpeg scene-score metadata. */
export function parseShots(txt, duration) {
  const cuts = [...String(txt).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.2 && t < duration - 0.2);
  const times = [0, ...cuts.filter((t, i, a) => i === 0 || t - a[i - 1] > 0.4), duration];
  const r = (x) => Math.round(x * 1000) / 1000;
  const shots = [];
  for (let i = 0; i < times.length - 1; i++) shots.push({ start: r(times[i]), end: r(times[i + 1]) });
  return shots;
}

/**
 * One decode of the source for everything that needs every frame: 720p preview proxy and/or shot detection.
 * GPU path (NVIDIA): NVDEC → scale_cuda → NVENC, with only a 320px copy coming back for the scene score.
 * info: { duration, rotation, hasAudio }. Returns { proxy, shots, mode }.
 */
export async function videoPass(file, info, { proxyOut = null, scenesFile = null, threshold = 0.32, signal, onProgress } = {}) {
  if (!proxyOut && !scenesFile) return { proxy: null, shots: null, mode: null };
  const { encoder: hwEncoder } = await hwCaps();
  const quarter = isQuarterTurn(info.rotation);
  const build = (mode) => {
    const branches = [];
    const outArgs = [];
    if (proxyOut) {
      const enc = proxyEncoder(mode, hwEncoder);
      const gpuFrames = mode === 'cuda' && enc === 'h264_nvenc';
      // display height ≤ 720 (in coded orientation, a quarter-turned clip is limited by its width)
      const [w, h] = quarter ? ["'min(720,iw)'", '-2'] : ['-2', "'min(720,ih)'"];
      branches.push({ label: 'px', chain: scaleChain(mode, w, h, { rotation: info.rotation, keepOnGpu: gpuFrames }) });
      outArgs.push('-map', '[px]', '-c:v', enc, ...ENCODERS[enc], '-g', '30');
      if (!gpuFrames) outArgs.push('-pix_fmt', enc === 'libx264' ? 'yuv420p' : 'nv12');
      if (info.hasAudio) outArgs.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
      outArgs.push('-movflags', '+faststart', proxyOut);
    }
    if (scenesFile) {
      // frame 0 is always selected: a single-shot clip would otherwise send no frame at all to this output, which
      // ffmpeg treats as an error (and parseShots ignores cuts before 0.2 s anyway)
      const chain = [...scaleChain(mode, 320, -2, { flags: 'fast_bilinear' }), `select='eq(n\\,0)+gt(scene\\,${threshold})'`, `metadata=mode=print:file='${escFilterPath(scenesFile)}'`];
      branches.push({ label: 'sc', chain });
      outArgs.push('-map', '[sc]', '-f', 'null', '-');
    }
    const fc = branches.length > 1
      ? [`[0:v:0]split=${branches.length}${branches.map((_, i) => `[s${i}]`).join('')}`, ...branches.map((b, i) => `[s${i}]${b.chain.join(',')}[${b.label}]`)].join(';')
      : `[0:v:0]${branches[0].chain.join(',')}[${branches[0].label}]`;
    return ['-noautorotate', ...decodeArgs(mode), '-i', file, '-filter_complex', fc, ...outArgs];
  };
  try {
    const { mode } = await runWithDecodeFallback(build, { signal, duration: info.duration, onProgress, priority: LOW });
    let shots = null;
    if (scenesFile) shots = parseShots(fs.existsSync(scenesFile) ? fs.readFileSync(scenesFile, 'utf8') : '', info.duration);
    return { proxy: proxyOut, shots, mode };
  } finally {
    if (scenesFile) fs.rm(scenesFile, { force: true }, () => {});
  }
}

/** Extract one frame as an image file. */
export async function extractFrame(file, time, out, { width = 0, signal } = {}) {
  const args = ['-ss', Math.max(0, time).toFixed(3), '-i', file, '-frames:v', '1'];
  if (width) args.push('-vf', `scale=${width}:-2:flags=bicubic`);
  if (/\.jpe?g$/i.test(out)) args.push('-q:v', '3');
  args.push(out);
  await runFfmpeg(args, { signal, quiet: true });
  return out;
}
