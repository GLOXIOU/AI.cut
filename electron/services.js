// High-level services shared by the UI (IPC) and the AI (MCP tools).
import fs from 'node:fs';
import { runFfmpeg } from './media/ffmpeg.js';
import { app } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { store } from './project/store.js';
import { OPS } from './project/ops.js';
import { jobs } from './core/jobs.js';
import { bus } from './core/bus.js';
import { log } from './core/log.js';
import { getSettings, tr } from './core/settings.js';
import { defaultProjectsDir, tempDir, libraryDir } from './core/paths.js';
import { safeFileName, uniquePath, writeJson, exists, uid } from './core/util.js';
import { importPaths, waitForProbe } from './media/service.js';
import { exportProject, renderTimelineFrame } from './export/exporter.js';
import { presetById } from './export/presets.js';
import { loadAnalysis, timelineWords, analysisDirFor } from './analysis/index.js';
import { extractFrames, sampleTimes, contactSheet } from './analysis/video-analysis.js';
import { downloadLibraryItem, sfxFile, isLocalLibraryId } from './library/library.js';
import { downloadMedia, videoInfo, searchYoutube } from './youtube/ytdlp.js';
import { memeSounds, memeImages, memeGifs, memeScreens, memeFile, rememberItems } from './library/memebank.js';
import { composeHtmlClip } from './render/html.js';
import { renderHtmlFrame } from './render/html-renderer.js';
import { registerRenderDoc, unregisterRenderDoc } from './media/protocol.js';
import { buildCues, resolveSubtitleStyle } from '../shared/subtitles.js';
import { scoreWords, normWord } from '../shared/keywords.js';
import { clipById, clipEnd, mediaById, trackById, projectDuration, r4, fmtTime, evalKeyframes } from '../shared/timeline.js';
import { MEMES, stickerOffset } from '../shared/memes.js';
import { packPath, packManifest, stickerById, searchStickers } from './library/packs.js';
import { agentsMd } from './ai/guide.js';

// ------------------------------------------------------------------ UI state (playhead, selection)
export const uiState = { playhead: 0, selection: [], playing: false, visible: null, panel: null };
export function setUiState(s) { Object.assign(uiState, s || {}); }

// ------------------------------------------------------------------ projects
export function mcpUrl() { return `http://127.0.0.1:${getSettings().mcpPort}/mcp`; }

export function writeAgentFiles(dir, name) {
  try {
    const url = mcpUrl();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), agentsMd(name, url));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `@AGENTS.md\n`);
    fs.writeFileSync(path.join(dir, 'GEMINI.md'), `@AGENTS.md\n`);
    const mcpFile = path.join(dir, '.mcp.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(mcpFile, 'utf8')); } catch { /* new */ }
    cfg.mcpServers = { ...(cfg.mcpServers || {}), aicut: { type: 'http', url } };
    fs.writeFileSync(mcpFile, JSON.stringify(cfg, null, 2));
  } catch (e) { log.warn('agent files', e.message); }
}

export function createProject({ name = 'Untitled', preset = '1080p', fps = 60, folder = null } = {}) {
  if (store.isOpen) store.close();
  const parent = folder || getSettings().defaultProjectsDir || defaultProjectsDir();
  fs.mkdirSync(parent, { recursive: true });
  const p = store.create({ name, parentDir: parent, preset, fps });
  writeAgentFiles(store.dir, name);
  return { project: p, file: store.file, dir: store.dir };
}

/**
 * What deleting a project sends to the Recycle Bin: the project's own folder when AI.cut created it (one .aicut file,
 * a .aicut-cache, folder named after the project), otherwise only the .aicut file — never a shared/user folder.
 */
export function projectTrashTarget(file) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { kind: 'file', path: file }; }
  const projectFiles = entries.filter((f) => f.toLowerCase().endsWith('.aicut'));
  const folder = path.basename(dir);
  const ownFolder = (folder === base || folder.startsWith(`${base} (`)) && projectFiles.length === 1 && entries.includes('.aicut-cache');
  const protectedDirs = [app.getPath('home'), app.getPath('documents'), app.getPath('desktop'), app.getPath('downloads'), app.getPath('videos'),
    defaultProjectsDir(), getSettings().defaultProjectsDir, path.parse(path.resolve(dir)).root].filter(Boolean).map(norm);
  if (ownFolder && !protectedDirs.includes(norm(dir))) return { kind: 'folder', path: dir };
  return { kind: 'file', path: file };
}

export function openProject(file) {
  if (store.isOpen && store.file === file) return { project: store.project, file, dir: store.dir };
  if (store.isOpen) store.close();
  const p = store.open(file);
  writeAgentFiles(store.dir, p.name);
  return { project: p, file: store.file, dir: store.dir };
}

// ------------------------------------------------------------------ export
export function startExport(opts = {}, meta = {}) {
  store.requireOpen();
  const preset = presetById(opts.preset || getSettings().exportDefaults.preset);
  const snapshot = structuredClone(store.project);
  const dir = store.dir;
  const ext = preset.format;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const output = opts.path || uniquePath(path.join(dir, 'exports', `${safeFileName(snapshot.name)} ${stamp}.${ext}`));
  const job = jobs.create('export', `Export ${path.basename(output)}`, async (ctx) => {
    const r = await exportProject(snapshot, dir, { ...opts, preset: preset.id, output }, ctx);
    bus.emit('toast', { level: 'success', message: `${tr('Export terminé', 'Export finished')} : ${path.basename(r.path)}`, path: r.path });
    return r;
  }, { queue: 'export', meta: { output, preset: preset.id, source: meta.source || 'ui' } });
  return job;
}

// ------------------------------------------------------------------ subtitles
export function generateSubtitles(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const words = timelineWords(p, { tracks: opts.tracks || null });
  const pendingMedia = [];
  for (const c of p.clips) {
    const m = mediaById(p, c.mediaId);
    if (m?.hasAudio && (c.type === 'video' || c.type === 'audio') && !c.muted && !loadAnalysis(m.id).transcript) pendingMedia.push(m.name);
  }
  if (!words.length) {
    throw new Error(pendingMedia.length
      ? `No transcript yet for: ${[...new Set(pendingMedia)].join(', ')}. Run analyze_media (or wait for the transcription job) and retry.`
      : 'No speech found in the audible clips of the timeline.');
  }
  const style = resolveSubtitleStyle({ ...p.subtitles.style, ...(opts.preset ? { preset: opts.preset } : {}) });
  // importance score of every word (keyword / emphasis subtitle modes): text + timing + vocal energy
  const lang = (() => {
    for (const c of p.clips) { const tr = c.mediaId && loadAnalysis(c.mediaId).transcript; if (tr?.language) return tr.language; }
    return null;
  })();
  attachWordEnergy(p, words);
  const scores = scoreWords(words, { language: lang });
  words.forEach((w, i) => { w.s = scores[i]; delete w.e; });
  const cues = buildCues(words, {
    maxWords: opts.maxWords ?? style.maxWords, maxChars: opts.maxChars ?? style.maxChars, maxLines: opts.maxLines ?? style.maxLines,
    maxDuration: opts.maxDuration, gap: opts.gap,
  });
  const { result, warnings } = store.transaction('generate subtitles', (draft) => {
    if (opts.preset) OPS.setSubtitleStyle(draft, { preset: opts.preset });
    if (opts.maxWords) draft.subtitles.style.maxWords = opts.maxWords;
    return OPS.setSubtitleCues(draft, { cues, append: opts.replace === false });
  }, meta);
  if (pendingMedia.length) warnings.push(`Some media have no transcript yet (${[...new Set(pendingMedia)].join(', ')}); their speech is not subtitled.`);
  return { cues: result.count, words: words.length, warnings };
}

/** Mean waveform level (0..1) under each timeline word, from the media peaks (100 values / s). */
function attachWordEnergy(p, words) {
  const peaks = new Map();
  const peaksOf = (m) => {
    if (!m?.peaks) return null;
    if (!peaks.has(m.id)) { try { peaks.set(m.id, fs.readFileSync(m.peaks)); } catch { peaks.set(m.id, null); } }
    return peaks.get(m.id);
  };
  for (const w of words) {
    const c = clipById(p, w.clipId);
    const m = c && mediaById(p, c.mediaId);
    const pk = peaksOf(m);
    if (!pk) continue;
    const s0 = c.in + (w.start - c.start) * c.speed, s1 = c.in + (w.end - c.start) * c.speed;
    const a = Math.max(0, Math.floor(s0 * 100)), b = Math.min(pk.length, Math.max(a + 1, Math.ceil(s1 * 100)));
    let sum = 0;
    for (let i = a; i < b; i++) sum += pk[i];
    if (b > a) w.e = sum / (b - a) / 255;
  }
}

