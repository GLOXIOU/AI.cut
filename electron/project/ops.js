// Editing operations. Each op mutates a draft project (already cloned by the store) and returns a result.
// Shared by the UI (IPC) and the AI (MCP tools), so both edit through exactly the same code paths.
import { uid } from '../core/util.js';
import { makeClip, makeTrack, normalizeClip, RESOLUTION_PRESETS } from './schema.js';
import {
  r4, EPS, clipEnd, sortByStart, mediaById, trackById, clipById, trackClips, isVisual, maxClipDuration, projectDuration,
  KEYFRAME_PROPS, EASING_NAMES, contentSize, fittedSize,
} from '../../shared/timeline.js';
import { TRANSITION_IDS } from '../../shared/transitions.js';
import { SUBTITLE_PRESETS, SUBTITLE_STYLE_KEYS } from '../../shared/subtitles.js';
import { splitAnim, normalizeAnim, ANIM_IN, ANIM_OUT, ANIM_LOOP } from '../../shared/anim.js';

export class OpError extends Error {
  constructor(message) { super(message); this.name = 'OpError'; }
}
const fail = (m) => { throw new OpError(m); };

// ----------------------------------------------------------------------------------------------
// Track helpers
// ----------------------------------------------------------------------------------------------
function tracksOfType(p, type) { return p.tracks.filter((t) => t.type === type); }

