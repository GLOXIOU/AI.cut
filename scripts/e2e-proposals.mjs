// Proposals: edits made between start_proposal / end_proposal are recorded; reject restores exactly, accept keeps.
// node scripts/e2e-proposals.mjs <port>   (AI.cut running with a project that has at least one video clip)
const port = process.argv[2] || '7788';
const call = async (name, args = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/call/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aicut-client': 'e2e-proposals' }, body: JSON.stringify(args) }).then((x) => x.json());
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result ?? r.text;
};
const op = (name, args) => fetch(`http://127.0.0.1:${port}/debug/eval`, { method: 'POST', body: JSON.stringify({ js: `window.aicut.call('project:op', ${JSON.stringify({ name, args, label: name })}).then(() => 1)` }) }).then((r) => r.json());
let fails = 0;
const check = (ok, msg) => { if (!ok) fails++; console.log(ok ? 'OK  ' : 'FAIL', msg); };

const proj = await call('get_project', { includeClips: true });
const vid = proj.clips.find((c) => c.type === 'video' && !c.cutoutOf);
const before = JSON.stringify(vid);
const nClips = proj.clips.length;

// 1. reject: modified clip restored, added clip removed, deleted clip back
await call('start_proposal', { title: 'Speed ramp fou', description: 'test' });
await call('update_clip', { id: vid.id, speed: 2, color: { saturation: 2 } });
const added = await call('add_motion', { template: 'flash', start: 1, duration: 0.3 });
const victim = proj.clips.find((c) => c.type === 'html' && c.id !== vid.id);
if (victim) await call('delete_clips', { ids: [victim.id] });
const end = await call('end_proposal');
check(end.status === 'pending', `proposal pending (${JSON.stringify(end)})`);
let p = await call('get_project', { includeClips: true });
check(p.clips.find((c) => c.id === vid.id).proposal === end.id, 'modified clip flagged with the proposal');
await op('rejectProposal', { id: end.id });
p = await call('get_project', { includeClips: true });
const v2 = { ...p.clips.find((c) => c.id === vid.id) };
check(JSON.stringify(v2) === before, 'rejected: the modified clip is exactly restored');
check(!p.clips.some((c) => c.id === added.clips[0].id), 'rejected: the added clip is gone');
if (victim) check(p.clips.some((c) => c.id === victim.id), 'rejected: the deleted clip is back');
check(p.clips.length === nClips, `clip count restored (${p.clips.length} / ${nClips})`);

// 2. accept: changes kept, flags cleared
await call('start_proposal', { title: 'Look ciné' });
await call('set_color_grade', { ids: [vid.id], look: 'cinema' });
const e2 = await call('end_proposal');
await op('acceptProposal', { id: e2.id });
p = await call('get_project', { includeClips: true });
const v3 = p.clips.find((c) => c.id === vid.id);
check(v3.color?.fade > 0 && !v3.proposal, 'accepted: grade kept, flag cleared');
const props = await call('list_proposals');
check(props.find((x) => x.id === end.id)?.status === 'rejected' && props.find((x) => x.id === e2.id)?.status === 'accepted', 'statuses rejected / accepted');
// 3. an empty proposal is discarded
await call('start_proposal', { title: 'rien' });
const e3 = await call('end_proposal');
check(e3.empty === true, 'empty proposal discarded');
console.log(fails ? `${fails} FAILURE(S)` : 'ALL OK');
process.exitCode = fails ? 1 : 0;