/** Ask the local scorer to re-rank the words of the current cues (e.g. after importing an SRT). */
export function rescoreSubtitleWords(meta = {}) {
  const p = store.requireOpen();
  const cues = p.subtitles.cues;
  if (!cues.length) throw new Error('No subtitles yet.');
  const flat = [];
  for (const q of cues) {
    const ws = q.words?.length ? q.words : String(q.text).split(/\s+/).filter(Boolean).map((text, i, arr) => {
      const d = (q.end - q.start) / Math.max(1, arr.length);
      return { text, start: q.start + i * d, end: q.start + (i + 1) * d };
    });
    flat.push(...ws.map((w) => ({ ...w })));
  }
  const scores = scoreWords(flat);
  let k = 0;
  const { result } = store.transaction('detect subtitle keywords', (draft) => {
    for (const q of draft.subtitles.cues) {
      const n = q.words?.length || String(q.text).split(/\s+/).filter(Boolean).length;
      const ws = flat.slice(k, k + n).map((w, i) => { const o = { ...w, s: Math.round(scores[k + i] * 100) / 100 }; delete o.k; return o; });
      q.words = ws;
      k += n;
    }
    return { words: flat.length };
  }, meta);
  return result;
}

// ------------------------------------------------------------------ music detection
const SFX_LABELS = new Set(['auto-sfx', 'meme', 'sfx']);
/** Background music clip? (audio-only media that is not a sound effect / meme / voice-over) */
export function isMusicClip(p, c) {
  if (c.type !== 'audio' || SFX_LABELS.has(c.label)) return false;
  const tr = trackById(p, c.trackId);
  if (tr && /^SFX/i.test(tr.name)) return false;
  const m = mediaById(p, c.mediaId);
  if (!m || m.type !== 'audio') return false;
  const src = m.source || {};
  if (src.kind === 'meme' || src.kind === 'tts' || (src.kind === 'library' && /builtin|pack$|myinstants/.test(src.provider || '') && !String(src.libraryId || '').startsWith('music:'))) return false;
  const tr2 = loadAnalysis(m.id).transcript;
  if (tr2?.wordCount > 3 && m.duration > 0 && tr2.wordCount / m.duration > 0.6) return false; // a voice
  return (m.duration || 0) >= 8;
}
/** Ripple-delete ranges on the cut tracks (music kept continuous), then end the music with the content (fade-out). */
function rippleCut(ranges, tracks, meta, label) {
  return store.transaction(label, (draft, ctx) => {
    const r = OPS.rippleDeleteRanges(draft, { ranges, tracks, shiftSubtitles: true }, ctx);
    const contentEnd = Math.max(0, ...draft.clips.filter((c) => !isMusicClip(draft, c)).map((c) => c.start + c.duration));
    for (const c of draft.clips.filter((x) => isMusicClip(draft, x))) {
      if (contentEnd > 0 && c.start + c.duration > contentEnd + 0.05) {
        if (c.start >= contentEnd - 0.2) { draft.clips = draft.clips.filter((x) => x.id !== c.id); continue; }
        OPS.updateClip(draft, { id: c.id, duration: r4(contentEnd - c.start), fadeOut: Math.min(1.5, (contentEnd - c.start) / 3) }, ctx);
      }
    }
    return { ...r, duration: projectDuration(draft) };
  }, meta);
}

/** Tracks a ripple cut must touch: everything except the tracks that only hold background music (kept continuous). */
function cutTracks(p) {
  return p.tracks.filter((t) => !t.locked).filter((t) => {
    const clips = p.clips.filter((c) => c.trackId === t.id);
    return !(t.type === 'audio' && clips.length && clips.every((c) => isMusicClip(p, c)));
  }).map((t) => t.id);
}

// ------------------------------------------------------------------ silences / ducking
export function removeSilences(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const minSilence = opts.minSilence ?? 0.45;
  const padding = opts.padding ?? 0.12;
  let clips;
  if (opts.clipIds?.length) clips = opts.clipIds.map((id) => clipById(p, id)).filter(Boolean);
  else {
    const track = p.tracks.find((t) => t.name.toLowerCase() === String(opts.track || 'V1').toLowerCase() || t.id === opts.track);
    clips = p.clips.filter((c) => c.trackId === track?.id && (c.type === 'video' || c.type === 'audio'));
  }
  const minClip = Math.max(0, opts.minClip ?? 0.7);
  const missing = [];
  const ranges = [];
  let shortFixed = 0, shortDropped = 0;
  for (const c of clips) {
    const m = mediaById(p, c.mediaId);
    if (!m?.hasAudio) continue;
    const a = loadAnalysis(m.id);
    if (!a.silences) { missing.push(m.name); continue; }
    const srcA = c.in, srcB = c.in + c.duration * c.speed;
    const cuts = [];
    for (const s of a.silences) {
      const s0 = Math.max(s.start + padding, srcA);
      const s1 = Math.min(s.end - padding, srcB);
      if (s1 - s0 < minSilence - 2 * padding || s1 <= s0) continue;
      const atStart = s.start <= srcA + 0.01, atEnd = s.end >= srcB - 0.01;
      const t0 = c.start + ((atStart ? srcA : s0) - c.in) / c.speed;
      const t1 = c.start + ((atEnd ? srcB : s1) - c.in) / c.speed;
      if (t1 - t0 > 0.05) cuts.push({ start: t0, end: t1 });
    }
    // minimum shot length: a piece of speech kept between two cuts shorter than minClip stutters on screen.
    // A short piece with words grows (the neighbouring cuts shrink, keeping a bit more pause); a short piece without
    // words (breath, click) is cut away with the silences around it.
    if (minClip > 0 && cuts.length) {
      const words = loadAnalysis(m.id).transcript?.segments?.flatMap((sg) => sg.words || []) || [];
      const toTl = (src) => c.start + (src - c.in) / c.speed;
      const hasWords = (t0, t1) => words.some((w) => { const a0 = toTl(w.start), a1 = toTl(w.end); return Math.min(a1, t1) - Math.max(a0, t0) > Math.min(0.08, (a1 - a0) / 2); });
      const end = c.start + c.duration;
      for (let guard = 0; guard < 400; guard++) {
        cuts.sort((x, y) => x.start - y.start);
        let changed = false;
        for (let i = 0; i <= cuts.length; i++) {
          const k0 = i === 0 ? c.start : cuts[i - 1].end, k1 = i === cuts.length ? end : cuts[i].start;
          const len = k1 - k0;
          if (len <= 1e-3 || len >= minClip - 1e-3) continue;
          const prev = cuts[i - 1], next = cuts[i];
          if (!prev && !next) continue;
          if (!hasWords(k0, k1)) {
            // drop the piece: merge with the neighbouring cut(s)
            if (prev && next) { prev.end = next.end; cuts.splice(i, 1); }
            else if (prev) prev.end = end;
            else if (next) next.start = c.start;
            shortDropped++; changed = true; break;
          }
          let need = minClip - len;
          const takePrev = prev ? Math.min(prev.end - prev.start, next ? need / 2 : need) : 0;
          if (prev) { prev.end -= takePrev; need -= takePrev; }
          const takeNext = next ? Math.min(next.end - next.start, need) : 0;
          if (next) { next.start += takeNext; need -= takeNext; }
          if (need > 1e-3 && prev && prev.end - prev.start > 0) { const t = Math.min(prev.end - prev.start, need); prev.end -= t; }
          for (let j = cuts.length - 1; j >= 0; j--) if (cuts[j].end - cuts[j].start < 0.05) cuts.splice(j, 1);
          shortFixed++; changed = true; break;
        }
        if (!changed) break;
      }
    }
    for (const k of cuts) if (k.end - k.start > 0.05) ranges.push({ start: r4(k.start), end: r4(k.end) });
  }
  if (missing.length && !ranges.length) throw new Error(`No silence analysis for: ${missing.join(', ')}. Run analyze_media first.`);
  ranges.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.01) last.end = Math.max(last.end, r.end); else merged.push({ ...r });
  }
  if (!merged.length) return { removed: 0, ranges: [], message: 'No silence long enough to remove.' };
  let tracks = null;
  if (!opts.allTracks) {
    const ids = new Set(clips.map((c) => c.trackId));
    // tracks holding detached audio of the same media at the same place
    for (const c of p.clips) {
      if (ids.has(c.trackId)) continue;
      if (clips.some((k) => k.mediaId === c.mediaId && Math.abs(k.start - c.start) < 0.05 && Math.abs(k.in - c.in) < 0.05)) ids.add(c.trackId);
    }
    tracks = [...ids];
  }
  const { result, warnings } = rippleCut(merged, tracks || cutTracks(p), meta, `remove ${merged.length} silences`);
  if (missing.length) warnings.push(`Skipped (no analysis): ${missing.join(', ')}`);
  return { ...result, ranges: merged.length, minClip, shortPiecesExtended: shortFixed, shortPiecesRemoved: shortDropped, warnings };
}

