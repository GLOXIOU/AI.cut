#!/usr/bin/env node
// AI.cut stdio ⇄ Streamable-HTTP MCP bridge (dependency-free).
// For MCP clients that only support stdio servers (Claude Desktop, older Codex, …):
//   command: node   args: ["<path>/bin/aicut-mcp.cjs"]      (env AICUT_URL to override the endpoint)
// The AI.cut app must be running. The bridge re-initializes transparently if the app restarts.
'use strict';

const URL_ = process.env.AICUT_URL || `http://127.0.0.1:${process.env.AICUT_PORT || 7777}/mcp`;
let sessionId = null;
let protocolVersion = null;
let initRequest = null; // last initialize request (replayed after an app restart)
let initializing = null;

function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function log(...a) { if (process.env.AICUT_DEBUG) process.stderr.write(`[aicut-mcp] ${a.join(' ')}\n`); }

async function post(msg, { allowReinit = true } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  let res;
  try {
    res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(msg) });
  } catch (e) {
    throw Object.assign(new Error('AI.cut is not running. Open the AI.cut app, then retry.'), { code: 'OFFLINE' });
  }
  if (res.status === 404 && sessionId && allowReinit && initRequest && msg.method !== 'initialize') {
    log('session expired → re-initializing');
    sessionId = null;
    await reinit();
    return post(msg, { allowReinit: false });
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (res.status === 202 || res.status === 204) return [];
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) return readSse(res);
  const text = await res.text();
  if (!text) return [];
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [data];
}

async function readSse(res) {
  const out = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg.method) write(msg); // server → client notification (progress, logs) — forward immediately
        else out.push(msg);
      } catch { /* ignore */ }
    }
  }
  return out;
}

async function reinit() {
  if (initializing) return initializing;
  initializing = (async () => {
    const replies = await post({ ...initRequest, id: `aicut-reinit-${Date.now()}` }, { allowReinit: false });
    const r = replies.find((m) => m.result);
    if (r?.result?.protocolVersion) protocolVersion = r.result.protocolVersion;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { allowReinit: false });
  })().finally(() => { initializing = null; });
  return initializing;
}

async function handle(msg) {
  if (msg.method === 'initialize') initRequest = msg;
  try {
    const replies = await post(msg);
    for (const r of replies) {
      if (msg.method === 'initialize' && r.result?.protocolVersion) protocolVersion = r.result.protocolVersion;
      write(r);
    }
  } catch (e) {
    if (msg.id !== undefined && msg.id !== null) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } });
    log('error', e.message);
  }
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  pending += d;
  let i;
  while ((i = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, i).trim();
    pending = pending.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (Array.isArray(msg)) msg.forEach((m) => handle(m)); else handle(msg);
  }
});
process.stdin.on('end', async () => {
  if (sessionId) {
    try { await fetch(URL_, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }); } catch { /* ignore */ }
  }
  process.exit(0);
});
