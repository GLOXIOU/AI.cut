// Export pipeline: HTML layers → video chunks → audio → mux. Also renders single timeline frames (AI previews).
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, detectEncoders } from '../media/ffmpeg.js';
import { buildVideoGraph, htmlClipsInWindow, planChunks, expandWindow } from './graph.js';
import { renderAudioMix } from './audio-mix.js';
import { presetById, outputSize, videoEncoderArgs, audioEncoderArgs } from './presets.js';
import { composeHtmlClip, composeSubtitleDoc } from '../render/html.js';
import { renderHtmlToVideo, renderHtmlFrame, renderSubtitleSequence } from '../render/html-renderer.js';
import { registerRenderDoc, unregisterRenderDoc } from '../media/protocol.js';
import { projectDuration, r4, mediaById, activeVisualLayers } from '../../shared/timeline.js';
import { cuesToSrt, cuesToVtt } from '../../shared/subtitles.js';
import { sha1, exists, uid, fileSize } from '../core/util.js';
import { log } from '../core/log.js';
import { hwCaps, HWDEC } from '../media/hw.js';

function writeFilter(dir, name, text) {
  const file = path.join(dir, `${name}.txt`);
  fs.writeFileSync(file, text);
  return file;
}

function checkMedia(project) {
  const missing = new Set();
  for (const c of project.clips) {
    if (!c.mediaId) continue;
    const m = mediaById(project, c.mediaId);
    if (!m || !m.path || !exists(m.path)) missing.add(m?.name || c.mediaId);
  }
  if (missing.size) throw new Error(`Missing media files: ${[...missing].join(', ')}`);
}

/** Motion graphics rendered in parallel: each page captures frames one by one, so several pages keep the GPU busy. */
const HTML_CONCURRENCY = 3;

async function renderHtmlLayers(project, projectDir, w0, w1, fps, { signal, onProgress } = {}) {
  const { width: W, height: H } = project.settings;
  const layers = new Map();
  const list = htmlClipsInWindow(project, w0, w1);
  const errors = [];
  const dir = path.join(projectDir, '.aicut-cache', 'render', 'html');
  fs.mkdirSync(dir, { recursive: true });
  const todo = [];
  for (const { clip, t0, t1 } of list) {
    const doc = composeHtmlClip(clip, project, { mode: 'render' });
    const key = sha1(`${doc}|${r4(t0)}|${r4(t1)}|${fps}|${W}x${H}`).slice(0, 20);
    const file = path.join(dir, `${key}.mov`);
    layers.set(clip.id, { file, t0 });
    if (!exists(file) || fileSize(file) < 100) todo.push({ clip, t0, t1, doc, file, frames: Math.max(1, (t1 - t0) * fps) });
  }
  if (!todo.length) return { layers, errors };
  // progress weighted by frame count; longest renders first so the pool finishes together
  todo.sort((a, b) => b.frames - a.frames);
  const total = todo.reduce((n, x) => n + x.frames, 0);
  const done = new Map();
  const report = (name) => onProgress?.([...done.values()].reduce((n, v) => n + v, 0) / total, `motion ${name}`);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      if (signal?.aborted) throw new Error('Aborted');
      const it = todo[next++];
      const token = uid('doc', 10);
      const url = registerRenderDoc(token, it.doc);
      const tmp = `${it.file}.part.mov`;
      try {
        const r = await renderHtmlToVideo({ url, width: W, height: H, fps, t0: it.t0, t1: it.t1, out: tmp, signal, onProgress: (p) => { done.set(it, p * it.frames); report(it.clip.name); } });
        fs.renameSync(tmp, it.file); // a canceled export never leaves a truncated layer in the cache
        if (r.errors?.length) errors.push({ clip: it.clip.id, name: it.clip.name, errors: r.errors });
      } finally {
        unregisterRenderDoc(token);
        fs.rm(tmp, { force: true }, () => {});
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HTML_CONCURRENCY, todo.length) }, worker));
  return { layers, errors };
}

