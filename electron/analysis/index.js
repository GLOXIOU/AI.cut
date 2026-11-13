// Analysis orchestrator ("video → text"): transcript, shots, silences, loudness, beats + AI visual notes.
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../project/store.js';
import { jobs } from '../core/jobs.js';
import { bus } from '../core/bus.js';
import { log } from '../core/log.js';
import { readJson, writeJson } from '../core/util.js';
import { getSettings, tr } from '../core/settings.js';
import { waitForProbe, videoPassPending } from '../media/service.js';
import { transcribeMedia, refineStackedWords, alignWordsToSilences, applyWordReplacements, WORD_ALIGN_VERSION } from './transcribe.js';
import { audioEnvelope, detectSilences, detectBeats, measureLoudness, BEATS_VERSION } from './audio-analysis.js';
import { detectScenes } from './video-analysis.js';
import { fmtTime, mediaById, clipEnd, trackById } from '../../shared/timeline.js';

const cache = new Map();
let whisperLock = Promise.resolve();
const running = new Map(); // mediaId -> job

const analysisPath = (mediaId) => path.join(store.dir, '.aicut-cache', 'analysis', `${mediaId}.json`);

export function loadAnalysis(mediaId) {
  if (!store.dir) return {};
  const key = `${store.dir}|${mediaId}`;
  if (cache.has(key)) return cache.get(key);
  const data = readJson(analysisPath(mediaId), {}) || {};
  cache.set(key, data);
  // transcripts made before word alignment existed: align once on the silence analysis and save
  if (data.transcript?.segments?.length && data.silences?.length && (data.transcript.aligned || 0) < WORD_ALIGN_VERSION) {
    try {
      alignWordsToSilences(data.transcript.segments, data.silences);
      data.transcript.aligned = WORD_ALIGN_VERSION;
      writeJson(analysisPath(mediaId), data, false);
    } catch (e) { log.warn('word alignment failed', e.message); }
  }
  return data;
}

/** Custom vocabulary of the project (names, jargon): Whisper prompt + automatic replacements. */
export function projectVocabulary(project = store.project) {
  const v = project?.settings?.vocabulary || {};
  const words = (Array.isArray(v.words) ? v.words : []).map((w) => String(w).trim()).filter(Boolean);
  const replacements = (Array.isArray(v.replacements) ? v.replacements : []).filter((r) => r?.find);
  return { words, replacements, prompt: words.length ? `${words.join(', ')}.` : '' };
}

/** Beat analysis of the current version (older ones are recomputed: they were ~0.2 s late and had no grid). */
export async function ensureBeats(mediaId, { timeoutSec = 90 } = {}) {
  let a = loadAnalysis(mediaId);
  if (a.beats && (a.beats.version || 1) >= BEATS_VERSION) return a.beats;
  const job = analyzeMedia(mediaId, { beats: true, transcribe: false, scenes: false, force: true, audioOnly: true });
  await Promise.race([job.promise.catch(() => {}), new Promise((r) => setTimeout(r, timeoutSec * 1000))]);
  a = loadAnalysis(mediaId);
  return a.beats || null;
}

export function saveAnalysis(mediaId, patch) {
  const data = { ...loadAnalysis(mediaId), ...patch, updatedAt: new Date().toISOString() };
  cache.set(`${store.dir}|${mediaId}`, data);
  writeJson(analysisPath(mediaId), data, false);
  return data;
}

export function clearAnalysisCache() { cache.clear(); }

function updateStatus(mediaId, patch) {
  const m = mediaById(store.project, mediaId);
  if (!m) return;
  store.setDerived(mediaId, { analysis: { ...(m.analysis || {}), ...patch } });
}

// Shot lists computed for free by the proxy pass (same decode as the proxy, see media/service.js).
bus.on('media:shots', ({ mediaId, projectId, shots }) => {
  if (!store.project || store.project.id !== projectId || !mediaById(store.project, mediaId)) return;
  if (shots) {
    saveAnalysis(mediaId, { shots });
    updateStatus(mediaId, { scenes: 'done', shots: shots.length });
  } else if (mediaById(store.project, mediaId).analysis?.scenes === 'queued') {
    updateStatus(mediaId, { scenes: 'error' });
  }
});

/**
 * Analyse a media item. opts: { transcribe, scenes, audio, beats, language, force }
 * Returns the job.
 */
