// Style references: "edit like this video". A YouTube (or any yt-dlp) link — or an imported media — is downloaded
// (a section, 720p), analysed like any media (transcript, shots, silences, loudness) plus visual statistics (light,
// saturation, warmth, motion), and summarised into a style profile with contact sheets (one frame per shot) that the AI
// LOOKS at. The AI then reproduces the editing style — pacing, zooms, captions, grade, sound design — with its own
// texts and its own motion designs (add_html_clip), never by reusing the reference's footage.
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../project/store.js';
import { jobs } from '../core/jobs.js';
import { log } from '../core/log.js';
import { uid } from '../core/util.js';
import { runFfmpeg } from '../media/ffmpeg.js';
import { importPaths, waitForProbe } from '../media/service.js';
import { downloadMedia } from '../youtube/ytdlp.js';
import { analyzeMedia, loadAnalysis, analysisDirFor } from '../analysis/index.js';
import { extractFrames, contactSheet } from '../analysis/video-analysis.js';
import { mediaById, r4, fmtTime } from '../../shared/timeline.js';

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** Per-second visual statistics (signalstats) + motion energy (frame difference). */
async function visualStats(file, duration, workDir, signal) {
  const statsFile = path.join(workDir, `stats_${Date.now()}.txt`), motionFile = path.join(workDir, `motion_${Date.now()}.txt`);
  const esc = (f) => f.replace(/\\/g, '/').replace(/:/g, '\\:');
  await runFfmpeg(['-i', file, '-an', '-vf', `fps=2,scale=320:-2,signalstats,metadata=print:file='${esc(statsFile)}'`, '-f', 'null', '-'], { signal, duration, quiet: true, priority: 'low' });
  await runFfmpeg(['-i', file, '-an', '-vf', `fps=10,scale=160:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:file='${esc(motionFile)}'`, '-f', 'null', '-'], { signal, duration, quiet: true, priority: 'low' });
  const parse = (f, keys) => {
    const out = [];
    let cur = null;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (line.startsWith('frame:')) { if (cur) out.push(cur); cur = { t: Number((/pts_time:([\d.]+)/.exec(line) || [])[1] || 0) }; continue; }
      const m = /lavfi\.signalstats\.(\w+)=([-\d.]+)/.exec(line);
      if (m && cur && keys.includes(m[1])) cur[m[1]] = Number(m[2]);
    }
    if (cur) out.push(cur);
    fs.rm(f, { force: true }, () => {});
    return out;
  };
  const st = parse(statsFile, ['YAVG', 'YLOW', 'YHIGH', 'SATAVG', 'UAVG', 'VAVG', 'HUEMED']);
  const mo = parse(motionFile, ['YAVG']);
  const avg = (k) => st.reduce((s, x) => s + (x[k] ?? 0), 0) / Math.max(1, st.length);
  const motion = mo.map((x) => x.YAVG || 0);
  return {
    brightness: r4(avg('YAVG') / 255), contrast: r4((avg('YHIGH') - avg('YLOW')) / 255), saturation: r4(avg('SATAVG') / 128),
    warmth: r4((avg('VAVG') - avg('UAVG')) / 128), // > 0 warm / orange, < 0 cool / blue
    motion: { mean: r4(motion.reduce((s, x) => s + x, 0) / Math.max(1, motion.length)), p90: r4(pct(motion, 0.9)), staticShare: r4(motion.filter((x) => x < 1.5).length / Math.max(1, motion.length)) },
  };
}

/** Suggested grade (shared/grade.js values) that moves neutral footage toward the reference's look. */
function suggestedGrade(v) {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  return {
    saturation: r4(clamp(v.saturation / 0.32, 0.6, 1.6)),
    contrast: r4(clamp(1 + (v.contrast - 0.78) * 0.8, 0.85, 1.3)),
    temperature: r4(clamp(v.warmth * 6, -0.6, 0.6)),
    exposure: r4(clamp((v.brightness - 0.45) * 2, -0.8, 0.8)),
    ...(v.contrast < 0.65 ? { fade: r4(clamp((0.65 - v.contrast) * 1.5, 0, 0.5)) } : {}),
  };
}

function describePacing(cpm) {
  if (cpm >= 40) return 'very fast (a cut every 1–1.5 s: shorts / hype edit)';
  if (cpm >= 22) return 'fast (a cut every 2–3 s: dynamic YouTube / vlog)';
  if (cpm >= 10) return 'medium (a cut every 4–6 s)';
  return 'slow (long shots, documentary / interview pace)';
}