async function renderSubs(project, projectDir, w0, w1, fps, workDir, { signal, onProgress } = {}) {
  const subs = project.subtitles;
  if (!subs?.enabled || !subs.cues?.length) return null;
  if (!subs.cues.some((q) => q.end > w0 && q.start < w1)) return null;
  // all cues are sent (not only the window's): the automatic keyword choice is global, it must match the preview
  const cues = subs.cues;
  const { width: W, height: H } = project.settings;
  const token = uid('subs', 10);
  const url = registerRenderDoc(token, composeSubtitleDoc(project, { cues, style: subs.style }));
  try {
    return await renderSubtitleSequence({ url, width: W, height: H, fps, t0: w0, t1: w1, outDir: path.join(workDir, `subs_${Math.round(w0 * 1000)}`), signal, onProgress });
  } finally {
    unregisterRenderDoc(token);
  }
}

/**
 * Export the timeline. opts: { output, preset, quality, hardware, range:{start,end}, burnSubtitles, subtitlesFile ('srt'|'vtt'|null),
 *   width, height, fps, normalize }
 */
export async function exportProject(project, projectDir, opts, ctx) {
  const t0 = Date.now();
  const preset = presetById(opts.preset);
  const total = projectDuration(project);
  if (total <= 0) throw new Error('The timeline is empty — nothing to export.');
  checkMedia(project);
  const w0 = Math.max(0, opts.range?.start ?? 0);
  const w1 = Math.min(total, opts.range?.end ?? total);
  if (!(w1 > w0)) throw new Error('Invalid export range');
  const fps = opts.fps || preset.fps || project.settings.fps;
  const { width: outW, height: outH } = outputSize(preset, project, opts);
  const format = preset.format;
  const audioOnly = !preset.video;
  const output = opts.output;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const workDir = path.join(projectDir, '.aicut-cache', 'render', `export_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const progress = (p, m) => ctx?.progress(p, m);
  const encoders = await detectEncoders();
  let encoderUsed = null;
  const warnings = [];

  try {
    let videoChunks = [];
    if (!audioOnly) {
      const [e0, e1] = expandWindow(project, w0, w1);
      // 1. HTML layers
      progress(0.01, 'motion graphics');
      const { layers, errors } = await renderHtmlLayers(project, projectDir, e0, e1, fps, { signal: ctx?.signal, onProgress: (p, m) => progress(0.01 + 0.14 * p, m) });
      for (const e of errors) warnings.push(`Motion "${e.name}" reported JS errors: ${e.errors.slice(0, 3).join(' | ')}`);
      // 2. video chunks. CPU decoding by default: measured on 4K60 HEVC, hardware decoding (opts.gpuDecode) is not faster
      // here (same wall time, less CPU) and several NVDEC-heavy chunks at once could stall; it stays available as an option
      const caps = opts.hardware !== false && opts.gpuDecode === true ? await hwCaps().catch(() => null) : null;
      let decode = caps?.modes?.[0] && caps.modes[0] !== 'sw' ? caps.modes[0] : 'sw';
      const chunks = planChunks(project, e0, e1, decode === 'sw' ? 24 : 12);
      const isGif = format === 'gif';
      const enc = isGif ? videoEncoderArgs('intermediate') : videoEncoderArgs(preset.video, { quality: opts.quality || preset.quality || 'high', hardware: opts.hardware !== false, encoders, bitrate: opts.bitrate });
      encoderUsed = enc.encoder;
      const chunkExt = isGif ? 'mkv' : format === 'webm' ? 'webm' : format === 'mov' ? 'mov' : 'mp4';
      const span = e1 - e0;
      // one chunk at a time by default: with CPU decoding a chunk already uses every core (opts.parallelChunks to try more)
      const concurrency = Math.max(1, Math.min(chunks.length, opts.parallelChunks ?? 1));
      const chunkDone = new Array(chunks.length).fill(0); // seconds rendered per chunk
      const reportVideo = (ci, st) => {
        const doneSec = chunkDone.reduce((x, y) => x + y, 0);
        progress(0.15 + 0.7 * (doneSec / span), `video ${Math.min(chunks.length, ci + 1)}/${chunks.length}${st?.speed ? ` · ×${(st.speed * concurrency).toFixed(2)}` : ''}`);
      };
      const runChunk = async (ci) => {
        const [c0, c1] = chunks[ci];
        const subs = opts.burnSubtitles === false ? null : await renderSubs(project, projectDir, c0, c1, fps, workDir, { signal: ctx?.signal, onProgress: (p) => progress(0.15 + 0.7 * (chunkDone.reduce((x, y) => x + y, 0) / span), `subtitles ${Math.round(p * 100)}%`) });
        const trim = {};
        if (ci === 0 && w0 > e0) trim.start = w0 - e0;
        if (ci === chunks.length - 1 && w1 < e1) trim.end = w1 - c0;
        const out = path.join(workDir, `chunk_${String(ci).padStart(3, '0')}.${chunkExt}`);
        const chunkDur = (trim.end ?? (c1 - c0)) - (trim.start ?? 0);
        const encodeChunk = async (dec, encArgs) => {
          const g = buildVideoGraph(project, c0, c1, {
            width: project.settings.width, height: project.settings.height, fps, htmlLayers: layers, subtitles: subs,
            outWidth: isGif ? 0 : outW, outHeight: isGif ? 0 : outH, trim, decode: dec === 'sw' ? null : dec, hwdec: HWDEC,
          });
          const filterFile = writeFilter(workDir, `video_${ci}`, g.filter);
          const args = [...g.inputs.flat(), '-/filter_complex', filterFile, '-map', `[${g.out}]`, ...encArgs, '-r', String(fps), '-an'];
          if (chunkExt === 'mp4' || chunkExt === 'mov') args.push('-movflags', '+faststart');
          args.push(out);
          try {
            await runFfmpeg(args, { duration: chunkDur, signal: ctx?.signal, onProgress: (r, st) => { chunkDone[ci] = r * (c1 - c0); reportVideo(ci, st); } });
          } catch (e) {
            e.filterFile = filterFile;
            throw e;
          }
        };
        // fallbacks: GPU decode → CPU decode (kept for the next chunks), then hardware encoder → software encoder
        const attempts = [[decode, enc.args]];
        if (decode !== 'sw') attempts.push(['sw', enc.args]);
        if (/nvenc/.test(enc.encoder)) attempts.push(['sw', null]);
        for (let ai = 0; ai < attempts.length; ai++) {
          let [dec, encArgs] = attempts[ai];
          if (!encArgs) {
            const sw = videoEncoderArgs(preset.video, { quality: opts.quality || 'high', hardware: false });
            enc.args = sw.args; enc.encoder = sw.encoder; encoderUsed = sw.encoder; encArgs = sw.args;
          }
          try {
            await encodeChunk(dec, encArgs);
            if (dec !== decode && decode !== 'sw') { decode = dec; warnings.push('GPU decoding failed on this footage: the export used CPU decoding.'); }
            break;
          } catch (e) {
            if (ctx?.signal?.aborted || ai === attempts.length - 1) {
              if (e.filterFile) e.message += `\n(filter graph: ${e.filterFile})`;
              throw e;
            }
            log.warn(`export chunk ${ci} failed (decode ${dec}, ${encArgs[1]}), retrying:`, e.message.slice(0, 400));
          }
        }
        chunkDone[ci] = c1 - c0;
        videoChunks[ci] = out;
      };
      let nextChunk = 0;
      let failed = null;
      const worker = async () => {
        while (nextChunk < chunks.length && !failed) {
          const ci = nextChunk++;
          try { await runChunk(ci); } catch (e) { failed = failed || e; }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (failed) throw failed;
      if (videoChunks.length !== chunks.length || videoChunks.some((x) => !x)) throw new Error('Some video chunks were not rendered.');
    }

    // 3. audio
    let audioFile = null;
    if (format !== 'gif') {
      progress(0.86, 'audio');
      audioFile = path.join(workDir, 'audio.wav');
      await renderAudioMix(project, w0, w1, audioFile, { signal: ctx?.signal, normalize: opts.normalize, onProgress: (r) => progress(0.86 + 0.08 * r, 'audio') });
    }

    // 4. finalize
    progress(0.95, 'finalizing');
    if (audioOnly) {
      await runFfmpeg(['-i', audioFile, ...audioEncoderArgs(format), output], { signal: ctx?.signal });
    } else {
      const list = path.join(workDir, 'chunks.ffconcat');
      fs.writeFileSync(list, ['ffconcat version 1.0', ...videoChunks.map((c) => `file '${c.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)].join('\n') + '\n');
      if (format === 'gif') {
        const gw = outW;
        await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-filter_complex', `[0:v]fps=${fps},scale=${gw}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', output], { signal: ctx?.signal });
      } else {
        const args = ['-f', 'concat', '-safe', '0', '-i', list, '-i', audioFile, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...audioEncoderArgs(format), '-shortest'];
        if (format === 'mp4' || format === 'mov') args.push('-movflags', '+faststart');
        args.push(output);
        await runFfmpeg(args, { signal: ctx?.signal, duration: w1 - w0 });
      }
    }

    // 5. sidecar subtitles
    let subtitleFile = null;
    if (opts.subtitlesFile && project.subtitles?.cues?.length) {
      const cues = project.subtitles.cues.filter((q) => q.end > w0 && q.start < w1).map((q) => ({ ...q, start: Math.max(0, q.start - w0), end: q.end - w0 }));
      subtitleFile = output.replace(/\.[^.]+$/, `.${opts.subtitlesFile === 'vtt' ? 'vtt' : 'srt'}`);
      fs.writeFileSync(subtitleFile, opts.subtitlesFile === 'vtt' ? cuesToVtt(cues) : cuesToSrt(cues));
    }
    progress(1, 'done');
    return {
      path: output, duration: r4(w1 - w0), width: audioOnly ? 0 : outW, height: audioOnly ? 0 : outH, fps, format,
      encoder: encoderUsed, size: fileSize(output), subtitleFile, seconds: Math.round((Date.now() - t0) / 100) / 10, warnings,
    };
  } finally {
    if (!opts.keepTemp) fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

/**
 * Render one composed timeline frame (what the viewer sees at time t) to an image file.
 * Used by the AI to visually verify its edits.
 */
export async function renderTimelineFrame(project, projectDir, t, { out, width = 960, subtitles = true, signal } = {}) {
  const fps = project.settings.fps;
  const total = projectDuration(project);
  t = Math.max(0, Math.min(t, Math.max(0, total - 1 / fps)));
  checkMedia(project);
  const W = project.settings.width, H = project.settings.height;
  const outW = Math.max(2, Math.round(Math.min(width, W) / 2) * 2);
  const outH = Math.max(2, Math.round((outW * H) / W / 2) * 2);
  const workDir = path.join(projectDir, '.aicut-cache', 'render', `frame_${Date.now()}_${Math.round(Math.random() * 1e6)}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const [e0, e1] = expandWindow(project, t, t + 1 / fps);
    // html layers active at t → still PNGs
    const layers = new Map();
    for (const L of activeVisualLayers(project, t)) {
      if (L.clip.type !== 'html') continue;
      const token = uid('doc', 10);
      const url = registerRenderDoc(token, composeHtmlClip(L.clip, project, { mode: 'render' }));
      try {
        const file = path.join(workDir, `${L.clip.id}.png`);
        await renderHtmlFrame({ url, width: W, height: H, time: Math.max(0, t - L.clip.start), out: file });
        layers.set(L.clip.id, { file, still: true, t0: 0 });
      } finally { unregisterRenderDoc(token); }
    }
    // html clips in the expanded window but not active at t (transitions) → still at their nearest time
    for (const { clip } of htmlClipsInWindow(project, e0, e1)) {
      if (layers.has(clip.id)) continue;
      const token = uid('doc', 10);
      const url = registerRenderDoc(token, composeHtmlClip(clip, project, { mode: 'render' }));
      try {
        const file = path.join(workDir, `${clip.id}.png`);
        await renderHtmlFrame({ url, width: W, height: H, time: Math.min(clip.duration, Math.max(0, t - clip.start)), out: file });
        layers.set(clip.id, { file, still: true, t0: 0 });
      } finally { unregisterRenderDoc(token); }
    }
    const subs = subtitles ? await renderSubs(project, projectDir, e0, e1, fps, workDir, { signal }) : null;
    const trimStart = t - e0;
    const g = buildVideoGraph(project, e0, e1, { width: W, height: H, fps, htmlLayers: layers, subtitles: subs, outWidth: outW, outHeight: outH, trim: { start: trimStart, end: trimStart + 1 / fps } });
    const filterFile = writeFilter(workDir, 'frame', g.filter);
    await runFfmpeg([...g.inputs.flat(), '-/filter_complex', filterFile, '-map', `[${g.out}]`, '-frames:v', '1', ...(/\.jpe?g$/i.test(out) ? ['-q:v', '3'] : []), out], { signal, quiet: true });
    return out;
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}
