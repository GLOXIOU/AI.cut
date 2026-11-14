// Built-in AI chat: drives the locally installed Claude Code CLI in headless stream-json mode,
// connected to the AI.cut MCP server. Uses the user's own Claude subscription / login.
import { spawnTracked, killTree } from '../core/proc.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bus } from '../core/bus.js';
import { log } from '../core/log.js';
import { which } from '../core/util.js';
import { tempDir } from '../core/paths.js';
import { getSettings, tr } from '../core/settings.js';
import { store } from '../project/store.js';
import { mcpUrl } from '../services.js';
import { COPILOT_SYSTEM } from './guide.js';

let proc = null;
let sessionId = null;
let busy = false;
let buf = '';
const transcript = []; // UI messages: {id, role, text, tools:[...], done}
let current = null; // assistant message being streamed

function emit() { bus.emit('copilot:update', state()); }
export function state() {
  return { available: !!which('claude'), running: !!proc, busy, sessionId, messages: transcript.slice(-200) };
}

function startProcess() {
  const claude = which('claude');
  if (!claude) throw new Error(tr('Claude Code CLI introuvable. Installe-le (claude.com/claude-code) puis connecte-toi avec `claude` une première fois.', 'Claude Code CLI not found. Install it (claude.com/claude-code), then sign in by running `claude` once.'));
  const s = getSettings().copilot || {};
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
  ];
  if (s.model) args.push('--model', s.model);
  if (sessionId) args.push('--resume', sessionId);
  else { sessionId = randomUUID(); args.push('--session-id', sessionId); }
  const cwd = store.dir || process.cwd();
  log.info('copilot start', claude, cwd);
  // Claude Code starts processes of its own: the whole tree is killed on stop / app exit
  proc = spawnTracked(claude, args, { cwd, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'aicut-copilot' } }, { tree: true });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', onData);
  let errTail = '';
  proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-3000); });
  proc.on('close', (code) => {
    log.info('copilot exited', code, errTail.slice(-500));
    proc = null;
    if (busy) {
      busy = false;
      pushSystem(code ? `${tr(`Le chat s'est arrêté (code ${code}).`, `The chat stopped (code ${code}).`)} ${errTail.trim().split('\n').slice(-2).join(' ')}` : tr('Session terminée.', 'Session ended.'));
    }
    emit();
  });
  proc.on('error', (e) => { pushSystem(`${tr('Impossible de lancer claude', 'Could not start claude')} : ${e.message}`); proc = null; busy = false; emit(); });
}

function pushSystem(text) {
  transcript.push({ id: randomUUID(), role: 'system', text, done: true, at: Date.now() });
}

function onData(d) {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    handleEvent(ev);
  }
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
        const srv = (ev.mcp_servers || []).find((s) => s.name === 'aicut');
        if (srv && srv.status !== 'connected') pushSystem(`${tr('Serveur MCP aicut', 'aicut MCP server')} : ${srv.status}`);
      }
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
      break;
    }
    default: break;
  }
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
  proc = null;
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
  emit();
  return state();
}