/**
 * Analyse a style reference. a: { url? | mediaId?, start? (s), seconds? (default 240), name? }
 * Returns a job; result = { id, name, profile, sheets }.
 */
export function analyzeStyleJob(a, meta = {}) {
  store.requireOpen();
  if (!a.url && !a.mediaId) throw new Error('Give a url (YouTube, TikTok, Instagram… anything yt-dlp reads) or a mediaId.');
  return jobs.create('analysis', `Style : ${a.name || a.url || a.mediaId}`, async ({ progress, signal }) => {
    let mediaId = a.mediaId, title = a.name || null, url = a.url || null;
    if (url) {
      progress(0.02, 'download');
      const start = Math.max(0, Number(a.start) || 0), seconds = Math.min(900, Math.max(20, Number(a.seconds) || 240));
      const { file, info } = await downloadMedia(url, { mode: 'video', maxHeight: 720, start, end: start + seconds, dir: path.join(store.dir, 'media', 'references'), signal, onProgress: (r) => progress(0.02 + 0.28 * r, 'download') });
      title = title || info?.title || 'Référence';
      [mediaId] = importPaths([file], { ...meta, sourceInfo: { kind: 'reference', url: info?.webpage_url || url, title: info?.title || null, author: info?.channel || info?.uploader || null, license: 'reference only — do not reuse the footage' }, name: `🎬 Réf. style — ${title}` }).map((m) => m.id);
    }
    const m = await waitForProbe(mediaId);
    if (!m || m.type !== 'video') throw new Error('The reference must be a video.');
    title = title || m.name;
    progress(0.32, 'analysis (transcript, shots, sound)');
    const aj = analyzeMedia(mediaId, { scenes: true, transcribe: true, beats: true });
    signal.addEventListener('abort', () => jobs.cancel(aj.id), { once: true });
    await aj.promise.catch((e) => log.warn('style analysis partial', e.message));
    progress(0.72, 'look & motion');
    const an = loadAnalysis(mediaId);
    const work = analysisDirFor(mediaId);
    fs.mkdirSync(work, { recursive: true });
    const visual = await visualStats(m.path, m.duration, work, signal);
    // pacing
    const cuts = (an.shots || []).map((s) => (typeof s === 'number' ? s : s.start ?? s.time ?? s.t)).filter((x) => Number.isFinite(x) && x > 0.05).sort((x, y) => x - y);
    const bounds = [0, ...cuts, m.duration];
    const shots = [];
    for (let i = 0; i < bounds.length - 1; i++) if (bounds[i + 1] - bounds[i] > 0.04) shots.push({ start: bounds[i], end: bounds[i + 1] });
    const lens = shots.map((s) => s.end - s.start);
    const cpm = (shots.length - 1) / (m.duration / 60);
    // speech
    const words = (an.transcript?.segments || []).flatMap((s) => s.words || []);
    const speechSec = (an.transcript?.segments || []).reduce((s, x) => s + Math.max(0, x.end - x.start), 0);
    const profile = {
      source: { title, url, duration: r4(m.duration), size: `${m.width}x${m.height}`, aspect: m.width > m.height * 1.2 ? 'horizontal 16:9' : m.height > m.width * 1.2 ? 'vertical 9:16' : 'square-ish', fps: m.fps },
      pacing: {
        shots: shots.length, cutsPerMinute: r4(cpm), averageShot: r4(lens.reduce((s, x) => s + x, 0) / Math.max(1, lens.length)), medianShot: r4(median(lens)),
        shortest10: r4(pct(lens, 0.1)), longest10: r4(pct(lens, 0.9)), feel: describePacing(cpm),
        firstCuts: cuts.slice(0, 40).map(r4),
      },
      speech: words.length ? {
        language: an.transcript?.language || null, wordsPerMinute: r4(words.length / Math.max(1, speechSec / 60)), speakingShare: r4(speechSec / m.duration),
        longPauses: (an.silences || []).filter((s) => s.end - s.start > 0.6).length, hook: (an.transcript?.segments || []).filter((s) => s.start < 8).map((s) => s.text).join(' ').slice(0, 400),
      } : { note: 'no speech detected (music / visuals only)' },
      sound: { loudnessLufs: an.audio?.integratedLufs ?? null, bpm: an.beats?.bpm || null },
      look: { ...visual, suggestedGrade: suggestedGrade(visual) },
    };
    // contact sheets: one frame per shot (middle), in order, labelled with the shot time and length
    progress(0.85, 'contact sheets');
    const pick = shots.length <= 32 ? shots : shots.filter((_, i) => i % Math.ceil(shots.length / 32) === 0);
    const frames = await extractFrames(m.path, pick.map((s) => r4((s.start + s.end) / 2)), work, { width: 480, signal });
    const sheets = [];
    for (let i = 0; i < frames.length; i += 16) {
      const part = frames.slice(i, i + 16).map((f, j) => { const s = pick[i + j]; return { ...f, label: `${fmtTime(s.start)} · ${r4(s.end - s.start)} s` }; });
      const sheet = await contactSheet(part, path.join(work, `style_sheet_${i / 16 + 1}_${Date.now()}.jpg`), { cols: 4, cellWidth: 320, title: `${title} — shots ${i + 1}–${i + part.length} of ${pick.length} (start · length)` });
      sheets.push(sheet.path);
    }
    const ref = { id: uid('style'), name: title, url, mediaId, createdAt: new Date().toISOString(), profile, sheets };
    store.apply('addStyleRef', { ref }, { ...meta, label: `style reference ${title}` });
    progress(1, 'done');
    return { id: ref.id, name: ref.name, profile, sheets: sheets.length };
  }, { queue: 'download', meta: { kind: 'style' } });
}

