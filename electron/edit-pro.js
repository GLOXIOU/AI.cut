// Editing services added for AI-driven work on real shoots: voice levelling, compact timeline reading, source ↔
// timeline time mapping, subtitle find / replace, custom vocabulary, audio sync, clean-music placement and multicam.
import fs from 'node:fs';
import path from 'node:path';
import { store } from './project/store.js';
import { OPS } from './project/ops.js';
import { runFfmpeg } from './media/ffmpeg.js';
import { loadAnalysis, saveAnalysis, projectVocabulary, ensureBeats } from './analysis/index.js';
import { replaceInWords } from './analysis/transcribe.js';
import { syncFiles } from './analysis/sync.js';
import { clipById, clipEnd, mediaById, trackById, r4, fmtTime } from '../shared/timeline.js';
import { tempDir } from './core/paths.js';
import { uid } from './core/util.js';
import { log } from './core/log.js';

const trackName = (p, id) => trackById(p, id)?.name || id;
const findTrack = (p, spec) => p.tracks.find((t) => t.id === spec || t.name.toLowerCase() === String(spec).toLowerCase());

// ------------------------------------------------------------------------------------------- voice levelling
/** Integrated loudness (LUFS) of [start, start + duration] of a file (speech gating by ebur128's own gate). */
async function rangeLoudness(file, start, duration) {
  const out = path.join(tempDir(), `ebur_${uid('l', 6)}.txt`);
  try {
    await runFfmpeg(['-ss', String(Math.max(0, start)), '-t', String(Math.max(0.5, duration)), '-i', file, '-vn', '-af',
      `ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.I:file='${out.replace(/\\/g, '/').replace(/:/g, '\\:')}'`, '-f', 'null', '-'], { quiet: true, priority: 'low' });
    const txt = fs.readFileSync(out, 'utf8');
    const m = [...txt.matchAll(/lavfi\.r128\.I=(-?[\d.]+)/g)];
    const v = m.length ? Number(m[m.length - 1][1]) : null;
    return Number.isFinite(v) && v > -70 ? v : null;
  } catch { return null; } finally { fs.rm(out, { force: true }, () => {}); }
}

/**
 * Bring every speech clip to the same loudness: measure each clip's source range (only its speech parts when a
 * transcript exists), then set the clip volume so it reaches targetLufs. opts: { clipIds?, track?, targetLufs = -16,
 * maxGainDb = 15, minGainDb = -20, dryRun }.
 */
export async function levelVoices(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const target = opts.targetLufs ?? -16;
  let clips;
  if (opts.clipIds?.length) clips = opts.clipIds.map((id) => clipById(p, id)).filter(Boolean);
  else {
    const t = opts.track ? findTrack(p, opts.track) : null;
    clips = p.clips.filter((c) => (c.type === 'video' || c.type === 'audio') && (!t || c.trackId === t.id) && !c.muted && (() => {
      const m = mediaById(p, c.mediaId);
      if (!m?.hasAudio) return false;
      const tr = loadAnalysis(m.id).transcript;
      return !!tr && tr.segments.some((sg) => sg.end > c.in && sg.start < c.in + c.duration * c.speed);
    })());
  }
  if (!clips.length) throw new Error('No speech clip to level (clips need audio and a transcript; or pass clipIds).');
  const results = [];
  for (const c of clips) {
    const m = mediaById(p, c.mediaId);
    if (!m?.path) continue;
    const a = c.in, b = c.in + c.duration * c.speed;
    // speech span inside the clip (avoid measuring long silences / music before the first word)
    const words = (loadAnalysis(m.id).transcript?.segments || []).flatMap((sg) => sg.words || []).filter((w) => w.end > a && w.start < b);
    const s0 = words.length ? Math.max(a, words[0].start - 0.1) : a, s1 = words.length ? Math.min(b, words[words.length - 1].end + 0.1) : b;
    const lufs = await rangeLoudness(m.path, s0, s1 - s0);
    if (lufs == null) { results.push({ id: c.id, name: c.name, skipped: 'too quiet / no audio' }); continue; }
    const gainDb = Math.max(opts.minGainDb ?? -20, Math.min(opts.maxGainDb ?? 15, target - lufs));
    const volume = Math.round(Math.min(8, Math.pow(10, gainDb / 20)) * 1000) / 1000;
    results.push({ id: c.id, name: c.name, start: c.start, measuredLufs: Math.round(lufs * 10) / 10, gainDb: Math.round(gainDb * 10) / 10, volume, previousVolume: c.volume ?? 1 });
  }
  const todo = results.filter((r) => r.volume != null);
  if (!opts.dryRun && todo.length) {
    store.transaction(`level ${todo.length} voice clips to ${target} LUFS`, (draft, ctx) => {
      for (const r of todo) OPS.updateClip(draft, { id: r.id, volume: r.volume }, ctx);
    }, meta);
  }
  return { targetLufs: target, applied: !opts.dryRun, clips: results };
}

