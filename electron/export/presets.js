// Export presets. `short` = size of the shorter side (aspect follows the project), `match` = project size.
export const EXPORT_PRESETS = [
  { id: 'project', label: 'Match project', format: 'mp4', video: 'h264', size: 'match' },
  { id: 'youtube-1080p', label: 'YouTube 1080p (H.264)', format: 'mp4', video: 'h264', size: { short: 1080 } },
  { id: 'youtube-4k', label: 'YouTube 4K (H.264)', format: 'mp4', video: 'h264', size: { short: 2160 } },
  { id: 'shorts-1080', label: 'TikTok / Reels / Shorts 1080×1920', format: 'mp4', video: 'h264', size: { w: 1080, h: 1920 } },
  { id: 'square-1080', label: 'Instagram square 1080×1080', format: 'mp4', video: 'h264', size: { w: 1080, h: 1080 } },
  { id: 'web-720p', label: 'Web 720p (light)', format: 'mp4', video: 'h264', size: { short: 720 }, quality: 'good' },
  { id: 'hevc-1080p', label: 'H.265 / HEVC 1080p', format: 'mp4', video: 'hevc', size: { short: 1080 } },
  { id: 'prores-hq', label: 'ProRes 422 HQ master (.mov)', format: 'mov', video: 'prores', size: 'match' },
  { id: 'webm-vp9', label: 'WebM VP9', format: 'webm', video: 'vp9', size: 'match' },
  { id: 'gif', label: 'Animated GIF (480px, 15 fps)', format: 'gif', video: 'gif', size: { w: 480 }, fps: 15 },
  { id: 'audio-mp3', label: 'Audio MP3 320k', format: 'mp3', video: null },
  { id: 'audio-wav', label: 'Audio WAV', format: 'wav', video: null },
  { id: 'audio-m4a', label: 'Audio AAC (m4a)', format: 'm4a', video: null },
];

export function presetById(id) {
  return EXPORT_PRESETS.find((p) => p.id === id) || EXPORT_PRESETS[1];
}

/** Output size for a preset and project. */
export function outputSize(preset, project, override = {}) {
  const W = project.settings.width, H = project.settings.height;
  if (override.width && override.height) return { width: even(override.width), height: even(override.height) };
  const s = preset.size;
  if (!s || s === 'match') return { width: W, height: H };
  if (s.w && s.h) return { width: s.w, height: s.h };
  if (s.w) return { width: even(s.w), height: even((s.w * H) / W) };
  if (s.short) {
    const k = s.short / Math.min(W, H);
    return { width: even(W * k), height: even(H * k) };
  }
  return { width: W, height: H };
}
const even = (x) => Math.max(2, Math.round(x / 2) * 2);

const QUALITY = {
  draft: { x264: ['veryfast', 26], x265: ['fast', 28], nv: ['p4', 28], vp9: [36, 5] },
  good: { x264: ['medium', 21], x265: ['medium', 25], nv: ['p5', 23], vp9: [32, 3] },
  high: { x264: ['slow', 18], x265: ['slow', 22], nv: ['p6', 20], vp9: [28, 2] },
  max: { x264: ['slower', 15], x265: ['slower', 19], nv: ['p7', 17], vp9: [24, 1] },
};

/**
 * ffmpeg video encoder args. codec: h264 | hevc | prores | vp9 | gif-intermediate
 * encoders: result of detectEncoders()
 */
export function videoEncoderArgs(codec, { quality = 'high', hardware = true, encoders = {}, bitrate = null } = {}) {
  const q = QUALITY[quality] || QUALITY.high;
  switch (codec) {
    case 'hevc':
      if (hardware && encoders.hevc_nvenc) {
        return { args: ['-c:v', 'hevc_nvenc', '-preset', q.nv[0], '-rc', 'vbr', '-cq', String(q.nv[1] + 1), '-b:v', bitrate || '0', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'], encoder: 'hevc_nvenc' };
      }
      return { args: ['-c:v', 'libx265', '-preset', q.x265[0], ...(bitrate ? ['-b:v', bitrate] : ['-crf', String(q.x265[1])]), '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'], encoder: 'libx265' };
    case 'prores':
      return { args: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'], encoder: 'prores_ks' };
    case 'vp9':
      return { args: ['-c:v', 'libvpx-vp9', '-b:v', bitrate || '0', '-crf', String(q.vp9[0]), '-deadline', 'good', '-cpu-used', String(q.vp9[1]), '-row-mt', '1', '-pix_fmt', 'yuv420p'], encoder: 'libvpx-vp9' };
    case 'intermediate':
      return { args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p'], encoder: 'libx264' };
    case 'h264':
    default:
      if (hardware && encoders.h264_nvenc) {
        return { args: ['-c:v', 'h264_nvenc', '-preset', q.nv[0], '-rc', 'vbr', '-cq', String(q.nv[1]), '-b:v', bitrate || '0', '-profile:v', 'high', '-pix_fmt', 'yuv420p'], encoder: 'h264_nvenc' };
      }
      return { args: ['-c:v', 'libx264', '-preset', q.x264[0], ...(bitrate ? ['-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate] : ['-crf', String(q.x264[1])]), '-profile:v', 'high', '-pix_fmt', 'yuv420p'], encoder: 'libx264' };
  }
}

export function audioEncoderArgs(format, { audioBitrate = '192k' } = {}) {
  switch (format) {
    case 'mov': return ['-c:a', 'pcm_s16le'];
    case 'webm': return ['-c:a', 'libopus', '-b:a', '160k'];
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', '320k'];
    case 'wav': return ['-c:a', 'pcm_s16le'];
    case 'm4a': return ['-c:a', 'aac', '-b:a', '256k'];
    default: return ['-c:a', 'aac', '-b:a', audioBitrate];
  }
}