export function analyzeMedia(mediaId, opts = {}) {
  store.requireOpen();
  const existing = running.get(mediaId);
  if (existing && !existing.endedAt && !opts.force) return existing;
  const m0 = mediaById(store.project, mediaId);
  if (!m0) throw new Error(`Unknown media ${mediaId}`);
  const job = jobs.create('analysis', `${tr('Analyse', 'Analysis')} ${m0.name}`, async (ctx) => {
    const m = await waitForProbe(mediaId);
    if (!m || m.status === 'error') throw new Error(`Media not readable: ${m?.error || mediaId}`);
    const work = path.join(store.dir, '.aicut-cache', 'tmp');
    const prev = loadAnalysis(mediaId);
    // library music / SFX and very short sounds are not worth transcribing (unless explicitly requested)
    const skipSpeech = opts.transcribe !== true && (m.source?.kind === 'library' || (m.type === 'audio' && m.duration < 3));
    const want = {
      audio: opts.audio !== false && m.hasAudio,
      transcribe: opts.transcribe !== false && m.hasAudio && !skipSpeech && !opts.audioOnly,
      scenes: opts.scenes !== false && m.type === 'video' && !opts.audioOnly,
      beats: opts.beats ?? (m.type === 'audio' && m.duration > 8),
    };
    const result = {};
    let transcriptError = null;
    // 1. audio envelope → silences / beats / loudness
    if (want.audio && (opts.force || !prev.silences || (want.beats && !prev.beats))) {
      ctx.progress(0.03, 'audio analysis');
      try {
        const env = await audioEnvelope(m.path, { flux: want.beats, signal: ctx.signal });
        const sil = detectSilences(env, { minSilence: 0.35 });
        result.silences = sil.silences;
        result.audio = { floorDb: sil.floorDb, speechDb: sil.speechDb, thresholdDb: sil.thresholdDb };
        if (want.beats) result.beats = detectBeats(env);
        const loud = await measureLoudness(m.path, work, { signal: ctx.signal });
        result.audio.integratedLufs = loud.integratedLufs;
        saveAnalysis(mediaId, result);
        updateStatus(mediaId, { silences: result.silences.length, bpm: result.beats?.bpm || null, lufs: loud.integratedLufs });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        log.warn('audio analysis failed', e.message);
      }
    }
    // 2. transcript (first: it only needs the audio and is what matters most to the AI)
    if (want.transcribe && (opts.force || !prev.transcript)) {
      updateStatus(mediaId, { transcript: 'queued' });
      const release = await acquireWhisper();
      try {
        updateStatus(mediaId, { transcript: 'running' });
        const silences = loadAnalysis(mediaId).silences || [];
        const vocab = projectVocabulary();
        const prompt = [opts.prompt, vocab.prompt].filter(Boolean).join(' ').trim() || undefined;
        const tr = await transcribeMedia(m.path, work, {
          language: opts.language, silences, signal: ctx.signal, duration: m.duration, prompt,
          onProgress: (p, msg) => ctx.progress(0.1 + 0.75 * p, msg),
        });
        // re-time words Whisper stacked on the same instant, from the waveform (peaks: 100 values / s)
        try { const pp = mediaById(store.project, mediaId)?.peaks; const pk = pp && fs.existsSync(pp) ? fs.readFileSync(pp) : null; if (pk) refineStackedWords(tr.segments, pk, 100); } catch (e) { log.warn('word re-timing failed', e.message); }
        // words never extend into the silences (they would vanish from the subtitles once the silences are cut)
        try { alignWordsToSilences(tr.segments, silences); tr.aligned = WORD_ALIGN_VERSION; } catch (e) { log.warn('word alignment failed', e.message); }
        if (vocab.replacements.length) tr.replaced = applyWordReplacements(tr.segments, vocab.replacements);
        if (prompt) tr.prompt = prompt;
        saveAnalysis(mediaId, { transcript: tr });
        updateStatus(mediaId, { transcript: 'done', language: tr.language, words: tr.wordCount, model: tr.model, backend: tr.backend });
        result.transcript = { language: tr.language, words: tr.wordCount };
      } catch (e) {
        updateStatus(mediaId, { transcript: ctx.signal.aborted ? 'none' : 'error', transcriptError: e.message });
        if (ctx.signal.aborted) throw e;
        transcriptError = e; // reported after the shot detection, which does not depend on it
      } finally {
        release();
      }
    }
    // 3. shots — when a proxy is being built the same decode yields them ('media:shots'): no second pass over the file
    if (want.scenes && (opts.force || !loadAnalysis(mediaId).shots)) {
      if (!opts.force && videoPassPending(mediaId)) {
        updateStatus(mediaId, { scenes: 'queued' });
      } else {
        ctx.progress(0.85, 'shot detection');
        updateStatus(mediaId, { scenes: 'running' });
        try {
          const shots = await detectScenes(m.path, m.duration, work, { rotation: m.rotation, signal: ctx.signal, onProgress: (r) => ctx.progress(0.85 + 0.15 * r, 'shot detection') });
          saveAnalysis(mediaId, { shots });
          updateStatus(mediaId, { scenes: 'done', shots: shots.length });
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          updateStatus(mediaId, { scenes: 'error' });
          log.warn('scene detection failed', e.message);
        }
      }
    }
    if (transcriptError) throw transcriptError;
    bus.emit('analysis:done', mediaId);
    return { mediaId, ...summarize(mediaId) };
  }, { queue: 'analysis', meta: { mediaId }, projectId: store.project?.id });
  running.set(mediaId, job);
  return job;
}