// ------------------------------------------------------------------------------------------- reading the timeline
/**
 * Compact, filterable timeline listing. opts: { start, end (timeline s), tracks: names/ids, types, format:
 * 'compact' (one short line per clip) | 'json' }.
 */
export function timelineListing(p, opts = {}) {
  const a = opts.start ?? 0, b = opts.end ?? Infinity;
  const tracks = opts.tracks?.length ? opts.tracks.map((x) => findTrack(p, x)).filter(Boolean) : null;
  const order = [...p.tracks.filter((t) => t.type === 'video').reverse(), ...p.tracks.filter((t) => t.type === 'audio')];
  const rows = [];
  for (const t of order) {
    if (tracks && !tracks.includes(t)) continue;
    for (const c of p.clips.filter((x) => x.trackId === t.id).sort((x, y) => x.start - y.start)) {
      if (clipEnd(c) <= a || c.start >= b) continue;
      if (opts.types?.length && !opts.types.includes(c.type)) continue;
      const m = mediaById(p, c.mediaId);
      const row = { id: c.id, track: t.name, type: c.type, start: r4(c.start), end: r4(clipEnd(c)), name: c.name };
      if (m && (c.type === 'video' || c.type === 'audio')) Object.assign(row, { mediaId: m.id, in: r4(c.in), out: r4(c.in + c.duration * c.speed) });
      if (c.speed !== 1) row.speed = c.speed;
      if ((c.volume ?? 1) !== 1) row.volume = c.volume;
      if (c.muted) row.muted = true;
      if (c.html?.template) row.template = c.html.template;
      rows.push(row);
    }
  }
  if (opts.format === 'json') return { clips: rows, count: rows.length };
  const f = (x) => x.toFixed(2);
  const lines = rows.map((r) => `${r.track.padEnd(3)} ${f(r.start)}–${f(r.end)} ${r.id} ${r.type}${r.template ? `:${r.template}` : ''} "${r.name}"${r.mediaId ? ` src ${f(r.in)}–${f(r.out)}` : ''}${r.speed ? ` ×${r.speed}` : ''}${r.volume != null ? ` vol ${r.volume}` : ''}${r.muted ? ' muted' : ''}`);
  return { text: `${rows.length} clip(s)${Number.isFinite(b) || a > 0 ? ` in ${f(a)}–${Number.isFinite(b) ? f(b) : 'end'}` : ''}\n${lines.join('\n')}` };
}

/**
 * Source ↔ timeline time conversion.
 *  - { mediaId, sourceTime }: every timeline position where that instant of the media is used (clip, track, time);
 *  - { time, track? }: what is under the timeline time (clip, its media and the source time).
 */
