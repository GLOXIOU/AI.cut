// Built-in AI chat: drives the locally installed Claude Code CLI in headless stream-json mode,
// connected to the AI.cut MCP server. Uses the user's own Claude subscription / login.
// Model, effort and plan usage go through the CLI's control protocol (initialize, get_settings, set_model,
// apply_flag_settings, get_context_usage, rate_limit_event) and its `/usage` command, which costs no tokens.
// The choices only apply to this chat: the user's own Claude Code settings are never written.
import { spawnTracked, killTree } from '../core/proc.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bus } from '../core/bus.js';
import { log } from '../core/log.js';
import { which } from '../core/util.js';
import { tempDir } from '../core/paths.js';
import { getSettings, setSettings, tr } from '../core/settings.js';
import { store } from '../project/store.js';
import { mcpUrl } from '../services.js';
import { COPILOT_SYSTEM } from './guide.js';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

let proc = null;
let channel = null; // control requests of the running chat process
let sessionId = null;
let busy = false;
const transcript = []; // UI messages: {id, role, text, tools:[...], done}
let current = null; // assistant message being streamed
let queued = null; // { model?, effort? } picked while a reply streams: applied once it ends

// What the chat runs with and how much of the plan is used (shown in the composer).
// windows: [{ id: 'session' | 'week' | 'week:<model>', label, pct 0-100, resetsAt ms }]
const meta = { models: null, plan: null, model: null, effort: null, windows: null, limited: false, usageAt: 0, context: null, refreshing: false };

function emit() { bus.emit('copilot:update', state()); }
export function state() {
  return { available: !!which('claude'), running: !!proc, busy, sessionId, messages: transcript.slice(-200), meta: { ...meta } };
}

const prefs = () => getSettings().copilot || {};

/** --model / --effort for a new CLI process, from the choices saved for the chat. */
function flagArgs() {
  const s = prefs();
  const a = [];
  if (s.model) a.push('--model', s.model);
  if (EFFORTS.includes(s.effort)) a.push('--effort', s.effort);
  return a;
}

/** Splits a stream into JSON events (one per line). */
function jsonLines(onEvent) {
  let rest = '';
  return (d) => {
    rest += d;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i).trim();
      rest = rest.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      onEvent(ev);
    }
  };
}

/** Request / response over the CLI's control protocol (control_request → control_response). */
function controlChannel(p) {
  const waiting = new Map();
  return {
    request(subtype, extra = {}, timeout = 20000) {
      const id = `aicut-${randomUUID()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${subtype}: timeout`)); }, timeout);
        waiting.set(id, { resolve, reject, timer });
        p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype, ...extra } }) + '\n');
      });
    },
    settle(r) {
      const w = waiting.get(r?.request_id);
      if (!w) return;
      waiting.delete(r.request_id);
      clearTimeout(w.timer);
      if (r.subtype === 'success') w.resolve(r.response || {});
      else w.reject(new Error(r.error || 'control request failed'));
    },
    close() {
      for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error('claude exited')); }
      waiting.clear();
    },
  };
}

function control(subtype, extra) {
  if (!proc || !channel) return Promise.reject(new Error('chat not running'));
  return channel.request(subtype, extra);
}