function acquireWhisper() {
  let release;
  const p = new Promise((r) => { release = r; });
  const prev = whisperLock;
  whisperLock = prev.then(() => p);
  return prev.then(() => release);
}

export function autoAnalyze(mediaId) {
  if (!getSettings().autoAnalyze) return;
  try { analyzeMedia(mediaId); } catch (e) { log.warn('auto analysis', e.message); }
}

/** Short machine-readable summary of available analysis. */
export function summarize(mediaId) {
  const a = loadAnalysis(mediaId);
  return {
    transcript: a.transcript ? { language: a.transcript.language, words: a.transcript.wordCount, segments: a.transcript.segments.length } : null,
    shots: a.shots ? a.shots.length : null,
    silences: a.silences ? a.silences.length : null,
    beats: a.beats ? { bpm: a.beats.bpm, count: a.beats.beats.length, ...(a.beats.drops?.length ? { drops: a.beats.drops } : {}) } : null,
    loudnessLufs: a.audio?.integratedLufs ?? null,
    aiNotes: a.descriptions ? { summary: !!a.descriptions.summary, scenes: a.descriptions.scenes?.length || 0 } : null,
  };
}

/** Transcript slice. format: 'segments' | 'words' | 'text' */
export function getTranscript(mediaId, { start = 0, end = Infinity, format = 'segments' } = {}) {
  const a = loadAnalysis(mediaId);
  if (!a.transcript) return null;
  const segs = a.transcript.segments.filter((s) => s.end > start && s.start < end);
  if (format === 'words') return segs.flatMap((s) => s.words).filter((w) => w.end > start && w.start < end);
  if (format === 'text') return segs.map((s) => s.text).join(' ');
  return segs.map((s) => ({ start: s.start, end: s.end, text: s.text }));
}

/**
 * Words of a media between source times (for subtitles). A word cut by a range edge belongs to the side holding most
 * of it (clamped to the range): a word whose tail was trimmed by a jump cut is still subtitled.
 */
export function wordsInRange(mediaId, a, b) {
  const t = loadAnalysis(mediaId).transcript;
  if (!t) return [];
  const out = [];
  for (const s of t.segments) {
    if (s.end < a - 0.5 || s.start > b + 0.5) continue;
    for (const w of s.words) {
      if (w.start >= a - 0.05 && w.end <= b + 0.05) { out.push(w); continue; }
      const ov = Math.min(w.end, b) - Math.max(w.start, a);
      const d = Math.max(0.04, w.end - w.start);
      if (ov > 0 && (ov >= d * 0.5 || ov >= 0.25)) out.push({ ...w, start: Math.max(w.start, a), end: Math.min(w.end, b) });
    }
  }
  return out;
}

export function describeMedia(mediaId, { summary, scenes, tags, append = false }) {
  const a = loadAnalysis(mediaId);
  const d = { ...(a.descriptions || {}) };
  if (summary !== undefined) d.summary = summary;
  if (scenes) {
    const list = scenes.map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || s.description || '') }));
    d.scenes = append ? [...(d.scenes || []), ...list].sort((x, y) => x.start - y.start) : list;
  }
  if (tags) d.tags = tags;
  saveAnalysis(mediaId, { descriptions: d });
  updateStatus(mediaId, { described: true });
  if (tags && store.project) {
    const m = mediaById(store.project, mediaId);
    if (m) store.setDerived(mediaId, { tags });
  }
  return d;
}

