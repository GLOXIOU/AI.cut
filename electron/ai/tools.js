// MCP tool catalogue. Each tool: { name, title, description, schema (zod raw shape), annotations, handler(args, ctx) }.
// Handlers return { json } | { text } | { json, image } and may throw (→ isError result for the AI).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { store } from '../project/store.js';
import { RESOLUTION_PRESETS } from '../project/schema.js';
import { OPS } from '../project/ops.js';
import { jobs, snapshot } from '../core/jobs.js';
import { bus } from '../core/bus.js';
import { getSettings } from '../core/settings.js';
import { importPaths, waitForProbe } from '../media/service.js';
import {
  analyzeMedia, mediaReport, getTranscript, searchMedia, describeMedia, loadAnalysis, timelineReport, summarize,
} from '../analysis/index.js';
import { detectSilences } from '../analysis/audio-analysis.js';
import { motionTemplates, getTemplate, composeHtmlClip, htmlClipParams } from '../render/html.js';
import { searchLibrary, creditsText, isLocalLibraryId, SFX_CATEGORIES, MUSIC_CATEGORIES } from '../library/library.js';
import { MEMES, STICKER_POSITIONS } from '../../shared/memes.js';
import { searchYoutube, videoInfo } from '../youtube/ytdlp.js';
import { EXPORT_PRESETS } from '../export/presets.js';
import { SUBTITLE_PRESETS, cuesToSrt, cuesToVtt, parseSrt } from '../../shared/subtitles.js';
import { TRANSITIONS, TRANSITION_IDS } from '../../shared/transitions.js';
import { FONT_FAMILIES } from '../../shared/fonts.js';
import { clipById, trackById, mediaById, projectDuration, r4, FITS, EASING_NAMES, KEYFRAME_PROPS } from '../../shared/timeline.js';
import { ANIM_IN_IDS, ANIM_OUT_IDS, ANIM_LOOP_IDS, STILL_LOOP_IDS, animCatalog } from '../../shared/anim.js';
import { SUBTITLE_MODES, SUBTITLE_HIGHLIGHTS, SUBTITLE_ANIMATIONS, KEYWORD_ANIMATIONS, SUBTITLE_BACKGROUNDS, cueWords, resolveSubtitleStyle, keywordFlags } from '../../shared/subtitles.js';
import { download, safeFileName, uniquePath } from '../core/util.js';
import * as S from '../services.js';
import { importMotionFiles } from '../library/motion-library.js';
import { AUDIO_FX, AUDIO_FX_IDS } from '../../shared/audiofx.js';
import * as PRO from '../edit-pro.js';
import * as CR from '../creative.js';
import { startCutout, placeBehind } from '../segment/cutout.js';
import { separateStems } from '../segment/stems.js';
import { analyzeStyleJob, styleRef, styleRecipe } from '../style/reference.js';
import { AFX, AFX_PRESETS, AFX_TYPES } from '../../shared/dsp.js';
import { LOOKS, LOOK_IDS, GRADE_KEYS } from '../../shared/grade.js';
import { MASK_SHAPES, ANCHORS } from '../../shared/fx.js';
import { startProposal, finishProposal, sessionKey, requestContext } from './proposals.js';
import { proposalInfo } from '../../shared/proposals.js';
import { ensureBeats } from '../analysis/index.js';

export const TOOLS = [];
const tool = (name, def) => TOOLS.push({ name, ...def });
const RO = { readOnlyHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const NET = { readOnlyHint: false, openWorldHint: true };
const meta = (ctx, label) => ({ source: 'ai', client: ctx.client, ...(label ? { label } : {}) });
const needProject = () => store.requireOpen();

function trackName(p, id) { return trackById(p, id)?.name || id; }
export function clipInfo(p, c) {
  if (!c) return null;
  const o = { id: c.id, type: c.type, track: trackName(p, c.trackId), start: c.start, end: r4(c.start + c.duration), duration: c.duration, name: c.name };
  if (c.mediaId) Object.assign(o, { mediaId: c.mediaId, in: c.in, out: r4(c.in + c.duration * c.speed) });
  if (c.speed !== 1) o.speed = c.speed;
  if (c.html?.template) o.template = c.html.template;
  return o;
}
function mediaInfo(m) {
  const a = m.analysis || {};
  return {
    id: m.id, name: m.name, type: m.type, duration: m.duration, ...(m.width ? { size: `${m.width}x${m.height}` } : {}),
    ...(m.fps ? { fps: m.fps } : {}), hasAudio: !!m.hasAudio, status: m.status,
    transcript: a.transcript || 'none', ...(a.words ? { words: a.words, language: a.language } : {}),
    ...(a.shots ? { shots: a.shots } : {}), ...(a.bpm ? { bpm: a.bpm } : {}), ...(a.described ? { aiNotes: true } : {}),
    ...(m.source?.kind && m.source.kind !== 'import' ? { source: m.source.kind, license: m.source.license } : {}),
    ...(m.offline ? { offline: true } : {}), path: m.path,
  };
}
function editResult(res, extra = {}) {
  const p = store.project;
  const r = res.result;
  let clips;
  if (Array.isArray(r)) clips = r.map((c) => (c && c.id && c.trackId ? clipInfo(p, clipById(p, c.id) || c) : c));
  else if (r && r.id && r.trackId) clips = [clipInfo(p, clipById(p, r.id) || r)];
  const out = { ok: true, ...(clips ? { clips } : { result: r }), ...extra };
  if (res.warnings?.length) out.warnings = res.warnings;
  out.timelineDuration = projectDuration(p);
  return { json: out };
}
async function jobOutcome(job, maxSec = 25) {
  await jobs.wait(job.id, maxSec * 1000);
  const j = snapshot(job);
  if (j.status === 'done') return { json: { status: 'done', jobId: j.id, result: j.result } };
  if (j.status === 'error') throw new Error(`${j.title} failed: ${j.error}`);
  if (j.status === 'canceled') throw new Error(`${j.title} was canceled`);
  return { json: { status: j.status, jobId: j.id, progress: Math.round(j.progress * 100) + '%', message: j.message, hint: 'Still running — call wait_job with this jobId.' } };
}

// ---------------------------------------------------------------------------------------- schemas
const num = () => z.number();
const animIn = z.union([z.enum([...ANIM_IN_IDS, 'none']), z.object({ type: z.enum(ANIM_IN_IDS), duration: num().optional() })]).nullable();
const animOut = z.union([z.enum([...ANIM_OUT_IDS, 'none']), z.object({ type: z.enum(ANIM_OUT_IDS), duration: num().optional() })]).nullable();
const animLoop = z.union([z.enum([...ANIM_LOOP_IDS, 'none']), z.object({ type: z.enum(ANIM_LOOP_IDS), amount: num().optional(), speed: num().optional() })]).nullable();
const animSchema = z.object({ in: animIn.optional(), out: animOut.optional(), loop: animLoop.optional() }).nullable()
  .describe(`Clip animation (independent from keyframes): in = entrance (${ANIM_IN_IDS.join('|')}), out = exit (${ANIM_OUT_IDS.join('|')}), loop = continuous motion over the whole clip (${ANIM_LOOP_IDS.join('|')}; ${STILL_LOOP_IDS.join('/')} = "animated still image": the picture breathes and drifts very slightly as if floating on a cloud / in the wind). Strings or {type, duration} / {type, amount (intensity, 1 = default), speed}. Merged with the existing animation; null removes all.`);
const tr = () => z.string().describe('Track: name like "V1"/"V2"/"A1", a track id, or "auto" | "overlay" | "new"');
const colorSchema = z.object({
  brightness: num().optional(), contrast: num().optional(), saturation: num().optional(), hue: num().optional(),
  grayscale: num().optional(), sepia: num().optional(), invert: num().optional(), blur: num().optional(),
  exposure: num().optional(), temperature: num().optional(), tint: num().optional(), highlights: num().optional(), shadows: num().optional(),
  whites: num().optional(), blacks: num().optional(), fade: num().optional(), splitShadow: num().optional(), splitShadowHue: num().optional(),
  splitHighlight: num().optional(), splitHighlightHue: num().optional(),
}).partial().nullable().describe('Color grade. Basic: brightness/contrast/saturation multipliers (1 = neutral), hue degrees, grayscale/sepia/invert 0–1, blur px. Lumetri-like: exposure (stops -4..4), temperature (-1 cool..1 warm), tint (-1 green..1 magenta), highlights/shadows/whites/blacks (-1..1), fade (0..1 matte blacks), split toning splitShadow/splitHighlight (0..1) with splitShadowHue/splitHighlightHue (degrees). Preview = export.');
const maskSchema = z.object({
  shape: z.enum(MASK_SHAPES).optional(), cx: num().optional(), cy: num().optional(), w: num().optional(), h: num().optional(),
  feather: num().optional(), invert: z.boolean().optional(),
  follow: z.object({ tracking: z.string(), clip: z.string().optional(), anchor: z.enum(ANCHORS).optional(), offsetX: num().optional(), offsetY: num().optional(), size: z.boolean().optional() }).optional(),
}).nullable().describe('Mask of an adjustment layer in FRAME fractions: centre cx/cy (0..1), size w/h (0..1), feather px, invert (effect OUTSIDE the shape). follow {tracking} makes it move with a tracked object.');
const afxItem = z.object({ type: z.enum(AFX_TYPES) }).passthrough();
const visualProps = {
  name: z.string().optional(),
  volume: num().min(0).max(8).optional().describe('Audio gain: 1 = original, 0.25 ≈ background music'),
  muted: z.boolean().optional(),
  fadeIn: num().optional().describe('Audio fade-in (s)'),
  fadeOut: num().optional().describe('Audio fade-out (s)'),
  opacity: num().min(0).max(1).optional(),
  x: num().optional().describe('Horizontal offset of the clip centre from the frame centre, px'),
  y: num().optional().describe('Vertical offset (px, positive = down)'),
  scale: num().optional().describe('1 = fitted to frame'),
  rotation: num().optional().describe('degrees'),
  flipH: z.boolean().optional(), flipV: z.boolean().optional(),
  fit: z.enum(FITS).optional(),
  crop: z.object({ top: num(), right: num(), bottom: num(), left: num() }).partial().nullable().optional().describe('Fractions 0–0.95'),
  color: colorSchema.optional(),
  chromaKey: z.object({ color: z.enum(['green', 'blue']), strength: num(), threshold: num(), despill: num() }).partial().nullable().optional().describe('Remove green/blue screen (strength 2–12, threshold -0.1–0.3)'),
  vignette: num().min(0).max(1).optional(),
  videoFadeIn: num().optional().describe('Fade from transparent (s)'),
  videoFadeOut: num().optional().describe('Fade to transparent (s)'),
  transition: z.object({ type: z.enum(TRANSITION_IDS), duration: num() }).nullable().optional().describe('Transition INTO this clip from the previous clip on the same track'),
  label: z.string().nullable().optional(),
  anim: animSchema.optional(),
  audioFx: z.object({ preset: z.enum(AUDIO_FX_IDS) }).nullable().optional().describe(`Voice/audio effect: ${AUDIO_FX_IDS.join('|')}`),
  radius: num().min(0).optional().describe('Rounded corners in px (fitted space, scales with the clip). 24–60 for B-roll cards'),
  border: z.object({ width: num(), color: z.string() }).partial().nullable().optional().describe('Border inside the rounded frame, e.g. {width: 8, color: "#ffffff"}'),
  shadow: z.object({ blur: num(), x: num(), y: num(), opacity: num(), color: z.string() }).partial().nullable().optional().describe('Drop shadow in frame px, e.g. {blur: 40, y: 14, opacity: 0.45}'),
  fx: z.object({ blur: num().optional(), pixelate: num().optional() }).nullable().optional().describe('Adjustment layers only: blur (px σ) and pixelate (block px) of everything below'),
  mask: maskSchema.optional(),
  follow: z.object({ tracking: z.string(), clip: z.string().optional(), anchor: z.enum(ANCHORS).optional(), offsetX: num().optional(), offsetY: num().optional(), scale: z.boolean().optional() }).nullable().optional()
    .describe('Attach the clip to a tracking: its centre follows the tracked object (anchor on the tracked box + offset px; scale=true also follows its size). null detaches.'),
  afx: z.array(z.union([afxItem, z.string()])).nullable().optional().describe(`Audio effect chain of the clip (preview = export): items {type, ...params} or preset names. Types: ${AFX_TYPES.join(', ')}. Presets: ${Object.keys(AFX_PRESETS).join(', ')}`),
};
const placement = {
  track: tr().optional(),
  start: z.union([num(), z.literal('end')]).optional().describe('Timeline start (s). Omit or "end" = append after the last clip of the track'),
  mode: z.enum(['overwrite', 'insert', 'auto']).optional(),
};
const clipItem = z.object({
  mediaId: z.string().optional(),
  in: num().optional().describe('Source in-point (s)'),
  out: num().optional().describe('Source out-point (s)'),
  duration: num().optional().describe('Timeline duration (s) (alternative to out)'),
  speed: num().optional(),
  ...placement,
  ...visualProps,
}).passthrough();

// ======================================================================================== PROJECT
tool('get_project', {
  title: 'Get project state',
  description: 'Current project: settings, tracks, media (with analysis status), timeline summary, subtitles, markers, notes and what the user is looking at (playhead, selection). Call this first.',
  schema: { includeClips: z.boolean().optional().describe('Include every clip as JSON (default false; use get_timeline for a readable view)') },
  annotations: RO,
  handler: async ({ includeClips }) => {
    const p = store.project;
    if (!p) return { json: { open: false, recentProjects: (getSettings().recentProjects || []).slice(0, 8), hint: 'No project open: call create_project or open_project.' } };
    return {
      json: {
        open: true, name: p.name, file: store.file, folder: store.dir,
        settings: p.settings,
        duration: projectDuration(p),
        tracks: p.tracks.map((t) => ({ id: t.id, name: t.name, type: t.type, clips: p.clips.filter((c) => c.trackId === t.id).length, ...(t.muted ? { muted: true } : {}), ...(t.hidden ? { hidden: true } : {}), ...(t.locked ? { locked: true } : {}), ...(t.volume !== 1 ? { volume: t.volume } : {}), ...(t.pan ? { pan: t.pan } : {}), ...(t.afx ? { audioEffects: t.afx.map((x) => x.type) } : {}) })),
        media: p.media.map(mediaInfo),
        clipCount: p.clips.length,
        ...(includeClips ? { clips: p.clips } : {}),
        subtitles: { cues: p.subtitles.cues.length, enabled: p.subtitles.enabled, style: p.subtitles.style },
        markers: p.markers,
        notes: p.notes,
        trackings: (p.trackings || []).map((t) => ({ id: t.id, name: t.name, kind: t.kind, mediaId: t.mediaId })),
        openRequests: (p.requests || []).filter((r) => r.status === 'open' || r.status === 'working').map((r) => ({ id: r.id, text: r.text, where: requestContext(p, r) })),
        proposals: (p.proposals || []).filter((x) => x.status === 'pending' || x.status === 'recording').map(proposalInfo),
        styleReferences: (p.styleRefs || []).map((x) => ({ id: x.id, name: x.name, pacing: x.profile?.pacing?.feel })),
        ui: { playhead: r4(S.uiState.playhead), selectedClips: S.uiState.selection, playing: S.uiState.playing, ...(S.uiState.inPoint != null ? { inPoint: S.uiState.inPoint, outPoint: S.uiState.outPoint } : {}) },
        activeJobs: jobs.list({ active: true }).map((j) => ({ id: j.id, title: j.title, progress: Math.round(j.progress * 100) + '%' })),
      },
    };
  },
});

tool('create_project', {
  title: 'Create project',
  description: `Create and open a new project. Presets: ${Object.entries(RESOLUTION_PRESETS).map(([k, v]) => `${k} (${v.width}x${v.height})`).join(', ')}.`,
  schema: { name: z.string(), preset: z.enum(Object.keys(RESOLUTION_PRESETS)).optional(), fps: num().optional(), folder: z.string().optional().describe('Parent folder (default: Documents/AI.cut Projects)') },
  annotations: EDIT,
  handler: async (a) => { const r = S.createProject(a); return { json: { ok: true, file: r.file, folder: r.dir, settings: r.project.settings } }; },
});

tool('open_project', {
  title: 'Open project',
  description: 'Open an existing .aicut project file (see get_project → recentProjects).',
  schema: { path: z.string() },
  annotations: EDIT,
  handler: async ({ path: p }) => { const r = S.openProject(p); return { json: { ok: true, name: r.project.name, media: r.project.media.length, clips: r.project.clips.length } }; },
});

tool('update_project_settings', {
  title: 'Project settings',
  description: 'Change name, resolution (preset or width/height), fps, background colour, master volume, loudness normalisation (-14 LUFS on export), and autoBroll: automatic animation for every image/video placed on an overlay track (V2+) — {enabled, in, inDuration, out, outDuration, imageLoop (e.g. "cloud"/"living"), videoLoop, radius, shadow}.',
  schema: {
    name: z.string().optional(), preset: z.enum(Object.keys(RESOLUTION_PRESETS)).optional(), width: num().optional(), height: num().optional(), fps: num().optional(), background: z.string().optional(), masterVolume: num().optional(), normalizeLoudness: z.boolean().optional(),
    autoBroll: z.object({ enabled: z.boolean(), in: z.string(), inDuration: num(), out: z.string(), outDuration: num(), imageLoop: z.string(), videoLoop: z.string(), radius: num(), shadow: z.boolean() }).partial().optional(),
  },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('setProjectSettings', a, meta(ctx, 'project settings'))),
});

