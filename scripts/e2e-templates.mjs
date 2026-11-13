// Renders every motion template offscreen (preview_motion) and reports JS errors.
// node scripts/e2e-templates.mjs <projectsDir> <outDir>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';

const [projectsDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const client = new Client({ name: 'aicut-templates-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7777/mcp')));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { r, text, json };
};
await call('create_project', { name: 'Templates test', preset: '1080p', folder: projectsDir });
await call('add_clip', { fill: '#2a3550', start: 0, duration: 12, track: 'V1' });
const list = (await call('list_motion_templates')).json;
let bad = 0;
for (const t of list) {
  const add = await call('add_motion', { template: t.id, start: 0, duration: t.defaultDuration });
  if (add.r.isError) { console.log(`FAIL add ${t.id}: ${add.text}`); bad++; continue; }
  const id = add.json.clips[0].id;
  const d = t.defaultDuration;
  const pv = await call('preview_motion', { id, times: [d * 0.1, d * 0.45, d * 0.8] });
  const img = pv.r.content.find((c) => c.type === 'image');
  if (img) fs.writeFileSync(path.join(outDir, `${t.id}.jpg`), Buffer.from(img.data, 'base64'));
  const errs = pv.json?.jsErrors || [];
  console.log(`${pv.r.isError || errs.length ? 'FAIL' : 'OK  '} ${t.id}${errs.length ? ' → ' + errs.join(' | ') : ''}${pv.r.isError ? ' → ' + pv.text : ''}`);
  if (pv.r.isError || errs.length) bad++;
  await call('delete_clips', { ids: [id] });
}
// one composed frame with several overlays on top of video-ish background
console.log(bad ? `❌ ${bad} template(s) with problems` : `✅ ${list.length} templates OK`);
await client.close();
