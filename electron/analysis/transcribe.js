// Speech-to-text with whisper.cpp (@fugood/whisper.node) running in an isolated utility process.
import { utilityProcess } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelsDir } from '../core/paths.js';
import { getSettings } from '../core/settings.js';
import { download, exists, fileSize, uid } from '../core/util.js';
import { runFfmpeg } from '../media/ffmpeg.js';
import { log } from '../core/log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const WHISPER_MODELS = {
  tiny: { file: 'ggml-tiny.bin', size: 77691713, label: 'Tiny (75 MB, fastest, low accuracy)' },
  base: { file: 'ggml-base.bin', size: 147951465, label: 'Base (142 MB, fast)' },
  small: { file: 'ggml-small.bin', size: 487601967, label: 'Small (466 MB, good)' },
  medium: { file: 'ggml-medium-q5_0.bin', size: 539212467, label: 'Medium q5 (514 MB, very good)' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195, label: 'Large v3 Turbo q5 (547 MB, best — GPU recommended)' },
};

let worker = null;
let workerReady = null;
const pending = new Map();
let gpuOk = null; // null = unknown, true/false after first attempt

function startWorker() {
  if (worker) return workerReady;
  worker = utilityProcess.fork(path.join(here, 'whisper-worker.js'), [], { serviceName: 'AI.cut whisper', stdio: 'pipe' });
  // background work: on CPU-only machines whisper keeps 6 threads busy, the editor must stay responsive
  worker.once('spawn', () => { try { os.setPriority(worker.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignore */ } });
  worker.stdout?.on('data', (d) => log.debug('[whisper]', String(d).trim().slice(0, 300)));
  worker.stderr?.on('data', (d) => log.debug('[whisper]', String(d).trim().slice(0, 300)));
  workerReady = new Promise((resolve) => {
    const onMsg = (msg) => { if (msg.type === 'ready') { resolve(); } };
    worker.on('message', onMsg);
  });
  worker.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') p.onProgress?.(msg.p);
    else if (msg.type === 'result') { pending.delete(msg.id); p.resolve(msg.result); }
    else if (msg.type === 'error') { pending.delete(msg.id); p.reject(new Error(msg.message)); }
  });
  worker.on('exit', (code) => {
    log.warn('whisper worker exited', code);
    for (const [, p] of pending) p.reject(new Error(`Transcription process crashed (code ${code})`));
    pending.clear();
    worker = null;
    workerReady = null;
  });
  return workerReady;
}

export function stopWhisper() {
  try { worker?.kill(); } catch { /* ignore */ }
  worker = null;
}

function resolveModelName() {
  const s = getSettings();
  if (s.whisperModel && s.whisperModel !== 'auto' && WHISPER_MODELS[s.whisperModel]) return s.whisperModel;
  return gpuOk === false ? 'base' : 'large-v3-turbo';
}

export function modelPath(name) { return path.join(modelsDir(), WHISPER_MODELS[name].file); }

export function modelStatus() {
  return Object.entries(WHISPER_MODELS).map(([id, m]) => {
    const p = path.join(modelsDir(), m.file);
    return { id, ...m, installed: exists(p) && fileSize(p) > m.size * 0.9, path: p };
  });
}

export async function ensureModel(name, { onProgress, signal } = {}) {
  const m = WHISPER_MODELS[name];
  if (!m) throw new Error(`Unknown whisper model ${name}`);
  const p = path.join(modelsDir(), m.file);
  if (exists(p) && fileSize(p) > m.size * 0.9) return p;
  log.info('downloading whisper model', name);
  await download(`${HF}/${m.file}`, p, { signal, onProgress: (r, t) => onProgress?.(t ? r / t : 0) });
  return p;
}

