// Local MCP server (Streamable HTTP on 127.0.0.1) + tiny REST bridge, exposing the AI.cut tool catalogue.
import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, toolByName } from './tools.js';
import { SERVER_INSTRUCTIONS } from './guide.js';
import { bus } from '../core/bus.js';
import { log } from '../core/log.js';
import { store } from '../project/store.js';
import { uid, readJson, writeJson } from '../core/util.js';
import { userDir } from '../core/paths.js';
import { tr } from '../core/settings.js';

const VERSION = '0.1.0';
const sessions = new Map(); // id -> session
let httpServer = null;
let currentPort = null;
const activity = []; // recent tool calls

function prettyClient(info) {
  const n = String(info?.name || 'AI').toLowerCase();
  if (n.includes('claude-code') || n === 'claude-code') return 'Claude Code';
  if (n.includes('claude')) return 'Claude';
  if (n.includes('codex')) return 'Codex';
  if (n.includes('cursor')) return 'Cursor';
  if (n.includes('gemini')) return 'Gemini';
  if (n.includes('vscode') || n.includes('visual studio')) return 'VS Code';
  if (n.includes('aicut-copilot')) return 'Copilot';
  return info?.name || 'AI';
}

// A session is "connected" while the client holds its event stream open (Claude Code, Cursor… keep a GET stream),
// or — for clients that only POST — while it has talked to us recently. Idle is not disconnected: an AI that has not
// called a tool for an hour is still there, the editor must not show it as gone.
const SEEN_MS = 3 * 60 * 60 * 1000;
const PRUNE_MS = 24 * 60 * 60 * 1000;
function hasStream(s) {
  try { return !!s.transport?._webStandardTransport?._streamMapping?.has('_GET_stream'); } catch { return false; }
}
export function sessionsList() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (!hasStream(s) && now - s.lastSeen > PRUNE_MS) { sessions.delete(id); try { s.transport?.close(); } catch { /* */ } }
  }
  return [...sessions.values()].filter((s) => !s.probe).map((s) => ({
    id: s.id, client: s.client, version: s.clientInfo?.version || null, connectedAt: s.connectedAt, lastActivity: s.lastActivity, calls: s.calls,
    active: hasStream(s) || now - s.lastSeen < SEEN_MS, stream: hasStream(s),
  }));
}
let lastSessionsKey = '';
function emitSessions(force = false) {
  const list = sessionsList();
  const key = JSON.stringify(list.map((x) => [x.id, x.client, x.active, x.calls]));
  if (!force && key === lastSessionsKey) return;
  lastSessionsKey = key;
  bus.emit('ai:sessions', list);
}
setInterval(() => emitSessions(), 30000).unref?.();
export function activityLog() { return activity.slice(-200); }

// Client names of recent sessions survive an AI.cut restart, so a revived session keeps its name (see reviveSession).
const knownFile = () => userDir('mcp-sessions.json');
let known = null;
function knownSessions() {
  if (!known) { try { known = readJson(knownFile(), {}) || {}; } catch { known = {}; } }
  return known;
}
function rememberSession(s) {
  const k = knownSessions();
  k[s.id] = { clientInfo: s.clientInfo || null, at: Date.now() };
  const ids = Object.keys(k).sort((a, b) => k[b].at - k[a].at);
  for (const id of ids.slice(30)) delete k[id];
  try { writeJson(knownFile(), k, false); } catch { /* best effort */ }
}

function summarizeArgs(args) {
  try {
    const s = JSON.stringify(args);
    return s.length > 220 ? s.slice(0, 220) + '…' : s;
  } catch { return ''; }
}