export function duckMusic(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const amountDb = opts.amountDb ?? -12;
  const attack = opts.attack ?? 0.25, release = opts.release ?? 0.6, minGap = opts.minGap ?? 0.8;
  let music;
  if (opts.clipIds?.length) music = opts.clipIds.map((id) => clipById(p, id)).filter(Boolean);
  else {
    const t = opts.track ? p.tracks.find((x) => x.name.toLowerCase() === String(opts.track).toLowerCase() || x.id === opts.track) : null;
    music = p.clips.filter((c) => (t ? c.trackId === t.id && c.type === 'audio' : isMusicClip(p, c)));
  }
  const musicIds = new Set(music.map((c) => c.id));
  if (!music.length) throw new Error('No background music on the timeline to duck (music = audio-only clips of 8 s or more that are not sound effects).');
  const words = timelineWords(p).filter((w) => !musicIds.has(w.clipId));
  if (!words.length) throw new Error('No transcribed speech on the timeline to duck under (analyze the voice media first).');
  const iv = [];
  for (const w of words) {
    const last = iv[iv.length - 1];
    if (last && w.start - last.end < minGap) last.end = Math.max(last.end, w.end); else iv.push({ start: w.start, end: w.end });
  }
  const k = Math.pow(10, amountDb / 20);
  const items = [];
  for (const c of music) {
    const v = c.volume ?? 1, d = v * k;
    const kf = [{ t: 0, v }];
    for (const s of iv) {
      const a = s.start - c.start - attack, b = s.end - c.start + release;
      if (b < 0 || a > c.duration) continue;
      const pts = [[a, v], [a + attack, d], [b - release, d], [b, v]];
      for (const [t, val] of pts) {
        const tt = r4(Math.max(0, Math.min(c.duration, t)));
        const last = kf[kf.length - 1];
        if (tt <= last.t) { if (val < last.v || tt === last.t) last.v = val; continue; }
        kf.push({ t: tt, v: val, ease: 'ease-in-out' });
      }
    }
    items.push({ id: c.id, kf });
  }
  const { warnings } = store.transaction(`duck music (${amountDb} dB)`, (draft, ctx) => {
    for (const it of items) OPS.setKeyframes(draft, { id: it.id, property: 'volume', keyframes: it.kf }, ctx);
  }, meta);
  return { musicClips: items.length, speechSegments: iv.length, amountDb, warnings };
}

/** A local sound effect (built-in synth, or real recording of the bundled pack) as project media (copied once into media/sfx, imported once). */
export async function ensureSfxMedia(id, meta = {}) {
  const dir = path.join(store.dir, 'media', 'sfx');
  fs.mkdirSync(dir, { recursive: true });
  const bare = String(id).replace(/^(builtin|pack):/, '');
  const src = sfxFile(id);
  const real = !src.startsWith(path.join(libraryDir(), 'builtin'));
  const file = path.join(dir, `${bare}${path.extname(src)}`);
  if (!exists(file)) fs.copyFileSync(src, file);
  const [m] = importPaths([file], {
    ...meta,
    sourceInfo: real
      ? { kind: 'library', provider: 'pack', title: bare, license: 'CC0 (Freesound)', attributionRequired: false }
      : { kind: 'library', provider: 'builtin', title: bare, license: 'CC0 (generated by AI.cut)', attributionRequired: false },
  });
  const ready = await waitForProbe(m.id, 30000);
  return ready?.duration > 0 ? ready : null;
}

// ------------------------------------------------------------------ text-based editing (sequence transcript)
const FILLERS = new Set(['euh', 'euhh', 'euuh', 'heu', 'heuu', 'hum', 'humm', 'hmm', 'hm', 'mmh', 'bah', 'beh', 'ben', 'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ehm', 'ah', 'eh', 'ehh']);
export const isFiller = (text) => FILLERS.has(normWord(text));

/** Words spoken on the timeline (timeline seconds) with filler flags — for the transcript panel. */
export function sequenceTranscript() {
  const p = store.requireOpen();
  return timelineWords(p).map((w) => ({ text: w.text, start: w.start, end: w.end, clipId: w.clipId, ...(isFiller(w.text) ? { filler: true } : {}) }));
}

/** Timeline range covering words [i0..i1], extended over the micro-pauses around them. */
function wordsRange(words, i0, i1) {
  const a = words[i0], b = words[i1];
  const prev = words[i0 - 1], next = words[i1 + 1];
  const start = prev && a.start - prev.end < 0.35 ? prev.end + 0.02 : a.start - 0.04;
  const end = next && next.start - b.end < 0.35 ? next.start - 0.02 : b.end + 0.04;
  return { start: r4(Math.max(0, start)), end: r4(Math.max(start + 0.02, end)) };
}

/** Delete spoken words from the edit (text-based editing): ranges of word indices of sequenceTranscript(). */
export function deleteWords(ranges, meta = {}) {
  const p = store.requireOpen();
  const words = timelineWords(p);
  const rs = ranges.map(([i0, i1]) => wordsRange(words, Math.max(0, Math.min(i0, i1)), Math.min(words.length - 1, Math.max(i0, i1))));
  return deleteTimeRanges(rs, meta);
}

function deleteTimeRanges(rs, meta) {
  rs.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const r of rs) { const l = merged[merged.length - 1]; if (l && r.start <= l.end + 0.01) l.end = Math.max(l.end, r.end); else merged.push({ ...r }); }
  if (!merged.length) return { rangesRemoved: 0, secondsRemoved: 0 };
  // music keeps playing continuously; voice, video, overlays, SFX, subtitles and markers stay in sync
  return rippleCut(merged, cutTracks(store.project), meta, meta.label || `cut ${merged.length} range(s)`).result;
}

/** Remove filler words ("euh", "um"…) from the whole edit. */
export function removeFillers(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const words = timelineWords(p);
  const extra = new Set((opts.extra || []).map(normWord));
  const rs = [];
  words.forEach((w, i) => { if (isFiller(w.text) || extra.has(normWord(w.text))) rs.push(wordsRange(words, i, i)); });
  if (!rs.length) return { removed: 0, message: 'No filler word found.' };
  const r = deleteTimeRanges(rs, { ...meta, label: `remove ${rs.length} filler words` });
  return { removed: rs.length, ...r };
}

// ------------------------------------------------------------------ dynamic zooms (talking head punch-ins)
/**
 * Punch-in zooms on the main video (V1) at the most emphasised words (score from text, timing and loudness).
 * opts: { amount (0.14 = +14 %), every (average seconds between zooms), style: 'cut' | 'smooth' }
 */
export function autoZooms(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const amount = Math.max(0.03, Math.min(0.6, opts.amount ?? 0.14));
  const every = Math.max(1.5, opts.every ?? 5);
  const smooth = opts.style === 'smooth';
  const words = timelineWords(p);
  if (!words.length) throw new Error('No transcribed speech on the timeline (analyze the media first).');
  attachWordEnergy(p, words);
  const scores = scoreWords(words);
  const dur = projectDuration(p);
  const target = Math.max(1, Math.round(dur / every));
  const minGap = Math.max(1.2, every * 0.55);
  const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
  const picked = [];
  for (const [, i] of order) {
    if (picked.length >= target) break;
    const t = words[i].start;
    if (picked.every((j) => Math.abs(words[j].start - t) >= minGap)) picked.push(i);
  }
  picked.sort((a, b) => words[a].start - words[b].start);
  const v1 = p.tracks.find((t) => t.type === 'video');
  const byClip = new Map();
  for (const i of picked) {
    const t = words[i].start;
    const c = p.clips.find((x) => x.trackId === v1.id && (x.type === 'video' || x.type === 'image') && t >= x.start + 0.15 && t < x.start + x.duration - 0.4);
    if (!c) continue;
    // zoom out at the next pause (end of the phrase), 0.8–3 s later
    let off = t + 2.2;
    for (let j = i; j < words.length - 1; j++) { if (words[j + 1].start - words[j].end > 0.45) { off = words[j].end + 0.1; break; } if (words[j].end - t > 3) { off = words[j].end; break; } }
    off = Math.min(Math.max(off, t + 0.8), t + 3, c.start + c.duration - 0.05);
    if (!byClip.has(c.id)) byClip.set(c.id, []);
    byClip.get(c.id).push([t - c.start, off - c.start]);
  }
  if (!byClip.size) throw new Error('No zoom could be placed (no video clip on V1 under the speech).');
  const { result } = store.transaction(`dynamic zooms (${picked.length})`, (draft, ctx) => {
    let n = 0;
    for (const [id, list] of byClip) {
      const c = clipById(draft, id);
      const s0 = c.scale ?? 1, s1 = r4(s0 * (1 + amount));
      const kf = [{ t: 0, v: s0, ease: 'hold' }];
      let last = 0;
      for (const [a, b] of list) {
        if (a < last + 0.3) continue;
        if (smooth) {
          kf.push({ t: r4(Math.max(last, a - 0.2)), v: s0, ease: 'ease-out' }, { t: r4(a), v: s1, ease: 'hold' }, { t: r4(Math.max(a + 0.3, b - 0.3)), v: s1, ease: 'ease-in-out' }, { t: r4(b), v: s0, ease: 'hold' });
        } else {
          kf.push({ t: r4(a), v: s1, ease: 'hold' }, { t: r4(b), v: s0, ease: 'hold' });
        }
        last = b;
        n++;
      }
      OPS.setKeyframes(draft, { id, property: 'scale', keyframes: kf }, ctx);
    }
    return { zooms: n, clips: byClip.size };
  }, { ...meta, label: 'dynamic zooms' });
  return result;
}