/** Extract mono 16 kHz WAV for whisper. */
async function extractWav(file, out, { signal, start, duration } = {}) {
  const args = [];
  if (start) args.push('-ss', String(start));
  if (duration) args.push('-t', String(duration));
  args.push('-i', file, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out);
  await runFfmpeg(args, { signal, quiet: true, priority: 'low' });
  return out;
}

const NON_SPEECH = /^\s*[[(（【*♪♫].*[\])）】*♪♫]\s*$/;
// Sound descriptions Whisper writes instead of speech: *music*, [Applause], (laughs), ♪ … ♪ (may span several words)
const OPENERS = { '*': '*', '[': ']', '(': ')', '（': '）', '【': '】', '♪': '♪', '♫': '♫' };
const HALLUCINATIONS = [
  /amara\.org/i, /sous-titr(es|age)\s+(réalisés?|par|fait|st)/i, /sous-titres?\s+par/i, /subtitles\s+by/i,
  /^\s*(merci d'avoir regardé|thanks? for watching)[.!\s]*$/i, /transcription\s+par/i,
];
// Short phrases Whisper invents on music / noise when nobody speaks.
const FILLER_HALLUCINATION = /^\s*((thank you|thanks|merci( beaucoup)?|you|bye|okay|gracias|danke|obrigad[oa])[.!,\s]*)+$/i;

/** Merge whisper token segments (maxLen=1) into words with timings. */
export function tokensToWords(segments) {
  const words = [];
  for (const s of segments) {
    const raw = s.text || '';
    if (!raw.trim()) continue;
    const t0 = s.t0 / 1000, t1 = s.t1 / 1000;
    const startsWord = /^\s/.test(raw) || words.length === 0;
    const text = raw.trim();
    const isPunct = /^[.,!?;:…»"')\]}%-]+$/.test(text) || /^['’]/.test(text);
    const prev = words[words.length - 1];
    if (prev && (!startsWord || isPunct || /['’-]$/.test(prev.text))) {
      prev.text += text;
      prev.end = Math.max(prev.end, t1);
    } else {
      words.push({ text, start: t0, end: Math.max(t0, t1) });
    }
  }
  // drop sound annotations spanning one or several words (*Sounds of a game*, [Music], ♪ la la ♪)
  const kept = [];
  let closer = null;
  for (const w of words) {
    const tx = w.text.trim();
    if (closer) { if (tx.endsWith(closer) || tx.includes(closer)) closer = null; continue; }
    const c = OPENERS[tx[0]];
    if (c) {
      const rest = tx.slice(1);
      if (!rest.includes(c)) closer = c; // annotation continues on the next words
      continue;
    }
    kept.push(w);
  }
  return kept
    .filter((w) => !NON_SPEECH.test(w.text) && w.text.replace(/[^\p{L}\p{N}]/gu, '').length > 0)
    .map((w) => ({ text: w.text, start: Math.round(w.start * 1000) / 1000, end: Math.round(Math.max(w.end, w.start + 0.04) * 1000) / 1000 }));
}

/**
 * Whisper's token timestamps sometimes stack several words on the same instant ("Euh, alors, c'est" all at 10.88 s
 * with 40 ms each), typically after a pause. When that happens, the words of the segment are re-timed from the audio:
 * speech chunks are found in the waveform envelope (peaks, `rate` values / s) and matched with the punctuation groups
 * of the segment; words are spread inside their chunk proportionally to their length. Segments with sane timings are
 * left untouched.
 */
export function refineStackedWords(segments, peaks, rate = 100) {
  if (!peaks?.length) return segments;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const weight = (w) => Math.max(1, String(w.text).replace(/[^\p{L}\p{N}]/gu, '').length);
  const place = (list, t0, t1) => {
    const tot = list.reduce((n, w) => n + weight(w), 0);
    let t = t0;
    for (const w of list) { const d = ((t1 - t0) * weight(w)) / tot; w.start = r3(t); w.end = r3(t + d); t += d; }
  };
  segments.forEach((s, si) => {
    const ws = s.words;
    if (!ws || ws.length < 2) return;
    let stacked = 0;
    for (let i = 1; i < ws.length; i++) if (ws[i].start - ws[i - 1].start < 0.025) stacked++;
    if (!stacked) return;
    const next = segments[si + 1];
    const a = Math.max(0, Math.floor(s.start * rate)), b = Math.min(peaks.length, Math.ceil(Math.min(s.end + 0.15, next ? next.start : Infinity) * rate));
    if (b - a < 10) return;
    let max = 0;
    for (let i = a; i < b; i++) max = Math.max(max, peaks[i]);
    if (!max) return;
    const thr = max * 0.12;
    const chunks = [];
    let cs = -1, last = -1;
    for (let i = a; i < b; i++) {
      if (peaks[i] <= thr) continue;
      if (cs < 0) cs = i;
      else if (i - last > 0.12 * rate) { chunks.push([cs, last + 1]); cs = i; }
      last = i;
    }
    if (cs >= 0) chunks.push([cs, last + 1]);
    if (!chunks.length) return;
    const groups = [];
    let g = [];
    for (const w of ws) { g.push(w); if (/[,.;:!?…]$/.test(w.text)) { groups.push(g); g = []; } }
    if (g.length) groups.push(g);
    if (groups.length === chunks.length) {
      groups.forEach((gr, i) => place(gr, chunks[i][0] / rate, chunks[i][1] / rate));
    } else {
      // spread every word over the loud parts only (the pauses between chunks are skipped)
      const total = chunks.reduce((n, [x, y]) => n + (y - x), 0);
      const tw = ws.reduce((n, w) => n + weight(w), 0);
      const at = (u) => { // u in [0, total] frames of speech → absolute seconds
        for (const [x, y] of chunks) { if (u <= y - x) return (x + u) / rate; u -= y - x; }
        return chunks[chunks.length - 1][1] / rate;
      };
      let acc = 0;
      for (const w of ws) {
        const u0 = (acc / tw) * total;
        acc += weight(w);
        const u1 = (acc / tw) * total;
        w.start = r3(at(u0)); w.end = r3(Math.max(at(u1), w.start + 0.04));
      }
    }
    s.start = ws[0].start;
    s.end = Math.max(s.end, ws[ws.length - 1].end);
  });
  return segments;
}

export const WORD_ALIGN_VERSION = 1;

/**
 * Whisper spreads word timings over the pauses around them (a word "ends" 0.6 s into the silence that follows, or
 * starts in the one before). Cutting the silences then removed those words from the subtitles although their sound
 * was kept. Words are clamped to the speech regions of the silence analysis (the very regions remove_silences keeps):
 *  - a word overlapping a silence loses the silent part (a few ms of margin are kept);
 *  - a word spanning a whole silence keeps its larger spoken side;
 *  - a word placed inside a silence is moved against the nearest speech edge.
 * Mutates and returns the segments.
 */
export function alignWordsToSilences(segments, silences, { margin = 0.03 } = {}) {
  if (!segments?.length || !silences?.length) return segments;
  const sil = silences.filter((z) => z.end - z.start >= 0.2).sort((a, b) => a.start - b.start);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const all = segments.flatMap((sg) => sg.words || []);
  let zi = 0;
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    let s0 = w.start, e0 = w.end;
    while (zi < sil.length && sil[zi].end <= s0) zi++;
    for (let j = Math.max(0, zi - 1); j < sil.length && sil[j].start < e0; j++) {
      const z = sil[j];
      if (z.end <= s0 || z.start >= e0) continue;
      const a = z.start + margin, b = z.end - margin; // silent core
      if (b <= a) continue;
      if (s0 >= a && e0 <= b) {
        // inside the silence: against the closest edge
        const prev = all[i - 1], next = all[i + 1];
        const d = Math.min(0.3, Math.max(0.08, e0 - s0));
        if (s0 - z.start <= z.end - e0) { e0 = a; s0 = Math.max(prev ? prev.end : 0, a - d); }
        else { s0 = b; e0 = Math.min(next ? next.start : Infinity, b + d); }
      } else if (s0 < a && e0 > b) {
        if (a - s0 >= e0 - b) e0 = a; else s0 = b; // spans the silence: keep the larger spoken side
      } else if (s0 >= a && s0 < b) s0 = b; // starts in the silence
      else if (e0 > a && e0 <= b) e0 = a; // ends in the silence
    }
    if (e0 - s0 < 0.04) e0 = s0 + 0.04;
    w.start = r3(s0); w.end = r3(e0);
  }
  for (const sg of segments) if (sg.words?.length) { sg.start = sg.words[0].start; sg.end = sg.words[sg.words.length - 1].end; }
  return segments;
}

/** Vocabulary replacements ("QLC plus" → "QLC+") on transcript words. rules: [{find, replace, caseSensitive?, regex?}] */
export function applyWordReplacements(segments, rules) {
  if (!rules?.length || !segments?.length) return 0;
  let n = 0;
  for (const sg of segments) {
    if (!sg.words?.length) continue;
    const r = replaceInWords(sg.words, rules);
    if (r.count) { sg.words = r.words; sg.text = r.words.map((w) => w.text).join(' '); n += r.count; }
  }
  return n;
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Find / replace over a timed word list, matching across word boundaries ("QLC plus" is two words). Matched words
 * are replaced by the words of the replacement, spread over the time of the original ones. Returns {words, count}.
 */
export function replaceInWords(words, rules) {
  let list = words.map((w) => ({ ...w }));
  let count = 0;
  for (const rule of rules) {
    if (!rule?.find) continue;
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const body = rule.regex ? rule.find : esc(rule.find);
    const re = new RegExp(rule.wholeWord === false || rule.regex ? body : `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, `${flags}u`);
    // text of the words joined by single spaces, with each word's character span
    let text = '';
    const spans = list.map((w) => { const a = text.length; text += (a ? ' ' : '') + w.text; return [a ? a + 1 : 0, text.length]; });
    const matches = [...text.matchAll(re)].filter((m) => m[0].length);
    if (!matches.length) continue;
    const out = [];
    let wi = 0;
    for (const m of matches) {
      const a = m.index, b = m.index + m[0].length;
      const i0 = spans.findIndex(([, e]) => e > a);
      let i1 = i0;
      while (i1 + 1 < spans.length && spans[i1 + 1][0] < b) i1++;
      if (i0 < wi || i0 < 0) continue; // overlaps a previous match
      while (wi < i0) out.push(list[wi++]);
      const first = list[i0], last = list[i1];
      // keep what was glued to the match inside the first / last word (punctuation, elision…)
      const before = first.text.slice(0, Math.max(0, a - spans[i0][0]));
      const after = last.text.slice(Math.max(0, b - spans[i1][0]));
      const repl = m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), rule.replace ?? '');
      const parts = `${before}${repl}${after}`.split(/\s+/).filter(Boolean);
      const t0 = first.start, t1 = last.end;
      const tot = parts.reduce((k, x) => k + Math.max(1, x.length), 0) || 1;
      let t = t0;
      for (const ptxt of parts) {
        const d = ((t1 - t0) * Math.max(1, ptxt.length)) / tot;
        const nw = { ...first, text: ptxt, start: Math.round(t * 1000) / 1000, end: Math.round((t + d) * 1000) / 1000 };
        out.push(nw);
        t += d;
      }
      wi = i1 + 1;
      count++;
    }
    while (wi < list.length) out.push(list[wi++]);
    list = out;
  }
  return { words: list, count };
}

/** Group words into sentence-like segments. */
export function wordsToSegments(words) {
  const segs = [];
  let cur = null;
  for (const w of words) {
    if (cur && (w.start - cur.end > 1.0 || cur.words.length >= 40)) { segs.push(cur); cur = null; }
    if (!cur) cur = { start: w.start, end: w.end, words: [] };
    cur.words.push(w);
    cur.end = w.end;
    if (/[.!?…]$/.test(w.text) && cur.words.length >= 3) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  return segs.map((s) => ({ start: s.start, end: s.end, text: s.words.map((w) => w.text).join(' '), words: s.words }));
}

function dropHallucinations(segments, silences = [], duration = 0) {
  const kept = segments.filter((s) => {
    if (HALLUCINATIONS.some((re) => re.test(s.text))) return false;
    // inside a long silence → hallucination
    const inSilence = silences.some((z) => s.start >= z.start - 0.2 && s.end <= z.end + 0.2 && z.end - z.start > 1.5);
    return !inSilence;
  });
  // music / ambience with almost no speech: Whisper fills it with "Thank you." / "Merci." — real speech is denser
  const total = kept.reduce((n, s) => n + s.words.length, 0);
  const dur = Math.max(duration || 0, kept.length ? kept[kept.length - 1].end : 0);
  if (dur > 15 && total / dur < 0.2) return kept.filter((s) => !FILLER_HALLUCINATION.test(s.text));
  return kept;
}

/**
 * Transcribe a media file. Returns { language, model, backend, segments:[{start,end,text,words}], words: count, ms }
 */
export async function transcribeMedia(mediaPath, workDir, { language, onProgress, signal, silences, prompt, duration } = {}) {
  const s = getSettings();
  let modelName = resolveModelName();
  onProgress?.(0.01, 'model');
  let model = await ensureModel(modelName, { signal, onProgress: (p) => onProgress?.(0.02 + 0.2 * p, `downloading model ${modelName}`) });
  onProgress?.(0.23, 'audio');
  fs.mkdirSync(workDir, { recursive: true });
  const wav = path.join(workDir, `whisper_${uid('a', 6)}.wav`);
  await extractWav(mediaPath, wav, { signal });
  try {
    await startWorker();
    const variants = s.whisperBackend === 'cpu' ? ['default'] : gpuOk === false ? ['default'] : ['vulkan', 'default'];
    let res = null, used = null, lastErr = null;
    for (const variant of variants) {
      try {
        const id = uid('w', 8);
        const lang = (language || s.whisperLanguage || 'auto').toLowerCase();
        res = await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject, onProgress: (p) => onProgress?.(0.25 + 0.73 * p, 'transcribing') });
          worker.postMessage({ type: 'transcribe', id, model, variant, file: wav, language: lang, threads: 6, prompt });
          signal?.addEventListener('abort', () => { pending.delete(id); stopWhisper(); reject(new Error('Aborted')); }, { once: true });
        });
        used = variant;
        if (variant === 'vulkan') gpuOk = true;
        break;
      } catch (e) {
        lastErr = e;
        if (signal?.aborted) throw e;
        log.warn(`whisper ${variant} failed`, e.message);
        if (variant === 'vulkan') {
          gpuOk = false;
          if (s.whisperModel === 'auto' && modelName === 'large-v3-turbo') {
            modelName = 'base';
            model = await ensureModel(modelName, { signal });
          }
        }
        await startWorker();
      }
    }
    if (!res) throw lastErr || new Error('Transcription failed');
    const words = tokensToWords(res.segments || []);
    const segments = dropHallucinations(wordsToSegments(words), silences, duration);
    return {
      language: res.language || language || null,
      model: modelName,
      backend: used === 'vulkan' ? 'gpu-vulkan' : 'cpu',
      segments,
      wordCount: segments.reduce((n, x) => n + x.words.length, 0),
      ms: res.ms,
    };
  } finally {
    fs.rm(wav, { force: true }, () => {});
  }
}

export function whisperInfo() {
  return { gpu: gpuOk, model: resolveModelName(), models: modelStatus() };
}