function startProcess() {
  const claude = which('claude');
  if (!claude) throw new Error(tr('Claude Code CLI introuvable. Installe-le (claude.com/claude-code) puis connecte-toi avec `claude` une première fois.', 'Claude Code CLI not found. Install it (claude.com/claude-code), then sign in by running `claude` once.'));
  const promptFile = path.join(tempDir(), 'aicut-copilot-prompt.md');
  fs.writeFileSync(promptFile, COPILOT_SYSTEM);
  const mcp = JSON.stringify({ mcpServers: { aicut: { type: 'http', url: mcpUrl() } } });
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--strict-mcp-config', '--mcp-config', mcp,
    '--tools', 'WebSearch,WebFetch',
    '--allowedTools', 'mcp__aicut', 'WebSearch', 'WebFetch',
    '--permission-prompts', 'none',
    '--append-system-prompt-file', promptFile,
    '-n', `AI.cut ${store.project?.name || ''}`.trim(),
    ...flagArgs(),
  ];
  queued = null; // the flags already carry the latest choices
  if (sessionId) args.push('--resume', sessionId);
  else { sessionId = randomUUID(); args.push('--session-id', sessionId); }
  const cwd = store.dir || process.cwd();
  log.info('copilot start', claude, cwd);
  // Claude Code starts processes of its own: the whole tree is killed on stop / app exit
  const p = spawnTracked(claude, args, { cwd, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'aicut-copilot' } }, { tree: true });
  const ch = controlChannel(p);
  proc = p;
  channel = ch;
  p.stdin.on('error', () => { /* closed pipe: 'close' reports it */ });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', jsonLines(handleEvent));
  let errTail = '';
  p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-3000); });
  p.on('close', (code) => {
    log.info('copilot exited', code, errTail.slice(-500));
    ch.close();
    if (proc !== p) return; // stopped, and maybe already restarted
    proc = null;
    channel = null;
    if (busy) {
      busy = false;
      pushSystem(code ? `${tr(`Le chat s'est arrêté (code ${code}).`, `The chat stopped (code ${code}).`)} ${errTail.trim().split('\n').slice(-2).join(' ')}` : tr('Session terminée.', 'Session ended.'));
    }
    emit();
  });
  p.on('error', (e) => {
    ch.close();
    if (proc !== p) return;
    pushSystem(`${tr('Impossible de lancer claude', 'Could not start claude')} : ${e.message}`);
    proc = null; channel = null; busy = false; emit();
  });
  // models list + the model / effort this session really uses
  ch.request('initialize').then(applyInitialize).then(() => ch.request('get_settings')).then((r) => { applyApplied(r); emit(); })
    .catch((e) => log.warn('copilot init', e.message));
}

function pushSystem(text) {
  transcript.push({ id: randomUUID(), role: 'system', text, done: true, at: Date.now() });
}

function ensureCurrent() {
  if (!current) {
    current = { id: randomUUID(), role: 'assistant', text: '', tools: [], done: false, at: Date.now() };
    transcript.push(current);
  }
  return current;
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.model) meta.model = ev.model;
        const srv = (ev.mcp_servers || []).find((s) => s.name === 'aicut');
        if (srv && srv.status !== 'connected') pushSystem(`${tr('Serveur MCP aicut', 'aicut MCP server')} : ${srv.status}`);
      }
      break;
    case 'control_response':
      channel?.settle(ev.response);
      break;
    case 'rate_limit_event':
      applyRateLimit(ev.rate_limit_info);
      emit();
      break;
    case 'stream_event': {
      const e = ev.event || {};
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        ensureCurrent().text += e.delta.text;
        throttledEmit();
      }
      break;
    }
    case 'assistant': {
      const msg = ev.message || {};
      const cur = ensureCurrent();
      for (const block of msg.content || []) {
        if (block.type === 'tool_use') {
          cur.tools.push({ id: block.id, name: String(block.name).replace(/^mcp__aicut__/, ''), input: shortJson(block.input), status: 'running' });
        } else if (block.type === 'text' && block.text && !cur.text.includes(block.text.slice(0, 40))) {
          cur.text += (cur.text ? '\n' : '') + block.text;
        }
      }
      emit();
      break;
    }
    case 'user': {
      const msg = ev.message || {};
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (block.type === 'tool_result') {
          for (const m of transcript) {
            const t = m.tools?.find((x) => x.id === block.tool_use_id);
            if (t) { t.status = block.is_error ? 'error' : 'done'; if (block.is_error) t.error = textOf(block.content).slice(0, 300); }
          }
        }
      }
      // a new assistant turn will follow tool results
      current = null;
      emit();
      break;
    }
    case 'result': {
      busy = false;
      if (current) current.done = true;
      current = null;
      if (ev.is_error || ev.subtype !== 'success') pushSystem(`${tr('Erreur', 'Error')} : ${ev.result || ev.subtype}`);
      transcript.push({ id: randomUUID(), role: 'meta', text: `${ev.num_turns || ''} ${tr('tours', 'turns')} · ${ev.duration_ms ? Math.round(ev.duration_ms / 1000) + ' s' : ''}${ev.total_cost_usd ? ` · $${ev.total_cost_usd.toFixed(3)}` : ''}`, done: true, at: Date.now() });
      emit();
      afterTurn();
      break;
    }
    default: break;
  }
}

/** Once a reply ends: apply a model / effort picked meanwhile, then read how full the context is. */
async function afterTurn() {
  const q = queued;
  queued = null;
  if (q) await applyLive(q);
  try {
    const r = await control('get_context_usage');
    if (Number.isFinite(r?.totalTokens) && r.maxTokens > 0) meta.context = { used: r.totalTokens, max: r.maxTokens, pct: Math.min(100, (r.totalTokens / r.maxTokens) * 100) };
  } catch { /* not running anymore */ }
  emit();
}

