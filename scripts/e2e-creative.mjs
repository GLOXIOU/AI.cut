// End-to-end test of tracking / adjustment layers / grade / audio fx / requests / proposals / cutout through the
// REST bridge of a running AI.cut: node scripts/e2e-creative.mjs <port> <projectsDir> <outDir> <faceVideo> [toneVideo] [--cutout]
import fs from 'node:fs';
import path from 'node:path';

const [port, projectsDir, outDir, faceVideo, toneVideo] = process.argv.slice(2);
const doCutout = process.argv.includes('--cutout');
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
async function call(name, args = {}, { expectError = false } = {}) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/api/call/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aicut-client': 'e2e' }, body: JSON.stringify(args) }).then((x) => x.json());
  const ok = !!r.ok !== expectError;
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} (${Date.now() - t0} ms) ${JSON.stringify(r.ok ? r.result ?? r.text : r.error).slice(0, ok ? 300 : 1200)}`);
  if (r.image) for (const img of [].concat(r.image)) fs.copyFileSync(img, path.join(outDir, `${name}_${Date.now()}${path.extname(img)}`));
  return r.result;
}
async function waitJob(res) {
  let r = res;
  while (r && r.status && r.status !== 'done') {
    if (r.status === 'error' || r.status === 'canceled') { failures++; console.log('job failed', r); return null; }
    r = await call('wait_job', { jobId: r.jobId, timeoutSec: 50 });
  }
  return r?.result;
}

await call('create_project', { name: `Creative ${Date.now() % 100000}`, preset: '1080p', folder: projectsDir });
const imp = await call('import_media', { paths: [faceVideo, ...(toneVideo ? [toneVideo] : [])] });
const ids = (imp.imported || imp.media || []).map((m) => m.id);
console.log('media', ids);
await new Promise((r) => setTimeout(r, 4000));
const add = await call('add_clip', { mediaId: ids[0], track: 'V1', start: 0 });
const clipId = add.clips[0].id;

// --- tracking a face, attaching a label, blurring it
const faces = await call('detect_faces', { clipId, time: 3 });
const tr = await waitJob(await call('track_object', { clipId, time: 3, face: true, name: 'Le gars' }));
const trackingId = tr?.trackingId;
await call('list_trackings');
await call('tracking_at', { tracking: trackingId, time: 5 });
await call('attach_to_tracking', { tracking: trackingId, label: 'Lui 👀', params: { angle: 60, distance: 260 } });
await call('track_effect', { tracking: trackingId, mode: 'pixelate', start: 6, end: 9 });
await call('render_frames', { times: [1, 3, 5, 7.5] });

// --- adjustment layer, grade, audio fx
await call('add_adjustment_layer', { start: 0.5, duration: 2, fx: { blur: 10 }, mask: { shape: 'rect', cx: 0.8, cy: 0.2, w: 0.3, h: 0.25, feather: 30 } });
await call('set_color_grade', { ids: [clipId], look: 'teal-orange' });
await call('set_audio_effects', { track: 'A1', preset: 'cathedral', pan: -0.3 });
await call('set_audio_effects', { clipIds: [clipId], effects: [{ type: 'walkie' }] });
await call('set_audio_effects', { clipIds: [clipId], preset: 'nope' }, { expectError: true });
await call('list_audio_effects');
await call('render_frames', { times: [1.5], grid: true });

// --- proposals
await call('start_proposal', { title: 'Zoom dramatique', description: 'Un zoom rapide sur la réaction + flash' });
await call('add_motion', { template: 'flash', start: 4, duration: 0.4 });
await call('end_proposal');
const props = await call('list_proposals');
const gp = await call('get_project');
console.log('proposals in get_project', JSON.stringify(gp.proposals));

// --- requests (pinned by the "user" through the REST bridge = ops)
await call('list_requests');

if (doCutout) {
  const cut = await waitJob(await call('cutout_subject', { clipId, from: 2, to: 5 }));
  if (cut?.clipId) {
    await call('place_behind_subject', { cutoutClipId: cut.clipId, text: 'DERRIÈRE' });
    await call('render_frames', { times: [3, 4] });
  }
}
await call('get_timeline', { format: 'compact' });
console.log(failures ? `${failures} FAILURE(S)` : 'ALL OK', props?.length);
process.exitCode = failures ? 1 : 0;