// ------------------------------------------------------------------ freeze frame
/** Freeze the frame under the playhead for `duration` seconds (inserts time, optional zoom + shutter sound). */
export async function freezeFrame(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const t = r4(opts.time ?? uiState.playhead);
  const vids = p.tracks.filter((x) => x.type === 'video' && !x.hidden).reverse();
  let c = opts.clipId ? clipById(p, opts.clipId) : null;
  if (!c) for (const tr of vids) { c = p.clips.find((x) => x.trackId === tr.id && x.type === 'video' && t >= x.start && t < x.start + x.duration); if (c) break; }
  if (!c || c.type !== 'video') throw new Error('No video clip under the playhead (select one or move the playhead).');
  const m = mediaById(p, c.mediaId);
  const src = Math.max(0, Math.min((m.duration || 0) - 0.04, c.in + (t - c.start) * c.speed));
  const dir = path.join(store.dir, 'media', 'freeze');
  fs.mkdirSync(dir, { recursive: true });
  const out = uniquePath(path.join(dir, `${safeFileName(m.name.replace(/\.[^.]+$/, ''), 50)}_${Math.round(src * 1000)}.png`));
  const { extractFrame } = await import('./media/ingest.js');
  await extractFrame(m.path, src, out);
  const [img] = importPaths([out], { ...meta, sourceInfo: { kind: 'generated', title: `Freeze ${m.name} @${src.toFixed(2)}s` } });
  const ready = await waitForProbe(img.id, 30000);
  if (!ready) throw new Error('Could not read the extracted frame.');
  const d = Math.max(0.2, opts.duration ?? 1.5);
  const sfx = opts.sfx !== false ? await ensureSfxMedia('camera-shutter', meta) : null;
  // keep music running: do not split audio-only music/library tracks
  const keep = new Set(p.clips.filter((x) => x.start < t && x.start + x.duration > t && isMusicClip(p, x)).map((x) => x.trackId));
  const tracks = p.tracks.filter((x) => !x.locked && !keep.has(x.id)).map((x) => x.id);
  const { result } = store.transaction('freeze frame', (draft, ctx) => {
    OPS.insertGap(draft, { at: t, duration: d, tracks, shiftSubtitles: true }, ctx);
    const still = OPS.addClip(draft, {
      mediaId: ready.id, start: t, duration: d, track: c.trackId, name: `Arrêt sur image`,
      x: c.x, y: c.y, scale: c.scale, rotation: c.rotation, fit: c.fit, crop: c.crop, color: c.color, flipH: c.flipH, flipV: c.flipV,
      radius: c.radius, border: c.border, shadow: c.shadow, anim: opts.zoom !== false ? { loop: { type: 'kenburns-in', amount: 1.4 } } : null,
    }, ctx);
    if (sfx) {
      const tr = draft.tracks.find((x) => x.type === 'audio' && /^SFX/.test(x.name)) || OPS.addTrack(draft, { type: 'audio', name: 'SFX' }, ctx);
      OPS.addClip(draft, { mediaId: sfx.id, start: t, track: tr.id, mode: 'auto', volume: 0.7, label: 'sfx', name: 'Shutter' }, ctx);
    }
    return still;
  }, meta);
  return { clip: result.id, time: t, duration: d };
}

// ------------------------------------------------------------------ beat markers
/** Markers on the beats (or downbeats) of a music clip, to cut on the rhythm with snapping. */
export async function beatMarkers(opts = {}, meta = {}) {
  const p = store.requireOpen();
  let c = opts.clipId ? clipById(p, opts.clipId) : null;
  if (!c) {
    // the music with the most screen time (all its pieces: split / looped clips of the same media)
    const byMedia = new Map();
    for (const x of p.clips.filter((y) => isMusicClip(p, y))) byMedia.set(x.mediaId, (byMedia.get(x.mediaId) || 0) + x.duration);
    const best = [...byMedia.entries()].sort((a1, b1) => b1[1] - a1[1])[0];
    c = best ? p.clips.find((x) => x.mediaId === best[0] && isMusicClip(p, x)) : null;
  }
  if (!c) throw new Error('No music clip on the timeline.');
  const pieces = p.clips.filter((x) => x.mediaId === c.mediaId && x.type === 'audio' && x.trackId === c.trackId);
  const { ensureBeats } = await import('./analysis/index.js');
  const a = { beats: await ensureBeats(c.mediaId, { timeoutSec: 120 }) }; // re-analyses beats of the old (late) version
  if (!a.beats) throw new Error('Could not detect a tempo in this music.');
  const every = Math.max(1, Math.round(opts.every || 1));
  const list = (opts.downbeats ? a.beats.downbeats : a.beats.beats).filter((_, i) => i % every === 0);
  const down = new Set(a.beats.downbeats.map((x) => Math.round(x * 1000)));
  const times = [];
  for (const pc of opts.clipId ? [c] : pieces) {
    for (const b of list) {
      const t = r4(pc.start + (b - pc.in) / pc.speed);
      if (t >= pc.start - 1e-3 && t < pc.start + pc.duration - 1e-3) times.push({ t, down: down.has(Math.round(b * 1000)) });
    }
  }
  times.sort((x, y) => x.t - y.t);
  const { result } = store.transaction(`beat markers (${times.length})`, (draft, ctx) => {
    draft.markers = draft.markers.filter((m) => m.label !== 'beat' && m.label !== 'downbeat');
    for (const x of times) OPS.addMarker(draft, { time: x.t, label: x.down ? 'downbeat' : 'beat', color: x.down ? '#d9a13b' : '#3a8ee6' }, ctx);
    return { markers: times.length, bpm: a.beats.bpm };
  }, meta);
  return result;
}

