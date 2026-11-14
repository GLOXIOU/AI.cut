// End-to-end test of: voice / music separation, object cutout (SAM), tracking fix, smooth slow motion, style reference.
// node scripts/e2e-more.mjs <port> <projectsDir> <outDir> <faceVideo> <mix.wav> [styleUrl]
import fs from 'node:fs';
import path from 'node:path';

const [port, projectsDir, outDir, video, mix, styleUrl] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
let fails = 0;
const call = async (name, args = {}, quiet = false) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/call/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aicut-client': 'e2e' }, body: JSON.stringify(args) }).then((x) => x.json());
  if (!quiet || !r.ok) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(r.ok ? r.result ?? r.text : r.error).slice(0, 300)}`);
  if (!r.ok) fails++;
  if (r.image) fs.copyFileSync(r.image, path.join(outDir, `${name}_${Date.now()}.jpg`));
  return r.result;
};
const waitJob = async (res) => {
  let r = res;
  while (r?.status && r.status !== 'done') {
    if (r.status === 'error' || r.status === 'canceled') { fails++; console.log('JOB FAILED', JSON.stringify(r).slice(0, 400)); return null; }
    r = await call('wait_job', { jobId: r.jobId, timeoutSec: 50 }, true);
  }
  return r?.result;
};

await call('create_project', { name: `More ${Date.now() % 100000}`, preset: '1080p', folder: projectsDir });
const imp = await call('import_media', { paths: [video, mix] });
await new Promise((r) => setTimeout(r, 4000));
const [vId, aId] = imp.imported.map((m) => m.id);
const clip = (await call('add_clip', { mediaId: vId, track: 'V1', start: 0 })).clips[0].id;
const aclip = (await call('add_clip', { mediaId: aId, track: 'A1', start: 0 })).clips[0].id;

// 1. voice / music separation
const st = await waitJob(await call('separate_stems', { clipId: aclip }));
console.log('stems', JSON.stringify(st));
// 2. object cutout from a box (the woman on the right at 3.5 s)
const co = await waitJob(await call('cutout_subject', { clipId: clip, box: { x: 0.68, y: 0.5, w: 0.3, h: 0.5 }, time: 3.5, from: 3, to: 5 }));
console.log('object cutout', JSON.stringify(co));
if (co?.clipId) {
  await call('place_behind_subject', { cutoutClipId: co.clipId, text: 'ELLE' });
  await call('render_frames', { times: [3.5, 4.5] });
}
// 3. tracking fix
const tr = await waitJob(await call('track_object', { clipId: clip, time: 2, box: { x: 0.3, y: 0.3, w: 0.2, h: 0.35 }, name: 'Test fix' }));
const fx = await waitJob(await call('track_object', { clipId: clip, time: 6, box: { x: 0.5, y: 0.3, w: 0.2, h: 0.35 }, fix: tr.trackingId }));
console.log('fix', JSON.stringify(fx));
// 4. smooth slow motion
const sm = await waitJob(await call('derive_clip', { clipId: clip, kind: 'slowmo', factor: 0.5 }));
console.log('slowmo', JSON.stringify(sm));
const p = await call('get_project', { includeClips: true }, true);
console.log('slowmo clip duration', p.clips.find((c) => c.id === clip)?.duration);
// 5. style reference
if (styleUrl) {
  const sr = await waitJob(await call('analyze_style_reference', { url: styleUrl, seconds: 60 }));
  console.log('style', JSON.stringify(sr).slice(0, 600));
  const g = await call('get_style_reference', { frames: true });
  console.log('recipe', (g?.recipe || '').slice(0, 500));
}
console.log(fails ? `${fails} FAILURE(S)` : 'ALL OK');
