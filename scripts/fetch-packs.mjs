// Downloads and prepares the bundled content packs from the curated catalogs in scripts/packs/*.json:
//   resources/packs/sfx/*.mp3        real sound effects (Freesound, CC0) — silence trimmed, loudness matched
//   resources/packs/music/*.mp3      background music (FreePD, CC0 / public domain)
//   resources/packs/stickers/*.json  animated emoji (Google Noto, Lottie, CC BY 4.0)
//   resources/packs/stickers/*.png   3D emoji (Microsoft Fluent, MIT)
//   resources/packs/manifest.json    runtime manifest read by the app (electron/library/packs.js)
// Files already present are kept (use --force to rebuild). Usage: node scripts/fetch-packs.mjs [--force] [sfx|music|stickers]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAT = path.join(root, 'scripts', 'packs');
const OUT = path.join(root, 'resources', 'packs');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = args.filter((a) => !a.startsWith('--'));
const want = (k) => !ONLY.length || ONLY.includes(k);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

function ffmpegBin() {
  const local = process.env.FFMPEG_PATH;
  if (local && fs.existsSync(local)) return local;
  return 'ffmpeg';
}
const FF = ffmpegBin();
if (spawnSync(FF, ['-version']).status !== 0) { console.error('ffmpeg not found (install it or set FFMPEG_PATH)'); process.exit(1); }

function ff(argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(FF, ['-hide_banner', '-nostdin', '-y', ...argv], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-6000); });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(err) : reject(new Error(err.split('\n').slice(-4).join(' ')))));
  });
}

async function fetchTo(url, file, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'AI.cut pack fetcher' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      return;
    } catch (e) {
      if (i === tries - 1) throw new Error(`${e.message} — ${url}`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function pool(items, n, fn) {
  let i = 0, done = 0;
  const errors = [];
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch (e) { errors.push(`${it.id}: ${e.message}`); }
      done++;
      if (done % 20 === 0 || done === items.length) process.stdout.write(`  ${done}/${items.length}\n`);
    }
  }));
  return errors;
}

const durationOf = (file) => {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(r.stderr || '');
  return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) / 1000 : null;
};

/** Trim silences, short fades, loudness to ~-16 LUFS (peaks ≤ -1 dBFS), 48 kHz stereo MP3. */
async function processSfx(src, dst, maxDur = 0) {
  const trim = 'silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.01,areverse,silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.03,areverse';
  const tmp = `${dst}.tmp.wav`;
  await ff(['-i', src, '-af', `${trim},afade=t=in:d=0.004${maxDur ? `,atrim=0:${maxDur},afade=t=out:st=${Math.max(0, maxDur - 0.6)}:d=0.6` : ''}`, '-ar', '48000', '-ac', '2', tmp]);
  const st = await ff(['-i', tmp, '-af', 'astats=measure_perchannel=none,ebur128=framelog=quiet', '-f', 'null', '-']);
  const peak = Number((/Peak level dB:\s*(-?[\d.]+)/.exec(st) || [])[1] ?? -1);
  const lufs = Number((/I:\s*(-?[\d.]+) LUFS/.exec(st.split('Summary:').pop()) || [])[1] ?? -16);
  const gain = Math.max(-20, Math.min(24, Math.min(-16 - (Number.isFinite(lufs) && lufs > -70 ? lufs : -16), -1 - peak)));
  const d = durationOf(tmp) || 1;
  const fo = Math.min(0.03, d / 4);
  await ff(['-i', tmp, '-af', `volume=${gain.toFixed(2)}dB,afade=t=out:st=${Math.max(0, d - fo).toFixed(3)}:d=${fo.toFixed(3)}`, '-c:a', 'libmp3lame', '-b:a', '192k', dst]);
  fs.rmSync(tmp, { force: true });
}

const manifest = readJson(path.join(OUT, 'manifest.json'), { version: 1 });
const tmpDir = path.join(OUT, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });

// ------------------------------------------------------------------ sound effects
if (want('sfx')) {
  const cat = readJson(path.join(CAT, 'sfx.json'), { sounds: [] });
  const dir = path.join(OUT, 'sfx');
  fs.mkdirSync(dir, { recursive: true });
  console.log(`sfx: ${cat.sounds.length}`);
  const errors = await pool(cat.sounds, 6, async (s) => {
    const dst = path.join(dir, `${s.id}.mp3`);
    if (fs.existsSync(dst) && !FORCE) return;
    const src = path.join(tmpDir, `sfx_${s.id}${path.extname(new URL(s.url).pathname) || '.mp3'}`);
    await fetchTo(s.url, src);
    await processSfx(src, dst, s.maxDur || 0);
  });
  manifest.sfx = cat.sounds.filter((s) => fs.existsSync(path.join(dir, `${s.id}.mp3`))).map((s) => ({
    id: s.id, fr: s.fr, en: s.en, cat: s.cat, tags: s.tags, ...(s.replaces ? { replaces: s.replaces } : {}), file: `sfx/${s.id}.mp3`,
    duration: durationOf(path.join(dir, `${s.id}.mp3`)), title: s.title, author: s.author, license: s.license, licenseUrl: s.licenseUrl, landing: s.landing,
  }));
  if (errors.length) console.warn('sfx errors:\n ' + errors.join('\n '));
}

// ------------------------------------------------------------------ music
if (want('music')) {
  const cat = readJson(path.join(CAT, 'music.json'), { tracks: [] });
  const dir = path.join(OUT, 'music');
  fs.mkdirSync(dir, { recursive: true });
  console.log(`music: ${cat.tracks.length}`);
  const errors = await pool(cat.tracks, 4, async (t) => {
    const dst = path.join(dir, `${t.id}.mp3`);
    if (fs.existsSync(dst) && !FORCE) return;
    const src = path.join(tmpDir, `music_${t.id}.mp3`);
    await fetchTo(t.url, src);
    // ~190 kb/s VBR: transparent for background music, 40 % lighter than the 320 kb/s originals
    await ff(['-i', src, '-map', '0:a', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-q:a', '2', '-ar', '44100', dst]);
    fs.rmSync(src, { force: true });
  });
  manifest.music = cat.tracks.filter((t) => fs.existsSync(path.join(dir, `${t.id}.mp3`))).map((t) => ({
    id: t.id, title: t.title, cat: t.cat, tags: t.tags, file: `music/${t.id}.mp3`, duration: durationOf(path.join(dir, `${t.id}.mp3`)) || t.duration,
    author: t.author, license: t.license, licenseUrl: t.licenseUrl, landing: t.landing,
  }));
  if (errors.length) console.warn('music errors:\n ' + errors.join('\n '));
}

// ------------------------------------------------------------------ stickers
if (want('stickers')) {
  const cat = readJson(path.join(CAT, 'stickers.json'), { stickers: [] });
  const dir = path.join(OUT, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  console.log(`stickers: ${cat.stickers.length}`);
  const errors = await pool(cat.stickers, 8, async (s) => {
    if (s.lottie) {
      const dst = path.join(dir, `${s.id}.json`);
      if (!fs.existsSync(dst) || FORCE) {
        await fetchTo(s.lottie, dst);
        JSON.parse(fs.readFileSync(dst, 'utf8')); // valid JSON or throw
      }
    }
    if (s.png) {
      const dst = path.join(dir, `${s.id}.png`);
      if (!fs.existsSync(dst) || FORCE) await fetchTo(s.png, dst);
    }
  });
  manifest.stickerLicenses = cat.licenses;
  manifest.stickers = cat.stickers.map((s) => ({
    id: s.id, glyph: s.glyph, fr: s.fr, en: s.en, cat: s.cat, catFr: s.catFr, tags: s.tags,
    ...(s.lottie && fs.existsSync(path.join(dir, `${s.id}.json`)) ? { lottie: `stickers/${s.id}.json` } : {}),
    ...(s.png && fs.existsSync(path.join(dir, `${s.id}.png`)) ? { png: `stickers/${s.id}.png` } : {}),
  })).filter((s) => s.lottie || s.png);
  if (errors.length) console.warn('sticker errors:\n ' + errors.join('\n '));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
manifest.generatedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
const size = (d) => { let s = 0; for (const f of fs.readdirSync(d, { withFileTypes: true })) s += f.isDirectory() ? size(path.join(d, f.name)) : fs.statSync(path.join(d, f.name)).size; return s; };
console.log(`packs ready in ${OUT} (${(size(OUT) / 1e6).toFixed(0)} MB): ${manifest.sfx?.length || 0} sfx, ${manifest.music?.length || 0} music, ${manifest.stickers?.length || 0} stickers`);