export function styleRef(id) {
  const p = store.requireOpen();
  const ref = (p.styleRefs || []).find((x) => x.id === id) || (p.styleRefs || [])[(p.styleRefs || []).length - 1];
  if (!ref) throw new Error('No style reference yet: analyze_style_reference first.');
  return ref;
}

/** How to apply a profile (text for the AI). */
export function styleRecipe(ref) {
  const pr = ref.profile;
  const g = pr.look?.suggestedGrade || {};
  return [
    `Reproduce the EDITING STYLE of "${ref.name}" (never reuse its footage, logos or exact texts — write your own):`,
    `- Pacing: ${pr.pacing.feel}; median shot ${pr.pacing.medianShot} s (10 % shortest ≤ ${pr.pacing.shortest10} s, 10 % longest ≥ ${pr.pacing.longest10} s). Cut the user's footage to a similar rhythm (remove_silences / delete_words, b-roll changes, punch-in zooms between cuts).`,
    pr.speech?.wordsPerMinute ? `- Speech: ${pr.speech.wordsPerMinute} words/min, speaking ${Math.round(pr.speech.speakingShare * 100)} % of the time, ${pr.speech.longPauses} long pauses → ${pr.speech.longPauses < 3 ? 'remove almost every pause' : 'keep some breathing room'}. Hook of the reference: "${pr.speech.hook}" — write an equivalent hook for the user's content.` : '- No speech: music / visual driven edit — cut on the beats (get_beats).',
    `- Motion: ${pr.look.motion.staticShare > 0.5 ? 'mostly static shots → add zooms / Ken Burns to keep energy only if the reference does' : 'lots of movement → dynamic zooms, whip transitions, shake on impacts'}.`,
    `- Look: brightness ${pr.look.brightness}, saturation ${pr.look.saturation}, contrast ${pr.look.contrast}, warmth ${pr.look.warmth}. Suggested set_color_grade color: ${JSON.stringify(g)} (check with render_frames side by side with the reference frames).`,
    `- Sound: ${pr.sound.loudnessLufs != null ? `${pr.sound.loudnessLufs} LUFS` : 'n/a'}${pr.sound.bpm ? `, music ~${Math.round(pr.sound.bpm)} BPM` : ''}.`,
    '- LOOK at the contact sheets (get_style_reference frames=true, view_media_frames on the reference media for any moment): note the subtitle style (font, size, colors, position, words per line, highlights), the text overlays / titles / lower thirds, the transitions, the framing (close-ups, PIP, split screens), the stickers / memes / emojis density, and reproduce that language with YOUR OWN motion designs (add_html_clip with custom HTML/CSS/JS in the same colors, fonts and animation style), set_subtitle_style, set_animation, auto_sfx…',
    '- Keep the reference media OUT of the timeline (it is only a model).',
  ].join('\n');
}