tool('set_project_notes', {
  title: 'Project notes',
  description: 'Save your edit plan / brief / decisions in the project (persisted, visible to future sessions).',
  schema: { notes: z.string() },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('setNotes', a, meta(ctx, 'notes'))),
});

tool('undo', {
  title: 'Undo', description: 'Undo the last edit step(s).', schema: { steps: num().optional() }, annotations: EDIT,
  handler: async ({ steps = 1 }) => { const labels = []; for (let i = 0; i < steps; i++) { const l = store.undo(); if (!l) break; labels.push(l); } return { json: { undone: labels } }; },
});
tool('redo', {
  title: 'Redo', description: 'Redo undone step(s).', schema: { steps: num().optional() }, annotations: EDIT,
  handler: async ({ steps = 1 }) => { const labels = []; for (let i = 0; i < steps; i++) { const l = store.redo(); if (!l) break; labels.push(l); } return { json: { redone: labels } }; },
});
tool('history', {
  title: 'Edit history', description: 'Recent undo history (who did what).', schema: {}, annotations: RO,
  handler: async () => ({ json: { steps: store.historyList().slice(0, 40) } }),
});
tool('checkpoint', {
  title: 'Save checkpoint', description: 'Save a named version of the whole edit (safe point before big changes).', schema: { name: z.string() }, annotations: EDIT,
  handler: async ({ name }) => { needProject(); return { json: store.createCheckpoint(name) }; },
});
tool('restore_checkpoint', {
  title: 'Restore checkpoint', description: 'Restore a checkpoint (list them with list_checkpoints). Undoable.', schema: { id: z.string() }, annotations: DESTRUCTIVE,
  handler: async ({ id }, ctx) => editResult(store.restoreCheckpoint(id, meta(ctx))),
});
tool('list_checkpoints', { title: 'List checkpoints', description: 'Saved versions of the edit.', schema: {}, annotations: RO, handler: async () => ({ json: store.listCheckpoints() }) });

// ======================================================================================== MEDIA
tool('import_media', {
  title: 'Import media',
  description: 'Import local files/folders (video, audio, images, .html, Lottie .json) or direct http(s) file URLs. Analysis (transcript, shots, silences) starts automatically.',
  schema: { paths: z.array(z.string()).optional(), urls: z.array(z.string()).optional().describe('Direct file URLs to download (for YouTube use youtube_download)') },
  annotations: EDIT,
  handler: async ({ paths = [], urls = [] }, ctx) => {
    needProject();
    const files = [...paths];
    for (const u of urls) {
      const name = safeFileName(decodeURIComponent(new URL(u).pathname.split('/').pop() || 'download'));
      const dest = uniquePath(path.join(store.dir, 'media', 'downloads', name.includes('.') ? name : `${name}.bin`));
      await download(u, dest);
      files.push(dest);
    }
    const recs = importPaths(files, { source: 'ai', client: ctx.client });
    const out = [];
    for (const r of recs) { const m = await waitForProbe(r.id, 30000); out.push(mediaInfo(m || r)); }
    return { json: { imported: out, hint: 'Transcription runs in the background; get_media_report shows progress.' } };
  },
});

tool('list_media', { title: 'List media', description: 'Media in the project with analysis status.', schema: {}, annotations: RO, handler: async () => ({ json: needProject().media.map(mediaInfo) }) });

tool('analyze_media', {
  title: 'Analyze media (video → text)',
  description: 'Run/refresh analysis: speech transcription with word timestamps (whisper, GPU), shot detection, silences, loudness, beats/BPM (music). Waits up to waitSec then returns a jobId.',
  schema: { mediaIds: z.array(z.string()), transcribe: z.boolean().optional(), scenes: z.boolean().optional(), beats: z.boolean().optional(), language: z.string().optional().describe('ISO code like "fr", "en" (default auto)'), prompt: z.string().optional().describe('Extra spelling hints for Whisper (names, jargon) on top of the project vocabulary (set_vocabulary)'), force: z.boolean().optional(), waitSec: num().optional() },
  annotations: EDIT,
  handler: async ({ mediaIds, waitSec = 25, ...o }) => {
    needProject();
    const jobsList = mediaIds.map((id) => analyzeMedia(id, o));
    const results = [];
    for (const j of jobsList) results.push((await jobOutcome(j, waitSec / jobsList.length + 1)).json);
    return { json: results };
  },
});

tool('get_media_report', {
  title: 'Media report (video → text)',
  description: 'Everything known about a media as text: specs, loudness, BPM, shots (with your saved visual notes), full timestamped transcript. Optionally restrict to [start, end] (source seconds).',
  schema: { mediaId: z.string(), start: num().optional(), end: num().optional(), maxChars: num().optional() },
  annotations: RO,
  handler: async ({ mediaId, ...o }) => { needProject(); await waitForProbe(mediaId, 20000); return { text: mediaReport(mediaId, o) }; },
});

tool('get_transcript', {
  title: 'Transcript',
  description: 'Timestamped transcript of a media (source seconds). format: segments (sentences), words (word-level timing for precise cuts) or text.',
  schema: { mediaId: z.string(), start: num().optional(), end: num().optional(), format: z.enum(['segments', 'words', 'text']).optional() },
  annotations: RO,
  handler: async ({ mediaId, ...o }) => {
    needProject();
    const t = getTranscript(mediaId, o);
    if (!t) return { json: { transcript: null, status: mediaById(store.project, mediaId)?.analysis?.transcript || 'none', hint: 'Call analyze_media.' } };
    return { json: t };
  },
});

tool('search_media', {
  title: 'Search media',
  description: 'Find where words are SAID (transcripts) or SHOWN (your saved visual notes) across all media. Returns media ids and source times.',
  schema: { query: z.string(), mediaIds: z.array(z.string()).optional() },
  annotations: RO,
  handler: async ({ query, mediaIds }) => { needProject(); return { json: searchMedia(query, { mediaIds }) }; },
});

tool('view_media_frames', {
  title: 'Look at media',
  description: 'See a source media: returns a labelled contact sheet image of evenly spaced frames (or given times). Use it to understand visuals, then save what you saw with describe_media.',
  schema: { mediaId: z.string(), start: num().optional(), end: num().optional(), count: num().optional().describe('frames, default 12, max 36'), times: z.array(num()).optional(), cols: num().optional() },
  annotations: RO,
  handler: async ({ mediaId, ...o }) => { const r = await S.viewMediaFrames(mediaId, o); return { json: { times: r.times, image: r.image }, image: r.image }; },
});

tool('describe_media', {
  title: 'Save visual notes',
  description: 'Store your understanding of a media (summary, per-scene descriptions with source times, tags). Persisted; shown in get_media_report and searchable.',
  schema: { mediaId: z.string(), summary: z.string().optional(), scenes: z.array(z.object({ start: num(), end: num(), text: z.string() })).optional(), tags: z.array(z.string()).optional(), append: z.boolean().optional() },
  annotations: EDIT,
  handler: async ({ mediaId, ...o }) => { needProject(); const d = describeMedia(mediaId, o); return { json: { ok: true, scenes: d.scenes?.length || 0, summary: !!d.summary } }; },
});

