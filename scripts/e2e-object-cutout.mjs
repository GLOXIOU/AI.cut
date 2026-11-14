// Visual check of the object cutout: box → tracking → MobileSAM → text behind. node scripts/e2e-object-cutout.mjs <port> <projectsDir> <outDir> <video> <t> <x> <y> <w> <h> [text]
import fs from 'node:fs';
import path from 'node:path';

const [port, projectsDir, outDir, video, t, x, y, w, h, text = 'DERRIÈRE'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const call = async (name, args = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/call/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) }).then((q) => q.json());
  if (!r.ok) { console.log('FAIL', name, r.error); process.exit(1); }
  if (r.image) fs.copyFileSync(r.image, path.join(outDir, `${name}_${Date.now()}.jpg`));
  return r.result;
};
const waitJob = async (r) => { while (r?.status && r.status !== 'done') { if (r.status === 'error') { console.log('JOB FAILED', r); process.exit(1); } r = await call('wait_job', { jobId: r.jobId, timeoutSec: 50 }); } return r.result; };
await call('create_project', { name: `ObjCut ${Date.now() % 100000}`, folder: projectsDir });
const imp = await call('import_media', { paths: [video] });
await new Promise((s) => setTimeout(s, 3000));
const clipId = (await call('add_clip', { mediaId: imp.imported[0].id, track: 'V1', start: 0 })).clips[0].id;
const T = Number(t);
const t0 = Date.now();
const co = await waitJob(await call('cutout_subject', { clipId, box: { x: +x, y: +y, w: +w, h: +h }, time: T, from: Math.max(0, T - 1), to: T + 1 }));
console.log('cutout', JSON.stringify(co), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
await call('place_behind_subject', { cutoutClipId: co.clipId, text, params: { size: 300 } });
await call('render_frames', { times: [T - 0.5, T, T + 0.5], width: 960 });
console.log('done');
