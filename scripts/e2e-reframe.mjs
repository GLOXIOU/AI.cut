// Auto reframe (vertical project) + reverse / stabilize through the REST bridge.
// node scripts/e2e-reframe.mjs <port> <projectsDir> <outDir> <faceVideo>
import fs from 'node:fs';
import path from 'node:path';

const [port, projectsDir, outDir, video] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
let fails = 0;
const call = async (name, args = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/call/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aicut-client': 'e2e' }, body: JSON.stringify(args) }).then((x) => x.json());
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(r.ok ? r.result ?? r.text : r.error).slice(0, 260)}`);
  if (!r.ok) fails++;
  if (r.image) fs.copyFileSync(r.image, path.join(outDir, `${name}_${Date.now()}.jpg`));
  return r.result;
};
const waitJob = async (res) => { let r = res; while (r?.status && r.status !== 'done' && r.status !== 'error') r = await call('wait_job', { jobId: r.jobId, timeoutSec: 50 }); return r?.result; };

await call('create_project', { name: `Reframe ${Date.now() % 100000}`, preset: 'vertical', folder: projectsDir });
const imp = await call('import_media', { paths: [video] });
await new Promise((r) => setTimeout(r, 4000));
const add = await call('add_clip', { mediaId: imp.imported[0].id, track: 'V1', start: 0 });
const clipId = add.clips[0].id;
await call('auto_reframe', { clipId, time: 3 });
await call('render_frames', { times: [1, 3, 5, 7] });
const p = await call('get_project', { includeClips: true });
const c = p.clips.find((x) => x.id === clipId);
console.log('fit', c.fit, 'x keys', c.keyframes?.x?.length, JSON.stringify(c.keyframes?.x?.slice(0, 4)));
const dup = await call('duplicate_clips', { ids: [clipId] });
const rev = await waitJob(await call('derive_clip', { clipId, kind: 'reverse' }));
console.log('reverse', JSON.stringify(rev));
const stab = await waitJob(await call('derive_clip', { clipId: dup.clips[0].id, kind: 'stabilize' }));
console.log('stabilize', JSON.stringify(stab));
await call('render_frames', { times: [0.5, 8.5] });
console.log(fails ? `${fails} FAILURE(S)` : 'ALL OK');