tool('get_beats', {
  title: 'Beats, bars, sections, drops',
  description: 'Music structure of a media (source seconds): BPM, beat and downbeat (bar) times, the tempo grid (constant-tempo tracks: grid fitted on the whole song, no drift — bar n starts at firstDownbeat + n × 4 × beatSec), and the sections (intro, build, drop, break, outro…) with their energy. Use downbeats / section starts to cut on the music. Add `beats:false` for a short answer.',
  schema: { mediaId: z.string(), start: num().optional(), end: num().optional(), beats: z.boolean().optional().describe('include every beat time (default true)') }, annotations: RO,
  handler: async ({ mediaId, start = 0, end = Infinity, beats = true }) => {
    needProject();
    const b = await ensureBeats(mediaId);
    if (!b) return { json: { beats: null, hint: 'Could not detect a tempo (not music, or no audio).' } };
    const inR = (t) => t >= start && t <= end;
    return {
      json: {
        bpm: b.bpm, confidence: b.confidence, grid: b.grid, bars: b.bars,
        sections: (b.sections || []).filter((x) => x.end >= start && x.start <= end), drops: (b.drops || []).filter(inR),
        downbeats: b.downbeats.filter(inR), ...(beats ? { beats: b.beats.filter(inR) } : {}),
      },
    };
  },
});

tool('get_silences', {
  title: 'Silences', description: 'Silent ranges (source seconds) of a media, adaptive threshold. Useful to plan jump cuts.',
  schema: { mediaId: z.string(), minSilence: num().optional() }, annotations: RO,
  handler: async ({ mediaId, minSilence }) => {
    needProject();
    const a = loadAnalysis(mediaId);
    if (!a.silences) return { json: { silences: null, hint: 'Call analyze_media first.' } };
    const list = minSilence ? a.silences.filter((s) => s.end - s.start >= minSilence) : a.silences;
    return { json: { thresholdDb: a.audio?.thresholdDb, silences: list } };
  },
});

tool('update_media', {
  title: 'Rename / annotate media', description: 'Rename a media or set notes/tags.', schema: { mediaId: z.string(), name: z.string().optional(), notes: z.string().optional(), tags: z.array(z.string()).optional() }, annotations: EDIT,
  handler: async ({ mediaId, ...o }, ctx) => editResult(store.apply('updateMedia', { id: mediaId, ...o }, meta(ctx, 'update media'))),
});
tool('remove_media', {
  title: 'Remove media', description: 'Remove media from the project (and every clip using it). Files on disk are kept.', schema: { mediaIds: z.array(z.string()) }, annotations: DESTRUCTIVE,
  handler: async ({ mediaIds }, ctx) => editResult(store.apply('removeMedia', { ids: mediaIds }, meta(ctx, 'remove media'))),
});

// ======================================================================================== TIMELINE
tool('get_timeline', {
  title: 'Read the timeline',
  description: 'The current edit. Default: readable report of every clip per track (times, source ranges, properties, what is said). format "compact": one short line per clip; "json": clip list. start / end (timeline s), tracks (names like "V1", "A2") and types filter the clips — use them on long timelines instead of reading everything.',
  schema: {
    maxChars: num().optional(), format: z.enum(['report', 'compact', 'json']).optional(), start: num().optional(), end: num().optional(),
    tracks: z.array(z.string()).optional(), types: z.array(z.enum(['video', 'audio', 'image', 'html', 'color'])).optional(),
  },
  annotations: RO,
  handler: async ({ maxChars, format, ...f }) => {
    const p = needProject();
    if (!format || format === 'report') {
      if (f.start == null && f.end == null && !f.tracks?.length && !f.types?.length) return { text: timelineReport(p, { maxChars }) };
      format = 'compact';
    }
    const r = PRO.timelineListing(p, { ...f, format });
    return r.text ? { text: r.text } : { json: r };
  },
});

tool('time_map', {
  title: 'Source ↔ timeline time',
  description: 'Convert times. {mediaId, sourceTime}: where that instant of the media is on the timeline (every clip using it; if it was cut out, the nearest use). {time, track?}: what is under a timeline time (clip, media and source time).',
  schema: { mediaId: z.string().optional(), sourceTime: num().optional(), time: num().optional(), track: z.string().optional() }, annotations: RO,
  handler: async (a) => ({ json: PRO.timeMap(needProject(), a) }),
});

tool('add_clip', {
  title: 'Add clip',
  description: 'Place a media on the timeline. Video → V1 by default (append), images/motion → overlay track, audio → free audio track. in/out are SOURCE seconds; start is TIMELINE seconds. Also accepts template+params (motion) or fill (colour matte).',
  schema: { ...clipItem.shape, template: z.string().optional(), params: z.record(z.string(), z.any()).optional(), fill: z.string().optional().describe('Colour matte, e.g. #000000') },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('addClip', a, meta(ctx, 'add clip'))),
});

tool('add_clips', {
  title: 'Add several clips',
  description: 'Add many clips in one undo step. sequential=true places items back-to-back (on `track`, starting at `start` or the end of the track).',
  schema: { items: z.array(clipItem), sequential: z.boolean().optional(), track: tr().optional(), start: num().optional(), gap: num().optional(), mode: z.enum(['overwrite', 'insert', 'auto']).optional() },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('addClips', a, meta(ctx, `add ${a.items.length} clips`))),
});

tool('assemble_sequence', {
  title: 'Assemble a sequence (rough cut)',
  description: 'Build a cut from selects: items [{mediaId, in, out, transition?…}] are placed back-to-back on a track (default V1). replace=true clears the track first. Typical: pick sentences from get_transcript and assemble them.',
  schema: { items: z.array(clipItem), track: tr().optional(), start: num().optional(), replace: z.boolean().optional(), gap: num().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => {
    const res = store.apply('assembleSequence', a, meta(ctx, `assemble ${a.items.length} clips`));
    const p = store.project;
    return { json: { ok: true, track: res.result.track, end: res.result.end, clips: res.result.clips.map((c) => clipInfo(p, clipById(p, c.id) || c)), warnings: res.warnings, timelineDuration: projectDuration(p) } };
  },
});

tool('update_clip', {
  title: 'Update clip',
  description: 'Change any clip property: timing (start, duration, in/out, speed, track), audio (volume, muted, fades), transform (x, y, scale, rotation, opacity, fit, crop, flip), color grade, chroma key, vignette, transition-in, video fades. Motion clips: params/template/html.',
  schema: { id: z.string(), start: num().optional(), duration: num().optional(), in: num().optional(), out: num().optional(), speed: num().optional(), track: tr().optional(), ...visualProps, params: z.record(z.string(), z.any()).optional(), template: z.string().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('updateClip', a, meta(ctx, 'update clip'))),
});

tool('update_clips', {
  title: 'Update several clips', description: 'Batch version of update_clip (one undo step).',
  schema: { items: z.array(z.object({ id: z.string() }).passthrough()) }, annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('updateClips', a, meta(ctx, `update ${a.items.length} clips`))),
});

tool('split', {
  title: 'Split (razor)', description: 'Cut a clip in two at a timeline time (id given) or cut every clip crossing that time (optionally only some tracks).',
  schema: { time: num(), id: z.string().optional(), tracks: z.array(z.string()).optional() }, annotations: EDIT,
  handler: async ({ time, id, tracks }, ctx) => (id ? editResult(store.apply('splitClip', { id, time }, meta(ctx, 'split'))) : editResult(store.apply('splitAt', { time, tracks }, meta(ctx, 'split all')))),
});

tool('trim_clip', {
  title: 'Trim clip', description: 'Move the start or end edge of a clip to a timeline time (keeps media in sync). ripple=true shifts the following clips on that track.',
  schema: { id: z.string(), edge: z.enum(['start', 'end']), time: num(), ripple: z.boolean().optional() }, annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('trimClip', a, meta(ctx, 'trim'))),
});

tool('delete_clips', {
  title: 'Delete clips', description: 'Remove clips. ripple=true closes the gaps on their tracks.',
  schema: { ids: z.array(z.string()), ripple: z.boolean().optional() }, annotations: DESTRUCTIVE,
  handler: async (a, ctx) => editResult(store.apply('removeClips', a, meta(ctx, `delete ${a.ids.length} clips`))),
});

tool('ripple_delete', {
  title: 'Cut out time ranges', description: 'Remove timeline ranges and close the gaps (all tracks by default, so everything stays in sync; subtitles & markers follow). ranges: [{start, end}] in timeline seconds.',
  schema: { ranges: z.array(z.object({ start: num(), end: num() })), tracks: z.array(z.string()).optional() }, annotations: DESTRUCTIVE,
  handler: async (a, ctx) => editResult(store.apply('rippleDeleteRanges', a, meta(ctx, `cut ${a.ranges.length} ranges`))),
});

tool('remove_silences', {
  title: 'Remove silences (jump cuts)', description: 'Automatically cut the pauses inside speech clips (default: clips on V1) using the silence analysis, keeping `padding` seconds around speech. Ripples the speech tracks (and their detached audio).',
  schema: { clipIds: z.array(z.string()).optional(), track: z.string().optional(), minSilence: num().optional().describe('default 0.45 s'), padding: num().optional().describe('default 0.12 s'), minClip: num().optional().describe('minimum length of a kept piece, default 0.7 s (shorter pieces with words are extended, without words removed; 0 = off)'), allTracks: z.boolean().optional() },
  annotations: DESTRUCTIVE,
  handler: async (a, ctx) => ({ json: S.removeSilences(a, meta(ctx)) }),
});

tool('insert_gap', {
  title: 'Insert space', description: 'Push everything after `at` by `duration` seconds (all tracks by default).',
  schema: { at: num(), duration: num(), tracks: z.array(z.string()).optional() }, annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('insertGap', a, meta(ctx, 'insert gap'))),
});

tool('duplicate_clips', {
  title: 'Duplicate clips', description: 'Copy clips (after themselves by default, or at `start`, optionally on another track).',
  schema: { ids: z.array(z.string()), start: num().optional(), offset: num().optional(), track: tr().optional() }, annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('duplicateClips', a, meta(ctx, 'duplicate'))),
});

tool('detach_audio', {
  title: 'Detach audio', description: 'Move the audio of a video clip to its own audio clip (for J/L cuts, separate volume). The video clip gets muted.',
  schema: { id: z.string(), track: tr().optional() }, annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('detachAudio', a, meta(ctx, 'detach audio'))),
});

tool('set_transition', {
  title: 'Transition', description: `Transition INTO a clip from the previous adjacent clip on its track (or from transparent). Types: ${TRANSITIONS.map((t) => t.id).join(', ')}. type "none" removes it. Typical duration 0.3–1 s.`,
  schema: { id: z.string(), type: z.enum([...TRANSITION_IDS, 'none']), duration: num().optional() }, annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('setTransition', a, meta(ctx, `transition ${a.type}`))),
});

tool('set_keyframes', {
  title: 'Keyframes', description: `Animate a property over the clip: property ${KEYFRAME_PROPS.join('|')}; keyframes [{t (s from clip start), v, ease ${EASING_NAMES.join('|')}}]. Empty list removes the animation.`,
  schema: { id: z.string(), property: z.enum(KEYFRAME_PROPS), keyframes: z.array(z.object({ t: num(), v: num(), ease: z.enum(EASING_NAMES).optional() })) }, annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('setKeyframes', a, meta(ctx, `keyframes ${a.property}`))),
});

tool('animate_clip', {
  title: 'Animation preset', description: 'Quick motion presets via keyframes: zoom-in (punch-in / Ken Burns), zoom-out, pan-left, pan-right, pop-in, slide-in-left/right/up/down, fade-in, fade-out, shake, pulse, none.',
  schema: { id: z.string(), preset: z.enum(['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pop-in', 'slide-in-left', 'slide-in-right', 'slide-in-up', 'slide-in-down', 'fade-in', 'fade-out', 'shake', 'pulse', 'none']), amount: num().optional(), duration: num().optional(), interval: num().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('animateClip', a, meta(ctx, `animate ${a.preset}`))),
});

tool('list_animations', {
  title: 'Clip animations catalogue',
  description: 'Entrance (in), exit (out) and continuous (loop) animations available for set_animation / anim, with labels. Loops marked still=true are the "animated still image" looks for photos (cloud, wind, living, dream, jelly).',
  schema: {}, annotations: RO,
  handler: async () => ({ json: animCatalog('en') }),
});