// ------------------------------------------------------------------ chapters
/** YouTube chapters (description text) from the timeline markers. */
export function youtubeChapters() {
  const p = store.requireOpen();
  const ms = p.markers.filter((m) => m.label !== 'beat' && m.label !== 'downbeat').sort((a, b) => a.time - b.time);
  const fmt = (t) => { t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`; };
  const rows = [];
  if (!ms.length || ms[0].time > 0.5) rows.push({ t: 0, label: 'Intro' });
  ms.forEach((m, i) => rows.push({ t: m.time, label: m.label || `Chapitre ${i + 1}` }));
  const warnings = [];
  if (rows.length < 3) warnings.push('YouTube needs at least 3 chapters.');
  for (let i = 1; i < rows.length; i++) if (rows[i].t - rows[i - 1].t < 10) { warnings.push('Each chapter must last at least 10 s.'); break; }
  return { text: rows.map((r) => `${fmt(r.t)} ${r.label}`).join('\n'), chapters: rows.length, warnings };
}

// ------------------------------------------------------------------ bulk helpers & recipes
/** Animate every B-roll (images / videos on V2+). opts: { in, out, imageLoop, videoLoop, radius, shadow } */
export function animateBroll(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const vids = p.tracks.filter((t) => t.type === 'video');
  const clips = p.clips.filter((c) => (c.type === 'image' || c.type === 'video') && vids.findIndex((t) => t.id === c.trackId) > 0 && c.label !== 'blur-fill' && c.label !== 'meme' && !c.chromaKey && mediaById(p, c.mediaId)?.source?.kind !== 'meme');
  if (!clips.length) throw new Error('No B-roll (image/video on V2 or above).');
  const { result } = store.transaction(`animate ${clips.length} b-roll`, (draft, ctx) => {
    // pieces of one shot (split by a cut) touching on the same track animate as one: entrance on the first, exit on the last
    const touching = (a, b) => a.trackId === b.trackId && a.mediaId === b.mediaId && Math.abs(a.start + a.duration - b.start) < 0.02;
    for (const c of clips) {
      const loop = c.type === 'image' ? opts.imageLoop : opts.videoLoop;
      const hasPrev = clips.some((o) => o !== c && touching(o, c));
      const hasNext = clips.some((o) => o !== c && touching(c, o));
      OPS.setAnimation(draft, { ids: [c.id], in: hasPrev ? 'none' : opts.in ?? 'pop', out: hasNext ? 'none' : opts.out ?? 'fade', ...(loop !== undefined ? { loop: loop || 'none' } : {}) }, ctx);
      if (opts.radius !== undefined || opts.shadow) OPS.setFrameLook(draft, { ids: [c.id], ...(opts.radius !== undefined ? { radius: opts.radius } : {}), ...(opts.shadow ? { shadow: {} } : {}) }, ctx);
    }
    return { clips: clips.length };
  }, meta);
  return result;
}

/** Voice effect on every clip that contains speech. */
export function enhanceVoices(preset = 'voice', meta = {}) {
  const p = store.requireOpen();
  const items = p.clips.filter((c) => (c.type === 'audio' || c.type === 'video') && !c.muted && c.label !== 'meme' && mediaById(p, c.mediaId)?.source?.kind !== 'meme' && loadAnalysis(c.mediaId).transcript?.wordCount > 0).map((c) => ({ id: c.id, audioFx: preset ? { preset } : null }));
  if (!items.length) throw new Error('No speech clip found (analyze the media first).');
  store.apply('updateClips', { items }, { ...meta, label: `voice ${preset || 'off'}` });
  return { clips: items.length, preset };
}

export const RECIPES = {
  short: { label: 'Short viral', en: 'Viral short' },
  podcast: { label: 'Podcast / interview', en: 'Podcast / interview' },
  vlog: { label: 'Vlog', en: 'Vlog' },
  cinematic: { label: 'Cinématique', en: 'Cinematic' },
};

/** One-click edit styles: chains the automatic tools (each step is its own undo step; failures are reported, not fatal). */
export async function applyRecipe(id, meta = {}) {
  const p = store.requireOpen();
  if (!RECIPES[id]) throw new Error(`Unknown recipe ${id}. Use: ${Object.keys(RECIPES).join(', ')}`);
  const done = [], skipped = [];
  const step = async (label, fn) => {
    try { await fn(); done.push(label); } catch (e) { skipped.push(`${label} — ${e.message}`); }
  };
  const hasSpeech = () => timelineWords(store.project).length > 0;
  if (id === 'short') {
    await step('silences', () => removeSilences({}, meta));
    await step('fillers', () => removeFillers({}, meta));
    await step('subtitles', () => { if (!hasSpeech()) throw new Error('no speech'); return generateSubtitles({ preset: 'keywords-pop', maxWords: 3 }, meta); });
    await step('zooms', () => autoZooms({ style: 'cut', every: 4, amount: 0.15 }, meta));
    await step('b-roll', () => animateBroll({ in: 'pop', out: 'fade', imageLoop: 'living', radius: 32, shadow: true }, meta));
    await step('sfx', () => autoSfx({ keywords: true }, meta));
    await step('ducking', () => duckMusic({}, meta));
  } else if (id === 'podcast') {
    await step('silences', () => removeSilences({}, meta));
    await step('fillers', () => removeFillers({}, meta));
    await step('voice', () => enhanceVoices('podcast', meta));
    await step('subtitles', () => { if (!hasSpeech()) throw new Error('no speech'); return generateSubtitles({ preset: 'podcast' }, meta); });
    await step('loudness', () => store.apply('setProjectSettings', { normalizeLoudness: true }, { ...meta, label: 'loudness' }));
    await step('ducking', () => duckMusic({ amountDb: -16 }, meta));
  } else if (id === 'vlog') {
    await step('subtitles', () => { if (!hasSpeech()) throw new Error('no speech'); return generateSubtitles({ preset: 'emphasis' }, meta); });
    await step('b-roll', () => animateBroll({ in: 'fade-scale', out: 'fade', imageLoop: 'cloud' }, meta));
    await step('voice', () => enhanceVoices('voice', meta));
    await step('sfx', () => autoSfx({ titles: true, broll: true, transitions: true, volume: 0.45 }, meta));
    await step('ducking', () => duckMusic({}, meta));
  } else if (id === 'cinematic') {
    const total = projectDuration(p);
    await step('grade', () => {
      const items = store.project.clips.filter((c) => c.type === 'video' || c.type === 'image').map((c) => ({ id: c.id, color: { contrast: 1.12, saturation: 0.86, brightness: 0.97 }, vignette: Math.max(c.vignette || 0, 0.25) }));
      if (!items.length) throw new Error('no clip');
      store.apply('updateClips', { items }, { ...meta, label: 'cinematic grade' });
    });
    await step('letterbox', () => { if (!(total > 0)) throw new Error('empty timeline'); return store.apply('addClip', { template: 'letterbox', start: 0, duration: total, track: 'new', params: { ratio: 2.39 } }, { ...meta, label: 'letterbox' }); });
    await step('stills', () => animateBroll({ in: 'fade', out: 'fade', imageLoop: 'kenburns-in', videoLoop: '' }, meta));
    await step('transitions', () => {
      const v1 = store.project.tracks.find((t) => t.type === 'video');
      const clips = store.project.clips.filter((c) => c.trackId === v1.id).sort((a, b) => a.start - b.start).slice(1);
      if (!clips.length) throw new Error('single clip');
      store.apply('updateClips', { items: clips.map((c) => ({ id: c.id, transition: { type: 'fade', duration: 0.6 } })) }, { ...meta, label: 'cross dissolves' });
    });
    await step('subtitles', () => { if (!hasSpeech()) throw new Error('no speech'); return generateSubtitles({ preset: 'cinematic' }, meta); });
    await step('ducking', () => duckMusic({}, meta));
  }
  return { recipe: id, done, skipped };
}

// ------------------------------------------------------------------ stickers & memes
/** Copy a sticker of the bundled pack into the project media folder and import it (animated Lottie or 3D PNG). */
async function stickerMedia(s, animated, meta) {
  const rel = animated ? s.lottie : s.png;
  const dir = path.join(store.dir, 'media', 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${s.id}${path.extname(rel)}`);
  if (!exists(file)) fs.copyFileSync(packPath(rel), file);
  const lic = packManifest().stickerLicenses?.[animated ? 'lottie' : 'png'] || {};
  const [m] = importPaths([file], {
    ...meta, name: `${s.glyph} ${s.fr}`,
    sourceInfo: { kind: 'library', provider: animated ? 'noto-emoji' : 'fluent-emoji', title: s.en, license: lic.license, licenseUrl: lic.url, attributionRequired: animated, attribution: animated ? lic.attribution : null },
  });
  return (await waitForProbe(m.id, 20000)) || m;
}

/** Clip args placing a sticker media: size = fraction of the frame's short side, position preset or explicit x/y (px from centre). */
function stickerClipArgs(p, media, { start, duration = 2, position = 'center', size = 0.3, x, y, anim, track = 'overlay', name } = {}) {
  const { width: W, height: H } = p.settings;
  const side = Math.max(0.03, Math.min(1.5, size)) * Math.min(W, H);
  const off = stickerOffset(position, side, W, H);
  const animated = media.type === 'lottie';
  return {
    mediaId: media.id, start: r4(Math.max(0, start)), duration: Math.max(0.2, duration), track, mode: 'auto', name,
    scale: r4(Math.max(0.03, Math.min(1.5, size))), x: x ?? off.x, y: y ?? off.y, fit: 'contain',
    anim: anim === null ? null : { in: 'pop', out: 'pop', ...(animated ? {} : { loop: 'float' }), ...(anim || {}) },
    ...(animated ? { params: { loop: true } } : {}),
  };
}

/**
 * Add an emoji sticker from the bundled pack (animated by default when available).
 * opts: { start, duration, position, size, x, y, animated, anim, track }
 */
export async function addSticker(id, opts = {}, meta = {}) {
  const p = store.requireOpen();
  const s = stickerById(id);
  if (!s) throw new Error(`Unknown sticker "${id}" (use search_stickers)`);
  const animated = opts.animated !== false && !!s.lottie;
  if (!animated && !s.png) throw new Error(`Sticker ${s.id} has no still image`);
  const media = await stickerMedia(s, animated, meta);
  const args = stickerClipArgs(p, media, { ...opts, start: opts.start ?? uiState.playhead, name: `${s.glyph} ${s.fr}` });
  const { result, warnings } = store.apply('addClip', args, { ...meta, label: `sticker ${s.glyph}` });
  return { clip: result.id, sticker: s.id, glyph: s.glyph, animated, start: result.start, duration: result.duration, warnings };
}

export function searchStickersSvc(opts = {}) {
  return searchStickers(opts).map((s) => ({ id: s.id, glyph: s.glyph, name: s.fr, en: s.en, category: s.catFr, animated: !!s.lottie, image: !!s.png, png: s.png ? packPath(s.png) : null }));
}

