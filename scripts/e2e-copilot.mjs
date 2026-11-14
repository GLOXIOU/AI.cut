// Live test of "ask the AI here" through the built-in copilot (uses the local Claude Code CLI and its subscription).
// node scripts/e2e-copilot.mjs <port>   (AI.cut running with AICUT_DEBUG=1 and a project open)
const port = process.argv[2] || '7788';
const evalJs = (js) => fetch(`http://127.0.0.1:${port}/debug/eval`, { method: 'POST', body: JSON.stringify({ js }) }).then((r) => r.json());
const call = (name, args = {}) => fetch(`http://127.0.0.1:${port}/api/call/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) }).then((r) => r.json());

const before = (await call('get_project')).result.markers.length;
const r = await evalJs("window.aicut.call('ai:askHere', { text: 'Ajoute juste un marqueur nommé « test copilote » à cet endroit, rien d\\'autre.', time: 2, target: 'copilot' })");
console.log('asked', JSON.stringify(r.data?.request?.id), 'sent to', r.data?.sentTo);
const id = r.data?.request?.id;
const t0 = Date.now();
let req = null;
while (Date.now() - t0 < 240000) {
  await new Promise((s) => setTimeout(s, 4000));
  const p = (await call('list_requests', { status: 'all' })).result || [];
  req = p.find((x) => x.id === id);
  if (req && (req.status === 'done' || req.status === 'dismissed')) break;
}
const proj = (await call('get_project')).result;
const mk = proj.markers.find((m) => /copilote/i.test(m.label || ''));
console.log('request', JSON.stringify(req), `${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log('markers', before, '→', proj.markers.length, mk ? `OK marker "${mk.label}" at ${mk.time}s` : 'FAIL no marker');
const cp = await evalJs("window.aicut.call('copilot:state').then((s) => s.messages.slice(-3).map((m) => `${m.role}: ${(m.text || '').slice(0, 160)} [${(m.tools || []).map((t) => t.name).join(',')}]`))");
console.log(JSON.stringify(cp.data, null, 1));
process.exitCode = mk && req?.status === 'done' ? 0 : 1;