export function timeMap(p, { mediaId, sourceTime, time, track } = {}) {
  if (mediaId != null && sourceTime != null) {
    const hits = [];
    for (const c of p.clips) {
      if (c.mediaId !== mediaId) continue;
      const a = c.in, b = c.in + c.duration * c.speed;
      if (sourceTime < a - 1e-4 || sourceTime > b + 1e-4) continue;
      hits.push({ clipId: c.id, track: trackName(p, c.trackId), time: r4(c.start + (sourceTime - c.in) / c.speed), clipStart: c.start, clipEnd: r4(clipEnd(c)) });
    }
    // nearest use when the instant was cut out
    let nearest = null;
    if (!hits.length) {
      for (const c of p.clips) {
        if (c.mediaId !== mediaId) continue;
        const a = c.in, b = c.in + c.duration * c.speed;
        const d = sourceTime < a ? a - sourceTime : sourceTime - b;
        if (!nearest || d < nearest.distance) nearest = { clipId: c.id, track: trackName(p, c.trackId), distance: r4(d), time: r4(sourceTime < a ? c.start : clipEnd(c)), side: sourceTime < a ? 'before clip start' : 'after clip end' };
      }
    }
    return { mediaId, sourceTime, onTimeline: hits, ...(nearest ? { cutOut: true, nearest } : {}) };
  }
  if (time != null) {
    const t = track ? findTrack(p, track) : null;
    const under = p.clips.filter((c) => c.start <= time + 1e-4 && clipEnd(c) > time && (!t || c.trackId === t.id)).map((c) => {
      const m = mediaById(p, c.mediaId);
      return { clipId: c.id, track: trackName(p, c.trackId), type: c.type, name: c.name, ...(m && (c.type === 'video' || c.type === 'audio') ? { mediaId: m.id, sourceTime: r4(c.in + (time - c.start) * c.speed) } : {}), localTime: r4(time - c.start) };
    });
    return { time, clips: under };
  }
  throw new Error('Pass {mediaId, sourceTime} or {time}.');
}

// ------------------------------------------------------------------------------------------- subtitles / vocabulary
/**
 * Find / replace in subtitles (and, by default, in the transcripts so regenerated subtitles keep the fix).
 * opts: { find, replace, regex, caseSensitive, wholeWord (default true), transcripts (default true), dryRun }.
 */
export function findReplaceSubtitles(opts = {}, meta = {}) {
  const p = store.requireOpen();
  if (!opts.find) throw new Error('find is required');
  const rule = { find: opts.find, replace: opts.replace ?? '', regex: !!opts.regex, caseSensitive: !!opts.caseSensitive, wholeWord: opts.wholeWord !== false };
  try { new RegExp(rule.regex ? rule.find : 'x'); } catch (e) { throw new Error(`Invalid regex: ${e.message}`); }
  const changes = [];
  const updates = [];
  for (const q of p.subtitles.cues) {
    const words = q.words?.length ? q.words : String(q.text).split(/\s+/).filter(Boolean).map((text, i, arr) => {
      const d = (q.end - q.start) / Math.max(1, arr.length);
      return { text, start: q.start + i * d, end: q.start + (i + 1) * d };
    });
    const r = replaceInWords(words, [rule]);
    if (!r.count) continue;
    const text = r.words.map((w) => w.text).join(' ');
    changes.push({ id: q.id, before: q.text, after: text });
    updates.push({ id: q.id, text, words: r.words });
  }
  let transcriptFixes = 0;
  if (!opts.dryRun && opts.transcripts !== false) {
    for (const m of p.media) {
      const a = loadAnalysis(m.id);
      if (!a.transcript?.segments) continue;
      let n = 0;
      for (const sg of a.transcript.segments) {
        const r = replaceInWords(sg.words || [], [rule]);
        if (r.count) { sg.words = r.words; sg.text = r.words.map((w) => w.text).join(' '); n += r.count; }
      }
      if (n) { saveAnalysis(m.id, { transcript: a.transcript }); transcriptFixes += n; }
    }
  }
  if (!opts.dryRun && updates.length) {
    store.transaction(`replace "${opts.find}" in subtitles`, (draft) => {
      for (const u of updates) {
        const q = draft.subtitles.cues.find((x) => x.id === u.id);
        if (!q) continue;
        q.text = u.text;
        q.words = u.words.map((w) => ({ ...w }));
      }
    }, meta);
  }
  return { cues: changes.length, changes: changes.slice(0, 60), transcriptReplacements: transcriptFixes, dryRun: !!opts.dryRun };
}