function applyInitialize(r) {
  if (Array.isArray(r?.models) && r.models.length) {
    meta.models = r.models.filter((m) => m?.value && m.value !== 'default').map((m) => ({
      value: m.value,
      name: m.displayName || m.value,
      resolved: m.resolvedModel || m.value,
      efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e) => EFFORTS.includes(e)) : [],
      main: !/^claude-/.test(m.value), // aliases of the current generation; full ids are older versions
    }));
  }
  if (r?.account) meta.plan = r.account.subscriptionType || null;
}

function applyApplied(r) {
  const a = r?.applied;
  if (!a) return;
  if (a.model) meta.model = a.model;
  meta.effort = a.effort || null;
}

function setWindows(list) {
  const order = (w) => (w.id === 'session' ? 0 : w.id === 'week' ? 1 : 2);
  meta.windows = list.sort((a, b) => order(a) - order(b));
}

function applyRateLimit(info) {
  if (!info) return;
  const list = [...(meta.windows || [])];
  const put = (id, utilization, resetsAt) => {
    if (!Number.isFinite(utilization)) return;
    const i = list.findIndex((w) => w.id === id);
    const w = { id, label: null, pct: Math.max(0, Math.min(100, utilization * 100)), resetsAt: resetsAt ? resetsAt * 1000 : (list[i]?.resetsAt ?? null) };
    if (i >= 0) list[i] = w; else list.push(w);
  };
  const u = info.unifiedWindows || {};
  put('session', u.five_hour?.utilization, u.five_hour?.resetsAt);
  put('week', u.seven_day?.utilization, u.seven_day?.resetsAt);
  if (!u.five_hour && !u.seven_day) { // older CLI: the event is about a single window
    const id = { five_hour: 'session', seven_day: 'week' }[info.rateLimitType];
    if (id) put(id, info.utilization, info.resetsAt);
  }
  setWindows(list);
  meta.limited = info.status === 'rejected';
  meta.usageAt = Date.now();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Nov 15, 10:39pm (Europe/Paris)" / "10:39pm" → timestamp (the CLI prints the machine's local time). */
function parseReset(s, now) {
  const m = String(s || '').replace(/\([^)]*\)/g, ' ').trim()
    .match(/^(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[3]);
  const ap = (m[5] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const d = new Date(now);
  if (m[1]) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    d.setMonth(mi, Number(m[2]));
    d.setHours(h, Number(m[4] || 0), 0, 0);
    if (d.getTime() < now.getTime() - 86400000) d.setFullYear(d.getFullYear() + 1);
  } else {
    d.setHours(h, Number(m[4] || 0), 0, 0);
    if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

/** Lines of the CLI's `/usage` ("Current session: 5% used · resets …", "Current week (Fable): 51% used …"). */
export function parseUsageText(txt, now = new Date()) {
  const out = [];
  for (const line of String(txt || '').split(/\r?\n/)) {
    const m = line.match(/^\s*Current (session|week)(?:\s*\(([^)]*)\))?\s*:\s*(\d+(?:\.\d+)?)\s*%\s*used(?:.*?\bresets?\s+(.+))?$/i);
    if (!m) continue;
    const scope = (m[2] || '').replace(/\s+only$/i, '').trim(); // "all models", "Fable", "Sonnet only"
    const perModel = m[1].toLowerCase() === 'week' && scope && !/^all\b/i.test(scope);
    const id = m[1].toLowerCase() === 'session' ? 'session' : perModel ? `week:${scope.toLowerCase()}` : 'week';
    if (out.some((w) => w.id === id)) continue;
    out.push({ id, label: perModel ? scope : null, pct: Math.min(100, Number(m[3])), resetsAt: parseReset(m[4], now) });
  }
  return out;
}

/**
 * Short-lived CLI process without tools or MCP servers: models list, plan, model / effort the chat would run
 * with, and `/usage`. None of it calls a model.
 */
async function probe(claude) {
  const flags = flagArgs();
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', ...flags];
  const p = spawnTracked(claude, args, { cwd: tempDir(), env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'aicut-copilot' } }, { tree: true });
  const ch = controlChannel(p);
  let gotResult;
  const result = new Promise((r) => { gotResult = r; });
  p.stdin.on('error', () => {});
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', jsonLines((ev) => {
    if (ev.type === 'control_response') ch.settle(ev.response);
    else if (ev.type === 'result') gotResult(ev.result);
  }));
  p.on('close', () => { ch.close(); gotResult(null); });
  p.on('error', () => { ch.close(); gotResult(null); });
  const killer = setTimeout(() => killTree(p), 30000);
  try {
    applyInitialize(await ch.request('initialize'));
    const applied = await ch.request('get_settings');
    // a running chat reports its own; a choice made meanwhile wins over this reading
    if (!proc && flagArgs().join('\n') === flags.join('\n')) applyApplied(applied);
    emit();
    p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/usage' }] } }) + '\n');
    const windows = parseUsageText(await result);
    if (windows.length) {
      const prev = meta.windows || [];
      setWindows(windows.map((w) => ({ ...w, resetsAt: w.resetsAt ?? prev.find((x) => x.id === w.id)?.resetsAt ?? null })));
      meta.limited = windows.some((w) => w.pct >= 100);
      meta.usageAt = Date.now();
    }
  } finally {
    clearTimeout(killer);
    try { p.stdin.end(); } catch { /* gone */ }
    setTimeout(() => killTree(p), 3000);
  }
}