// ------------------------------------------------------------------ meme bank (internet memes)
export async function searchMemeBank({ kind = 'sound', query = '', page = 1, category = '' } = {}) {
  if (kind === 'image') return rememberItems(await memeImages({ query }));
  if (kind === 'gif') return rememberItems(await memeGifs({ query }));
  if (kind === 'video') return rememberItems(await memeScreens({ query, category }));
  if (kind === 'youtube') {
    const q = String(query).trim() || 'meme';
    const list = await searchYoutube(/green\s*screen|fond vert|chroma/i.test(q) ? q : `${q} green screen`, { limit: 16 });
    return list.filter((v) => !v.duration || v.duration <= 90).map((v) => ({ ...v, kind: 'meme-video', source: 'YouTube' }));
  }
  return rememberItems(await memeSounds({ query, page }));
}

/** A meme image of the bank on an overlay track: full frame cut-away (default) or picture-in-picture. */
export async function addMemeImage(id, opts = {}, meta = {}) {
  const p = store.requireOpen();
  const { file: cached, item } = await memeFile(id);
  const dir = path.join(store.dir, 'media', 'memes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(item.title, 60)}${path.extname(cached)}`);
  if (!exists(file)) fs.copyFileSync(cached, file);
  const [m0] = importPaths([file], { ...meta, name: item.title, sourceInfo: { kind: 'meme', provider: 'imgflip', title: item.title, license: 'Mème (droits non vérifiés)', attributionRequired: false, url: item.landing } });
  const m = (await waitForProbe(m0.id, 30000)) || m0;
  const start = r4(Math.max(0, opts.start ?? uiState.playhead));
  const full = opts.mode !== 'pip' && opts.size === undefined;
  const isVideo = m.type === 'video';
  const dur = isVideo ? Math.min(m.duration || 3, opts.duration ?? (m.duration || 3)) : opts.duration ?? 2;
  const args = full
    ? { mediaId: m.id, start, duration: dur, track: 'overlay', mode: 'auto', fit: 'contain', anim: { in: isVideo ? 'pop' : 'zoom-in', out: 'fade', ...(isVideo ? {} : { loop: 'kenburns-in' }) }, name: item.title, label: 'meme' }
    : { ...stickerClipArgs(p, m, { start, duration: opts.duration ?? 2, position: opts.position || 'center', size: opts.size ?? 0.45, name: item.title }), radius: 18, shadow: { blur: 40, y: 14, opacity: 0.45 }, label: 'meme' };
  const { result, warnings } = store.apply('addClip', args, { ...meta, label: `meme ${item.title}` });
  return { clip: result.id, meme: item.title, start: result.start, duration: result.duration, warnings };
}

/** A green-screen meme video of the bank (memescreens) placed keyed out (transparent green) on an overlay track. */
export async function addMemeVideo(id, opts = {}, meta = {}) {
  const p = store.requireOpen();
  const { file: cached, item } = await memeFile(id);
  const dir = path.join(store.dir, 'media', 'memes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(item.title, 60)}${path.extname(cached)}`);
  if (!exists(file)) fs.copyFileSync(cached, file);
  const [m0] = importPaths([file], { ...meta, name: item.title, sourceInfo: { kind: 'meme', provider: 'memescreens', title: item.title, license: 'Mème (droits non vérifiés)', attributionRequired: false, url: item.landing } });
  const m = await waitForProbe(m0.id, 60000);
  if (!m || m.status === 'error') throw new Error(`${tr('Vidéo illisible', 'Unreadable video')} : ${m?.error || item.title}`);
  const start = r4(Math.max(0, opts.start ?? uiState.playhead));
  const { width: W, height: H } = p.settings;
  const args = {
    mediaId: m.id, start, track: 'overlay', mode: 'auto', fit: 'contain', name: item.title, label: 'meme', anim: null, radius: 0, shadow: null, border: null,
    ...(opts.duration ? { duration: Math.min(opts.duration, m.duration) } : {}),
    ...(opts.keyed === false ? {} : { chromaKey: { color: 'green', strength: 6, threshold: 0.1, despill: 0.6 } }),
    ...(opts.size ? { scale: opts.size, ...stickerOffset(opts.position || 'center', opts.size * Math.min(W, H), W, H) } : {}),
  };
  const { result, warnings } = store.apply('addClip', args, { ...meta, label: `meme ${item.title}` });
  return { clip: result.id, meme: item.title, start: result.start, duration: result.duration, warnings };
}

/** Download a green-screen meme video (YouTube) and place it keyed out at `start` (background job). */
export function addGreenScreenMeme(url, opts = {}, meta = {}) {
  store.requireOpen();
  const start = r4(Math.max(0, opts.start ?? uiState.playhead));
  return youtubeDownloadJob(url, {
    mode: 'video', maxHeight: 720,
    place: { start, track: 'overlay', mode: 'auto', chromaKey: { color: 'green', strength: 6, threshold: 0.1, despill: 0.6 }, label: 'meme', ...(opts.duration ? { duration: opts.duration } : {}) },
  }, meta);
}

/** A meme sound of the bank (MyInstants) imported as project media. */
async function ensureMemeSoundMedia(id, meta = {}) {
  const { file, item, sourceInfo } = await downloadLibraryItem(id);
  const [m] = importPaths([file], { ...meta, sourceInfo, name: item.title });
  const ready = await waitForProbe(m.id, 30000);
  return ready?.duration > 0 ? ready : null;
}

/** Zoom keyframes on the main visual clip under timeline time t (punch = instant, slow = progressive). */
function memeZoom(draft, ctx, t, z) {
  const v1 = draft.tracks.find((x) => x.type === 'video');
  const c = draft.clips.find((x) => x.trackId === v1?.id && (x.type === 'video' || x.type === 'image') && t >= x.start && t < x.start + x.duration - 0.05);
  if (!c) return false;
  const lt = r4(t - c.start), end = r4(Math.min(c.duration, lt + z.dur));
  const kfs = (c.keyframes?.scale || [{ t: 0, v: c.scale ?? 1, ease: 'hold' }]).map((k) => ({ ...k }));
  const valueAt = (tt) => evalKeyframes(kfs, tt, c.scale ?? 1);
  const before = valueAt(lt), after = valueAt(end);
  const keep = kfs.filter((k) => k.t < lt - 1e-3 || k.t > end + 1e-3);
  const add = z.style === 'slow'
    ? [{ t: lt, v: before, ease: 'ease-in-out' }, { t: r4(Math.max(lt + 0.05, end - 0.02)), v: r4(before * (1 + z.amount)), ease: 'hold' }, { t: end, v: after, ease: 'hold' }]
    : [{ t: lt, v: r4(before * (1 + z.amount)), ease: 'hold' }, { t: end, v: after, ease: 'hold' }];
  OPS.setKeyframes(draft, { id: c.id, property: 'scale', keyframes: [...keep, ...add].sort((a, b) => a.t - b.t) }, ctx);
  return true;
}

/** Apply a one-click meme combo (sound + sticker + effect) at `time` (default: playhead). */
export async function applyMeme(id, opts = {}, meta = {}) {
  const p = store.requireOpen();
  const def = MEMES.find((m) => m.id === id);
  if (!def) throw new Error(`Unknown meme ${id}. Available: ${MEMES.map((m) => m.id).join(', ')}`);
  const t = r4(Math.max(0, opts.time ?? uiState.playhead));
  const done = [];
  if (def.freeze) {
    try { await freezeFrame({ time: t, duration: def.freeze.dur, sfx: false, zoom: true }, meta); done.push('freeze'); } catch (e) { done.push(`freeze skipped: ${e.message}`); }
  }
  let sfx = null;
  for (const sid of def.sfx || []) {
    try { sfx = String(sid).startsWith('myinstants:') ? await ensureMemeSoundMedia(sid, meta) : await ensureSfxMedia(sid, meta); if (sfx) break; } catch { /* next candidate */ }
  }
  const sticker = def.sticker ? stickerById(def.sticker.glyph) : null;
  const stMedia = sticker ? await stickerMedia(sticker, !!sticker.lottie, meta).catch(() => null) : null;
  const { result } = store.transaction(`meme ${def.fr}`, (draft, ctx) => {
    const added = [];
    if (sfx) {
      const tr = draft.tracks.find((x) => x.type === 'audio' && /^SFX/.test(x.name) && !draft.clips.some((c) => c.trackId === x.id && c.start < t + 1 && c.start + c.duration > t)) || OPS.addTrack(draft, { type: 'audio', name: draft.tracks.some((x) => /^SFX/.test(x.name)) ? `SFX ${draft.tracks.filter((x) => /^SFX/.test(x.name)).length + 1}` : 'SFX' }, ctx);
      const c = OPS.addClip(draft, { mediaId: sfx.id, start: t, track: tr.id, volume: 0.85, label: 'meme', name: sfx.name, ...(def.sfxDur && sfx.duration > def.sfxDur ? { duration: def.sfxDur, fadeOut: 0.4 } : {}) }, ctx);
      added.push(c.id);
    }
    if (def.zoom && memeZoom(draft, ctx, t, def.zoom)) added.push('zoom');
    if (def.flash) added.push(OPS.addClip(draft, { template: 'flash', start: t, duration: def.flash.dur, track: 'overlay', mode: 'auto', label: 'meme' }, ctx).id);
    if (def.confetti) added.push(OPS.addClip(draft, { template: 'confetti', start: t, duration: def.confetti.dur, track: 'overlay', mode: 'auto', label: 'meme' }, ctx).id);
    if (stMedia) {
      const a = stickerClipArgs(draft, stMedia, { start: t + (def.flash ? 0.05 : 0), duration: def.sticker.dur, position: def.sticker.pos, size: def.sticker.size, name: `${sticker.glyph} ${sticker.fr}` });
      added.push(OPS.addClip(draft, { ...a, label: 'meme' }, ctx).id);
    }
    return added;
  }, { ...meta, label: `meme ${def.fr}` });
  return { meme: id, time: t, added: result, steps: done };
}

// ------------------------------------------------------------------ automatic sound design
const SFX_FOR_IN = {
  pop: 'pop', 'bounce-in': 'boing', elastic: 'boing', 'zoom-in': 'zoom-in-whoosh', 'zoom-out': 'zoom-out-whoosh', 'zoom-blur': 'zoom-in-whoosh',
  'slide-left': 'whoosh-fast', 'slide-right': 'whoosh-fast', 'slide-up': 'whoosh-fast', 'slide-down': 'whoosh-fast',
  'slide-blur-left': 'whoosh-fast', 'slide-blur-right': 'whoosh-fast', whip: 'sword-swing', peek: 'swipe', drop: 'thud', spin: 'swoosh-rise',
  swing: 'whoosh-soft', tilt: 'whoosh-soft', 'flip-h': 'swipe', 'flip-v': 'swipe', unfold: 'swipe', stretch: 'boing', 'shake-in': 'hit-punch',
  glitch: 'glitch', blur: 'whoosh-soft', rise: 'whoosh-soft', fade: null, 'fade-scale': null,
};
const SFX_FOR_TEMPLATE = { text: 'pop', 'lower-third': 'whoosh-soft', social: 'pop-high', callout: 'pop', data: 'tick', fx: 'sparkle', transition: 'whoosh-fast', frame: null, other: 'pop', user: 'whoosh-soft' };
// offset of the "peak" of each sound (seconds after its start), so the peak lands on the event
const SFX_PEAK = { 'whoosh-fast': 0.2, 'whoosh-soft': 0.45, 'zoom-in-whoosh': 0.5, 'zoom-out-whoosh': 0.12, 'sword-swing': 0.16, 'swoosh-rise': 0.55, swipe: 0.1 };

/**
 * Add sound effects automatically: whoosh on transitions, B-roll entrances matched to their animation, pops on titles,
 * a soft pop on each keyword flash (subtitles "keywords" mode). Previous automatic SFX (label "auto-sfx") are replaced.
 * opts: { transitions, broll, titles, keywords, volume }
 */
export async function autoSfx(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const vol = Math.max(0.05, Math.min(2, opts.volume ?? 0.6));
  const events = [];
  const vids = p.tracks.filter((t) => t.type === 'video');
  const { templates } = await import('./render/html.js').then((m) => ({ templates: m.motionTemplates() }));
  for (const c of p.clips) {
    if (c.type === 'audio' || c.label === 'auto-sfx') continue;
    const ti = vids.findIndex((t) => t.id === c.trackId);
    if (opts.transitions !== false && c.transition) events.push({ t: c.start, sfx: c.transition.type.startsWith('fade') ? 'whoosh-soft' : 'whoosh-fast', v: 0.7 });
    if (c.type === 'html') {
      if (opts.titles === false) continue;
      const cat = templates.find((x) => x.id === c.html?.template)?.category || 'other';
      const s = SFX_FOR_TEMPLATE[cat];
      if (s) events.push({ t: c.start + (c.anim?.in ? 0 : 0.05), sfx: s, v: 0.6 });
      continue;
    }
    if (opts.broll !== false && ti > 0 && (c.type === 'image' || c.type === 'video')) {
      const inType = c.anim?.in?.type;
      const s = inType ? SFX_FOR_IN[inType] : 'whoosh-soft';
      if (s) events.push({ t: c.start, sfx: s, v: inType ? 0.75 : 0.45 });
      const outType = c.anim?.out?.type;
      if (outType && /slide|whip/.test(outType)) events.push({ t: c.start + c.duration - (c.anim.out.duration || 0.4) * 0.5, sfx: 'swipe', v: 0.4 });
    }
  }
  if (opts.keywords && p.subtitles.cues.length) {
    const { displayCues, resolveSubtitleStyle: rs } = await import('../shared/subtitles.js');
    const st = rs({ ...p.subtitles.style, mode: 'keywords' });
    for (const g of displayCues(p.subtitles.cues, st)) events.push({ t: g.start, sfx: /\d/.test(g.text) ? 'cash-register' : 'pop', v: 0.35, kw: true });
  }
  // de-duplicate (keep the first sound within 0.25 s); keyword pops stay sparse (one every 3 s at most)
  events.sort((a, b) => a.t - b.t);
  const kept = [];
  let lastKw = -Infinity;
  for (const e of events) {
    if (e.kw && e.t - lastKw < 3) continue;
    if (!kept.length || e.t - kept[kept.length - 1].t > 0.25) { kept.push(e); if (e.kw) lastKw = e.t; }
  }
  // make the needed sounds available as project media (stable files → imported once)
  const ids = [...new Set(kept.map((e) => e.sfx))];
  const mediaFor = new Map();
  for (const id of ids) {
    const ready = await ensureSfxMedia(id, meta);
    if (ready) mediaFor.set(id, ready);
  }
  const { result, warnings } = store.transaction(`auto sound design (${kept.length})`, (draft, ctx) => {
    draft.clips = draft.clips.filter((c) => c.label !== 'auto-sfx');
    let added = 0;
    for (const e of kept) {
      const m = mediaFor.get(e.sfx);
      if (!m) continue;
      const start = r4(Math.max(0, e.t - (SFX_PEAK[e.sfx] || 0)));
      const end = start + m.duration;
      let track = draft.tracks.find((t) => t.type === 'audio' && /^SFX/.test(t.name) && !draft.clips.some((c) => c.trackId === t.id && c.start < end - 1e-3 && c.start + c.duration > start + 1e-3));
      if (!track) track = OPS.addTrack(draft, { type: 'audio', name: `SFX${draft.tracks.filter((t) => /^SFX/.test(t.name)).length ? ` ${draft.tracks.filter((t) => /^SFX/.test(t.name)).length + 1}` : ''}` }, ctx);
      OPS.addClip(draft, { mediaId: m.id, start, track: track.id, volume: r4(vol * e.v), label: 'auto-sfx', name: m.name }, ctx);
      added++;
    }
    return { added, events: kept.length };
  }, meta);
  return { ...result, warnings };
}

// ------------------------------------------------------------------ visuals for the AI
export async function renderFrames(times, { width = 960, subtitles = true, grid = false } = {}) {
  const p = store.requireOpen();
  if (!p.clips.length) throw new Error('The timeline is empty.');
  const dir = store.cacheDir('render', 'frames');
  const snapshot = structuredClone(p);
  const frames = [];
  for (const t of times.slice(0, 16)) {
    const out = path.join(dir, `tl_${Date.now()}_${Math.round(t * 1000)}.jpg`);
    await renderTimelineFrame(snapshot, store.dir, Number(t), { out, width: times.length > 1 ? Math.min(width, 640) : width, subtitles });
    frames.push({ time: Number(t), path: out });
  }
  if (frames.length === 1) {
    if (grid) await drawGrid(frames[0].path);
    return { image: frames[0].path, frames };
  }
  const sheet = await contactSheet(frames.map((f) => ({ ...f, label: `timeline ${fmtTime(f.time)}` })), path.join(dir, `sheet_${Date.now()}.jpg`), { cols: frames.length <= 4 ? 2 : frames.length <= 9 ? 3 : 4, cellWidth: 400, title: `${p.name} — composed timeline frames` });
  return { image: sheet.path, frames };
}

/** Labelled 10×10 grid of frame fractions over an image (helps an AI measure boxes / positions). */
async function drawGrid(file) {
  const tmp = file.replace(/\.(\w+)$/, '_grid.$1');
  const labels = [];
  for (let i = 1; i < 10; i++) {
    labels.push(`drawtext=text='${i / 10}':x=w*${i / 10}+3:y=3:fontsize=h/40:fontcolor=yellow:box=1:boxcolor=black@0.5`);
    labels.push(`drawtext=text='${i / 10}':x=3:y=h*${i / 10}+3:fontsize=h/40:fontcolor=yellow:box=1:boxcolor=black@0.5`);
  }
  await runFfmpeg(['-y', '-i', file, '-vf', ['drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.55', ...labels].join(','), '-q:v', '3', tmp], { quiet: true });
  fs.renameSync(tmp, file);
}

export async function viewMediaFrames(mediaId, { start = 0, end = null, count = 12, times = null, cols = null, width = 360 } = {}) {
  const p = store.requireOpen();
  const m = mediaById(p, mediaId);
  if (!m) throw new Error(`Unknown media ${mediaId}`);
  if (m.type === 'audio') throw new Error('This media is audio-only.');
  await waitForProbe(mediaId);
  const dur = m.type === 'image' ? 0 : m.duration;
  const e = Math.min(end ?? dur, dur);
  const ts = m.type === 'image' ? [0] : (times?.length ? times : sampleTimes(Math.max(0, start), e, Math.max(1, Math.min(36, count))));
  const frames = await extractFrames(m.path, ts, analysisDirFor(mediaId), { width: Math.max(320, width * 1.5 | 0) });
  const c = cols || (frames.length <= 4 ? 2 : frames.length <= 9 ? 3 : frames.length <= 16 ? 4 : 6);
  const sheet = await contactSheet(frames, path.join(analysisDirFor(mediaId), `sheet_${Date.now()}.jpg`), { cols: c, cellWidth: width, title: `${m.name} — source frames (${fmtTime(ts[0])} → ${fmtTime(ts[ts.length - 1])})` });
  return { image: sheet.path, times: ts };
}

export async function previewMotion(clipId, { times = null } = {}) {
  const p = store.requireOpen();
  const c = clipById(p, clipId);
  if (!c || c.type !== 'html') throw new Error('preview_motion needs an html/motion clip id');
  const ts = times?.length ? times : sampleTimes(0, c.duration, 6);
  const dir = store.cacheDir('render', 'motion');
  const frames = [];
  let errors = [];
  const { width: W, height: H } = p.settings;
  const token = uid('doc', 10);
  const url = registerRenderDoc(token, composeHtmlClip(c, p, { mode: 'render' }));
  try {
    for (const t of ts.slice(0, 12)) {
      const png = path.join(dir, `m_${c.id}_${Date.now()}_${Math.round(t * 1000)}.png`);
      const r = await renderHtmlFrame({ url, width: W, height: H, time: t, out: png });
      if (r.errors?.length) errors = r.errors;
      frames.push({ time: t, path: png, label: `local ${t.toFixed(2)}s` });
    }
  } finally { unregisterRenderDoc(token); }
  const sheet = await contactSheet(frames, path.join(dir, `msheet_${Date.now()}.jpg`), { cols: frames.length <= 4 ? 2 : 3, cellWidth: 420, title: `Motion "${c.name}" alone (transparent shown as dark)` });
  return { image: sheet.path, times: ts, errors };
}

// ------------------------------------------------------------------ audio library / youtube / tts
async function placeImported(media, place, meta) {
  if (!place) return null;
  const m = await waitForProbe(media.id, 120000);
  if (!m || m.status === 'error') throw new Error(`Imported file is not readable: ${m?.error || ''}`);
  const args = { mediaId: m.id, ...place };
  if (place.loop && place.duration && m.duration && place.duration > m.duration) {
    // loop music: add consecutive copies
    const items = [];
    let t = place.start ?? 0, left = place.duration;
    while (left > 0.05) {
      const d = Math.min(left, m.duration);
      items.push({ mediaId: m.id, start: t, duration: d, track: place.track, volume: place.volume, fadeIn: items.length === 0 ? place.fadeIn : 0 });
      t += d; left -= d;
    }
    if (items.length) items[items.length - 1].fadeOut = place.fadeOut;
    const track = place.track || 'auto';
    const { result, warnings } = store.transaction('add looped audio', (draft, ctx) => {
      const first = OPS.addClip(draft, { ...items[0], track }, ctx);
      const out = [first];
      for (const it of items.slice(1)) out.push(OPS.addClip(draft, { ...it, track: first.trackId }, ctx));
      return out;
    }, meta);
    return { clips: result, warnings };
  }
  delete args.loop;
  const { result, warnings } = store.apply('addClip', args, { ...meta, label: `add ${m.name}` });
  return { clips: [result], warnings };
}

export async function addLibraryAudio(id, place = null, meta = {}) {
  store.requireOpen();
  const { file, item, sourceInfo } = await downloadLibraryItem(id);
  const [media] = importPaths([file], { ...meta, sourceInfo, name: item.title });
  const placed = await placeImported(media, place, meta);
  return { media: { id: media.id, name: media.name }, item: { title: item.title, license: item.license, attributionRequired: item.attributionRequired }, placed };
}

export function addLibraryAudioJob(id, place, meta) {
  if (isLocalLibraryId(id)) return null;
  return jobs.create('download', `${tr('Téléchargement', 'Download')} ${id}`, async (ctx) => {
    ctx.progress(0.1, 'downloading');
    return addLibraryAudio(id, place, meta);
  }, { queue: 'download' });
}

export function youtubeDownloadJob(url, opts = {}, meta = {}) {
  store.requireOpen();
  const dir = path.join(store.dir, 'media', 'youtube');
  return jobs.create('download', `YouTube ${opts.mode || 'audio'}: ${url}`, async (ctx) => {
    ctx.progress(0.02, 'yt-dlp');
    const { file, info } = await downloadMedia(url, { ...opts, dir, signal: ctx.signal, onProgress: (p) => ctx.progress(0.05 + 0.9 * p, 'downloading') });
    const sourceInfo = {
      kind: 'youtube', url: info?.webpage_url || url, title: info?.title || null, author: info?.channel || info?.uploader || null,
      license: info?.license || 'Standard YouTube License (check rights)', attributionRequired: !!info?.license && /creative/i.test(info.license),
      section: opts.start != null || opts.end != null ? { start: opts.start ?? 0, end: opts.end ?? null } : null,
    };
    const [media] = importPaths([file], { ...meta, sourceInfo, name: info?.title ? `${info.title}${opts.mode === 'audio' ? ' (audio)' : ''}` : undefined });
    const placed = await placeImported(media, opts.place || null, meta);
    return { media: { id: media.id, name: media.name, path: file }, title: info?.title, license: sourceInfo.license, placed };
  }, { queue: 'download', meta: { url } });
}

export { videoInfo };

/** Windows SAPI / macOS say text-to-speech → WAV, imported into the project. */
export async function generateVoiceover(text, opts = {}, meta = {}) {
  store.requireOpen();
  const dir = path.join(store.dir, 'media', 'voiceover');
  fs.mkdirSync(dir, { recursive: true });
  const out = uniquePath(path.join(dir, `${safeFileName(text.slice(0, 40))}.wav`));
  const txtFile = path.join(tempDir(), `tts_${Date.now()}.txt`);
  fs.writeFileSync(txtFile, text, 'utf8');
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
        (opts.voice ? `try { $s.SelectVoice('${String(opts.voice).replace(/'/g, "''")}') } catch {};` : '') +
        `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(opts.rate ?? 0)))}; $s.SetOutputToWaveFile('${out.replace(/'/g, "''")}');` +
        `$s.Speak([IO.File]::ReadAllText('${txtFile.replace(/'/g, "''")}', [Text.Encoding]::UTF8)); $s.Dispose()`;
      await runProc('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    } else if (process.platform === 'darwin') {
      const aiff = out.replace(/\.wav$/, '.aiff');
      await runProc('say', [...(opts.voice ? ['-v', opts.voice] : []), '-o', aiff, '-f', txtFile]);
      const { runFfmpeg } = await import('./media/ffmpeg.js');
      await runFfmpeg(['-i', aiff, out]);
      fs.rmSync(aiff, { force: true });
    } else {
      await runProc('espeak-ng', ['-w', out, '-f', txtFile]);
    }
  } finally { fs.rmSync(txtFile, { force: true }); }
  if (!exists(out)) throw new Error('Text-to-speech produced no file');
  const [media] = importPaths([out], { ...meta, sourceInfo: { kind: 'tts', title: text.slice(0, 80), license: 'generated' } });
  const placed = await placeImported(media, opts.place || null, meta);
  return { media: { id: media.id, name: media.name }, placed };
}

export async function listVoices() {
  if (process.platform !== 'win32') return [];
  const out = await runProc('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture }']);
  return out.split(/\r?\n/).filter(Boolean).map((l) => { const [name, culture] = l.split('|'); return { name, culture }; });
}

function runProc(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().slice(-400) || `${cmd} exited ${code}`))));
  });
}

export function projectSummary() {
  const p = store.project;
  if (!p) return null;
  return { name: p.name, file: store.file, dir: store.dir, duration: projectDuration(p) };
}

export { clipEnd, trackById };
