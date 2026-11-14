// AI creative proposals. An AI opens a proposal (start_proposal), edits with the normal tools, then closes it: every
// change it made meanwhile is recorded in the proposal so the user can accept it (keep) or reject it (undo just
// those changes, even after other edits). Pending proposals are visible in the timeline (dashed clips + a marker on
// the ruler) and are NOT exported unless accepted.
//
//   project.proposals[] = { id, title, description, by, status: 'recording' | 'pending' | 'accepted' | 'rejected',
//     createdAt, time, end, added: [clipIds], before: { clipId: clipSnapshot }, removed: [clipSnapshots] }
//   clip.proposal = id on clips added or modified by a proposal still open.

const clone = (o) => JSON.parse(JSON.stringify(o));
const strip = (c) => { const o = { ...c }; o.proposal = null; return o; };
export const OPEN_STATUSES = new Set(['recording', 'pending']);

/** Record the difference between two clip lists into the proposal (mutates `after` clips and the proposal). */
export function recordProposalDiff(prop, beforeClips, afterClips) {
  const before = new Map(beforeClips.map((c) => [c.id, c]));
  const after = new Map(afterClips.map((c) => [c.id, c]));
  const added = new Set(prop.added || []);
  prop.before = prop.before || {};
  prop.removed = prop.removed || [];
  for (const c of afterClips) {
    const b = before.get(c.id);
    if (!b) {
      if (!prop.before[c.id]) added.add(c.id);
      c.proposal = prop.id;
    } else if (JSON.stringify(b) !== JSON.stringify(c)) {
      if (!added.has(c.id) && !prop.before[c.id]) prop.before[c.id] = strip(clone(b));
      c.proposal = prop.id;
    }
  }
  for (const b of beforeClips) {
    if (after.has(b.id)) continue;
    if (added.has(b.id)) { added.delete(b.id); continue; }
    if (prop.before[b.id]) { prop.removed.push(prop.before[b.id]); delete prop.before[b.id]; } else prop.removed.push(strip(clone(b)));
  }
  prop.added = [...added];
  // time span of everything touched
  let t0 = Infinity, t1 = -Infinity;
  const span = (c) => { if (!c) return; t0 = Math.min(t0, c.start); t1 = Math.max(t1, c.start + c.duration); };
  for (const id of prop.added) span(after.get(id));
  for (const id of Object.keys(prop.before)) { span(after.get(id)); span(prop.before[id]); }
  for (const c of prop.removed) span(c);
  if (Number.isFinite(t0) && !prop.fixedTime) { prop.time = Math.round(t0 * 1000) / 1000; prop.end = Math.round(t1 * 1000) / 1000; }
}

/** Undo a proposal's changes on a project draft (clips only). */
export function revertProposal(p, prop) {
  const added = new Set(prop.added || []);
  p.clips = p.clips.filter((c) => !added.has(c.id));
  for (const [id, snap] of Object.entries(prop.before || {})) {
    const i = p.clips.findIndex((c) => c.id === id);
    if (i >= 0) p.clips[i] = clone(snap); else p.clips.push(clone(snap));
  }
  for (const snap of prop.removed || []) if (!p.clips.some((c) => c.id === snap.id)) p.clips.push(clone(snap));
}

/** Keep a proposal's changes: the clips become normal clips. */
export function keepProposal(p, prop) {
  for (const c of p.clips) if (c.proposal === prop.id) c.proposal = null;
}

/** Project copy without the pending proposals (export, "hide proposals" in the player). */
export function withoutPendingProposals(project) {
  const open = (project.proposals || []).filter((x) => OPEN_STATUSES.has(x.status));
  if (!open.length) return project;
  const p = { ...project, clips: project.clips.slice() };
  for (const prop of [...open].reverse()) revertProposal(p, prop);
  return p;
}

export function proposalInfo(prop) {
  return {
    id: prop.id, title: prop.title, description: prop.description, status: prop.status, by: prop.by, time: prop.time, end: prop.end,
    added: prop.added?.length || 0, modified: Object.keys(prop.before || {}).length, removed: prop.removed?.length || 0,
  };
}
