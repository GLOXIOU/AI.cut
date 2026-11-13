// Project data model: factories, defaults and normalization.
import { uid } from '../core/util.js';
import { r4 } from '../../shared/timeline.js';
import { normalizeAnim } from '../../shared/anim.js';
import { AUDIO_FX_IDS } from '../../shared/audiofx.js';
import { SUBTITLE_DEFAULT_PRESET } from '../../shared/subtitles.js';

export const SCHEMA_VERSION = 1;

export const RESOLUTION_PRESETS = {
  '1080p': { width: 1920, height: 1080, label: 'YouTube 16:9 1080p' },
  '4k': { width: 3840, height: 2160, label: '4K UHD 16:9' },
  '720p': { width: 1280, height: 720, label: 'HD 720p' },
  vertical: { width: 1080, height: 1920, label: 'TikTok / Reels / Shorts 9:16' },
  square: { width: 1080, height: 1080, label: 'Instagram 1:1' },
  portrait: { width: 1080, height: 1350, label: 'Instagram 4:5' },
  cinema: { width: 1920, height: 804, label: 'Cinema 2.39:1' },
};

/** Animation applied automatically to B-roll (images / videos dropped on overlay tracks V2+). */
export const AUTO_BROLL_DEFAULTS = { enabled: false, in: 'pop', inDuration: 0.45, out: 'fade', outDuration: 0.35, imageLoop: 'kenburns-in', videoLoop: '', radius: 0, shadow: false };

export function makeTrack(type, name) {
  return { id: uid(type === 'video' ? 'v' : 'a'), type, name, muted: false, hidden: false, locked: false, solo: false, volume: 1 };
}

export function createProject({ name = 'Untitled', preset = '1080p', width, height, fps = 30 } = {}) {
  const res = RESOLUTION_PRESETS[preset] || RESOLUTION_PRESETS['1080p'];
  const now = new Date().toISOString();
  return {
    schema: SCHEMA_VERSION,
    id: uid('prj', 8),
    name,
    createdAt: now,
    updatedAt: now,
    settings: { width: width || res.width, height: height || res.height, fps, sampleRate: 48000, background: '#000000', masterVolume: 1, normalizeLoudness: false, autoBroll: { ...AUTO_BROLL_DEFAULTS } },
    media: [],
    tracks: [makeTrack('video', 'V1'), makeTrack('video', 'V2'), makeTrack('video', 'V3'), makeTrack('audio', 'A1'), makeTrack('audio', 'A2'), makeTrack('audio', 'A3')],
    clips: [],
    subtitles: { enabled: true, style: { preset: SUBTITLE_DEFAULT_PRESET }, cues: [] },
    markers: [],
    notes: '',
  };
}

const CLIP_DEFAULTS = {
  name: '',
  in: 0,
  speed: 1,
  volume: 1,
  muted: false,
  fadeIn: 0,
  fadeOut: 0,
  opacity: 1,
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  flipH: false,
  flipV: false,
  fit: 'contain',
  crop: null,
  color: null,
  chromaKey: null,
  vignette: 0,
  transition: null,
  videoFadeIn: 0,
  videoFadeOut: 0,
  keyframes: null,
  html: null,
  fill: null,
  label: null,
  audioFx: null, // voice / audio effect preset: { preset: 'voice' | 'podcast' | 'radio' | 'phone' | 'deep' | 'echo' | 'megaphone' | 'underwater' }
  anim: null, // { in: {type, duration}, out: {type, duration}, loop: {type, amount, speed, offset, span} }
  radius: 0, // rounded corners, px in the clip's fitted space
  border: null, // { width, color }
  shadow: null, // { blur, x, y, opacity, color }
};

const isColor = (c) => typeof c === 'string' && c.length < 64;

export function makeClip(props) {
  const c = { id: props.id || uid('clip'), type: props.type, trackId: props.trackId, mediaId: props.mediaId || null, ...CLIP_DEFAULTS, ...props };
  return normalizeClip(c);
}