/** Project vocabulary: words (Whisper prompt for the next transcriptions) and automatic replacements. */
export function setVocabulary(opts = {}, meta = {}) {
  store.requireOpen();
  const cur = projectVocabulary();
  const words = opts.words ? [...new Set(opts.words.map((w) => String(w).trim()).filter(Boolean))] : cur.words;
  const replacements = opts.replacements ? opts.replacements.filter((r) => r?.find).map((r) => ({ find: String(r.find), replace: String(r.replace ?? ''), ...(r.caseSensitive ? { caseSensitive: true } : {}) })) : cur.replacements;
  store.transaction('vocabulary', (draft) => { draft.settings.vocabulary = { words, replacements }; }, meta);
  let applied = null;
  if (opts.apply && replacements.length) {
    applied = replacements.map((r) => ({ find: r.find, ...findReplaceSubtitles({ find: r.find, replace: r.replace, caseSensitive: r.caseSensitive }, meta) }));
    applied = applied.map((x) => ({ find: x.find, cues: x.cues, transcriptReplacements: x.transcriptReplacements }));
  }
  return { words, replacements, prompt: words.length ? `${words.join(', ')}.` : '', applied, hint: 'New words take effect on the next transcription: analyze_media {force: true, transcribe: true} to redo existing ones.' };
}

// ------------------------------------------------------------------------------------------- audio sync
const syncCache = new Map(); // `${refPath}|${otherPath}|${maxOffset}` → result

/** Offset between two media: other's time 0 sits at reference time `offset` (refTime = otherTime + offset). */
export async function mediaOffset(refMedia, otherMedia, { maxOffset, signal } = {}) {
  if (!refMedia?.hasAudio || !otherMedia?.hasAudio) throw new Error(`${!refMedia?.hasAudio ? refMedia?.name : otherMedia?.name} has no audio to synchronise.`);
  const key = `${refMedia.path}|${otherMedia.path}|${maxOffset ?? ''}`;
  if (syncCache.has(key)) return syncCache.get(key);
  const t0 = Date.now();
  const r = await syncFiles(refMedia.path, otherMedia.path, { maxOffset: maxOffset ?? Infinity, signal });
  log.info(`audio sync ${otherMedia.name} → ${refMedia.name}: ${r.offset}s (z ${r.confidence}, ${r.method}) in ${Date.now() - t0} ms`);
  const out = { ...r, reliable: r.confidence >= 6 && r.strength >= 0.15 };
  syncCache.set(key, out);
  return out;
}

/** Sync several media on a reference media. */
export async function syncAudio({ referenceMediaId, mediaIds = [], maxOffset } = {}) {
  const p = store.requireOpen();
  const ref = mediaById(p, referenceMediaId);
  if (!ref) throw new Error(`Unknown media ${referenceMediaId}`);
  const out = [];
  for (const id of mediaIds) {
    const m = mediaById(p, id);
    if (!m) { out.push({ mediaId: id, error: 'unknown media' }); continue; }
    try {
      const r = await mediaOffset(ref, m, { maxOffset });
      out.push({ mediaId: id, name: m.name, offset: r.offset, meaning: `${m.name} at t → ${ref.name} at t ${r.offset >= 0 ? '+' : '−'} ${Math.abs(r.offset)} s`, confidence: r.confidence, strength: r.strength, overlap: r.overlap, reliable: r.reliable, method: r.method });
    } catch (e) { out.push({ mediaId: id, name: m.name, error: e.message }); }
  }
  return { reference: { mediaId: ref.id, name: ref.name }, results: out };
}

/**
 * Put a media (clean music track, external mic…) on the timeline in sync with a reference clip whose audio recorded
 * the same sound. cover: 'clip' (same span as the reference clip) | 'media' (the whole media, e.g. the full song).
 * referenceVolume: volume given to the reference clip afterwards (0 = mute the phone sound, 0.2 = keep ambience).
 */