tool('set_animation', {
  title: 'Animate clips (B-roll entrance / exit / living image)',
  description: 'Give one or several visual clips an entrance (in), an exit (out) and/or a continuous motion (loop). Independent from keyframes and works with rounded corners. Typical B-roll: in "pop"/"slide-blur-left"/"fade-scale", out "fade", loop "cloud" or "living" for photos (animated still image), "kenburns-in" for full-frame photos. Strings or objects ({type, duration} for in/out, {type, amount, speed} for loop); "none" removes one part, clear=true removes everything.',
  schema: { ids: z.array(z.string()), in: animIn.optional(), out: animOut.optional(), loop: animLoop.optional(), clear: z.boolean().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('setAnimation', a, meta(ctx, `animate ${a.ids.length} clip(s)`))),
});

tool('set_frame_look', {
  title: 'Rounded corners / border / shadow',
  description: 'Card look for B-roll and picture-in-picture: radius (px, rounded corners), border {width, color}, shadow {blur, x, y, opacity, color}. null removes border/shadow. Applies to several clips at once.',
  schema: { ids: z.array(z.string()), radius: num().optional(), border: z.object({ width: num(), color: z.string() }).partial().nullable().optional(), shadow: z.object({ blur: num(), x: num(), y: num(), opacity: num(), color: z.string() }).partial().nullable().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('setFrameLook', a, meta(ctx, `frame look ${a.ids.length} clip(s)`))),
});

tool('manage_tracks', {
  title: 'Tracks', description: 'add (type video|audio), update (mute/hide/lock/solo/volume/name) or delete a track.',
  schema: { action: z.enum(['add', 'update', 'delete']), track: z.string().optional(), type: z.enum(['video', 'audio']).optional(), name: z.string().optional(), muted: z.boolean().optional(), hidden: z.boolean().optional(), locked: z.boolean().optional(), solo: z.boolean().optional(), volume: num().optional() },
  annotations: EDIT,
  handler: async ({ action, track, ...o }, ctx) => {
    if (action === 'add') return { json: store.apply('addTrack', { type: o.type || 'video', name: o.name }, meta(ctx, 'add track')).result };
    if (action === 'delete') return { json: store.apply('removeTrack', { track }, meta(ctx, 'delete track')).result };
    return { json: store.apply('updateTrack', { track, ...o }, meta(ctx, 'update track')).result };
  },
});

tool('markers', {
  title: 'Markers', description: 'add / update / delete timeline markers (chapters, beats, notes for the user).',
  schema: { action: z.enum(['add', 'update', 'delete']), id: z.string().optional(), time: num().optional(), label: z.string().optional(), color: z.string().optional(), ids: z.array(z.string()).optional() },
  annotations: EDIT,
  handler: async ({ action, ...o }, ctx) => {
    if (action === 'add') return { json: store.apply('addMarker', o, meta(ctx, 'marker')).result };
    if (action === 'update') return { json: store.apply('updateMarker', o, meta(ctx, 'marker')).result };
    return { json: store.apply('removeMarkers', { ids: o.ids || (o.id ? [o.id] : undefined) }, meta(ctx, 'delete markers')).result };
  },
});

tool('timeline_transcript', {
  title: 'Transcript of the edit (text-based editing)',
  description: 'Every word spoken in the current edit, in TIMELINE seconds, with its index and filler flag ("euh", "um"…). Use with delete_words to edit by text: removing words ripple-deletes their time on all tracks (subtitles & markers follow).',
  schema: { start: num().optional(), end: num().optional() }, annotations: RO,
  handler: async ({ start = 0, end = Infinity }) => ({ json: { words: S.sequenceTranscript().map((w, i) => ({ i, ...w, start: r4(w.start), end: r4(w.end) })).filter((w) => w.end > start && w.start < end) } }),
});

tool('delete_words', {
  title: 'Delete words (text-based editing)',
  description: 'Cut spoken words out of the edit by their indices in timeline_transcript: ranges [[from, to], …] (inclusive). The micro-pauses around them go too; everything after shifts left on all tracks.',
  schema: { ranges: z.array(z.tuple([num(), num()])) }, annotations: DESTRUCTIVE,
  handler: async ({ ranges }, ctx) => ({ json: S.deleteWords(ranges, meta(ctx, `delete ${ranges.length} word range(s)`)) }),
});

tool('remove_filler_words', {
  title: 'Remove filler words',
  description: 'Cut every filler word ("euh", "heu", "bah", "um", "uh", "er"…) out of the edit (ripple on all tracks). extra: more words to remove (e.g. ["genre", "voilà"]).',
  schema: { extra: z.array(z.string()).optional() }, annotations: DESTRUCTIVE,
  handler: async (a, ctx) => ({ json: S.removeFillers(a, meta(ctx)) }),
});

tool('auto_zooms', {
  title: 'Dynamic zooms (punch-ins)',
  description: 'Talking-head punch-in zooms on V1 at the most emphasised words (importance from the text, timing and vocal energy), released at the end of the phrase. style "cut" (instant jump zoom, TikTok/YouTube) or "smooth"; amount 0.08–0.25; every = average seconds between zooms. Replaces the scale keyframes of the V1 clips concerned.',
  schema: { amount: num().optional(), every: num().optional(), style: z.enum(['cut', 'smooth']).optional() }, annotations: EDIT,
  handler: async (a, ctx) => ({ json: S.autoZooms(a, meta(ctx)) }),
});

tool('layout_clip', {
  title: 'Layout preset (PIP / split screen / blurred background)',
  description: 'Position a visual clip with a preset: full (fill the frame), fit, pip-tr / pip-tl / pip-br / pip-bl (picture-in-picture corner with rounded corners + shadow), split-left / split-right / split-top / split-bottom (half of the frame), blur-fill (adds a blurred zoomed copy behind it — horizontal footage in a vertical video).',
  schema: { id: z.string(), preset: z.enum(['full', 'fit', 'pip-tr', 'pip-tl', 'pip-br', 'pip-bl', 'split-left', 'split-right', 'split-top', 'split-bottom', 'blur-fill']) }, annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('layoutClip', a, meta(ctx, `layout ${a.preset}`))),
});

tool('freeze_frame', {
  title: 'Freeze frame',
  description: 'Freeze the video frame at `time` (default: playhead) for `duration` s: the frame becomes a still clip, time is inserted (music keeps playing), with a slow zoom (zoom=false to disable) and a camera-shutter sound (sfx=false to disable).',
  schema: { time: num().optional(), duration: num().optional(), clipId: z.string().optional(), zoom: z.boolean().optional(), sfx: z.boolean().optional() }, annotations: EDIT,
  handler: async (a, ctx) => ({ json: await S.freezeFrame(a, meta(ctx)) }),
});

tool('beat_markers', {
  title: 'Markers on the beat',
  description: 'Add timeline markers on the beats (or downbeats) of a music clip (default: the longest music clip) — snapping then lets cuts land on the rhythm. every = keep one beat out of N.',
  schema: { clipId: z.string().optional(), downbeats: z.boolean().optional(), every: num().optional() }, annotations: EDIT,
  handler: async (a, ctx) => ({ json: await S.beatMarkers(a, meta(ctx)) }),
});

tool('youtube_chapters', {
  title: 'YouTube chapters',
  description: 'Chapters text for the YouTube description, built from the timeline markers (labels = titles). Add markers with labels first (markers tool).',
  schema: {}, annotations: RO,
  handler: async () => ({ json: S.youtubeChapters() }),
});

tool('animate_broll', {
  title: 'Animate all B-roll',
  description: 'Give every B-roll (images / videos on V2 and above) the same entrance / exit, and a continuous motion: imageLoop for photos (e.g. "living", "cloud"), videoLoop for videos. radius / shadow=true for a card look.',
  schema: { in: z.string().optional(), out: z.string().optional(), imageLoop: z.string().optional(), videoLoop: z.string().optional(), radius: num().optional(), shadow: z.boolean().optional() }, annotations: EDIT,
  handler: async (a, ctx) => ({ json: S.animateBroll(a, meta(ctx)) }),
});

tool('enhance_voices', {
  title: 'Voice effects on speech clips',
  description: `Apply a voice/audio preset to every clip containing speech: ${Object.entries(AUDIO_FX).map(([k, v]) => `${k} (${v.en})`).join(', ')}. null removes it. Single clips: update_clip audioFx {preset}.`,
  schema: { preset: z.enum(AUDIO_FX_IDS).nullable() }, annotations: EDIT,
  handler: async ({ preset }, ctx) => ({ json: S.enhanceVoices(preset, meta(ctx)) }),
});

tool('level_voices', {
  title: 'Level voices clip by clip',
  description: 'Measure the loudness (LUFS) of the speech in each clip and set every clip volume so all voices reach the same level (default -16 LUFS). Default: every clip with a transcript; or clipIds / track. dryRun=true only measures.',
  schema: { clipIds: z.array(z.string()).optional(), track: z.string().optional(), targetLufs: num().optional(), maxGainDb: num().optional(), dryRun: z.boolean().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: await PRO.levelVoices(a, meta(ctx)) }),
});

tool('sync_audio', {
  title: 'Synchronise recordings by their sound',
  description: 'Find the time offset between media that recorded the same sound (multicam angles, external mic, phone rush vs the clean music track). Returns for each media: offset (media at t = reference at t + offset), confidence (z-score, ≥ 6 reliable) and the method (waveform = sample-accurate). Then use place_synced or multicam, or place clips yourself with in = refTime − offset.',
  schema: { referenceMediaId: z.string(), mediaIds: z.array(z.string()), maxOffset: num().optional().describe('max |offset| in seconds (default: any)') },
  annotations: RO,
  handler: async (a) => ({ json: await PRO.syncAudio(a) }),
});

tool('place_synced', {
  title: 'Place a media in sync with a clip',
  description: 'Put a media (clean music, external mic…) on the timeline aligned with a reference clip that recorded the same sound (e.g. the phone rush filming the bar where the song plays). cover "clip" = same span as the reference clip, "media" = the whole media (full song). referenceVolume sets the reference clip volume afterwards (0 = replace its sound, 0.2 = keep some ambience). To identify an unknown song: read the lyrics in the transcript, search it (youtube_search / youtube_download), then place_synced — a wrong song is refused (low confidence).',
  schema: { referenceClipId: z.string(), mediaId: z.string(), track: z.string().optional(), cover: z.enum(['clip', 'media']).optional(), referenceVolume: num().optional(), maxOffset: num().optional(), force: z.boolean().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: await PRO.placeSynced(a, meta(ctx)) }),
});

tool('multicam', {
  title: 'Multicam edit on a common sound',
  description: 'Cut between several takes / angles that recorded the same sound, all synced to a master clip (e.g. the clean music on A1 or the main camera). Angles are synced automatically (sync_audio). cuts: [{at (timeline s), angle (index in angles or mediaId)}] to choose yourself; otherwise automatic switches every `every` ("beat" | "bar" | "2bars" | "4bars" on the master music, or seconds), round-robin among the angles covering each moment. Clips go on `track` (default V1, overwriting), muted unless angleAudio.',
  schema: {
    masterClipId: z.string(), angles: z.array(z.string()), cuts: z.array(z.object({ at: num(), angle: z.union([z.number(), z.string()]) })).optional(),
    every: z.union([z.enum(['beat', 'bar', '2bars', '4bars']), num()]).optional(), start: num().optional(), end: num().optional(), track: z.string().optional(),
    angleAudio: z.boolean().optional(), maxOffset: num().optional(), force: z.boolean().optional(),
  },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: await PRO.multicam(a, meta(ctx)) }),
});

tool('apply_recipe', {
  title: 'One-click edit recipe',
  description: `Chain the automatic tools in one go: ${Object.entries(S.RECIPES).map(([k, v]) => `${k} (${v.en})`).join(', ')}. short = silences + fillers + keyword subtitles + punch-in zooms + animated B-roll + auto SFX + ducking; podcast = silences + fillers + podcast voice + subtitles + loudness; vlog = emphasis subtitles + soft B-roll + clear voice + SFX; cinematic = grade + letterbox + Ken Burns + dissolves. Returns what was done / skipped.`,
  schema: { id: z.enum(Object.keys(S.RECIPES)) }, annotations: EDIT,
  handler: async ({ id }, ctx) => ({ json: await S.applyRecipe(id, meta(ctx)) }),
});

tool('auto_sfx', {
  title: 'Automatic sound design',
  description: 'Add sound effects automatically, matched to the edit: whoosh on transitions, a sound fitting each B-roll entrance animation (pop, whoosh, zoom whoosh, glitch…), pops on titles/graphics, optional pop/ka-ching on each keyword flash (subtitles keywords mode). Placed on dedicated "SFX" audio tracks; running it again replaces the previous automatic SFX. Run it after the visual edit is done.',
  schema: { transitions: z.boolean().optional(), broll: z.boolean().optional(), titles: z.boolean().optional(), keywords: z.boolean().optional(), volume: num().optional().describe('global SFX gain, default 0.6') },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: await S.autoSfx(a, meta(ctx)) }),
});