const fmt = (t) => fmtTime(t);
const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${(s % 60).toFixed(1)}s` : `${s.toFixed(1)}s`);

/** Markdown "video-to-text" report for a media item. */
export function mediaReport(mediaId, { maxChars = 12000, start = 0, end = Infinity } = {}) {
  const m = mediaById(store.project, mediaId);
  if (!m) throw new Error(`Unknown media ${mediaId}`);
  const a = loadAnalysis(mediaId);
  const L = [];
  L.push(`# ${m.name} (${m.id})`);
  const tech = [`type: ${m.type}`];
  if (m.duration) tech.push(fmtDur(m.duration));
  if (m.width) tech.push(`${m.width}×${m.height}${m.fps ? ` @ ${m.fps}fps` : ''}`);
  if (m.hasAudio) tech.push(`audio ${m.audioCodec || ''} ${m.channels || ''}ch`.trim());
  if (m.hasAlpha) tech.push('has alpha');
  L.push(tech.join(' · '));
  if (m.source?.kind && m.source.kind !== 'import') L.push(`source: ${m.source.kind}${m.source.title ? ` — ${m.source.title}` : ''}${m.source.license ? ` — license: ${m.source.license}` : ''}${m.source.author ? ` — by ${m.source.author}` : ''}`);
  if (a.audio) L.push(`audio: ${a.audio.integratedLufs != null ? `${a.audio.integratedLufs} LUFS · ` : ''}speech ≈ ${a.audio.speechDb} dB · noise floor ≈ ${a.audio.floorDb} dB · silences: ${a.silences?.length ?? 0} (${fmtDur((a.silences || []).reduce((n, s) => n + s.end - s.start, 0))})`);
  if (a.beats) {
    const g = a.beats.grid;
    L.push(`music: ${a.beats.bpm} BPM${g ? `${g.constant ? ' (constant tempo grid)' : ' (variable tempo)'}, first downbeat ${g.firstDownbeat}s` : ''}, ${a.beats.beats.length} beats${a.beats.bars ? `, ${a.beats.bars} bars` : ''} — use get_beats for all times`);
    if (a.beats.sections?.length) L.push(`sections: ${a.beats.sections.map((x) => `${x.kind} ${fmt(x.start)}`).join(' · ')}`);
  }
  const st = m.analysis || {};
  if (!a.transcript && m.hasAudio) L.push(`transcript: ${st.transcript || 'none'}${st.transcript === 'running' || st.transcript === 'queued' ? ' (in progress — retry soon)' : ' (call analyze_media)'}`);
  if (a.descriptions?.summary || a.descriptions?.tags?.length) {
    L.push('', '## AI visual notes');
    if (a.descriptions.summary) L.push(a.descriptions.summary);
    if (a.descriptions.tags?.length) L.push(`tags: ${a.descriptions.tags.join(', ')}`);
  }
  if (a.shots?.length) {
    L.push('', `## Shots (${a.shots.length})`);
    const notes = a.descriptions?.scenes || [];
    for (const [i, s] of a.shots.entries()) {
      if (s.end < start || s.start > end) continue;
      const n = notes.filter((d) => d.start < s.end && d.end > s.start).map((d) => d.text).join(' / ');
      L.push(`- shot ${i + 1} [${fmt(s.start)}–${fmt(s.end)}] ${fmtDur(s.end - s.start)}${n ? ` — ${n}` : ''}`);
      if (L.join('\n').length > maxChars * 0.35) { L.push(`… (${a.shots.length - i - 1} more shots)`); break; }
    }
  } else if (a.descriptions?.scenes?.length) {
    L.push('', '## Scene notes');
    for (const d of a.descriptions.scenes) L.push(`- [${fmt(d.start)}–${fmt(d.end)}] ${d.text}`);
  }
  if (a.transcript) {
    const segs = a.transcript.segments.filter((s) => s.end > start && s.start < end);
    L.push('', `## Transcript (${a.transcript.language || '?'}, ${a.transcript.wordCount} words, model ${a.transcript.model})`);
    let used = L.join('\n').length;
    let shown = 0;
    for (const s of segs) {
      const line = `[${fmt(s.start)}–${fmt(s.end)}] ${s.text}`;
      if (used + line.length > maxChars) { L.push(`… ${segs.length - shown} more segments — call get_transcript with start/end to read the rest.`); break; }
      L.push(line); used += line.length + 1; shown++;
    }
    if (!segs.length) L.push('(no speech detected)');
  }
  if (m.notes) L.push('', `## Notes`, m.notes);
  return L.join('\n');
}