/** Execute a tool by name with plain args (used by MCP, REST bridge and copilot). */
export async function callTool(name, args, { client = 'AI', sendProgress, signal } = {}) {
  const t = toolByName(name);
  if (!t) throw new Error(`Unknown tool ${name}`);
  const entry = { id: uid('act', 6), client, tool: name, args: summarizeArgs(args), at: Date.now(), status: 'running' };
  activity.push(entry);
  if (activity.length > 400) activity.splice(0, activity.length - 300);
  bus.emit('ai:activity', entry);
  const started = Date.now();
  try {
    const parsed = z.object(t.schema).parse(args || {});
    const res = await t.handler(parsed, { client, progress: sendProgress || (() => {}), signal });
    Object.assign(entry, { status: 'done', ms: Date.now() - started });
    bus.emit('ai:activity', entry);
    return res || { json: { ok: true } };
  } catch (e) {
    const msg = e?.issues ? `Invalid arguments: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : e?.message || String(e);
    Object.assign(entry, { status: 'error', ms: Date.now() - started, error: msg });
    bus.emit('ai:activity', entry);
    const err = new Error(msg);
    throw err;
  }
}

function toMcpContent(res) {
  const content = [];
  if (res.text) content.push({ type: 'text', text: res.text });
  if (res.json !== undefined) content.push({ type: 'text', text: JSON.stringify(res.json, null, 1) });
  for (const img of [].concat(res.image || [])) {
    try {
      const data = fs.readFileSync(img).toString('base64');
      content.push({ type: 'image', data, mimeType: /\.png$/i.test(img) ? 'image/png' : 'image/jpeg' });
    } catch (e) { content.push({ type: 'text', text: `(image unavailable: ${e.message})` }); }
  }
  if (!content.length) content.push({ type: 'text', text: 'ok' });
  return content;
}

const PROMPTS = [
  { name: 'edit_video', title: 'Edit my video', description: 'Analyse the imported footage and make a complete edit.', args: { goal: z.string().optional().describe('What you want (style, length, platform)') },
    text: ({ goal }) => `Edit a complete video in AI.cut from the media of the open project.${goal ? ` Goal: ${goal}.` : ''} Follow the AI.cut workflow: get_project, understand every media (get_media_report, view_media_frames, describe_media), plan (set_project_notes), build the cut, add music/SFX/motion graphics/subtitles where they help, verify with render_frames, then summarise. Do not export unless I ask.` },
  { name: 'make_short', title: 'Make a short (TikTok/Reels/Shorts)', description: 'Vertical 9:16 short with hook, fast cuts, bold subtitles.', args: { topic: z.string().optional() },
    text: ({ topic }) => `Make a vertical short (1080x1920, under 60 s) from the project media${topic ? ` about: ${topic}` : ''}. Strong hook in the first 2 s, remove silences, punch-in zooms, b-roll or motion graphics to keep it dynamic (animate every B-roll entrance with set_animation, photos with loop "living" or "cloud", rounded cards with set_frame_look for picture-in-picture), smart subtitles (preset "punch" in emphasis mode or "keywords" mode, and choose the important words yourself with set_subtitle_keywords), light music ducked under the voice, auto_sfx for whooshes/pops, CTA at the end. Verify framing with render_frames.` },
  { name: 'podcast_cleanup', title: 'Clean up a talking-head / podcast', description: 'Remove silences & filler, add titles and subtitles.', args: {},
    text: () => 'Clean up the talking-head/podcast footage: cut silences and filler words ("euh", "um", false starts) using word timestamps, keep natural pacing, add a lower third with the speaker name if known, chapter titles at topic changes, classic subtitles, and normalise loudness. Verify with get_timeline and render_frames.' },
  { name: 'add_subtitles', title: 'Add stylish subtitles', description: 'Generate and style subtitles.', args: { style: z.string().optional() },
    text: ({ style }) => `Generate subtitles for the current timeline and style them${style ? ` like: ${style}` : ' to fit the video'}. Proofread the cues (get_subtitles, edit_subtitles) and check them with render_frames.` },
  { name: 'music_video', title: 'Beat-synced montage', description: 'Cut the footage on the beat of a music track.', args: { mood: z.string().optional() },
    text: ({ mood }) => `Create a montage cut on the beat: find a ${mood || 'fitting'} music track (search_audio, or use the music already imported), get_beats, then place the best moments of the footage so cuts land on beats/downbeats, with transitions and a title. Verify with render_frames.` },
];

function buildServer(session) {
  const server = new McpServer({ name: 'aicut', version: VERSION, title: 'AI.cut — AI video editor' }, { instructions: SERVER_INSTRUCTIONS });
  for (const t of TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.schema, annotations: t.annotations }, async (args, extra) => {
      session.calls++;
      session.lastActivity = session.lastSeen = Date.now();
      session.probe = false;
      emitSessions();
      const token = extra?._meta?.progressToken;
      const sendProgress = token !== undefined ? (p, message) => {
        extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((p || 0) * 100), total: 100, ...(message ? { message } : {}) } }).catch(() => {});
      } : null;
      try {
        const res = await callTool(t.name, args, { client: session.client, sendProgress, signal: extra?.signal });
        return { content: toMcpContent(res) };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
      }
    });
  }
  for (const pr of PROMPTS) {
    server.registerPrompt(pr.name, { title: pr.title, description: pr.description, argsSchema: pr.args }, (args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: pr.text(args || {}) } }],
    }));
  }
  server.server.oninitialized = () => {
    session.clientInfo = server.server.getClientVersion() || session.clientInfo;
    session.client = prettyClient(session.clientInfo);
    if (session.id) rememberSession(session);
    // health checks (`claude mcp list`, a client's "test connection") connect and leave within a second:
    // only announce the sessions that stay
    setTimeout(() => {
      if (session.closed || !sessions.has(session.id)) return;
      session.probe = false;
      emitSessions(true);
      bus.emit('toast', { level: 'success', message: tr(`${session.client} est connecté à AI.cut`, `${session.client} is connected to AI.cut`) });
    }, 2500).unref?.();
  };
  return server;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return undefined;
  return JSON.parse(s);
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function badOrigin(req) {
  const o = req.headers.origin;
  if (!o) return false;
  return !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) && !o.startsWith('aicut://');
}

let debugHandler = null;
/** Test hook (only installed when AICUT_DEBUG=1): handler(pathname, body) → data */
export function setDebugHandler(fn) { debugHandler = fn; }

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (badOrigin(req)) return json(res, 403, { error: 'origin not allowed' });
  if (debugHandler && url.pathname.startsWith('/debug/')) {
    try { return json(res, 200, { ok: true, data: await debugHandler(url.pathname.slice(7), req.method === 'POST' ? await readBody(req) : null) }); }
    catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (url.pathname === '/health' || url.pathname === '/') {
    return json(res, 200, { ok: true, app: 'AI.cut', version: VERSION, mcp: `/mcp`, project: store.project ? { name: store.project.name, file: store.file } : null, sessions: sessionsList().length, tools: TOOLS.length });
  }
  if (url.pathname === '/api/tools' && req.method === 'GET') {
    const { toJSONSchema } = z;
    return json(res, 200, TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: safeSchema(toJSONSchema, t.schema) })));
  }
  if (url.pathname.startsWith('/api/call/') && req.method === 'POST') {
    const name = decodeURIComponent(url.pathname.slice('/api/call/'.length));
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    try {
      const r = await callTool(name, body || {}, { client: String(req.headers['x-aicut-client'] || 'REST') });
      return json(res, 200, { ok: true, text: r.text, result: r.json, image: r.image || null });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }
  if (url.pathname !== '/mcp') return json(res, 404, { error: 'not found' });

  const sid = req.headers['mcp-session-id'];
  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); }
    if (isInitializeRequest(body)) { // a (re)connecting client: always a fresh session, even if it sends a stale id
      const session = await createSession({ clientInfo: body.params?.clientInfo });
      return session.transport.handleRequest(req, res, body);
    }
    if (!sid) return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' }, id: null });
    const s = sessions.get(sid) || await reviveSession(sid);
    s.lastSeen = Date.now();
    return s.transport.handleRequest(req, res, body);
  }
  if (req.method === 'GET') {
    if (!sid) return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' }, id: null });
    const s = sessions.get(sid) || await reviveSession(sid);
    s.lastSeen = Date.now();
    res.on('close', () => setTimeout(() => emitSessions(), 50)); // the client's event stream ended
    setTimeout(() => emitSessions(), 50);
    return s.transport.handleRequest(req, res);
  }
  if (req.method === 'DELETE') {
    const s = sid ? sessions.get(sid) : null;
    if (!s) { res.writeHead(200).end(); return undefined; } // already gone (e.g. AI.cut restarted): nothing to end
    return s.transport.handleRequest(req, res);
  }
  res.writeHead(405).end();
}

/** New MCP session (transport + server). With `id`, the session takes over an existing id (see reviveSession). */
async function createSession({ clientInfo = null, id = null } = {}) {
  const session = {
    id, clientInfo, client: prettyClient(clientInfo), connectedAt: Date.now(), lastActivity: Date.now(), lastSeen: Date.now(), calls: 0,
    probe: !id, closed: false,
  };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id || randomUUID(),
    onsessioninitialized: (sid) => { session.id = sid; sessions.set(sid, session); },
    onsessionclosed: (sid) => { session.closed = true; sessions.delete(sid); emitSessions(true); },
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${currentPort}`, `localhost:${currentPort}`, '127.0.0.1', 'localhost'],
  });
  transport.onclose = () => { session.closed = true; if (session.id && sessions.get(session.id) === session) { sessions.delete(session.id); emitSessions(true); } };
  session.transport = transport;
  const server = buildServer(session);
  session.server = server;
  await server.connect(transport);
  return session;
}