tool('duck_music', {
  title: 'Duck music under speech', description: 'Lower music automatically while people speak (volume keyframes from the transcripts). Default: all audio-only clips that are not speech.',
  schema: { clipIds: z.array(z.string()).optional(), track: z.string().optional(), amountDb: num().optional().describe('default -12 dB'), attack: num().optional(), release: num().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: S.duckMusic(a, meta(ctx)) }),
});

// ======================================================================================== MOTION / TEXT
tool('list_motion_templates', {
  title: 'Motion templates', description: 'Ready-made HTML motion graphics (titles, lower thirds, subscribe, counters, call-outs, confetti, transitions…) with their parameters, plus the user\'s imported animations (category "user", ids "user:…").',
  schema: { category: z.string().optional() }, annotations: RO,
  handler: async ({ category }) => ({ json: motionTemplates().filter((t) => !category || t.category === category).map((t) => ({ id: t.id, name: t.name, category: t.category, description: t.description, defaultDuration: t.defaultDuration, ...(t.user ? { user: true } : {}), params: (t.params || []).map((p) => ({ name: p.name, type: p.type, default: p.default, ...(p.options ? { options: p.options } : {}), ...(p.description ? { description: p.description } : {}) })) })) }),
});

tool('import_motion_template', {
  title: 'Import HTML animations',
  description: 'Import .html animation files (or folders of them) into the user\'s reusable animation library ("Mes animations"); their local assets are copied along. Any web animation works (CSS, canvas/requestAnimationFrame, GSAP, anime.js, Lottie): it is rendered on a virtual clock, frame-exact. Optional metadata in the file: <script type="application/json" id="aicut-template">{"name","defaultDuration","params":[…]}</script> with {{param}} placeholders. Returns the new template ids for add_motion.',
  schema: { paths: z.array(z.string()) },
  annotations: EDIT,
  handler: async ({ paths }) => ({ json: { imported: importMotionFiles(paths).map((t) => ({ id: t.id, name: t.name, defaultDuration: t.defaultDuration, params: t.params.map((p) => p.name) })) } }),
});

tool('add_motion', {
  title: 'Add motion graphic', description: 'Add a motion template on an overlay track (transparent background, frame-accurate). See list_motion_templates for ids and params.',
  schema: { template: z.string(), params: z.record(z.string(), z.any()).optional(), start: num(), duration: num().optional(), track: tr().optional(), ...visualProps },
  annotations: EDIT,
  handler: async (a, ctx) => {
    if (!getTemplate(a.template)) throw new Error(`Unknown template ${a.template}. Call list_motion_templates.`);
    return editResult(store.apply('addClip', { ...a, track: a.track || 'overlay' }, meta(ctx, `motion ${a.template}`)));
  },
});

tool('add_text', {
  title: 'Add text / title', description: `Add a text overlay (template "text"). style: font (${FONT_FAMILIES.slice(0, 8).join(', ')}…), size (px @1080p), weight, color, strokeColor, strokeWidth, background, align, uppercase; position: center|top|bottom|lower-third|upper-third; animation: fade|pop|slide-up|slide-left|typewriter|blur|none.`,
  schema: { text: z.string(), start: num(), duration: num().optional(), position: z.string().optional(), animation: z.string().optional(), style: z.record(z.string(), z.any()).optional(), track: tr().optional(), x: num().optional(), y: num().optional() },
  annotations: EDIT,
  handler: async ({ text, start, duration, position, animation, style = {}, track, x, y }, ctx) => {
    const params = { text, ...(position ? { position } : {}), ...(animation ? { animation } : {}), ...style };
    return editResult(store.apply('addClip', { template: 'text', params, start, duration: duration ?? 3, track: track || 'overlay', x, y, name: text.slice(0, 40) }, meta(ctx, 'add text')));
  },
});

tool('add_html_clip', {
  title: 'Add custom HTML motion design', description: 'Write your own animated graphic in HTML/CSS/JS (rendered frame-by-frame over the video with transparency). Rules: transparent background, size = project size, CSS @keyframes with animation-delay (var(--dur) = clip duration), or AICUT.onFrame(t => …) for JS/canvas. No timers/Date.now. Check it with preview_motion.',
  schema: { html: z.string(), css: z.string().optional(), js: z.string().optional(), start: num(), duration: num(), track: tr().optional(), name: z.string().optional(), params: z.record(z.string(), z.any()).optional(), ...visualProps },
  annotations: EDIT,
  handler: async ({ html, css, js, ...a }, ctx) => editResult(store.apply('addClip', { ...a, htmlCode: { html, css, js }, track: a.track || 'overlay', name: a.name || 'Custom motion' }, meta(ctx, 'custom motion'))),
});

tool('update_motion', {
  title: 'Edit motion graphic', description: 'Change a motion clip: params (merged), switch template, or replace custom html/css/js.',
  schema: { id: z.string(), params: z.record(z.string(), z.any()).optional(), template: z.string().optional(), html: z.string().optional(), css: z.string().optional(), js: z.string().optional() },
  annotations: EDIT,
  handler: async ({ id, html, css, js, ...a }, ctx) => {
    const c = clipById(needProject(), id);
    if (!c || c.type !== 'html') throw new Error('Not a motion/html clip');
    const patch = { id, ...a };
    if (html !== undefined || css !== undefined || js !== undefined) {
      const cur = c.html?.code || {};
      patch.htmlCode = { html: html ?? cur.html ?? '', css: css ?? cur.css ?? '', js: js ?? cur.js ?? '' };
    }
    return editResult(store.apply('updateClip', patch, meta(ctx, 'edit motion')));
  },
});

tool('get_clip_html', {
  title: 'Get motion source', description: 'Source of a motion clip (custom code or template HTML + resolved params) so you can modify it.',
  schema: { id: z.string() }, annotations: RO,
  handler: async ({ id }) => {
    const p = needProject();
    const c = clipById(p, id);
    if (!c || c.type !== 'html') throw new Error('Not a motion/html clip');
    if (c.html?.code) return { json: { kind: 'custom', ...c.html.code, params: c.html.params || {} } };
    const t = getTemplate(c.html.template);
    return { json: { kind: 'template', template: c.html.template, params: htmlClipParams(c), templateSource: t?.source?.slice(0, 12000), hint: 'To customize beyond params: add_html_clip/update_motion with your own html (you can start from this source; {{param}} placeholders must be replaced).' } };
  },
});

tool('preview_motion', {
  title: 'Preview motion graphic', description: 'Render frames of ONE motion clip alone (contact sheet image) and report its JavaScript errors.',
  schema: { id: z.string(), times: z.array(num()).optional().describe('Local times (s from clip start)') }, annotations: RO,
  handler: async ({ id, times }) => { const r = await S.previewMotion(id, { times }); return { json: { times: r.times, jsErrors: r.errors, image: r.image }, image: r.image }; },
});

// ======================================================================================== SUBTITLES
tool('generate_subtitles', {
  title: 'Generate subtitles', description: 'Create word-timed subtitles from the transcripts of the clips currently on the timeline (run after the cut is final). preset sets the look; maxWords per cue (2–3 for shorts, 6–10 for long form).',
  schema: { preset: z.enum(Object.keys(SUBTITLE_PRESETS)).optional(), maxWords: num().optional(), maxChars: num().optional(), maxLines: num().optional(), tracks: z.array(z.string()).optional(), replace: z.boolean().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: S.generateSubtitles(a, meta(ctx)) }),
});

tool('get_subtitles', {
  title: 'Read subtitles', description: 'Subtitle cues (timeline seconds) with ids, for proofreading. words=true adds every word with its index, timing, automatic importance score (0–1) and whether it is currently a keyword (used by the "emphasis" / "keywords" display modes).',
  schema: { start: num().optional(), end: num().optional(), words: z.boolean().optional() }, annotations: RO,
  handler: async ({ start = 0, end = Infinity, words }) => {
    const p = needProject();
    const st = resolveSubtitleStyle(p.subtitles.style);
    const flags = words ? keywordFlags(p.subtitles.cues, st.kwDensity) : null;
    return {
      json: {
        enabled: p.subtitles.enabled, mode: st.mode, kwDensity: st.kwDensity, style: p.subtitles.style,
        cues: p.subtitles.cues.filter((q) => q.end > start && q.start < end).map((q) => ({
          id: q.id, start: q.start, end: q.end, text: q.text, ...(q.emoji ? { emoji: q.emoji } : {}),
          ...(words ? { words: cueWords(q).map((w, i) => ({ i, text: w.text, start: r4(w.start), end: r4(w.end), score: w.s ?? null, keyword: !!flags.get(q.id)?.[i], ...(w.k === 0 || w.k === 1 ? { forced: true } : {}) })) } : {}),
        })),
      },
    };
  },
});

tool('set_subtitle_keywords', {
  title: 'Choose the important words (smart subtitles)',
  description: 'YOU decide which words matter: they are emphasised in mode "emphasis" (colour/size) or shown alone in mode "keywords" (only key words, big, one at a time — Hormozi/MrBeast style). Read get_subtitles(words=true) first, then pass items [{cueId, keywords: [word indices or words], emoji?}] (each listed cue becomes exactly that choice) or words [{time}] (timeline seconds of each keyword, exclusive by default). Pick the words that carry the meaning or the emotion: numbers, names, key nouns/verbs, punchlines — typically 15–30 % of the words, 1–2 per cue. reset=true returns to the automatic choice, clear=true removes all. mode switches the display mode.',
  schema: {
    items: z.array(z.object({ cueId: z.string(), keywords: z.array(z.union([z.number(), z.string()])), emoji: z.string().optional() })).optional(),
    words: z.array(z.object({ time: num(), text: z.string().optional() })).optional(),
    exclusive: z.boolean().optional(), reset: z.boolean().optional(), clear: z.boolean().optional(), mode: z.enum(SUBTITLE_MODES).optional(),
  },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: store.apply('setSubtitleKeywords', a, meta(ctx, 'subtitle keywords')).result }),
});

tool('edit_subtitles', {
  title: 'Edit subtitles', description: 'Fix cue text/timing (items), delete cues (remove), or add manual cues (add: [{start, end, text}]).',
  schema: { items: z.array(z.object({ id: z.string(), text: z.string().optional(), start: num().optional(), end: num().optional() })).optional(), remove: z.array(z.string()).optional(), add: z.array(z.object({ start: num(), end: num(), text: z.string() })).optional() },
  annotations: EDIT,
  handler: async ({ items, remove, add }, ctx) => {
    needProject();
    const { result } = store.transaction('edit subtitles', (draft, c) => {
      const out = {};
      if (items?.length) out.updated = OPS.updateSubtitleCues(draft, { items }, c).length;
      if (remove?.length) out.removed = OPS.removeSubtitleCues(draft, { ids: remove }, c).removed;
      if (add?.length) out.total = OPS.setSubtitleCues(draft, { cues: add, append: true }, c).count;
      return out;
    }, meta(ctx));
    return { json: { ok: true, ...result } };
  },
});

tool('find_replace_subtitles', {
  title: 'Find / replace in subtitles',
  description: 'Replace a word or phrase everywhere in the subtitles (matches across words, e.g. "QLC plus" → "QLC+"; timings are kept). By default the transcripts are fixed too, so regenerated subtitles keep the correction. wholeWord (default true), caseSensitive, regex. dryRun=true lists the changes only.',
  schema: { find: z.string(), replace: z.string(), regex: z.boolean().optional(), caseSensitive: z.boolean().optional(), wholeWord: z.boolean().optional(), transcripts: z.boolean().optional(), dryRun: z.boolean().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: PRO.findReplaceSubtitles(a, meta(ctx)) }),
});

tool('set_vocabulary', {
  title: 'Custom vocabulary (names, jargon)',
  description: 'Project vocabulary for the transcription: words (names, brands, jargon — e.g. "Mingjie", "lyres", "powerCON", "DMX", "QLC+") are given to Whisper as spelling hints on the next transcriptions; replacements [{find, replace}] are applied automatically to new transcripts (apply=true also fixes the current subtitles and transcripts now). Re-run analyze_media {force:true, transcribe:true} to redo existing transcripts with the new words.',
  schema: { words: z.array(z.string()).optional(), replacements: z.array(z.object({ find: z.string(), replace: z.string(), caseSensitive: z.boolean().optional() })).optional(), apply: z.boolean().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: PRO.setVocabulary(a, meta(ctx)) }),
});