export async function placeSynced(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const c = clipById(p, opts.referenceClipId);
  if (!c || (c.type !== 'video' && c.type !== 'audio')) throw new Error('referenceClipId must be a video or audio clip on the timeline.');
  if (Math.abs((c.speed || 1) - 1) > 1e-6) throw new Error('The reference clip must play at normal speed.');
  const refMedia = mediaById(p, c.mediaId), m = mediaById(p, opts.mediaId);
  if (!m) throw new Error(`Unknown media ${opts.mediaId}`);
  const r = await mediaOffset(refMedia, m, { maxOffset: opts.maxOffset });
  if (!r.reliable && !opts.force) {
    throw new Error(`No reliable match between ${m.name} and ${refMedia.name} (confidence ${r.confidence}, strength ${r.strength}). Not the same recording? Pass force:true to place it anyway at offset ${r.offset}s.`);
  }
  // timeline t ↔ reference source c.in + (t - c.start) ↔ media time (that) − offset
  const mediaAt = (t) => c.in + (t - c.start) - r.offset;
  let start, inP, dur;
  if ((opts.cover || 'clip') === 'media') {
    start = c.start - mediaAt(c.start); inP = 0;
    if (start < 0) { inP = -start; start = 0; }
    dur = m.duration - inP;
  } else {
    start = c.start; inP = mediaAt(c.start);
    if (inP < 0) { start += -inP; inP = 0; }
    dur = Math.min(clipEnd(c) - start, m.duration - inP);
  }
  if (!(dur > 0.05)) throw new Error(`${m.name} does not overlap the reference clip in time (offset ${r.offset}s).`);
  const { result, warnings } = store.transaction(`sync ${m.name}`, (draft, ctx) => {
    const clip = OPS.addClip(draft, { mediaId: m.id, track: opts.track || 'auto', start: r4(start), in: r4(inP), duration: r4(dur), mode: opts.track ? 'overwrite' : 'auto' }, ctx);
    if (opts.referenceVolume != null) OPS.updateClip(draft, { id: c.id, volume: Math.max(0, Number(opts.referenceVolume)) }, ctx);
    return clip;
  }, meta);
  return {
    clipId: result.id, track: trackName(store.project, result.trackId), start: result.start, in: result.in, duration: result.duration,
    offset: r.offset, confidence: r.confidence, method: r.method, warnings,
  };
}

/**
 * Multicam: several takes / angles that recorded the same sound, cut together in sync with a master clip.
 * opts: { masterClipId (audio or video clip on the timeline, e.g. the clean music), angles: [mediaId…],
 *   cuts?: [{ at (timeline s), angle (index or mediaId) }], every?: seconds or 'bar' | '2bars' | '4bars' | 'beat',
 *   start?, end? (timeline range, default the master clip), track (default 'V1'), angleAudio (default false: angles muted) }
 */