/** Text description of the current edit (what is where), with transcript excerpts. */
export function timelineReport(project, { maxChars = 14000 } = {}) {
  const L = [];
  const dur = project.clips.reduce((d, c) => Math.max(d, clipEnd(c)), 0);
  L.push(`Project "${project.name}" — ${project.settings.width}×${project.settings.height} @ ${project.settings.fps}fps — duration ${fmtDur(dur)} — ${project.clips.length} clips`);
  const order = [...project.tracks.filter((t) => t.type === 'video').reverse(), ...project.tracks.filter((t) => t.type === 'audio')];
  for (const t of order) {
    const clips = project.clips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start);
    const flags = [t.muted && 'muted', t.hidden && 'hidden', t.locked && 'locked', t.solo && 'solo'].filter(Boolean).join(',');
    L.push(`\n${t.name} (${t.type}${flags ? `, ${flags}` : ''}) — ${clips.length} clip(s)`);
    for (const c of clips) {
      const m = mediaById(project, c.mediaId);
      let desc = '';
      if (c.type === 'html') desc = c.html?.template ? `motion:${c.html.template} ${JSON.stringify(c.html.params || {}).slice(0, 120)}` : c.html?.file ? `html file ${c.html.file.split(/[\\/]/).pop()}` : 'custom html';
      else if (c.type === 'color') desc = `color ${c.fill}`;
      else desc = `${m?.name || '?'} src ${fmt(c.in)}–${fmt(c.in + c.duration * c.speed)}`;
      const props = [];
      if (c.speed !== 1) props.push(`speed ${c.speed}`);
      if (c.volume !== 1) props.push(`vol ${c.volume}`);
      if (c.muted) props.push('muted');
      if (c.scale !== 1 || c.x || c.y) props.push(`pos ${Math.round(c.x)},${Math.round(c.y)} scale ${c.scale}`);
      if (c.opacity !== 1) props.push(`opacity ${c.opacity}`);
      if (c.transition) props.push(`transition-in ${c.transition.type} ${c.transition.duration}s`);
      if (c.keyframes) props.push(`keyframes ${Object.keys(c.keyframes).join('/')}`);
      if (c.fadeIn || c.fadeOut) props.push(`audio fades ${c.fadeIn}/${c.fadeOut}`);
      if (c.color) props.push('color-graded');
      if (c.chromaKey) props.push('chroma-key');
      if (c.anim) props.push(`anim ${[c.anim.in && `in:${c.anim.in.type}`, c.anim.out && `out:${c.anim.out.type}`, c.anim.loop && `loop:${c.anim.loop.type}`].filter(Boolean).join(' ')}`);
      if (c.radius || c.border || c.shadow) props.push(`frame${c.radius ? ` r${c.radius}` : ''}${c.border ? ' border' : ''}${c.shadow ? ' shadow' : ''}`);
      if (c.label === 'auto-sfx') props.push('auto-sfx');
      let speech = '';
      if (m && (c.type === 'video' || c.type === 'audio')) {
        const words = wordsInRange(m.id, c.in, c.in + c.duration * c.speed);
        if (words.length) {
          const txt = words.map((w) => w.text).join(' ');
          speech = ` · says: "${txt.length > 140 ? txt.slice(0, 140) + '…' : txt}"`;
        }
      }
      L.push(`  [${fmt(c.start)}–${fmt(clipEnd(c))}] ${c.id} ${c.type} ${desc}${props.length ? ` (${props.join(', ')})` : ''}${speech}`);
      if (L.join('\n').length > maxChars) { L.push('  … (truncated)'); break; }
    }
  }
  const subs = project.subtitles;
  L.push(`\nSubtitles: ${subs.cues.length} cue(s), ${subs.enabled ? 'visible' : 'hidden'}, style ${subs.style?.preset || 'custom'}`);
  if (project.markers.length) L.push(`Markers: ${project.markers.map((mk) => `${fmt(mk.time)} ${mk.label}`).join(' | ')}`);
  if (project.notes) L.push(`\nProject notes: ${project.notes.slice(0, 1500)}`);
  return L.join('\n');
}

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();