function nextTrackName(p, type) {
  const prefix = type === 'video' ? 'V' : 'A';
  let n = tracksOfType(p, type).length + 1;
  while (p.tracks.some((t) => t.name === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function addTrackInternal(p, type, name, position) {
  const t = makeTrack(type, name || nextTrackName(p, type));
  const vids = tracksOfType(p, 'video');
  const auds = tracksOfType(p, 'audio');
  if (type === 'video') {
    const idx = position === 'bottom' ? 0 : typeof position === 'number' ? Math.max(0, Math.min(vids.length, position)) : vids.length;
    vids.splice(idx, 0, t);
  } else {
    const idx = position === 'top' ? 0 : typeof position === 'number' ? Math.max(0, Math.min(auds.length, position)) : auds.length;
    auds.splice(idx, 0, t);
  }
  p.tracks = [...vids, ...auds];
  return t;
}

function isRangeFree(p, trackId, start, end, exceptIds = []) {
  return !p.clips.some((c) => c.trackId === trackId && !exceptIds.includes(c.id) && c.start < end - EPS && clipEnd(c) > start + EPS);
}

/**
 * Resolve a track spec: track id | name ("V2", "a1") | 1-based index number | 'auto' | 'new' | 'overlay'.
 * 'auto'   → first track of that type with free space for [start,end) (bottom-up), created if needed.
 * 'overlay'→ like auto but never V1 (for titles, motion graphics, B-roll).
 */
export function resolveTrack(p, spec, type, { start = 0, end = start + 1, exceptIds = [] } = {}) {
  if (spec && typeof spec === 'object' && spec.id) spec = spec.id;
  if (typeof spec === 'string' && spec) {
    const byId = trackById(p, spec);
    if (byId) return byId;
    const byName = p.tracks.find((t) => t.name.toLowerCase() === spec.toLowerCase());
    if (byName) return byName;
    const m = /^([va])(\d+)$/i.exec(spec);
    if (m) {
      const tType = m[1].toLowerCase() === 'v' ? 'video' : 'audio';
      const want = Number(m[2]);
      while (tracksOfType(p, tType).length < want && tracksOfType(p, tType).length < 30) addTrackInternal(p, tType);
      return tracksOfType(p, tType)[want - 1];
    }
    if (spec === 'new') return addTrackInternal(p, type);
    if (spec !== 'auto' && spec !== 'overlay') fail(`Unknown track "${spec}". Use an id, a name like V1/A2, "auto", "overlay" or "new".`);
  }
  if (typeof spec === 'number') {
    const list = tracksOfType(p, type);
    while (list.length < spec && list.length < 30) list.push(addTrackInternal(p, type));
    return tracksOfType(p, type)[spec - 1];
  }
  const list = tracksOfType(p, type);
  const from = spec === 'overlay' && type === 'video' ? 1 : 0;
  for (let i = from; i < list.length; i++) {
    if (!list[i].locked && isRangeFree(p, list[i].id, start, end, exceptIds)) return list[i];
  }
  return addTrackInternal(p, type);
}

// ----------------------------------------------------------------------------------------------
// Range helpers (overwrite / ripple)
// ----------------------------------------------------------------------------------------------
const STILL_TYPES = new Set(['image', 'html', 'color']);
function splitClipAt(p, c, t) {
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return null;
  const leftDur = r4(t - c.start);
  const right = structuredClone(c);
  right.id = uid('clip');
  right.start = r4(t);
  right.duration = r4(c.duration - leftDur);
  right.in = STILL_TYPES.has(c.type) ? 0 : r4(c.in + leftDur * c.speed);
  right.transition = null;
  right.fadeIn = 0;
  right.videoFadeIn = 0;
  if (right.keyframes) {
    for (const k of Object.keys(right.keyframes)) right.keyframes[k] = right.keyframes[k].map((f) => ({ ...f, t: r4(f.t - leftDur) }));
  }
  if (c.type === 'html' && c.html) right.html = structuredClone(c.html);
  if (c.anim) [c.anim, right.anim] = splitAnim(c.anim, leftDur, c.duration);
  c.duration = leftDur;
  c.fadeOut = 0;
  c.videoFadeOut = 0;
  normalizeClip(c);
  normalizeClip(right);
  p.clips.push(right);
  return right;
}

/** Remove/trim/split every clip on track overlapping [start, end). */
export function clearRange(p, trackId, start, end, exceptIds = []) {
  const affected = [];
  for (const c of [...p.clips]) {
    if (c.trackId !== trackId || exceptIds.includes(c.id)) continue;
    const ce = clipEnd(c);
    if (c.start >= end - EPS || ce <= start + EPS) continue;
    affected.push(c.id);
    if (c.start >= start - EPS && ce <= end + EPS) {
      p.clips.splice(p.clips.indexOf(c), 1);
    } else if (c.start < start && ce > end) {
      const right = splitClipAt(p, c, end);
      c.duration = r4(start - c.start);
      normalizeClip(c);
      if (right) affected.push(right.id);
    } else if (c.start < start) {
      c.duration = r4(start - c.start);
      c.fadeOut = Math.min(c.fadeOut, c.duration);
      normalizeClip(c);
    } else {
      const cut = r4(end - c.start);
      if (!STILL_TYPES.has(c.type)) c.in = r4(c.in + cut * c.speed);
      c.start = r4(end);
      c.duration = r4(ce - end);
      c.transition = null;
      if (c.keyframes) for (const k of Object.keys(c.keyframes)) c.keyframes[k] = c.keyframes[k].map((f) => ({ ...f, t: r4(f.t - cut) }));
      normalizeClip(c);
    }
  }
  return affected;
}

function shiftAfter(p, trackIds, at, delta, exceptIds = []) {
  for (const c of p.clips) {
    if (!trackIds.includes(c.trackId) || exceptIds.includes(c.id)) continue;
    if (c.start >= at - EPS) c.start = r4(Math.max(0, c.start + delta));
  }
}

function shiftSubtitlesAndMarkers(p, at, delta, removeStart = null, removeEnd = null) {
  if (removeStart != null) {
    p.subtitles.cues = p.subtitles.cues.filter((q) => !(q.start >= removeStart - EPS && q.end <= removeEnd + EPS));
    p.markers = p.markers.filter((m) => !(m.time >= removeStart && m.time < removeEnd));
  }
  for (const q of p.subtitles.cues) {
    if (q.start >= at - EPS) {
      q.start = r4(q.start + delta); q.end = r4(q.end + delta);
      if (q.words) q.words = q.words.map((w) => ({ ...w, start: r4(w.start + delta), end: r4(w.end + delta) }));
    }
  }
  for (const m of p.markers) if (m.time >= at - EPS) m.time = r4(Math.max(0, m.time + delta));
}

// ----------------------------------------------------------------------------------------------
// Clip creation helpers
// ----------------------------------------------------------------------------------------------
function clipTypeFor(media, trackType, args) {
  if (args.html || args.template || args.htmlCode) return 'html';
  if (args.fill && !media) return 'color';
  if (!media) fail('mediaId is required (or html/template for motion graphics, or fill for a colour matte).');
  if (media.type === 'audio') return 'audio';
  if (media.type === 'image') return 'image';
  if (media.type === 'html' || media.type === 'lottie') return 'html';
  return trackType === 'audio' ? 'audio' : 'video';
}

function defaultDuration(type, media, args, ctx) {
  if (type === 'video' || type === 'audio') {
    const md = media?.duration || 0;
    return Math.max(1 / 30, (md - (args.in || 0)) / (args.speed || 1));
  }
  if (type === 'html') {
    const tpl = args.template || args.html?.template || (media?.type === 'lottie' ? 'lottie' : null);
    const t = tpl && ctx.template ? ctx.template(tpl) : null;
    if (!tpl && media?.type === 'html' && media.duration > 0) return media.duration;
    return t?.defaultDuration || 5;
  }
  return 5;
}

const fileUrlOf = (p) => `aicut://file/${encodeURIComponent(p)}`;

/** html descriptor for an imported .html / Lottie media placed on the timeline. */
function htmlFromMedia(media, args) {
  if (media.type === 'lottie') return { template: 'lottie', params: { src: fileUrlOf(media.path), ...(args.params || {}) } };
  return { file: media.path, params: { ...(media.htmlParams || {}), ...(args.params || {}) } };
}

function trackEnd(p, trackId) {
  let e = 0;
  for (const c of p.clips) if (c.trackId === trackId) e = Math.max(e, clipEnd(c));
  return r4(e);
}

const CLIP_PATCH_KEYS = ['name', 'start', 'duration', 'in', 'speed', 'volume', 'muted', 'fadeIn', 'fadeOut', 'opacity', 'x', 'y', 'scale',
  'rotation', 'flipH', 'flipV', 'fit', 'crop', 'color', 'chromaKey', 'vignette', 'transition', 'videoFadeIn', 'videoFadeOut', 'keyframes',
  'html', 'fill', 'label', 'anim', 'radius', 'border', 'shadow', 'audioFx'];

/** Merge an anim patch: keys in / out / loop replace (null removes), others are kept. Accepts string shorthands. */
export function mergeAnim(cur, patch) {
  if (patch === null) return null;
  const out = { ...(cur || {}) };
  for (const k of ['in', 'out', 'loop']) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (typeof v === 'string') v = v === 'none' || !v ? null : { type: v };
    if (v && v.type === 'none') v = null;
    if (v) {
      const cat = k === 'in' ? ANIM_IN : k === 'out' ? ANIM_OUT : ANIM_LOOP;
      if (!cat[v.type]) fail(`Unknown ${k} animation "${v.type}". Available: ${Object.keys(cat).join(', ')}`);
      // keep the duration / amount of the previous animation when only the type changes
      v = { ...(cur?.[k] && k !== 'loop' ? { duration: cur[k].duration } : {}), ...(cur?.[k] && k === 'loop' && cur.loop.type === v.type ? cur.loop : {}), ...v };
    }
    out[k] = v;
  }
  return normalizeAnim(out);
}

function applyVisualProps(c, args) {
  for (const k of CLIP_PATCH_KEYS) {
    if (args[k] === undefined || k === 'start' || k === 'duration' || k === 'in' || k === 'html') continue;
    if (k === 'color' && args.color && c.color) c.color = { ...c.color, ...args.color };
    else if (k === 'anim') c.anim = mergeAnim(c.anim, args.anim);
    else if ((k === 'border' || k === 'shadow') && args[k] && c[k]) c[k] = { ...c[k], ...args[k] };
    else c[k] = structuredClone(args[k]);
  }
  if (args.transition && args.transition.type && !TRANSITION_IDS.includes(args.transition.type)) {
    fail(`Unknown transition "${args.transition.type}". Available: ${TRANSITION_IDS.join(', ')}`);
  }
}

/** B-roll defaults (project setting autoBroll) for images/videos placed on overlay tracks. */
function applyAutoBroll(p, clip, args) {
  const ab = p.settings.autoBroll;
  if (!ab?.enabled || (clip.type !== 'image' && clip.type !== 'video')) return;
  const vids = tracksOfType(p, 'video');
  if (vids.indexOf(trackById(p, clip.trackId)) <= 0) return; // only overlay tracks (V2+)
  if (args.anim === undefined) {
    const loop = clip.type === 'image' ? ab.imageLoop : ab.videoLoop;
    clip.anim = normalizeAnim({
      ...(ab.in ? { in: { type: ab.in, duration: ab.inDuration } } : {}),
      ...(ab.out ? { out: { type: ab.out, duration: ab.outDuration } } : {}),
      ...(loop ? { loop: { type: loop } } : {}),
    });
  }
  if (args.radius === undefined && ab.radius > 0) clip.radius = ab.radius;
  if (args.shadow === undefined && ab.shadow) clip.shadow = { blur: 40, x: 0, y: 14, opacity: 0.45, color: '#000000' };
}

function buildHtml(args, existing) {
  if (args.template || args.params) {
    const template = args.template || existing?.template;
    if (template) return { template, params: { ...(existing?.template === template ? existing.params : {}), ...(args.params || {}) } };
  }
  if (args.htmlCode) return { code: { html: args.htmlCode.html || '', css: args.htmlCode.css || '', js: args.htmlCode.js || '' }, params: args.params || existing?.params || {} };
  if (args.html) {
    if (typeof args.html === 'string') return { code: { html: args.html, css: '', js: '' }, params: existing?.params || {} };
    if (args.html.template) return { template: args.html.template, params: { ...(args.html.params || {}) } };
    if (args.html.code || args.html.html !== undefined) {
      const code = args.html.code || args.html;
      return { code: { html: code.html || '', css: code.css || '', js: code.js || '' }, params: args.html.params || {} };
    }
  }
  return existing || null;
}

// ----------------------------------------------------------------------------------------------
// Subtitle word helpers
// ----------------------------------------------------------------------------------------------
const normWord = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
function cleanWord(w) {
  const o = { text: String(w.text), start: r4(Number(w.start)), end: r4(Number(w.end)) };
  if (w.k === 0 || w.k === 1) o.k = w.k;
  if (Number.isFinite(Number(w.s)) && w.s !== null && w.s !== undefined) o.s = Math.round(Number(w.s) * 100) / 100;
  return o;
}
function cueWordList(q) {
  if (q.words?.length) return q.words;
  const parts = String(q.text || '').split(/\s+/).filter(Boolean);
  const d = (q.end - q.start) / Math.max(1, parts.length);
  return parts.map((w, i) => ({ text: w, start: r4(q.start + i * d), end: r4(q.start + (i + 1) * d) }));
}

// ----------------------------------------------------------------------------------------------
// Operations
// ----------------------------------------------------------------------------------------------
export const OPS = {
  setProjectSettings(p, a) {
    if (a.preset) {
      const r = RESOLUTION_PRESETS[a.preset];
      if (!r) fail(`Unknown preset ${a.preset}. Use: ${Object.keys(RESOLUTION_PRESETS).join(', ')}`);
      p.settings.width = r.width; p.settings.height = r.height;
    }
    if (a.name !== undefined) p.name = String(a.name);
    for (const k of ['width', 'height']) if (a[k] !== undefined) p.settings[k] = Math.max(16, Math.round(Number(a[k]) / 2) * 2);
    if (a.fps !== undefined) p.settings.fps = Math.min(120, Math.max(1, Number(a.fps)));
    if (a.background !== undefined) p.settings.background = String(a.background);
    if (a.masterVolume !== undefined) p.settings.masterVolume = Math.min(4, Math.max(0, Number(a.masterVolume)));
    if (a.normalizeLoudness !== undefined) p.settings.normalizeLoudness = !!a.normalizeLoudness;
    if (a.autoBroll) {
      const ab = { ...p.settings.autoBroll, ...a.autoBroll };
      if (ab.in && !ANIM_IN[ab.in]) fail(`Unknown entrance ${ab.in}. Use: ${Object.keys(ANIM_IN).join(', ')}`);
      if (ab.out && !ANIM_OUT[ab.out]) fail(`Unknown exit ${ab.out}. Use: ${Object.keys(ANIM_OUT).join(', ')}`);
      for (const k of ['imageLoop', 'videoLoop']) if (ab[k] && !ANIM_LOOP[ab[k]]) fail(`Unknown loop ${ab[k]}. Use: ${Object.keys(ANIM_LOOP).join(', ')}`);
      p.settings.autoBroll = ab;
    }
    return { settings: p.settings, name: p.name };
  },

  setNotes(p, a) { p.notes = String(a.notes ?? ''); return { notes: p.notes }; },

  addTrack(p, a) {
    const type = a.type === 'audio' ? 'audio' : 'video';
    return addTrackInternal(p, type, a.name, a.position);
  },

  updateTrack(p, a) {
    const t = resolveTrack(p, a.id || a.track, 'video');
    for (const k of ['name', 'muted', 'hidden', 'locked', 'solo']) if (a[k] !== undefined) t[k] = k === 'name' ? String(a[k]) : !!a[k];
    if (a.volume !== undefined) t.volume = Math.min(4, Math.max(0, Number(a.volume)));
    return t;
  },

  removeTrack(p, a) {
    const t = resolveTrack(p, a.id || a.track, 'video');
    if (tracksOfType(p, t.type).length <= 1) fail('Cannot remove the last track of this type.');
    p.clips = p.clips.filter((c) => c.trackId !== t.id);
    p.tracks = p.tracks.filter((x) => x.id !== t.id);
    return { removed: t.id };
  },

  /**
   * Add a clip. a: { mediaId | template+params | htmlCode | fill, track, start, in, out | duration, mode, ...props }
   * mode: 'overwrite' (default) | 'insert' (ripple later clips) | 'auto' (pick a free track if occupied)
   */
  addClip(p, a, ctx) {
    const media = a.mediaId ? mediaById(p, a.mediaId) : null;
    if (a.mediaId && !media) fail(`Unknown mediaId ${a.mediaId}`);
    const wantType = media?.type === 'audio' ? 'audio' : 'video';
    let trackType = wantType;
    let probeTrack = null;
    const spec = a.trackId || a.track;
    const deferred = !spec || spec === 'auto' || spec === 'overlay' || spec === 'new';
    if (!deferred) {
      probeTrack = resolveTrack(p, spec, wantType);
      trackType = probeTrack.type;
    }
    const type = clipTypeFor(media, trackType, a);
    if (type === 'audio' && media && !media.hasAudio) fail(`Media ${media.name} has no audio stream.`);
    if (type !== 'audio' && trackType === 'audio') {
      ctx.warn(`A ${type} clip cannot go on an audio track; placed on a video track instead.`);
      probeTrack = null;
      trackType = 'video';
    }
    if (type === 'audio' && trackType === 'video') {
      if (probeTrack) ctx.warn('Audio-only clips go on audio tracks; placed on an audio track instead.');
      probeTrack = null;
      trackType = 'audio';
    }
    const speed = a.speed || 1;
    const inPoint = Math.max(0, Number(a.in) || 0);
    let duration;
    if (a.out !== undefined && a.out !== null) duration = (Number(a.out) - inPoint) / speed;
    else if (a.duration !== undefined && a.duration !== null) duration = Number(a.duration);
    else duration = defaultDuration(type, media, { ...a, in: inPoint, speed }, ctx);
    if (!(duration > 0)) fail('Clip duration must be > 0 (check in/out).');
    if (media && (type === 'video' || type === 'audio')) {
      if (inPoint >= media.duration - 1e-3) fail(`in (${inPoint}s) is beyond the media length (${media.duration}s).`);
      const max = (media.duration - inPoint) / speed;
      if (duration > max + 0.02) { ctx.warn(`Duration clamped to media length (${r4(max)}s).`); duration = max; }
    }
    // resolve the track and start
    let track = probeTrack;
    const defaultSpec = deferred && spec ? spec : trackType === 'audio' ? 'auto' : type === 'video' ? 'V1' : 'overlay';
    let start = a.start;
    if (start === undefined || start === null || start === 'end') {
      track = track || resolveTrack(p, defaultSpec === 'V1' ? 'V1' : defaultSpec, trackType, { start: 0, end: 1e9 });
      start = trackEnd(p, track.id);
    }
    start = r4(Math.max(0, Number(start)));
    const end = start + duration;
    if (!track) track = resolveTrack(p, defaultSpec, trackType, { start, end });
    if (track.locked) fail(`Track ${track.name} is locked.`);
    const mode = a.mode || 'overwrite';
    if (mode === 'auto' && !isRangeFree(p, track.id, start, end)) track = resolveTrack(p, trackType === 'video' && type !== 'video' ? 'overlay' : 'auto', trackType, { start, end });
    if (mode === 'insert') {
      // split clips crossing `start` on this track and push later ones
      for (const c of trackClips(p, track.id)) if (c.start < start - EPS && clipEnd(c) > start + EPS) splitClipAt(p, c, start);
      shiftAfter(p, [track.id], start, duration);
    } else {
      const affected = clearRange(p, track.id, start, end);
      if (affected.length) ctx.warn(`Overwrote ${affected.length} clip(s) on ${track.name}.`);
    }
    const clip = makeClip({
      type, trackId: track.id, mediaId: media?.id || null, start, duration, in: inPoint, speed,
      name: a.name || media?.name || (a.template ? ctx.template?.(a.template)?.name : null) || (type === 'color' ? 'Color' : type === 'html' ? 'Motion' : 'Clip'),
    });
    if (type === 'image' || type === 'html' || type === 'color') clip.in = 0;
    if (type === 'html') {
      clip.html = media && (media.type === 'html' || media.type === 'lottie') && !a.template && !a.htmlCode && !a.html ? htmlFromMedia(media, a) : buildHtml(a, null);
      if (!clip.html) fail('html clip needs a template (with params) or htmlCode.');
      clip.fit = 'stretch';
    }
    if (type === 'color') { clip.fill = a.fill || '#000000'; clip.fit = 'stretch'; }
    applyVisualProps(clip, a);
    applyAutoBroll(p, clip, a);
    normalizeClip(clip);
    p.clips.push(clip);
    return clip;
  },

  /** Add several clips. a: { items: [...], sequential?: bool, track?, start? } */
  addClips(p, a, ctx) {
    const out = [];
    let cursor = a.start ?? null;
    for (const item of a.items || []) {
      const args = { mode: a.mode, ...item };
      if (a.sequential) {
        if (args.track === undefined && a.track !== undefined) args.track = a.track;
        if (args.start === undefined) args.start = cursor ?? 'end';
      }
      const c = OPS.addClip(p, args, ctx);
      cursor = clipEnd(c) + (a.gap || 0);
      out.push(c);
    }
    return out;
  },

  /** Replace/append a whole sequence of selects back-to-back on one track (rough cut). */
  assembleSequence(p, a, ctx) {
    const track = resolveTrack(p, a.track || 'V1', 'video');
    let cursor = r4(a.start ?? (a.replace ? 0 : trackEnd(p, track.id)));
    if (a.replace) {
      const ids = new Set(p.clips.filter((c) => c.trackId === track.id).map((c) => c.id));
      p.clips = p.clips.filter((c) => !ids.has(c.id));
    }
    const out = [];
    for (const item of a.items || []) {
      const c = OPS.addClip(p, { ...item, track: track.id, start: cursor, mode: 'overwrite' }, ctx);
      out.push(c);
      cursor = r4(clipEnd(c) + (a.gap || 0));
    }
    return { track: track.name, clips: out, end: cursor };
  },

  updateClip(p, a, ctx) {
    const c = clipById(p, a.id);
    if (!c) fail(`Unknown clip ${a.id}`);
    const media = mediaById(p, c.mediaId);
    const oldTrack = c.trackId;
    if (a.speed !== undefined && a.duration === undefined && (c.type === 'video' || c.type === 'audio')) {
      const src = c.duration * c.speed;
      c.speed = Math.min(16, Math.max(0.0625, Number(a.speed)));
      c.duration = r4(src / c.speed);
    }
    if (a.in !== undefined && c.type !== 'image' && c.type !== 'html' && c.type !== 'color') c.in = r4(Math.max(0, Number(a.in)));
    if (a.out !== undefined && a.duration === undefined) a.duration = (Number(a.out) - c.in) / (a.speed || c.speed);
    if (a.duration !== undefined) c.duration = r4(Math.max(1 / 240, Number(a.duration)));
    if (a.start !== undefined) c.start = r4(Math.max(0, Number(a.start)));
    if (a.track !== undefined || a.trackId !== undefined) {
      const t = resolveTrack(p, a.trackId || a.track, c.type === 'audio' ? 'audio' : 'video');
      if ((t.type === 'audio') !== (c.type === 'audio')) fail(`Cannot move a ${c.type} clip to ${t.type} track ${t.name}.`);
      c.trackId = t.id;
    }
    const max = maxClipDuration(c, media);
    if (c.duration > max + 0.02) { ctx.warn(`Duration clamped to the available media (${r4(max)}s).`); c.duration = r4(max); }
    applyVisualProps(c, a);
    if (c.type === 'html' && (a.html || a.template || a.params || a.htmlCode)) c.html = buildHtml(a, c.html);
    if (a.color === null) c.color = null;
    normalizeClip(c);
    if (a.start !== undefined || a.duration !== undefined || c.trackId !== oldTrack || a.speed !== undefined) {
      const affected = clearRange(p, c.trackId, c.start, clipEnd(c), [c.id]);
      if (affected.length) ctx.warn(`Overwrote ${affected.length} clip(s) on the track.`);
    }
    return c;
  },

  updateClips(p, a, ctx) {
    return (a.items || []).map((it) => OPS.updateClip(p, it, ctx));
  },

  /** UI drag: move several clips by delta seconds (and optionally to another track). */
  moveClips(p, a, ctx) {
    const ids = a.ids || [];
    const clips = ids.map((id) => clipById(p, id)).filter(Boolean);
    if (!clips.length) fail('No clips to move');
    let delta = Number(a.delta) || 0;
    const minStart = Math.min(...clips.map((c) => c.start));
    if (minStart + delta < 0) delta = -minStart;
    const trackShift = Number(a.trackShift) || 0;
    for (const c of clips) {
      c.start = r4(c.start + delta);
      if (trackShift || a.toTrackId) {
        const type = c.type === 'audio' ? 'audio' : 'video';
        const list = tracksOfType(p, type);
        let idx = list.findIndex((t) => t.id === c.trackId);
        if (a.toTrackId && ids.length === 1) {
          const t = trackById(p, a.toTrackId);
          if (t && t.type === type) idx = list.indexOf(t);
        } else idx = Math.max(0, Math.min(list.length - 1, idx + trackShift));
        c.trackId = list[idx].id;
      }
    }
    for (const c of clips) clearRange(p, c.trackId, c.start, clipEnd(c), ids);
    return clips;
  },

  /** Trim an edge to a timeline time. a: {id, edge: 'start'|'end', time, ripple} */
  trimClip(p, a) {
    const c = clipById(p, a.id);
    if (!c) fail(`Unknown clip ${a.id}`);
    const media = mediaById(p, c.mediaId);
    const neighbors = trackClips(p, c.trackId).filter((x) => x.id !== c.id);
    const t = r4(Number(a.time));
    const minDur = 1 / (p.settings.fps || 30);
    if (a.edge === 'start') {
      const prevEnd = Math.max(0, ...neighbors.filter((x) => clipEnd(x) <= c.start + EPS).map(clipEnd));
      let ns = Math.max(a.ripple ? 0 : prevEnd, Math.min(t, clipEnd(c) - minDur));
      if (c.type === 'video' || c.type === 'audio') ns = Math.max(ns, c.start - c.in / c.speed);
      const d = ns - c.start;
      const oldEnd = clipEnd(c);
      if (!STILL_TYPES.has(c.type)) c.in = r4(Math.max(0, c.in + d * c.speed));
      c.start = r4(ns);
      c.duration = r4(oldEnd - ns);
      if (c.keyframes) for (const k of Object.keys(c.keyframes)) c.keyframes[k] = c.keyframes[k].map((f) => ({ ...f, t: r4(f.t - d) }));
      if (a.ripple) { c.start = r4(c.start - d); shiftAfter(p, [c.trackId], oldEnd, -d, [c.id]); }
    } else {
      const nextStart = Math.min(Infinity, ...neighbors.filter((x) => x.start >= clipEnd(c) - EPS).map((x) => x.start));
      const max = c.start + maxClipDuration(c, media);
      const oldEnd = clipEnd(c);
      const ne = Math.max(c.start + minDur, Math.min(t, max, a.ripple ? Infinity : nextStart));
      c.duration = r4(ne - c.start);
      if (a.ripple) shiftAfter(p, [c.trackId], oldEnd, ne - oldEnd, [c.id]);
    }
    normalizeClip(c);
    return c;
  },

  splitClip(p, a) {
    const c = clipById(p, a.id);
    if (!c) fail(`Unknown clip ${a.id}`);
    const right = splitClipAt(p, c, Number(a.time));
    if (!right) fail(`Time ${a.time}s is not inside clip ${c.id} (${c.start}–${clipEnd(c)}).`);
    return { left: c.id, right: right.id };
  },

  /** Split every clip crossing `time` (optionally restricted to tracks). */
  splitAt(p, a) {
    const t = Number(a.time);
    const tracks = a.tracks ? a.tracks.map((s) => resolveTrack(p, s, 'video').id) : null;
    const out = [];
    for (const c of [...p.clips]) {
      if (tracks && !tracks.includes(c.trackId)) continue;
      if (trackById(p, c.trackId)?.locked) continue;
      if (c.start < t - EPS && clipEnd(c) > t + EPS) {
        const r = splitClipAt(p, c, t);
        if (r) out.push({ left: c.id, right: r.id });
      }
    }
    return out;
  },

  removeClips(p, a) {
    const ids = new Set(a.ids || (a.id ? [a.id] : []));
    const removed = p.clips.filter((c) => ids.has(c.id));
    if (!removed.length) fail('No matching clips.');
    p.clips = p.clips.filter((c) => !ids.has(c.id));
    if (a.ripple) {
      // close the gap left on each clip's own track, processing from the latest clip
      for (const c of removed.sort((x, y) => y.start - x.start)) {
        const blocked = p.clips.some((o) => o.trackId === c.trackId && o.start < clipEnd(c) - EPS && clipEnd(o) > c.start + EPS);
        if (!blocked) shiftAfter(p, [c.trackId], clipEnd(c), -c.duration);
      }
    }
    return { removed: removed.map((c) => c.id) };
  },

  /** Remove [start,end) on all (or given) tracks and close the gap (also shifts subtitles & markers). */
  rippleDeleteRange(p, a) {
    const start = r4(Number(a.start)), end = r4(Number(a.end));
    if (!(end > start)) fail('end must be greater than start');
    const ids = a.tracks ? a.tracks.map((s) => resolveTrack(p, s, 'video').id) : p.tracks.filter((t) => !t.locked).map((t) => t.id);
    for (const id of ids) clearRange(p, id, start, end);
    shiftAfter(p, ids, end, -(end - start));
    if (!a.tracks || a.shiftSubtitles) shiftSubtitlesAndMarkers(p, end, -(end - start), start, end);
    return { removed: r4(end - start), duration: projectDuration(p) };
  },

  /** Remove several timeline ranges (e.g. silences); processed from the end so times stay valid. */
  rippleDeleteRanges(p, a, ctx) {
    const ranges = [...(a.ranges || [])].map((r) => [Number(r.start ?? r[0]), Number(r.end ?? r[1])]).filter(([s, e]) => e > s).sort((x, y) => y[0] - x[0]);
    let total = 0;
    for (const [s, e] of ranges) { OPS.rippleDeleteRange(p, { start: s, end: e, tracks: a.tracks, shiftSubtitles: a.shiftSubtitles }, ctx); total += e - s; }
    return { rangesRemoved: ranges.length, secondsRemoved: r4(total), duration: projectDuration(p) };
  },

  insertGap(p, a) {
    const at = r4(Number(a.at)), d = r4(Number(a.duration));
    if (!(d > 0)) fail('duration must be > 0');
    const ids = a.tracks ? a.tracks.map((s) => resolveTrack(p, s, 'video').id) : p.tracks.filter((t) => !t.locked).map((t) => t.id);
    for (const c of [...p.clips]) if (ids.includes(c.trackId) && c.start < at - EPS && clipEnd(c) > at + EPS) splitClipAt(p, c, at);
    shiftAfter(p, ids, at, d);
    if (!a.tracks || a.shiftSubtitles) shiftSubtitlesAndMarkers(p, at, d);
    return { duration: projectDuration(p) };
  },

  /**
   * Layout presets for a visual clip: full | fit | pip-tr | pip-tl | pip-br | pip-bl | split-left | split-right | split-top | split-bottom | blur-fill
   * (blur-fill = blurred, zoomed copy of the clip behind it — typical for horizontal footage in a vertical video).
   */
  layoutClip(p, a) {
    const c = clipById(p, a.id);
    if (!c) fail(`Unknown clip ${a.id}`);
    if (!isVisual(c)) fail('Layouts apply to visual clips.');
    const W = p.settings.width, H = p.settings.height;
    const media = mediaById(p, c.mediaId);
    const [mw, mh] = contentSize(c, media, W, H);
    const k = Math.min(W, H);
    const reset = () => { c.x = 0; c.y = 0; c.scale = 1; c.rotation = 0; c.crop = null; };
    const pre = a.preset;
    if (pre === 'full') { reset(); if (c.type !== 'html' && c.type !== 'color') c.fit = 'cover'; c.radius = 0; c.border = null; c.shadow = null; }
    else if (pre === 'fit') { reset(); if (c.type !== 'html' && c.type !== 'color') c.fit = 'contain'; }
    else if (/^pip-/.test(pre)) {
      reset();
      if (c.type !== 'html' && c.type !== 'color') c.fit = 'contain';
      const [fw, fh] = fittedSize(c.fit || 'contain', mw, mh, W, H);
      const s = ((W >= H ? 0.34 : 0.5) * W) / fw;
      const w = fw * s, h = fh * s, m = 0.045 * k;
      c.scale = r4(s);
      c.x = r4((pre.endsWith('r') ? 1 : -1) * (W / 2 - m - w / 2));
      c.y = r4((pre.includes('-b') ? 1 : -1) * (H / 2 - m - h / 2));
      c.radius = r4((0.03 * k) / s);
      c.shadow = c.shadow || { blur: 40, x: 0, y: 14, opacity: 0.45, color: '#000000' };
    } else if (/^split-/.test(pre)) {
      reset();
      if (c.type !== 'html' && c.type !== 'color') c.fit = 'cover';
      const [fw, fh] = fittedSize(c.fit || 'cover', mw, mh, W, H);
      const horiz = pre === 'split-left' || pre === 'split-right';
      const vw = horiz ? W / 2 : W, vh = horiz ? H : H / 2;
      const cx = Math.max(0, (1 - vw / fw) / 2), cy = Math.max(0, (1 - vh / fh) / 2);
      c.crop = { left: r4(cx), right: r4(cx), top: r4(cy), bottom: r4(cy) };
      if (horiz) c.x = r4((pre === 'split-left' ? -1 : 1) * W / 4); else c.y = r4((pre === 'split-top' ? -1 : 1) * H / 4);
      c.radius = 0;
    } else if (pre === 'blur-fill') {
      const vids = tracksOfType(p, 'video');
      const idx = vids.findIndex((t) => t.id === c.trackId);
      const bgTrack = addTrackInternal(p, 'video', a.trackName || 'Fond', idx);
      const bg = structuredClone(c);
      Object.assign(bg, {
        id: uid('clip'), trackId: bgTrack.id, fit: 'cover', x: 0, y: 0, scale: 1.08, rotation: 0, crop: null, muted: true, anim: null,
        radius: 0, border: null, shadow: null, chromaKey: null, keyframes: null, vignette: 0.35, label: 'blur-fill',
        color: { ...(c.color || {}), blur: 38, brightness: 0.72, saturation: 1.15 }, name: `${c.name} (fond flou)`,
      });
      normalizeClip(bg);
      p.clips.push(bg);
      if (c.type !== 'html' && c.type !== 'color') c.fit = 'contain';
      c.x = 0; c.y = 0; c.scale = 1; c.crop = null;
    } else fail('preset must be full | fit | pip-tr | pip-tl | pip-br | pip-bl | split-left | split-right | split-top | split-bottom | blur-fill');
    normalizeClip(c);
    return c;
  },

  duplicateClips(p, a, ctx) {
    const out = [];
    for (const id of a.ids || []) {
      const c = clipById(p, id);
      if (!c) continue;
      const copy = structuredClone(c);
      copy.id = uid('clip');
      copy.start = r4(a.start !== undefined ? Number(a.start) : clipEnd(c) + (Number(a.offset) || 0));
      if (a.track) copy.trackId = resolveTrack(p, a.track, c.type === 'audio' ? 'audio' : 'video').id;
      clearRange(p, copy.trackId, copy.start, clipEnd(copy));
      p.clips.push(copy);
      out.push(copy);
    }
    if (!out.length) ctx.warn('Nothing duplicated.');
    return out;
  },

  /** Put the audio of a video clip on its own audio clip (the video clip gets muted). */
  detachAudio(p, a) {
    const c = clipById(p, a.id);
    if (!c || c.type !== 'video') fail('detachAudio needs a video clip id');
    const media = mediaById(p, c.mediaId);
    if (!media?.hasAudio) fail('This clip has no audio');
    const track = resolveTrack(p, a.track || 'auto', 'audio', { start: c.start, end: clipEnd(c) });
    clearRange(p, track.id, c.start, clipEnd(c));
    const ac = makeClip({
      type: 'audio', trackId: track.id, mediaId: c.mediaId, start: c.start, duration: c.duration, in: c.in, speed: c.speed,
      volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, name: `${c.name} (audio)`,
    });
    if (c.keyframes?.volume) ac.keyframes = { volume: structuredClone(c.keyframes.volume) };
    c.muted = true;
    p.clips.push(ac);
    return ac;
  },

  setTransition(p, a) {
    const c = clipById(p, a.id);
    if (!c) fail(`Unknown clip ${a.id}`);
    if (!isVisual(c)) fail('Transitions apply to visual clips (video/image/html/color).');
    if (!a.type || a.type === 'none') { c.transition = null; return c; }
    if (!TRANSITION_IDS.includes(a.type)) fail(`Unknown transition "${a.type}". Available: ${TRANSITION_IDS.join(', ')}`);
    c.transition = { type: a.type, duration: Number(a.duration) || 0.5 };
    normalizeClip(c);
    return c;
  },

  setKeyframes(p, a) {
    const c = clipById(p, a.id);
    if (!c) fail(`Unknown clip ${a.id}`);
    if (!KEYFRAME_PROPS.includes(a.property)) fail(`property must be one of ${KEYFRAME_PROPS.join(', ')}`);
    for (const k of a.keyframes || []) if (k.ease && !EASING_NAMES.includes(k.ease)) fail(`ease must be one of ${EASING_NAMES.join(', ')}`);
    c.keyframes = { ...(c.keyframes || {}) };
    if (!a.keyframes || !a.keyframes.length) delete c.keyframes[a.property];
    else c.keyframes[a.property] = a.keyframes.map((k) => ({ t: Number(k.t ?? k.time), v: Number(k.v ?? k.value), ease: k.ease }));
    normalizeClip(c);
    return c;
  },

  /** Keyframe presets: zoom-in, zoom-out, pan-left, pan-right, pop-in, slide-in-*, fade-in, fade-out, shake, pulse */
  animateClip(p, a) {
    const c = clipById(p, a.id);
    if (!c) fail(`Unknown clip ${a.id}`);
    const W = p.settings.width, H = p.settings.height, D = c.duration;
    const amt = a.amount ?? null;
    const d = Math.min(a.duration ?? 0.45, D);
    const kf = { ...(c.keyframes || {}) };
    const s0 = c.scale || 1;
    switch (a.preset) {
      case 'zoom-in': kf.scale = [{ t: 0, v: s0, ease: 'ease-in-out' }, { t: D, v: s0 * (1 + (amt ?? 0.15)) }]; break;
      case 'zoom-out': kf.scale = [{ t: 0, v: s0 * (1 + (amt ?? 0.15)), ease: 'ease-in-out' }, { t: D, v: s0 }]; break;
      case 'pan-left': kf.x = [{ t: 0, v: (amt ?? 0.06) * W, ease: 'ease-in-out' }, { t: D, v: -(amt ?? 0.06) * W }]; kf.scale = [{ t: 0, v: Math.max(s0, 1.15) }]; break;
      case 'pan-right': kf.x = [{ t: 0, v: -(amt ?? 0.06) * W, ease: 'ease-in-out' }, { t: D, v: (amt ?? 0.06) * W }]; kf.scale = [{ t: 0, v: Math.max(s0, 1.15) }]; break;
      case 'pop-in': kf.scale = [{ t: 0, v: s0 * 0.6, ease: 'ease-out' }, { t: d * 0.7, v: s0 * 1.06, ease: 'ease-in-out' }, { t: d, v: s0 }]; kf.opacity = [{ t: 0, v: 0, ease: 'ease-out' }, { t: d * 0.5, v: c.opacity ?? 1 }]; break;
      case 'slide-in-left': kf.x = [{ t: 0, v: -W, ease: 'ease-out' }, { t: d, v: c.x || 0 }]; break;
      case 'slide-in-right': kf.x = [{ t: 0, v: W, ease: 'ease-out' }, { t: d, v: c.x || 0 }]; break;
      case 'slide-in-up': kf.y = [{ t: 0, v: H, ease: 'ease-out' }, { t: d, v: c.y || 0 }]; break;
      case 'slide-in-down': kf.y = [{ t: 0, v: -H, ease: 'ease-out' }, { t: d, v: c.y || 0 }]; break;
      case 'fade-in': kf.opacity = [{ t: 0, v: 0, ease: 'ease-out' }, { t: d, v: c.opacity ?? 1 }]; break;
      case 'fade-out': kf.opacity = [{ t: Math.max(0, D - d), v: c.opacity ?? 1, ease: 'ease-in' }, { t: D, v: 0 }]; break;
      case 'shake': {
        const n = Math.max(4, Math.round(d / 0.04));
        const A = (amt ?? 0.012) * W;
        kf.x = Array.from({ length: n + 1 }, (_, i) => ({ t: (i * d) / n, v: (c.x || 0) + (i === n ? 0 : (i % 2 ? 1 : -1) * A * (1 - i / n)) }));
        break;
      }
      case 'pulse': {
        const beats = Math.max(1, Math.floor(D / (a.interval || 0.5)));
        const iv = D / beats;
        kf.scale = [];
        for (let i = 0; i < beats; i++) { kf.scale.push({ t: i * iv, v: s0 * (1 + (amt ?? 0.06)), ease: 'ease-out' }); kf.scale.push({ t: i * iv + iv * 0.6, v: s0 }); }
        break;
      }
      case 'none': return OPS.clearKeyframes(p, { id: c.id });
      default: fail('Unknown preset. Use zoom-in, zoom-out, pan-left, pan-right, pop-in, slide-in-left/right/up/down, fade-in, fade-out, shake, pulse, none');
    }
    c.keyframes = kf;
    normalizeClip(c);
    return c;
  },

  clearKeyframes(p, a) {
    const c = clipById(p, a.id);
    if (!c) fail(`Unknown clip ${a.id}`);
    if (a.property && c.keyframes) delete c.keyframes[a.property]; else c.keyframes = null;
    normalizeClip(c);
    return c;
  },

  /**
   * Entrance / exit / continuous animation on one or several visual clips (independent from keyframes).
   * a: { ids | id, in, out, loop } — each a type string or {type, duration | amount, speed}; null / 'none' removes it.
   */
  setAnimation(p, a) {
    const ids = a.ids || (a.id ? [a.id] : []);
    const out = [];
    for (const id of ids) {
      const c = clipById(p, id);
      if (!c) fail(`Unknown clip ${id}`);
      if (!isVisual(c)) continue;
      c.anim = a.clear ? null : mergeAnim(c.anim, { in: a.in, out: a.out, loop: a.loop });
      normalizeClip(c);
      out.push(c);
    }
    if (!out.length) fail('No visual clip to animate (audio clips cannot be animated).');
    return out;
  },

  /** Rounded corners / border / drop shadow on one or several visual clips. a: { ids | id, radius, border, shadow } */
  setFrameLook(p, a) {
    const ids = a.ids || (a.id ? [a.id] : []);
    const out = [];
    for (const id of ids) {
      const c = clipById(p, id);
      if (!c) fail(`Unknown clip ${id}`);
      if (!isVisual(c)) continue;
      if (a.radius !== undefined) c.radius = Number(a.radius) || 0;
      if (a.border !== undefined) c.border = a.border ? { ...(c.border || { width: 8, color: '#ffffff' }), ...a.border } : null;
      if (a.shadow !== undefined) c.shadow = a.shadow ? { ...(c.shadow || { blur: 40, x: 0, y: 14, opacity: 0.45, color: '#000000' }), ...a.shadow } : null;
      normalizeClip(c);
      out.push(c);
    }
    if (!out.length) fail('No visual clip to style.');
    return out;
  },

  addMarker(p, a) {
    const m = { id: uid('mk'), time: r4(Math.max(0, Number(a.time) || 0)), label: String(a.label || ''), color: a.color || '#f59e0b', duration: Number(a.duration) || 0 };
    p.markers.push(m);
    p.markers.sort((x, y) => x.time - y.time);
    return m;
  },
  updateMarker(p, a) {
    const m = p.markers.find((x) => x.id === a.id);
    if (!m) fail(`Unknown marker ${a.id}`);
    if (a.time !== undefined) m.time = r4(Number(a.time));
    if (a.label !== undefined) m.label = String(a.label);
    if (a.color !== undefined) m.color = a.color;
    p.markers.sort((x, y) => x.time - y.time);
    return m;
  },
  removeMarkers(p, a) {
    const ids = new Set(a.ids || (a.id ? [a.id] : p.markers.map((m) => m.id)));
    const before = p.markers.length;
    p.markers = p.markers.filter((m) => !ids.has(m.id));
    return { removed: before - p.markers.length };
  },

  // --- media ---------------------------------------------------------------------------------
  addMedia(p, a) {
    if (p.media.some((m) => m.id === a.media.id)) return a.media;
    p.media.push(a.media);
    return a.media;
  },
  updateMedia(p, a) {
    const m = mediaById(p, a.id);
    if (!m) fail(`Unknown media ${a.id}`);
    for (const k of ['name', 'notes', 'tags', 'favorite', 'label']) if (a[k] !== undefined) m[k] = a[k];
    if (a.path !== undefined) { m.path = a.path; m.offline = false; }
    return m;
  },
  removeMedia(p, a) {
    const ids = new Set(a.ids || [a.id]);
    const n = p.clips.length;
    p.clips = p.clips.filter((c) => !ids.has(c.mediaId));
    p.media = p.media.filter((m) => !ids.has(m.id));
    return { removedMedia: [...ids], removedClips: n - p.clips.length };
  },

  // --- subtitles -----------------------------------------------------------------------------
  setSubtitleCues(p, a) {
    const cues = (a.cues || []).map((q) => ({
      id: q.id || uid('cue'), start: r4(Number(q.start)), end: r4(Number(q.end)), text: String(q.text ?? '').trim(),
      ...(q.words ? { words: q.words.map(cleanWord) } : {}),
    })).filter((q) => q.end > q.start && q.text);
    p.subtitles.cues = a.append ? [...p.subtitles.cues, ...cues] : cues;
    p.subtitles.cues.sort((x, y) => x.start - y.start);
    p.subtitles.enabled = true;
    return { count: p.subtitles.cues.length };
  },
  updateSubtitleCues(p, a) {
    const out = [];
    for (const it of a.items || []) {
      const q = p.subtitles.cues.find((x) => x.id === it.id);
      if (!q) fail(`Unknown cue ${it.id}`);
      if (it.text !== undefined) {
        const text = String(it.text).trim();
        if (q.words && text !== q.text) {
          const parts = text.split(/\s+/).filter(Boolean);
          if (parts.length === q.words.length) q.words = q.words.map((w, i) => ({ ...w, text: parts[i] }));
          else {
            const d = (q.end - q.start) / Math.max(1, parts.length);
            q.words = parts.map((w, i) => ({ text: w, start: r4(q.start + i * d), end: r4(q.start + (i + 1) * d) }));
          }
        }
        q.text = text;
      }
      if (Array.isArray(it.keywords)) {
        // explicit keyword choice for this cue: word indices (or words) → k=1, every other word → k=0
        const words = cueWordList(q);
        const set = new Set(it.keywords.map((x) => (typeof x === 'number' ? x : words.findIndex((w) => normWord(w.text) === normWord(x)))).filter((i) => i >= 0));
        q.words = words.map((w, i) => ({ ...w, k: set.has(i) ? 1 : 0 }));
      }
      if (it.emoji !== undefined) { if (it.emoji) q.emoji = String(it.emoji).slice(0, 8); else delete q.emoji; }
      if (it.start !== undefined || it.end !== undefined) {
        const ns = it.start !== undefined ? Number(it.start) : q.start;
        const ne = it.end !== undefined ? Number(it.end) : q.end;
        if (q.words?.length) {
          const k = (ne - ns) / Math.max(1e-6, q.end - q.start);
          q.words = q.words.map((w) => ({ ...w, start: r4(ns + (w.start - q.start) * k), end: r4(ns + (w.end - q.start) * k) }));
        }
        q.start = r4(ns); q.end = r4(ne);
      }
      out.push(q);
    }
    p.subtitles.cues.sort((x, y) => x.start - y.start);
    return out;
  },
  /**
   * Choose the important words of the subtitles (keyword / emphasis modes). Words carry k: 1 (keyword), 0 (not), absent (automatic score).
   * a: { items: [{ cueId, keywords: [wordIndex | "word"], emoji? }], words: [{ time, k? }] (timeline seconds, exclusive by default),
   *      reset (back to automatic), clear (no keyword at all), mode ('all' | 'emphasis' | 'keywords') }
   */
  setSubtitleKeywords(p, a) {
    const cues = p.subtitles.cues;
    let changed = 0;
    const setAll = (fn) => { for (const q of cues) { q.words = cueWordList(q).map((w) => fn({ ...w })); } };
    if (a.reset) setAll((w) => { delete w.k; return w; });
    if (a.clear) setAll((w) => ({ ...w, k: 0 }));
    for (const it of a.items || []) {
      const q = cues.find((x) => x.id === (it.cueId || it.id));
      if (!q) fail(`Unknown cue ${it.cueId || it.id}`);
      const words = cueWordList(q);
      const set = new Set((it.keywords || []).map((x) => (typeof x === 'number' ? x : words.findIndex((w) => normWord(w.text) === normWord(x)))).filter((i) => i >= 0 && i < words.length));
      q.words = words.map((w, i) => ({ ...w, k: set.has(i) ? 1 : 0 }));
      if (it.emoji !== undefined) { if (it.emoji) q.emoji = String(it.emoji).slice(0, 8); else delete q.emoji; }
      changed++;
    }
    if (a.words?.length) {
      if (a.exclusive !== false) setAll((w) => ({ ...w, k: 0 }));
      for (const sel of a.words) {
        const t = Number(sel.time ?? sel.start);
        const q = cues.find((x) => t >= x.start - 0.05 && t <= x.end + 0.05);
        if (!q) continue;
        let best = -1, bd = Infinity;
        q.words.forEach((w, i) => {
          const d = t < w.start ? w.start - t : t > w.end ? t - w.end : 0;
          const textOk = !sel.text || normWord(sel.text) === normWord(w.text);
          if (textOk && d < bd) { bd = d; best = i; }
        });
        if (best >= 0) { q.words[best] = { ...q.words[best], k: sel.k ?? 1 }; changed++; }
      }
    }
    if (a.mode) {
      if (!['all', 'emphasis', 'keywords'].includes(a.mode)) fail('mode must be all | emphasis | keywords');
      p.subtitles.style = { ...p.subtitles.style, mode: a.mode };
    }
    return { changed, mode: p.subtitles.style.mode || 'all' };
  },

  removeSubtitleCues(p, a) {
    const ids = new Set(a.ids || []);
    const n = p.subtitles.cues.length;
    p.subtitles.cues = p.subtitles.cues.filter((q) => !ids.has(q.id));
    return { removed: n - p.subtitles.cues.length };
  },
  setSubtitleStyle(p, a) {
    if (a.preset && !SUBTITLE_PRESETS[a.preset]) fail(`Unknown subtitle preset. Use: ${Object.keys(SUBTITLE_PRESETS).join(', ')}`);
    const st = a.reset || a.preset ? { preset: a.preset || p.subtitles.style.preset } : { ...p.subtitles.style };
    if (a.preset && !a.reset) Object.assign(st, Object.fromEntries(Object.entries(p.subtitles.style).filter(([k]) => k === 'position' || k === 'offsetY')));
    for (const k of SUBTITLE_STYLE_KEYS) if (a.style && a.style[k] !== undefined) st[k] = a.style[k];
    p.subtitles.style = st;
    if (a.enabled !== undefined) p.subtitles.enabled = !!a.enabled;
    return p.subtitles.style;
  },
  setSubtitlesEnabled(p, a) { p.subtitles.enabled = !!a.enabled; return { enabled: p.subtitles.enabled }; },
  clearSubtitles(p) { const n = p.subtitles.cues.length; p.subtitles.cues = []; return { removed: n }; },
};

export const OP_NAMES = Object.keys(OPS);