let refreshing = null;
/** Refresh models, plan and usage (no tokens spent). maxAge: skip when the usage is more recent than that (ms). */
export function refreshMeta({ maxAge = 0 } = {}) {
  if (refreshing) return refreshing;
  if (meta.models && meta.usageAt && Date.now() - meta.usageAt < maxAge) return Promise.resolve(state());
  const claude = which('claude');
  if (!claude) return Promise.resolve(state());
  meta.refreshing = true;
  emit();
  refreshing = probe(claude)
    .catch((e) => log.warn('copilot probe', e.message))
    .then(() => { refreshing = null; meta.refreshing = false; emit(); return state(); });
  return refreshing;
}

/** Apply a model / effort to the running chat process, then read back what it really uses. */
async function applyLive(q) {
  try {
    if (q.model) { const r = await control('set_model', { model: q.model }); if (r?.model) meta.model = r.model; }
    if (q.effort !== undefined) await control('apply_flag_settings', { settings: { effortLevel: q.effort || null } });
    applyApplied(await control('get_settings'));
  } catch (e) { log.warn('copilot apply', e.message); }
  emit();
}

function choose(patch) {
  setSettings({ copilot: { ...prefs(), ...patch } });
  if (proc) {
    if (busy) queued = { ...queued, ...patch }; // never switch in the middle of a reply
    else applyLive(patch);
  }
}

/** Model of the chat (an alias like "opus" or a full id). Applies right away, or after the reply in progress. */
export function setModel(model) {
  const v = String(model || '').trim();
  if (!v) throw new Error('model required');
  const m = meta.models?.find((x) => x.value === v);
  meta.model = m?.resolved || v;
  // an effort the new model does not offer: the CLI picks its own, read back once applied
  if (m && meta.effort && m.efforts.length && !m.efforts.includes(meta.effort)) meta.effort = null;
  choose({ model: v });
  emit();
  return state();
}

/** Effort (thinking depth) of the chat: low | medium | high | xhigh | max. */
export function setEffort(effort) {
  if (!EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
  meta.effort = effort;
  choose({ effort });
  emit();
  return state();
}

let emitTimer = null;
function throttledEmit() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = null; emit(); }, 80);
}
function shortJson(o) { try { const s = JSON.stringify(o); return s.length > 160 ? s.slice(0, 160) + '…' : s; } catch { return ''; } }
function textOf(c) { return Array.isArray(c) ? c.map((b) => b.text || '').join(' ') : String(c || ''); }

/** Send a user message to the copilot. */
export function send(text, attachments = {}) {
  if (!text?.trim()) return state();
  if (!proc) startProcess();
  let content = text.trim();
  const ui = attachments.ui;
  if (ui) content += `\n\n[context: playhead=${(ui.playhead ?? 0).toFixed(2)}s${ui.selection?.length ? `, selected clips=${ui.selection.join(',')}` : ''}]`;
  transcript.push({ id: randomUUID(), role: 'user', text: text.trim(), done: true, at: Date.now() });
  current = null;
  busy = true;
  const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: content }] } };
  proc.stdin.write(JSON.stringify(msg) + '\n');
  emit();
  return state();
}

export function stop() {
  if (proc) killTree(proc);
  channel?.close();
  proc = null;
  channel = null;
  busy = false;
  if (current) { current.done = true; current = null; }
  pushSystem(tr('Arrêté.', 'Stopped.'));
  emit();
  return state();
}

export function reset() {
  stop();
  sessionId = null;
  transcript.length = 0;
  meta.context = null;
  emit();
  return state();
}
