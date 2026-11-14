// AI proposals ("creative idea the user can accept or reject") and user requests pinned on the timeline.
// A session in proposal mode has every edit it makes recorded into its proposal by store.transaction
// (see shared/proposals.js for the data model).
import { store } from '../project/store.js';
import { uid } from '../core/util.js';
import { bus } from '../core/bus.js';
import { tr } from '../core/settings.js';
import { OPEN_STATUSES } from '../../shared/proposals.js';
import { fmtTime, trackById, clipById } from '../../shared/timeline.js';

const recording = new Map(); // session key -> { id, at }
const IDLE_CLOSE_MS = 15 * 60 * 1000;

export const sessionKey = (ctx) => ctx?.session || ctx?.client || 'AI';

/** Proposal currently recorded for this session (closed automatically when idle for too long). */
export function activeProposalId(key) {
  const r = recording.get(key);
  if (!r) return null;
  const p = store.project?.proposals?.find((x) => x.id === r.id);
  if (!p || p.status !== 'recording') { recording.delete(key); return null; }
  if (Date.now() - r.at > IDLE_CLOSE_MS) { finishProposal(key); return null; }
  r.at = Date.now();
  return r.id;
}

export function startProposal(key, { title, description, time, end }, meta = {}) {
  store.requireOpen();
  if (recording.has(key)) finishProposal(key);
  const id = uid('prop');
  const fixed = time != null;
  store.transaction(`proposal: ${title}`, (draft) => {
    draft.proposals = draft.proposals || [];
    draft.proposals.push({
      id, title: String(title || 'Idée').slice(0, 120), description: String(description || '').slice(0, 2000), by: meta.client || 'AI',
      status: 'recording', createdAt: new Date().toISOString(), time: fixed ? Number(time) : null, end: end != null ? Number(end) : null,
      fixedTime: fixed, added: [], before: {}, removed: [],
    });
  }, { ...meta, noProposal: true });
  recording.set(key, { id, at: Date.now() });
  return { id, recording: true };
}

export function finishProposal(key, meta = {}) {
  const r = recording.get(key);
  recording.delete(key);
  if (!r || !store.project) return null;
  const prop = store.project.proposals?.find((x) => x.id === r.id);
  if (!prop || prop.status !== 'recording') return null;
  const empty = !prop.added.length && !Object.keys(prop.before).length && !prop.removed.length;
  store.transaction(`proposal ready: ${prop.title}`, (draft) => {
    const p = draft.proposals.find((x) => x.id === r.id);
    if (empty) draft.proposals = draft.proposals.filter((x) => x.id !== r.id);
    else p.status = 'pending';
  }, { ...meta, noProposal: true });
  if (!empty) bus.emit('toast', { level: 'info', message: tr(`💡 Proposition de l'IA : « ${prop.title} » — accepte ou refuse-la sur la timeline`, `💡 AI proposal: "${prop.title}" — accept or reject it on the timeline`) });
  return { id: r.id, status: empty ? 'discarded (no change)' : 'pending', empty };
}

export function openProposals() {
  return (store.project?.proposals || []).filter((x) => OPEN_STATUSES.has(x.status));
}

// ------------------------------------------------------------------------------------------- requests
/** Human-readable context of a request: where it is, what is there. */
export function requestContext(p, r) {
  const parts = [`at ${fmtTime(r.time)} (${r.time}s)`];
  if (r.end != null) parts[0] = `from ${fmtTime(r.time)} to ${fmtTime(r.end)} (${r.time}s–${r.end}s)`;
  const t = r.trackId ? trackById(p, r.trackId) : null;
  if (t) parts.push(`track ${t.name}`);
  const c = r.clipId ? clipById(p, r.clipId) : null;
  if (c) parts.push(`clip "${c.name}" (id ${c.id}, ${c.type}, ${fmtTime(c.start)}–${fmtTime(c.start + c.duration)})`);
  const under = p.clips.filter((x) => x.start <= (r.end ?? r.time) && x.start + x.duration >= r.time && x.id !== r.clipId)
    .map((x) => `${trackById(p, x.trackId)?.name || '?'}:"${x.name}" (${x.id})`).slice(0, 8);
  if (under.length) parts.push(`also there: ${under.join(', ')}`);
  return parts.join(', ');
}

/** Requests created since a session last looked (pushed into its next tool result). */
export function unseenRequests(seen) {
  const list = (store.project?.requests || []).filter((r) => (r.status === 'open') && !seen.has(r.id));
  for (const r of list) seen.add(r.id);
  return list;
}

export function requestsNote(list) {
  if (!list.length) return null;
  const p = store.project;
  return `📌 The user pinned ${list.length} request(s) on the timeline for you — do them now (precisely at that place), then call resolve_request with a short reply:\n` +
    list.map((r) => `- [${r.id}] ${requestContext(p, r)}: "${r.text}"`).join('\n');
}
