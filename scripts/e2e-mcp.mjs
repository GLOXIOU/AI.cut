// End-to-end test through a real MCP client: node scripts/e2e-mcp.mjs <mediaDir> <projectsDir> <outDir>
// Requires AI.cut running (npm start). Exercises project, import, analysis, editing, motion, audio, subtitles, render, export.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';

const [mediaDir, projectsDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const client = new Client({ name: 'aicut-e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7777/mcp')));
const t0 = Date.now();
let failures = 0;

async function call(name, args = {}, { expectError = false, quiet = false } = {}) {
  const started = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const images = (r.content || []).filter((c) => c.type === 'image');
  const ok = !!r.isError === expectError;
  if (!ok) failures++;
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name} (${Date.now() - started} ms)${images.length ? ` +${images.length} image` : ''}${!quiet || !ok ? '\n   ' + text.slice(0, ok ? 400 : 1500).replace(/\n/g, '\n   ') : ''}`);
  for (const [i, im] of images.entries()) fs.writeFileSync(path.join(outDir, `${name}_${Date.now()}_${i}.${im.mimeType.includes('png') ? 'png' : 'jpg'}`), Buffer.from(im.data, 'base64'));
  let json = null;
  try { json = JSON.parse(text); } catch { /* text result */ }
  return { text, json, images, isError: r.isError };
}

const tools = await client.listTools();
console.log(`tools: ${tools.tools.length}`);
const prompts = await client.listPrompts();
console.log(`prompts: ${prompts.prompts.map((p) => p.name).join(', ')}`);

await call('get_project');
const cp = await call('create_project', { name: `E2E ${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`, preset: '1080p', folder: projectsDir });
const imp = await call('import_media', { paths: ['talk.mp4', 'clipA.mp4', 'clipB.mp4', 'image.png', 'music.mp3'].map((f) => path.join(mediaDir, f)) });
const media = Object.fromEntries(imp.json.imported.map((m) => [m.name, m.id]));
console.log('media ids', media);

// analysis (transcription may download the model the first time)
let an = await call('analyze_media', { mediaIds: [media['talk.mp4']], waitSec: 50 });
for (let i = 0; i < 30 && an.json?.[0]?.status !== 'done'; i++) {
  const jobId = an.json?.[0]?.jobId;
  if (!jobId) break;
  const w = await call('wait_job', { jobId, timeoutSec: 50 }, { quiet: true });
  an = { json: [w.json] };
  if (w.json?.status === 'done') break;
}
await call('get_media_report', { mediaId: media['talk.mp4'] });
await call('get_transcript', { mediaId: media['talk.mp4'], format: 'words', end: 4 });
await call('search_media', { query: 'intelligence artificielle' });
await call('view_media_frames', { mediaId: media['clipA.mp4'], count: 6 });
await call('describe_media', { mediaId: media['clipA.mp4'], summary: 'Test pattern with moving gradient (synthetic).', scenes: [{ start: 0, end: 8, text: 'colour bars test pattern' }], tags: ['test', 'pattern'] });

// edit
const seq = await call('assemble_sequence', { replace: true, items: [
  { mediaId: media['talk.mp4'], in: 0, out: 8 },
  { mediaId: media['clipA.mp4'], in: 1, out: 4, transition: { type: 'fade', duration: 0.6 } },
  { mediaId: media['talk.mp4'], in: 8, out: 18, transition: { type: 'slideleft', duration: 0.5 } },
] });
const clipIds = seq.json.clips.map((c) => c.id);
await call('add_clip', { mediaId: media['image.png'], start: 2, duration: 3, track: 'V2', scale: 0.3, x: 600, y: -300 });
await call('animate_clip', { id: clipIds[0], preset: 'zoom-in', amount: 0.12 });
await call('add_motion', { template: 'lower-third-modern', start: 1, duration: 4, params: { name: 'Hortense', title: 'Voix de synthèse' } });
await call('add_text', { text: 'AI.cut 🚀', start: 8.5, duration: 2.5, position: 'top', animation: 'pop', style: { size: 120, color: '#FACC15' } });
const custom = await call('add_html_clip', { start: 12, duration: 3, html: '<div class="b">CUSTOM</div>', css: '.b{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:900 160px Anton;color:#fff;animation:s 1s ease-out both}@keyframes s{from{transform:translate(-50%,-50%) scale(3);opacity:0}}' });
await call('preview_motion', { id: custom.json.clips[0].id, times: [0, 0.5, 1.5] });
const lib = await call('search_audio', { query: 'whoosh', kind: 'sfx', source: 'builtin' });
await call('add_audio', { id: lib.json.results[0].id, start: 7.7, volume: 0.8 });
await call('search_audio', { query: 'upbeat', kind: 'music', limit: 3 });
const mus = await call('import_media', { paths: [path.join(mediaDir, 'music.mp3')] });
await call('add_clip', { mediaId: media['music.mp3'], start: 0, duration: 20, track: 'A2', volume: 0.4, fadeIn: 1, fadeOut: 2 });
await call('duck_music', { track: 'A2', amountDb: -10 });
await call('generate_subtitles', { preset: 'bold', maxWords: 3 });
await call('get_subtitles', { end: 5 });
await call('set_subtitle_style', { style: { highlightColor: '#22D3EE', size: 84 } });
await call('get_timeline');
await call('render_frames', { times: [0.5, 2.5, 8.3, 9.5, 13] });
await call('remove_silences', { track: 'V1', minSilence: 0.4 });
await call('undo');
await call('checkpoint', { name: 'before export' });
const ex = await call('export_video', { preset: 'project', quality: 'draft' });
let job = ex.json;
for (let i = 0; i < 40 && job?.status !== 'done'; i++) {
  const w = await call('wait_job', { jobId: job.jobId, timeoutSec: 50 }, { quiet: true });
  job = w.json;
  if (w.isError) break;
}
console.log('export result', JSON.stringify(job?.result || job).slice(0, 600));
await call('get_credits');
await call('player', { action: 'seek', time: 9 });
await call('notify', { message: 'Test E2E terminé ✅', level: 'success' });
await call('update_clip', { id: 'nope', x: 1 }, { expectError: true });
console.log(`\n${failures ? `❌ ${failures} failure(s)` : '✅ all calls OK'} in ${Math.round((Date.now() - t0) / 1000)} s`);
await client.close();
process.exit(failures ? 1 : 0);