/**
 * A request for a session we do not know: AI.cut was restarted while the AI client kept running. Instead of
 * answering 404 (most clients then show the server as failed until the user reconnects it by hand), the session is
 * transparently re-created under the same id: the tools are stateless, nothing is lost.
 */
async function reviveSession(sid) {
  const prev = knownSessions()[sid];
  const session = await createSession({ clientInfo: prev?.clientInfo || null, id: sid });
  const t = session.transport._webStandardTransport;
  t.sessionId = sid;
  t._initialized = true;
  sessions.set(sid, session);
  if (prev?.clientInfo) session.client = prettyClient(prev.clientInfo);
  session.probe = false;
  log.info(`MCP session revived (${session.client})`, sid);
  emitSessions(true);
  return session;
}

function safeSchema(toJSONSchema, shape) {
  try { return toJSONSchema(z.object(shape)); } catch { return { type: 'object' }; }
}

export function startMcpServer(port) {
  return new Promise((resolve, reject) => {
    if (httpServer) { resolve(currentPort); return; }
    const srv = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        log.error('MCP http error', e);
        if (!res.headersSent) json(res, 500, { error: e.message });
      });
    });
    srv.on('error', (e) => {
      log.error('MCP server error', e.message);
      reject(e);
    });
    srv.listen(port, '127.0.0.1', () => {
      httpServer = srv;
      currentPort = port;
      log.info(`MCP server listening on http://127.0.0.1:${port}/mcp`);
      resolve(port);
    });
  });
}

export async function stopMcpServer() {
  const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.race([
    Promise.allSettled([...sessions.values()].map((s) => s.transport?.close())),
    timeout(800),
  ]);
  sessions.clear();
  const srv = httpServer;
  httpServer = null;
  if (!srv) return;
  // close() alone waits for every open connection to end — a connected AI client (Claude Code, Codex…) keeps its
  // stream open forever, which used to leave the app running invisibly after its window was closed
  await Promise.race([
    new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); }),
    timeout(1500),
  ]);
}

export const mcpStatus = () => ({ running: !!httpServer, port: currentPort, url: currentPort ? `http://127.0.0.1:${currentPort}/mcp` : null, sessions: sessionsList(), tools: TOOLS.length });