tool('set_subtitle_style', {
  title: 'Subtitle style', description: `Look of the subtitles. preset: ${Object.entries(SUBTITLE_PRESETS).map(([k, v]) => `${k} (${v.label}${v.hint ? `, ${v.hint}` : ''}${v.mode && v.mode !== 'all' ? `, mode ${v.mode}` : ''})`).join(', ')}. style overrides: font, weight, size (px @1080p), uppercase, color, strokeColor, strokeWidth, shadowColor, shadowBlur, shadowX, shadowY, highlight (${SUBTITLE_HIGHLIGHTS.join('|')}) of the active word, highlightColor, highlightBoxColor, highlightScale, background {color, padding, radius, mode ${SUBTITLE_BACKGROUNDS.join('|')}}, position (bottom|center|top), offsetY (0–0.5), maxWidth (0–1), animation (${SUBTITLE_ANIMATIONS.join('|')}), wordReveal, maxWords, letterSpacing, lineHeight, secondLineColor, tilt (deg). Smart subtitles: mode (${SUBTITLE_MODES.join('|')}: all words / important words emphasised / ONLY important words), kwDensity (0.1–0.5 share of words kept automatically), kwColor or kwColors [cycled], kwScale, kwFont, kwWeight, kwUppercase, kwBox + kwBoxColor, kwAnim (${KEYWORD_ANIMATIONS.join('|')}), kwHold (s), emojis (auto emoji above keywords), emojiScale. enabled toggles visibility.`,
  schema: { preset: z.enum(Object.keys(SUBTITLE_PRESETS)).optional(), style: z.record(z.string(), z.any()).optional(), enabled: z.boolean().optional(), reset: z.boolean().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: store.apply('setSubtitleStyle', a, meta(ctx, 'subtitle style')).result }),
});

