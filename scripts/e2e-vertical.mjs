// Vertical short scenario through the REST bridge: node scripts/e2e-vertical.mjs <mediaDir> <projectsDir> <outDir>
import fs from 'node:fs';
import path from 'node:path';

const [mediaDir, projectsDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const call = async (name, args = {}) => {
  const r = await fetch(`http://127.0.0.1:7777/api/call/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aicut-client': 'vertical-test' }, body: JSON.stringify(args) });
  const d = await r.json();
  console.log(`${d.ok ? 'OK ' : 'FAIL'} ${name}${d.ok ? '' : ' → ' + d.error}`);
  if (!d.ok) throw new Error(d.error);
  return d.result ?? d.text;
};
await call('create_project', { name: 'Short vertical', preset: 'vertical', folder: projectsDir });
const imp = await call('import_media', { paths: [path.join(mediaDir, 'talk.mp4'), path.join(mediaDir, 'clipB.mp4')] });
const [talk, b] = imp.imported.map((m) => m.id);
let an = await call('analyze_media', { mediaIds: [talk], waitSec: 50 });
await call('assemble_sequence', { items: [{ mediaId: talk, in: 0, out: 9, fit: 'cover' }, { mediaId: b, in: 0, out: 2, fit: 'cover', transition: { type: 'zoomin', duration: 0.6 } }, { mediaId: talk, in: 9, out: 16, fit: 'cover', transition: { type: 'circleopen', duration: 0.6 } }] });
await call('add_motion', { template: 'kinetic-words', start: 0, duration: 1.8, params: { text: 'REGARDE ÇA', size: 200 } });
await call('add_motion', { template: 'progress-bar', start: 0, duration: 18, params: { position: 'top', thickness: 14 } });
await call('add_motion', { template: 'social-handle', start: 2, duration: 4, params: { handle: '@aicut', platform: 'tiktok' } });
await call('generate_subtitles', { preset: 'highlight', maxWords: 2 });
const tl = await call('get_timeline');
console.log(String(tl).split('\n').slice(0, 14).join('\n'));
const fr = await call('render_frames', { times: [0.6, 3.2, 9.0, 9.4, 12.5], width: 540 });
fs.copyFileSync(fr.image, path.join(outDir, 'vertical_frames.jpg'));
console.log('frames →', path.join(outDir, 'vertical_frames.jpg'));