export async function multicam(opts = {}, meta = {}) {
  const p = store.requireOpen();
  const master = clipById(p, opts.masterClipId);
  if (!master || (master.type !== 'video' && master.type !== 'audio')) throw new Error('masterClipId must be an audio or video clip on the timeline (the sound everything is synced to).');
  if (Math.abs((master.speed || 1) - 1) > 1e-6) throw new Error('The master clip must play at normal speed.');
  const mm = mediaById(p, master.mediaId);
  const angles = (opts.angles || []).map((id) => mediaById(p, id)).filter((m) => m && m.type === 'video');
  if (angles.length < 1) throw new Error('angles: give the media ids of the video takes (at least one).');
  const sync = [];
  for (const a of angles) {
    const r = await mediaOffset(mm, a, { maxOffset: opts.maxOffset });
    sync.push({ media: a, ...r });
  }
  const ok = sync.filter((s) => s.reliable || opts.force);
  if (!ok.length) throw new Error(`No angle matches the master sound reliably: ${sync.map((s) => `${s.media.name} (z ${s.confidence})`).join(', ')}.`);
  const T0 = Math.max(master.start, opts.start ?? master.start), T1 = Math.min(clipEnd(master), opts.end ?? clipEnd(master));
  const masterAt = (t) => master.in + (t - master.start);
  // coverage of an angle on the timeline: its media time = master time − offset must be inside [0, duration]
  const covers = (s, t0, t1) => masterAt(t0) - s.offset >= 0 && masterAt(t1) - s.offset <= s.media.duration - 0.02;
  // switch points
  let points = [];
  if (opts.cuts?.length) points = opts.cuts.map((k) => ({ at: Number(k.at), angle: k.angle })).filter((k) => k.at >= T0 - 1e-3 && k.at < T1).sort((x, y) => x.at - y.at);
  else {
    let times = [];
    const every = opts.every ?? '2bars';
    if (typeof every === 'string') {
      const beats = mm.type === 'audio' || mm.hasAudio ? await ensureBeats(mm.id).catch(() => null) : null;
      if (beats?.beats?.length) {
        const list = every === 'beat' ? beats.beats : beats.downbeats;
        const step = every === '4bars' ? 4 : every === '2bars' ? 2 : 1;
        times = list.filter((_, i) => i % step === 0).map((x) => master.start + (x - master.in)).filter((t) => t > T0 + 0.3 && t < T1 - 0.3);
      }
      if (!times.length) times = Array.from({ length: Math.floor((T1 - T0) / 4) }, (_, i) => T0 + 4 * (i + 1)).filter((t) => t < T1 - 0.3);
    } else {
      const step = Math.max(0.5, Number(every));
      for (let t = T0 + step; t < T1 - 0.3; t += step) times.push(t);
    }
    points = [{ at: T0 }, ...times.map((at) => ({ at }))];
  }
  if (!points.length || points[0].at > T0 + 1e-3) points.unshift({ at: T0, angle: points[0]?.angle });
  // choose angles: explicit, else round-robin among the angles covering the segment (never twice in a row if avoidable)
  const segs = [];
  let last = -1, rr = 0;
  for (let i = 0; i < points.length; i++) {
    const t0 = points[i].at, t1 = i + 1 < points.length ? points[i + 1].at : T1;
    if (t1 - t0 < 0.05) continue;
    let idx = -1;
    const want = points[i].angle;
    if (want != null) idx = typeof want === 'number' ? want : ok.findIndex((s) => s.media.id === want);
    if (idx < 0 || !ok[idx] || !covers(ok[idx], t0, t1)) {
      const cand = ok.map((s, k) => k).filter((k) => covers(ok[k], t0, t1));
      if (!cand.length) { segs.push({ t0, t1, gap: true }); continue; }
      const others = cand.filter((k) => k !== last);
      const pool = others.length ? others : cand;
      idx = pool[rr++ % pool.length];
    }
    if (segs.length && !segs[segs.length - 1].gap && segs[segs.length - 1].idx === idx) segs[segs.length - 1].t1 = t1;
    else segs.push({ t0, t1, idx });
    last = idx;
  }
  const items = segs.filter((s) => !s.gap);
  if (!items.length) throw new Error('No angle covers the requested range.');
  const track = opts.track || 'V1';
  const { result, warnings } = store.transaction(`multicam (${items.length} cuts, ${ok.length} angles)`, (draft, ctx) => {
    const placed = [];
    for (const s of items) {
      const a = ok[s.idx];
      const c = OPS.addClip(draft, { mediaId: a.media.id, track, start: r4(s.t0), in: r4(masterAt(s.t0) - a.offset), duration: r4(s.t1 - s.t0), mode: 'overwrite' }, ctx);
      if (!opts.angleAudio) OPS.updateClip(draft, { id: c.id, muted: true }, ctx);
      placed.push(c);
    }
    return placed;
  }, meta);
  return {
    clips: result.map((c) => ({ id: c.id, start: c.start, end: r4(clipEnd(c)), media: mediaById(store.project, c.mediaId)?.name })),
    angles: sync.map((s) => ({ mediaId: s.media.id, name: s.media.name, offset: s.offset, confidence: s.confidence, used: ok.includes(s) })),
    gaps: segs.filter((s) => s.gap).map((s) => ({ start: r4(s.t0), end: r4(s.t1) })),
    range: { start: r4(T0), end: r4(T1) }, warnings,
    note: `Angles are ${opts.angleAudio ? 'audible' : 'muted'}; the sound comes from the master clip ${master.id}. Times: ${fmtTime(T0)}–${fmtTime(T1)}.`,
  };
}