export function normalizeClip(c) {
  c.start = r4(Math.max(0, Number(c.start) || 0));
  c.duration = r4(Math.max(1 / 240, Number(c.duration) || 0));
  c.in = r4(Math.max(0, Number(c.in) || 0));
  c.speed = Math.min(16, Math.max(0.0625, Number(c.speed) || 1));
  c.volume = Math.min(8, Math.max(0, Number(c.volume ?? 1)));
  c.opacity = Math.min(1, Math.max(0, Number(c.opacity ?? 1)));
  c.scale = Math.min(50, Math.max(0.001, Number(c.scale ?? 1)));
  c.x = r4(Number(c.x) || 0);
  c.y = r4(Number(c.y) || 0);
  c.rotation = r4(Number(c.rotation) || 0);
  c.fadeIn = r4(Math.max(0, Math.min(c.duration, Number(c.fadeIn) || 0)));
  c.fadeOut = r4(Math.max(0, Math.min(c.duration, Number(c.fadeOut) || 0)));
  c.videoFadeIn = r4(Math.max(0, Math.min(c.duration, Number(c.videoFadeIn) || 0)));
  c.videoFadeOut = r4(Math.max(0, Math.min(c.duration, Number(c.videoFadeOut) || 0)));
  if (c.crop) {
    const k = ['top', 'right', 'bottom', 'left'];
    const cr = {};
    for (const key of k) cr[key] = Math.min(0.95, Math.max(0, Number(c.crop[key]) || 0));
    c.crop = k.some((key) => cr[key] > 0) ? cr : null;
  }
  if (c.transition && (!c.transition.type || c.transition.type === 'none' || !(c.transition.duration > 0))) c.transition = null;
  if (c.transition) c.transition = { type: c.transition.type, duration: r4(Math.min(10, Math.max(0.04, Number(c.transition.duration)))) };
  if (c.keyframes) {
    for (const k of Object.keys(c.keyframes)) {
      const arr = (c.keyframes[k] || []).filter((f) => Number.isFinite(Number(f.t)) && Number.isFinite(Number(f.v)))
        .map((f) => ({ t: r4(Number(f.t)), v: Number(f.v), ...(f.ease ? { ease: f.ease } : {}) }))
        .sort((a, b) => a.t - b.t);
      if (arr.length) c.keyframes[k] = arr; else delete c.keyframes[k];
    }
    if (!Object.keys(c.keyframes).length) c.keyframes = null;
  }
  c.anim = normalizeAnim(c.anim);
  c.radius = r4(Math.min(5000, Math.max(0, Number(c.radius) || 0)));
  if (c.border) {
    const w = Math.min(500, Math.max(0, Number(c.border.width) || 0));
    c.border = w > 0 ? { width: r4(w), color: isColor(c.border.color) ? c.border.color : '#ffffff' } : null;
  } else c.border = null;
  if (c.shadow) {
    const s = c.shadow;
    const sh = {
      blur: r4(Math.min(400, Math.max(0, Number(s.blur) || 0))), x: r4(Math.max(-2000, Math.min(2000, Number(s.x) || 0))),
      y: r4(Math.max(-2000, Math.min(2000, Number(s.y) || 0))), opacity: r4(Math.min(1, Math.max(0, Number(s.opacity ?? 0.5)))),
      color: isColor(s.color) ? s.color : '#000000',
    };
    c.shadow = sh.opacity > 0 && (sh.blur > 0 || sh.x || sh.y) ? sh : null;
  } else c.shadow = null;
  if (c.type === 'audio') { c.anim = null; c.radius = 0; c.border = null; c.shadow = null; }
  if (c.audioFx && !AUDIO_FX_IDS.includes(c.audioFx.preset)) c.audioFx = null;
  if (c.audioFx) c.audioFx = { preset: c.audioFx.preset };
  if (c.type !== 'audio' && c.type !== 'video') c.audioFx = null;
  return c;
}

/** Upgrade / repair a loaded project. */
export function normalizeProject(p) {
  p.schema = SCHEMA_VERSION;
  p.settings = { width: 1920, height: 1080, fps: 30, sampleRate: 48000, background: '#000000', masterVolume: 1, normalizeLoudness: false, ...(p.settings || {}) };
  p.settings.autoBroll = { ...AUTO_BROLL_DEFAULTS, ...(p.settings.autoBroll || {}) };
  p.media = p.media || [];
  p.tracks = p.tracks && p.tracks.length ? p.tracks : createProject().tracks;
  p.clips = (p.clips || []).filter((c) => p.tracks.some((t) => t.id === c.trackId)).map((c) => normalizeClip({ ...CLIP_DEFAULTS, ...c }));
  p.subtitles = { enabled: true, style: { preset: SUBTITLE_DEFAULT_PRESET }, cues: [], ...(p.subtitles || {}) };
  p.markers = p.markers || [];
  p.notes = p.notes || '';
  // video tracks first (bottom → top), then audio tracks
  p.tracks = [...p.tracks.filter((t) => t.type === 'video'), ...p.tracks.filter((t) => t.type === 'audio')];
  return p;
}