tool('subtitles_file', {
  title: 'Import/export subtitle file', description: 'import an .srt/.vtt file as cues, or export the cues to .srt/.vtt (returns the path).',
  schema: { action: z.enum(['import', 'export']), path: z.string().optional(), format: z.enum(['srt', 'vtt']).optional(), offset: num().optional() },
  annotations: EDIT,
  handler: async ({ action, path: file, format = 'srt', offset = 0 }, ctx) => {
    const p = needProject();
    if (action === 'import') {
      const cues = parseSrt(fs.readFileSync(file, 'utf8')).map((q) => ({ ...q, start: q.start + offset, end: q.end + offset }));
      return { json: store.apply('setSubtitleCues', { cues }, meta(ctx, 'import subtitles')).result };
    }
    const out = file || path.join(store.dir, 'exports', `${safeFileName(p.name)}.${format}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, format === 'vtt' ? cuesToVtt(p.subtitles.cues) : cuesToSrt(p.subtitles.cues));
    return { json: { path: out, cues: p.subtitles.cues.length } };
  },
});

// ======================================================================================== AUDIO LIBRARY / YOUTUBE
tool('search_audio', {
  title: 'Search music & sound effects',
  description: 'Free library, best sources first. SFX: ~100 real recordings (bundled pack, CC0: applause, laugh track, gasp, crickets, airhorn, sad trombone, record scratch, metal pipe, fart, animals, ambiences…) + ~85 synthesized CC0 sounds (whooshes, pops, risers, glitches, UI) — all local and instant (ids builtin:… / pack:…). ' +
    `SFX categories: ${SFX_CATEGORIES.map(([c]) => c).join(', ')} ("meme", "crowd", "human", "cartoon", "animals" = meme sounds). ` +
    `MUSIC without credit (CC0): bundled tracks (ids music:…, instant) and the FreePD catalog (~1000 public-domain tracks, ids freepd:…); moods (category): ${MUSIC_CATEGORIES.map(([c]) => c).join(', ')}. ` +
    'Also Openverse (Freesound/Jamendo) and Incompetech (CC-BY 4.0, credit required, mood & BPM). license "no-attribution" = CC0/public-domain only (no credit needed). An empty query lists the local items. Returns ids for add_audio.',
  schema: { query: z.string(), kind: z.enum(['music', 'sfx', 'any']).optional(), category: z.string().optional(), source: z.enum(['all', 'builtin', 'pack', 'freepd', 'openverse', 'incompetech']).optional(), license: z.enum(['no-attribution', 'attribution-ok']).optional(), limit: num().optional(), bpmMin: num().optional(), bpmMax: num().optional(), minDuration: num().optional(), maxDuration: num().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (a) => {
    const r = await searchLibrary({ limit: 12, ...a });
    return { json: { results: r.results.slice(0, a.limit || 24).map((x) => ({ id: x.id, title: x.title, kind: x.kind, source: x.source, duration: x.duration ? Math.round(x.duration * 10) / 10 : null, bpm: x.bpm || undefined, tags: x.tags?.slice(0, 6), license: x.license, attributionRequired: x.attributionRequired, author: x.author || undefined })), errors: r.errors.length ? r.errors : undefined } };
  },
});

tool('add_audio', {
  title: 'Add music / SFX from library', description: 'Download a search_audio result into the project and (optionally) place it: start (timeline s), track (default free audio track), volume, fadeIn/fadeOut, duration (trim) and loop=true to repeat music to fill `duration`.',
  schema: { id: z.string(), start: num().optional(), track: tr().optional(), volume: num().optional(), duration: num().optional(), in: num().optional(), fadeIn: num().optional(), fadeOut: num().optional(), loop: z.boolean().optional(), place: z.boolean().optional().describe('default true') },
  annotations: NET,
  handler: async ({ id, place = true, ...pl }, ctx) => {
    const placement2 = place ? { start: pl.start ?? 0, track: pl.track || 'auto', volume: pl.volume, duration: pl.duration, in: pl.in, fadeIn: pl.fadeIn, fadeOut: pl.fadeOut, loop: pl.loop } : null;
    if (placement2) Object.keys(placement2).forEach((k) => placement2[k] === undefined && delete placement2[k]);
    if (isLocalLibraryId(id)) {
      const r = await S.addLibraryAudio(id, placement2, meta(ctx));
      return { json: { ok: true, ...r, placed: r.placed ? { clips: r.placed.clips.map((c) => clipInfo(store.project, clipById(store.project, c.id) || c)), warnings: r.placed.warnings } : null } };
    }
    const job = S.addLibraryAudioJob(id, placement2, meta(ctx));
    const out = await jobOutcome(job, 40);
    if (out.json.status === 'done' && out.json.result?.placed) out.json.result.placed.clips = out.json.result.placed.clips.map((c) => clipInfo(store.project, clipById(store.project, c.id) || c));
    return out;
  },
});

/**
 * Memes must stay rare to be funny: an AI may not stack them. Refuses a new meme within 12 s of another one
 * (or beyond ~1 per 20 s of video overall). The user can always add more by hand.
 */
function memeGuard(time) {
  const p = needProject();
  const t = Number(time ?? S.uiState.playhead) || 0;
  const memes = p.clips.filter((c) => c.label === 'meme' || /^(noto-emoji|fluent-emoji|myinstants|imgflip|memescreens)$/.test(mediaById(p, c.mediaId)?.source?.provider || ''));
  const starts = [...new Set(memes.map((c) => Math.round(c.start * 2) / 2))];
  const near = starts.find((s0) => Math.abs(s0 - t) < 12);
  if (near !== undefined) throw new Error(`Meme refused: there is already one at ${near.toFixed(1)} s (less than 12 s away). Memes only work when they are rare: keep at most one every 20-30 s, on real punchlines, or skip it.`);
  const dur = Math.max(projectDuration(p), 1);
  if (starts.length + 1 > Math.max(1, Math.floor(dur / 20) + 1)) throw new Error(`Meme refused: ${starts.length} memes already for ${Math.round(dur)} s of video (max about 1 every 20 s). Too many memes kill the joke.`);
}

tool('search_stickers', {
  title: 'Search emoji stickers',
  description: 'Bundled emoji stickers (~240, mostly animated: Google Noto Lottie; 3D Microsoft Fluent PNG). Search in French or English or pass the emoji itself. Prefer real memes (search_meme_bank) for meme moments; emoji are for light reactions. Returns ids for add_sticker.',
  schema: { query: z.string().optional(), animated: z.boolean().optional().describe('true = only animated'), limit: num().optional() },
  annotations: RO,
  handler: async ({ query = '', animated, limit = 30 }) => ({ json: S.searchStickersSvc({ query, animated: animated ?? null, limit }).map(({ png, ...x }) => x) }),
});

tool('add_sticker', {
  title: 'Add an emoji sticker',
  description: 'Place an emoji sticker (id from search_stickers, or the emoji character) on an overlay track: pops in, plays its animation, pops out. size = fraction of the short side (default 0.3), position preset or x/y px offsets. Counts as a meme (rare use only).',
  schema: {
    id: z.string(), start: num().optional().describe('timeline s, default playhead'), duration: num().optional(), position: z.enum(STICKER_POSITIONS).optional(),
    size: num().optional(), x: num().optional(), y: num().optional(), animated: z.boolean().optional(),
    anim: z.object({ in: z.string().optional(), out: z.string().optional(), loop: z.string().optional() }).optional(),
  },
  annotations: EDIT,
  handler: async ({ id, ...o }, ctx) => { memeGuard(o.start); return { json: await S.addSticker(id, o, meta(ctx)) }; },
});

tool('list_memes', {
  title: 'List meme combos', description: 'One-click meme effects (real meme sound + zoom / flash / freeze frame / confetti) usable with add_meme.',
  schema: {}, annotations: RO,
  handler: async () => ({
    json: MEMES.map((m) => ({
      id: m.id, name: m.fr, en: m.en, sound: m.sfx?.[0],
      effect: [m.zoom ? `zoom ${m.zoom.style}` : null, m.flash ? 'flash' : null, m.freeze ? 'freeze frame' : null, m.confetti ? 'confetti' : null].filter(Boolean).join(' + ') || undefined,
    })),
  }),
});

tool('add_meme', {
  title: 'Add a meme combo',
  description: 'Apply a meme combo at a timeline time (default playhead): a real meme sound + punch-in / slow zoom, flash, freeze frame or confetti. Ids: ' + MEMES.map((m) => `${m.id} (${m.en})`).join(', ') + '. RARE use only: max one meme every 20-30 s, on genuine punchlines (refused otherwise).',
  schema: { id: z.enum(MEMES.map((m) => m.id)), time: num().optional() },
  annotations: EDIT,
  handler: async ({ id, time }, ctx) => { memeGuard(time); return { json: await S.applyMeme(id, { time }, meta(ctx)) }; },
});

tool('search_meme_bank', {
  title: 'Search the meme bank',
  description: 'Real internet memes, downloaded on demand (copyrighted works commonly reused as memes; the user decides). kind "video": ~800 green-screen meme clips from memescreens.com (reactions, funny, effects, animals, dance, gaming: The Rock eyebrow, coffin dance, explosion, a few moments later...) -> add_meme_video(id). kind "gif": popular animated meme templates (Imgflip) -> add_meme_image(id). kind "image": the 100 most used meme templates (Drake, Distracted Boyfriend, Two Buttons...) -> add_meme_image(id). kind "sound": MyInstants meme sounds (vine boom, bruh, sad violin, MLG air horn...; empty query = all-time best) -> add_audio(id, start). kind "youtube": green-screen search on YouTube -> add_meme_video(url). Memes are RARE: at most one every 20-30 s.',
  schema: { kind: z.enum(['video', 'gif', 'image', 'sound', 'youtube']), query: z.string().optional(), category: z.string().optional().describe('video only: Reactions | Funny | Effects | Animals | Dance | Gaming'), page: num().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ kind, query = '', page = 1, category = '' }) => {
    const list = await S.searchMemeBank({ kind, query, page, category });
    return {
      json: list.slice(0, 40).map((x) => (kind === 'youtube'
        ? { url: x.url, title: x.title, duration: x.duration, channel: x.channel }
        : { id: x.id, title: x.title, ...(x.duration ? { duration: Math.round(x.duration * 10) / 10 } : {}), ...(x.category ? { category: x.category } : {}), ...(x.tags?.length ? { tags: x.tags.slice(0, 6) } : {}), ...(x.width ? { size: `${x.width}x${x.height}` } : {}) })),
    };
  },
});

tool('add_meme_image', {
  title: 'Add a meme image / GIF',
  description: 'Place a meme image or GIF of the bank (id from search_meme_bank kind "image" or "gif") at start: mode "full" = full-frame cut-away (default, ~2 s, GIFs play once), "pip" = smaller card (size = fraction of the short side, position preset). Rare use only.',
  schema: { id: z.string(), start: num().optional(), duration: num().optional(), mode: z.enum(['full', 'pip']).optional(), size: num().optional(), position: z.enum(STICKER_POSITIONS).optional() },
  annotations: NET,
  handler: async ({ id, ...o }, ctx) => { memeGuard(o.start); return { json: await S.addMemeImage(id, o, meta(ctx)) }; },
});

tool('add_meme_video', {
  title: 'Add a green-screen meme video',
  description: 'Place a green-screen meme clip with the green keyed out (transparent) on an overlay track at start: id from search_meme_bank kind "video" (memescreens, instant), or url from kind "youtube" (download job -> wait_job). Optional duration (trim), size + position for a smaller insert. Rare use only.',
  schema: { id: z.string().optional(), url: z.string().optional(), start: num().optional(), duration: num().optional(), size: num().optional(), position: z.enum(STICKER_POSITIONS).optional() },
  annotations: NET,
  handler: async ({ id, url, ...o }, ctx) => {
    memeGuard(o.start);
    if (id) return { json: await S.addMemeVideo(id, o, meta(ctx)) };
    if (!url) throw new Error('id (memescreens) or url (YouTube) required');
    return jobOutcome(S.addGreenScreenMeme(url, o, meta(ctx)), 60);
  },
});

tool('youtube_search', {
  title: 'Search YouTube', description: 'Search YouTube videos (via yt-dlp). creativeCommonsOnly=true restricts to CC-BY videos (reusable with credit).',
  schema: { query: z.string(), limit: num().optional(), creativeCommonsOnly: z.boolean().optional() }, annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ query, limit = 8, creativeCommonsOnly }) => ({ json: await searchYoutube(query, { limit, creativeCommons: !!creativeCommonsOnly }) }),
});

tool('youtube_info', {
  title: 'YouTube video info', description: 'Title, duration, license, chapters and description of a YouTube (or other site) URL.',
  schema: { url: z.string() }, annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ url }) => ({ json: await videoInfo(url) }),
});

tool('youtube_download', {
  title: 'Download from YouTube', description: 'Download audio (mp3) or video (mp4) from YouTube or 1000+ sites with yt-dlp, optionally only a section [start, end] (s), import it and optionally place it (place: {start, track, volume}). Only for content the user may use.',
  schema: { url: z.string(), mode: z.enum(['audio', 'video']).optional(), start: num().optional(), end: num().optional(), maxHeight: num().optional(), place: z.object({ start: num().optional(), track: tr().optional(), volume: num().optional(), duration: num().optional() }).optional() },
  annotations: NET,
  handler: async ({ url, mode = 'audio', start, end, maxHeight, place }, ctx) => jobOutcome(S.youtubeDownloadJob(url, { mode, start, end, maxHeight, place }, meta(ctx)), 45),
});

tool('get_credits', {
  title: 'Credits / attributions', description: 'Attribution text required by the licenses of the music/SFX/footage used (paste it in the video description).',
  schema: {}, annotations: RO,
  handler: async () => ({ text: creditsText(needProject()) || 'No attribution required by the media currently used.' }),
});

tool('text_to_speech', {
  title: 'Voice-over (text to speech)', description: 'Generate a voice-over WAV from text with the system voices (offline) and optionally place it (place: {start, track}). list=true returns available voices.',
  schema: { text: z.string().optional(), voice: z.string().optional(), rate: num().optional().describe('-10..10'), place: z.object({ start: num().optional(), track: tr().optional(), volume: num().optional() }).optional(), list: z.boolean().optional() },
  annotations: EDIT,
  handler: async ({ text, voice, rate, place, list }, ctx) => {
    if (list || !text) return { json: { voices: await S.listVoices() } };
    return { json: await S.generateVoiceover(text, { voice, rate, place }, meta(ctx)) };
  },
});

// ======================================================================================== TRACKING
tool('track_object', {
  title: 'Track an object / a head',
  description: 'Motion tracking on a video clip: follows a region (or a face / head) through the shot, forward and backward. Give the clip, a timeline time where the object is visible and its box {x, y, w, h} as FRACTIONS of the clip\'s picture (top-left corner + size, 0..1) — use render_frames with grid=true or view_media_frames to measure it — or face=true to find the face automatically (biggest one, or faceIndex from detect_faces, or the one nearest to near {x, y}). Returns a trackingId (job: wait_job). Then: attach_to_tracking (label with arrow, image, sticker, any clip follows it) or track_effect (blur / pixelate / spotlight that follows it).',
  schema: {
    clipId: z.string(), time: num().optional().describe('Timeline time where the box is right (default: clip start)'),
    box: z.object({ x: num(), y: num(), w: num(), h: num() }).optional(), face: z.boolean().optional(), faceIndex: num().optional(),
    near: z.object({ x: num(), y: num() }).optional(), name: z.string().optional(), from: num().optional().describe('Timeline start of the range to track (default clip start)'), to: num().optional(),
    fix: z.string().optional().describe('Correct an existing tracking: give its id + the RIGHT box at `time` (check with render_frames grid=true where it drifts); it is re-tracked between the neighbouring corrections and merged'),
  },
  annotations: EDIT,
  handler: async (a, ctx) => jobOutcome(CR.trackObject(a, meta(ctx)), 50),
});
tool('detect_faces', {
  title: 'Detect faces', description: 'Faces visible in a video clip at a timeline time: boxes as fractions of the picture (x, y = top-left, w, h, cx, cy), biggest first. Use with track_object(face=true, faceIndex).',
  schema: { clipId: z.string(), time: num().optional() }, annotations: RO,
  handler: async (a) => ({ json: await CR.facesAt(a) }),
});
tool('list_trackings', {
  title: 'List trackings', description: 'Trackings of the project: id, name, kind, tracked source range, where they are visible on the timeline, attached clips.',
  schema: {}, annotations: RO, handler: async () => ({ json: CR.listTrackings() }),
});
tool('tracking_at', {
  title: 'Where is the tracked object', description: 'Position (frame px) and size of a tracked object at a timeline time.',
  schema: { tracking: z.string(), time: num() }, annotations: RO, handler: async ({ tracking, time }) => ({ json: CR.trackingAt(tracking, time) }),
});
tool('remove_tracking', {
  title: 'Remove trackings', description: 'Delete trackings (attached clips stop following them).',
  schema: { ids: z.array(z.string()) }, annotations: DESTRUCTIVE,
  handler: async ({ ids }, ctx) => editResult(store.apply('removeTrackings', { ids }, meta(ctx, 'remove tracking'))),
});
tool('attach_to_tracking', {
  title: 'Attach to a tracked object',
  description: 'Make something follow a tracked object / head during the shot. Without clipIds it ADDS an element: label (text with a pointer line and a dot on the target — template "track-label", params angle 0 = above / 90 = right / 270 = left, distance px), or template + params (any motion template; the frame centre lands on the target), or mediaId (image / sticker / video, size = scale). With clipIds it attaches existing clips. anchor = point of the tracked box (center, top, bottom, left, right, corners), offsetX / offsetY px, scale=true follows the size.',
  schema: {
    tracking: z.string(), clipIds: z.array(z.string()).optional(), label: z.string().optional(), template: z.string().optional(), params: z.record(z.string(), z.any()).optional(),
    mediaId: z.string().optional(), size: num().optional(), anchor: z.enum(ANCHORS).optional(), offsetX: num().optional(), offsetY: num().optional(), scale: z.boolean().optional(),
    start: num().optional(), end: num().optional(), duration: num().optional(), track: z.string().optional(), name: z.string().optional(),
  },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(CR.attachToTracking(a, meta(ctx))),
});
tool('track_effect', {
  title: 'Blur / pixelate / spotlight a tracked object',
  description: 'Adds an adjustment layer whose mask follows a tracking: mode "blur" or "pixelate" (anonymize a face, hide a logo / plate), "spotlight" (darken + desaturate everything AROUND the subject) or "darken". amount = blur px / block px / brightness. padding enlarges the mask (0.25 = +25 %).',
  schema: { tracking: z.string(), mode: z.enum(['blur', 'pixelate', 'spotlight', 'darken']).optional(), amount: num().optional(), padding: num().optional(), shape: z.enum(MASK_SHAPES).optional(), feather: num().optional(), start: num().optional(), end: num().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(CR.effectOnTracking(a, meta(ctx))),
});

tool('auto_reframe', {
  title: 'Auto reframe (keep the subject in frame)',
  description: 'Premiere-style Auto Reframe for vertical / square exports of wider footage: the clip is set to cover the frame and its position is keyframed (smooth, camera-like) so the person (face tracked automatically, or the given tracking) stays in the frame. smooth = reaction time in s (0.3 nervous … 1.5 very calm), offsetX = keep the subject left / right of centre (-0.3..0.3).',
  schema: { clipId: z.string(), tracking: z.string().optional(), smooth: num().optional(), offsetX: num().optional(), time: num().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(await CR.autoReframe(a, meta(ctx))),
});
tool('derive_clip', {
  title: 'Reverse / stabilize a clip',
  description: 'Renders a processed copy of the source range of the clip and swaps it in: kind "reverse" (plays backwards, sound too — rewind effect), "stabilize" (removes camera shake, two-pass vidstab; strength = smoothing frames, default 20) or "slowmo" (SMOOTH slow motion with motion-interpolated frames, factor 0.1–0.9 = new speed; the clip gets longer). Returns a jobId (wait_job).',
  schema: { clipId: z.string(), kind: z.enum(['reverse', 'stabilize', 'slowmo']), strength: num().optional(), factor: num().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => jobOutcome(CR.deriveClip(a, meta(ctx)), 50),
});

// ======================================================================================== CUTOUT (subject segmentation)
tool('cutout_subject', {
  title: 'Cut out a person or an object (text / photo behind it)',
  description: 'Separates a subject of a video clip from the background, frame by frame (GPU): the result is a transparent video laid on a new track right above the clip, perfectly aligned. Anything placed between the clip and this cutout appears BEHIND the subject (the classic "text behind the subject" effect) — use place_behind_subject for that. PEOPLE: just clipId (video matting model). ANY OBJECT (car, product, animal, logo…): give tracking (from track_object) or box {x, y, w, h} (picture fractions, top-left) + time — it is tracked then segmented with SAM. from / to (timeline s) limit the range (faster). Returns a jobId (wait_job); the first run downloads the model (15–40 MB).',
  schema: { clipId: z.string(), from: num().optional(), to: num().optional(), quality: z.enum(['fast', 'high']).optional(), tracking: z.string().optional(), box: z.object({ x: num(), y: num(), w: num(), h: num() }).optional(), time: num().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => jobOutcome(startCutout(a, meta(ctx)), 50),
});
tool('place_behind_subject', {
  title: 'Put text / an image behind the subject',
  description: 'Adds an element on a track between a clip and its cutout (cutout_subject) so it appears BEHIND the person: text (big stacked title by default, template "title-stack"; params to style it), or template + params (any motion template), or mediaId (photo, logo, video; with scale / x / y). start / duration default to the cutout span. Use set_animation for an entrance.',
  schema: {
    cutoutClipId: z.string(), text: z.string().optional(), template: z.string().optional(), params: z.record(z.string(), z.any()).optional(), mediaId: z.string().optional(),
    start: num().optional(), duration: num().optional(), ...visualProps,
  },
  annotations: EDIT,
  handler: async (a, ctx) => editResult({ result: placeBehind(a, meta(ctx)), warnings: [] }),
});

tool('separate_stems', {
  title: 'Separate voice / music',
  description: 'Splits the sound of an audio or video clip into VOICE and MUSIC (MDX-Net vocal model, GPU; first run downloads 67 MB): both stems are laid on audio tracks aligned with the clip and the clip is muted, so you can lower / replace the music under a voice, remove a voice from a song (karaoke), clean a vlog recorded with music… keep = both | voice | music. Returns a jobId (wait_job).',
  schema: { clipId: z.string(), keep: z.enum(['both', 'voice', 'music']).optional() },
  annotations: EDIT,
  handler: async (a, ctx) => jobOutcome(separateStems(a, meta(ctx)), 50),
});

// ======================================================================================== STYLE REFERENCE
tool('analyze_style_reference', {
  title: 'Learn the editing style of a video (YouTube link)',
  description: 'The user wants the edit to look like another video: give its url (YouTube, TikTok, Instagram, Vimeo… — a section of `seconds` from `start` is downloaded in 720p) or the mediaId of an imported video. It is analysed (cuts / pacing, shot lengths, speech rate, pauses, hook, loudness, BPM, light / saturation / warmth / motion, suggested grade) and summarised with contact sheets (one frame per shot). Returns a jobId (wait_job), then call get_style_reference to SEE it and get the recipe.',
  schema: { url: z.string().optional(), mediaId: z.string().optional(), start: num().optional(), seconds: num().optional(), name: z.string().optional() },
  annotations: NET,
  handler: async (a, ctx) => jobOutcome(analyzeStyleJob(a, meta(ctx)), 50),
});
tool('get_style_reference', {
  title: 'Style reference: profile, recipe and frames',
  description: 'A style reference of the project (id, default the latest): the measured profile, a step-by-step recipe to reproduce the style on the user footage, and (frames=true) the contact sheets of its shots so you can see the captions, titles, motion designs, framing and colors to imitate with your OWN texts and motion designs (add_html_clip). page = which sheet (16 shots each).',
  schema: { id: z.string().optional(), frames: z.boolean().optional(), page: num().optional() },
  annotations: RO,
  handler: async ({ id, frames = true, page = 1 }) => {
    const ref = styleRef(id);
    const sheet = ref.sheets?.[Math.max(0, Math.min((ref.sheets?.length || 1) - 1, page - 1))];
    return { json: { id: ref.id, name: ref.name, url: ref.url, referenceMediaId: ref.mediaId, sheets: ref.sheets?.length || 0, profile: ref.profile, recipe: styleRecipe(ref) }, ...(frames && sheet && fs.existsSync(sheet) ? { image: sheet } : {}) };
  },
});

// ======================================================================================== EFFECTS / COLOR / AUDIO FX
tool('add_adjustment_layer', {
  title: 'Adjustment layer (blur, pixelate, grade a region or the whole frame)',
  description: `Adds an adjustment layer (Premiere-style): from start for duration it modifies EVERYTHING BELOW it — fx.blur (px) / fx.pixelate (block px) / color grade (color or look) — on the whole frame, or only inside mask {shape rect|ellipse, cx, cy, w, h (frame fractions), feather px, invert}. invert=true applies OUTSIDE the shape (e.g. darken around a subject: color {brightness: 0.4}). opacity blends it, videoFadeIn/Out fade it. Looks: ${LOOK_IDS.join(', ')}.`,
  schema: {
    start: num(), duration: num().optional(), end: num().optional(), track: z.string().optional(), name: z.string().optional(),
    fx: z.object({ blur: num().optional(), pixelate: num().optional() }).optional(), color: colorSchema.optional(), look: z.enum(LOOK_IDS).optional(),
    mask: maskSchema.optional(), opacity: num().optional(), videoFadeIn: num().optional(), videoFadeOut: num().optional(),
  },
  annotations: EDIT,
  handler: async ({ look, color, ...a }, ctx) => editResult(store.apply('addAdjustmentLayer', { ...a, color: look ? { ...LOOKS[look].color, ...(color || {}) } : color }, meta(ctx, 'adjustment layer'))),
});
tool('set_color_grade', {
  title: 'Color grade / look',
  description: `Grade clips (video, image, motion or adjustment layers): look = ready-made look (${LOOK_IDS.map((id) => `${id} (${LOOKS[id].en})`).join(', ')}) and/or color = individual values merged on top (${GRADE_KEYS.join(', ')}, brightness, contrast, saturation, hue…). reset=true starts from neutral. To grade the whole video at once use add_adjustment_layer over the full timeline with a look.`,
  schema: { ids: z.array(z.string()), look: z.enum(LOOK_IDS).optional(), color: colorSchema.optional(), reset: z.boolean().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => editResult(store.apply('setColorGrade', a, meta(ctx, a.look ? `look ${a.look}` : 'color grade'))),
});
tool('list_audio_effects', {
  title: 'Audio effects catalogue', description: 'Audio effects (types with their parameters, defaults and ranges) and one-click presets for set_audio_effects.',
  schema: {}, annotations: RO,
  handler: async () => ({ json: {
    effects: Object.fromEntries(Object.entries(AFX).map(([k, v]) => [k, { name: v.en, params: Object.fromEntries(Object.entries(v.params).map(([pk, pv]) => [pk, { default: pv[0], min: pv[1], max: pv[2], ...(pv[3] ? { unit: pv[3] } : {}) }])) }])),
    presets: Object.fromEntries(Object.entries(AFX_PRESETS).map(([k, v]) => [k, { name: v.en, chain: v.chain }])),
  } }),
});
tool('set_audio_effects', {
  title: 'Audio effects on clips / tracks',
  description: `Audio effects (same sound in the preview and the export): on clips (clipIds: audio or video clips) and/or on a whole track (track: "A1"… — a track bus, so a reverb keeps ringing across cuts; pan -1..1). preset: ${Object.keys(AFX_PRESETS).join(', ')}. effects: [{type, ...params}] with types ${AFX_TYPES.join(', ')} (list_audio_effects gives the parameters). mode replace (default) | append | clear.`,
  schema: { clipIds: z.array(z.string()).optional(), track: z.string().optional(), preset: z.enum(Object.keys(AFX_PRESETS)).optional(), effects: z.array(afxItem).optional(), mode: z.enum(['replace', 'append', 'clear']).optional(), pan: num().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: store.apply('setAudioEffects', a, meta(ctx, `audio fx ${a.preset || (a.effects || []).map((e) => e.type).join('+') || a.mode}`)).result }),
});

// ======================================================================================== USER REQUESTS & AI PROPOSALS
tool('list_requests', {
  title: 'User requests on the timeline',
  description: 'Requests the user pinned at a precise place of the timeline ("ask the AI here"): text, time / range, track, clip and what is there. Handle the open ones exactly at that place, then resolve_request.',
  schema: { status: z.enum(['open', 'working', 'done', 'dismissed', 'all']).optional() }, annotations: RO,
  handler: async ({ status = 'open' }) => {
    const p = needProject();
    const list = (p.requests || []).filter((r) => status === 'all' || r.status === status || (status === 'open' && r.status === 'working'));
    return { json: list.map((r) => ({ id: r.id, status: r.status, text: r.text, time: r.time, end: r.end, trackId: r.trackId, clipId: r.clipId, where: requestContext(p, r), reply: r.reply || undefined })) };
  },
});
tool('resolve_request', {
  title: 'Answer a user request', description: 'Close a request pinned on the timeline once handled (status done), or dismissed with the reason; reply = one short line shown to the user on the pin.',
  schema: { id: z.string(), status: z.enum(['done', 'dismissed', 'working']).optional(), reply: z.string().optional() }, annotations: EDIT,
  handler: async ({ id, status = 'done', reply }, ctx) => ({ json: store.apply('updateRequest', { id, status, reply, repliedBy: ctx.client }, meta(ctx, `request ${status}`)).result }),
});
tool('start_proposal', {
  title: 'Propose a creative idea',
  description: 'Start a PROPOSAL: a bold / crazy / creative idea you would not put in the final cut without asking (an unexpected effect, a meme, a speed ramp, a wild transition, a different music drop…). Every edit you make after this call (with the normal tools) is recorded into the proposal until end_proposal. The user sees a "💡 AI proposal" marker on the timeline with your title + description, previews it, and accepts or rejects it (rejecting undoes exactly those edits). Pending proposals are NOT exported. Keep each proposal small and self-contained; one idea per proposal.',
  schema: { title: z.string().describe('Short title shown on the marker'), description: z.string().optional().describe('What it does and why it could be great (1–3 lines)'), time: num().optional(), end: num().optional() },
  annotations: EDIT,
  handler: async (a, ctx) => ({ json: { ...startProposal(sessionKey(ctx), a, meta(ctx)), hint: 'Now make the edits of the idea, then call end_proposal.' } }),
});
tool('end_proposal', {
  title: 'Finish the proposal', description: 'Close the proposal started with start_proposal: it becomes pending, waiting for the user\'s decision.',
  schema: {}, annotations: EDIT,
  handler: async (_a, ctx) => ({ json: finishProposal(sessionKey(ctx), meta(ctx)) || { status: 'no proposal was open' } }),
});
tool('list_proposals', {
  title: 'AI proposals', description: 'Proposals and their status (recording, pending, accepted, rejected): learn what the user liked.',
  schema: {}, annotations: RO,
  handler: async () => ({ json: (needProject().proposals || []).map(proposalInfo) }),
});

// ======================================================================================== RENDER / EXPORT / JOBS
tool('render_frames', {
  title: 'See the edit', description: 'Render what the viewer sees at given timeline times (all tracks, motion graphics, subtitles) and return the image(s). Use it to verify framing, text, graphics and transitions. grid=true (single time) draws a labelled 10×10 grid of frame fractions to measure positions / boxes (track_object, masks).',
  schema: { times: z.array(num()).min(1).max(16), width: num().optional(), subtitles: z.boolean().optional(), grid: z.boolean().optional() },
  annotations: RO,
  handler: async ({ times, width, subtitles, grid }) => { const r = await S.renderFrames(times, { width, subtitles, grid }); return { json: { times: r.frames.map((f) => f.time), image: r.image }, image: r.image }; },
});

tool('export_video', {
  title: 'Export video', description: `Render the final file. presets: ${EXPORT_PRESETS.map((p) => p.id).join(', ')}. quality: draft|good|high|max. hardware=true uses the GPU encoder when available. range {start,end} exports a part. subtitlesFile srt|vtt writes a sidecar file. Returns a jobId (wait_job).`,
  schema: { preset: z.enum(EXPORT_PRESETS.map((p) => p.id)).optional(), path: z.string().optional(), quality: z.enum(['draft', 'good', 'high', 'max']).optional(), range: z.object({ start: num(), end: num() }).optional(), burnSubtitles: z.boolean().optional(), subtitlesFile: z.enum(['srt', 'vtt']).optional(), hardware: z.boolean().optional(), normalize: z.boolean().optional(), fps: num().optional(), includeProposals: z.boolean().optional().describe('Also export the AI proposals still pending (default: no)') },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (a, ctx) => jobOutcome(S.startExport(a, meta(ctx)), 20),
});

tool('wait_job', {
  title: 'Wait for a job', description: 'Wait (up to timeoutSec, default 25) for a background job (analysis, download, export) and return its status/result.',
  schema: { jobId: z.string(), timeoutSec: num().optional() }, annotations: RO,
  handler: async ({ jobId, timeoutSec = 25 }) => {
    const j = jobs.get(jobId);
    if (!j) throw new Error(`Unknown job ${jobId}`);
    return jobOutcome(j, Math.min(55, timeoutSec));
  },
});
tool('list_jobs', { title: 'Jobs', description: 'Background jobs (running and recent).', schema: {}, annotations: RO, handler: async () => ({ json: jobs.list().slice(0, 20).map((j) => ({ id: j.id, title: j.title, status: j.status, progress: Math.round(j.progress * 100) + '%', message: j.message, error: j.error || undefined })) }) });
tool('cancel_job', { title: 'Cancel job', description: 'Cancel a background job.', schema: { jobId: z.string() }, annotations: EDIT, handler: async ({ jobId }) => ({ json: { canceled: jobs.cancel(jobId) } }) });

// ======================================================================================== APP / PLAYER
tool('player', {
  title: 'Control the preview', description: 'Show something to the user in the app: seek the playhead, play/pause the preview, select clips, zoom the timeline to fit.',
  schema: { action: z.enum(['seek', 'play', 'pause', 'select', 'zoom-fit']), time: num().optional(), clipIds: z.array(z.string()).optional() },
  annotations: EDIT,
  handler: async (a) => { bus.emit('player:command', a); return { json: { ok: true } }; },
});

tool('notify', {
  title: 'Message the user', description: 'Show a message toast in the AI.cut window (progress, plan, question, result).',
  schema: { message: z.string(), level: z.enum(['info', 'success', 'warning', 'error']).optional() },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ message, level = 'info' }, ctx) => { bus.emit('toast', { level, message, from: ctx.client }); return { json: { ok: true } }; },
});

tool('editing_guide', {
  title: 'Editing guide', description: 'Full AI.cut playbook (workflow, conventions, motion-design rules, editing craft). Read it if unsure.',
  schema: {}, annotations: RO,
  handler: async () => { const { SERVER_INSTRUCTIONS } = await import('./guide.js'); return { text: SERVER_INSTRUCTIONS }; },
});

export function toolByName(name) { return TOOLS.find((t) => t.name === name) || null; }
export { summarize };