/** Search transcripts + AI notes of all media. Returns matches with times. */
export function searchMedia(query, { mediaIds = null, limit = 40 } = {}) {
  const q = norm(query);
  if (!q) return [];
  const qWords = q.split(' ');
  const out = [];
  const qTokens = q.split(/[\s'’-]+/).filter(Boolean);
  for (const m of store.project.media) {
    if (mediaIds && !mediaIds.includes(m.id)) continue;
    const a = loadAnalysis(m.id);
    if (a.transcript) {
      for (const s of a.transcript.segments) {
        // tokens split on spaces/apostrophes/hyphens ("l'intelligence" → "l", "intelligence"), mapped back to words
        const toks = [];
        s.words.forEach((w, wi) => { for (const tk of norm(w.text).split(/[\s'’-]+/).filter(Boolean)) toks.push({ tk, wi }); });
        for (let i = 0; i < toks.length; i++) {
          let ok = true;
          for (let k = 0; k < qTokens.length; k++) {
            const w = toks[i + k]?.tk;
            if (!w || !(k === qTokens.length - 1 ? w.startsWith(qTokens[k]) : w === qTokens[k])) { ok = false; break; }
          }
          if (ok) {
            const w0 = s.words[toks[i].wi], w1 = s.words[toks[Math.min(toks.length - 1, i + qTokens.length - 1)].wi];
            out.push({ mediaId: m.id, media: m.name, kind: 'speech', start: w0.start, end: w1.end, context: s.text, segment: { start: s.start, end: s.end } });
            if (out.length >= limit) return out;
          }
        }
      }
    }
    void qWords;
    for (const d of a.descriptions?.scenes || []) {
      if (norm(d.text).includes(q)) out.push({ mediaId: m.id, media: m.name, kind: 'visual-note', start: d.start, end: d.end, context: d.text });
    }
    if (a.descriptions?.summary && norm(a.descriptions.summary).includes(q)) out.push({ mediaId: m.id, media: m.name, kind: 'summary', start: 0, end: m.duration, context: a.descriptions.summary.slice(0, 200) });
    if (norm(m.name).includes(q) || (m.tags || []).some((t) => norm(t).includes(q))) out.push({ mediaId: m.id, media: m.name, kind: 'name/tag', start: 0, end: m.duration, context: m.name });
    if (out.length >= limit) break;
  }
  return out;
}

/** Map transcripts of audible timeline clips to timeline time → words for subtitles. */
export function timelineWords(project, { tracks = null } = {}) {
  const out = [];
  const anySolo = project.tracks.some((t) => t.solo);
  for (const c of project.clips) {
    if (c.muted || (c.type !== 'video' && c.type !== 'audio')) continue;
    const t = trackById(project, c.trackId);
    if (!t || t.muted || (anySolo && !t.solo)) continue;
    if (tracks && !tracks.includes(t.id) && !tracks.includes(t.name)) continue;
    const m = mediaById(project, c.mediaId);
    if (!m?.hasAudio) continue;
    const a = c.in, b = c.in + c.duration * c.speed;
    for (const w of wordsInRange(m.id, a, b)) {
      const s = c.start + (w.start - c.in) / c.speed;
      const e = c.start + (w.end - c.in) / c.speed;
      if (s < c.start - 0.02 || e > clipEnd(c) + 0.05) continue;
      out.push({ text: w.text, start: Math.round(s * 1000) / 1000, end: Math.round(Math.min(e, clipEnd(c)) * 1000) / 1000, clipId: c.id });
    }
  }
  out.sort((x, y) => x.start - y.start);
  // drop overlapping duplicates (same audio on two tracks)
  const res = [];
  for (const w of out) {
    const last = res[res.length - 1];
    if (last && w.start < last.end - 0.05 && w.text === last.text) continue;
    res.push(w);
  }
  return res;
}

export function analysisDirFor(mediaId) {
  const d = path.join(store.dir, '.aicut-cache', 'media', mediaId, 'frames');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
