import path from 'node:path';
import fs from 'node:fs';
import { runFfprobe } from './ffmpeg.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.svg']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aif', '.aiff']);
const HTML_EXT = new Set(['.html', '.htm']);
const LOTTIE_EXT = new Set(['.json', '.lottie']);

export function guessKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (HTML_EXT.has(ext)) return 'html';
  if (LOTTIE_EXT.has(ext)) return 'lottie';
  return 'video';
}

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a;
}

/** Probe a media file and return normalized metadata. */
export async function probeMedia(file) {
  const kind = guessKind(file);
  const stat = fs.statSync(file);
  if (kind === 'html' || kind === 'lottie') {
    return { type: kind, duration: 5, size: stat.size, hasVideo: true, hasAudio: false, width: 0, height: 0 };
  }
  if (path.extname(file).toLowerCase() === '.svg') {
    return { type: 'image', duration: 0, size: stat.size, hasVideo: true, hasAudio: false, width: 1024, height: 1024, codec: 'svg', format: 'svg' };
  }
  const json = JSON.parse(await runFfprobe(['-print_format', 'json', '-show_format', '-show_streams', file]));
  const streams = json.streams || [];
  const fmt = json.format || {};
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const formatName = fmt.format_name || '';
  let type = 'video';
  const isStillFormat = /image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|svg_pipe|jpegxl|avif/.test(formatName) || IMAGE_EXT.has(path.extname(file).toLowerCase());
  const nbFrames = v ? Number(v.nb_frames || 0) : 0;
  if (!v && a) type = 'audio';
  else if (v && isStillFormat && (nbFrames <= 1 || !fmt.duration || Number(fmt.duration) < 0.05)) type = 'image';
  else if (v && formatName === 'gif' && nbFrames <= 1) type = 'image';
  else if (!v && !a) throw new Error('No audio or video stream found');

  let width = v ? Number(v.width) : 0;
  let height = v ? Number(v.height) : 0;
  let rotation = 0;
  if (v) {
    const sd = (v.side_data_list || []).find((d) => d.rotation !== undefined);
    rotation = sd ? Number(sd.rotation) : Number(v.tags?.rotate || 0);
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  }
  const duration = type === 'image' ? 0 : Number(fmt.duration || v?.duration || a?.duration || 0);
  const fps = v ? parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) : 0;
  const pixFmt = v?.pix_fmt || '';
  return {
    type,
    duration: Math.round(duration * 1000) / 1000,
    size: stat.size,
    format: formatName,
    hasVideo: !!v && type !== 'audio',
    hasAudio: !!a,
    width, height, rotation,
    fps: Math.round(fps * 1000) / 1000,
    codec: v?.codec_name || null,
    pixFmt,
    hasAlpha: /yuva|rgba|argb|bgra|abgr|gbrap|ya8|pal8/.test(pixFmt) || (v?.codec_name === 'vp9' && v?.tags?.alpha_mode === '1') || (v?.codec_name === 'vp8' && v?.tags?.alpha_mode === '1'),
    audioCodec: a?.codec_name || null,
    sampleRate: a ? Number(a.sample_rate) : 0,
    channels: a ? Number(a.channels) : 0,
    bitrate: Number(fmt.bit_rate || 0),
    title: fmt.tags?.title || null,
  };
}

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8', 'alac']);
const PLAYABLE_CONTAINERS = /mov|mp4|m4a|3gp|matroska|webm|ogg|mp3|wav|flac|aac/;

/** Can Chromium play the original file as is? */
export function canPlayNatively(info, file, { hevcSupported = false } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (info.type === 'image') return !['.tif', '.tiff', '.heic'].includes(ext);
  if (info.type === 'video') {
    if (ext === '.gif') return false;
    if (!PLAYABLE_CONTAINERS.test(info.format) || ['.mkv', '.avi', '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.vob', '.3gp'].includes(ext)) return false;
    const vOk = PLAYABLE_VIDEO.has(info.codec) || (info.codec === 'hevc' && hevcSupported);
    if (!vOk) return false;
    if (info.hasAlpha && info.codec !== 'vp9' && info.codec !== 'vp8') return false;
    if (info.hasAudio && !PLAYABLE_AUDIO.has(info.audioCodec)) return false;
    if (/yuv4(22|44)|10le|12le/.test(info.pixFmt) && info.codec === 'h264') return false;
    return true;
  }
  if (info.type === 'audio') {
    if (['.aif', '.aiff', '.wma'].includes(ext)) return false;
    return PLAYABLE_AUDIO.has(info.audioCodec);
  }
  return true;
}

/** Should a preview proxy be generated? (unplayable media, or heavy media for a smoother preview) */
export function needsProxy(info, file, { hevcSupported = false, mode = 'auto' } = {}) {
  if (mode === 'never') return false;
  if (!canPlayNatively(info, file, { hevcSupported })) return true;
  if (info.type !== 'video') return false;
  if (mode === 'always') return true;
  return mode === 'auto' && Math.max(info.width, info.height) > 2600; // 4K+ → lighter preview
}
