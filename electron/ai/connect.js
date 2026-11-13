// One-click connection of external AI clients (Claude Code, Codex, Claude Desktop, Cursor, Gemini CLI, VS Code).
import { app, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIN_SCRIPTS_DIR } from '../core/paths.js';
import { which, exists, readJson } from '../core/util.js';
import { log } from '../core/log.js';
import { mcpUrl } from '../services.js';
import { store } from '../project/store.js';
import { tr } from '../core/settings.js';

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, process.platform === 'darwin' ? 'Library/Application Support' : '.config');

/** stdio command for clients that need a local process (bridge to the HTTP server). */
export function stdioCommand() {
  const script = path.join(BIN_SCRIPTS_DIR, 'aicut-mcp.cjs');
  const node = which('node');
  if (node && !app.isPackaged) return { command: node, args: [script], env: {} };
  if (node) return { command: node, args: [script], env: {} };
  return { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

const CLIENTS = {
  'claude-code': { label: 'Claude Code', kind: 'cli' },
  codex: { label: 'Codex CLI', kind: 'cli' },
  'claude-desktop': { label: 'Claude Desktop', kind: 'app' },
  cursor: { label: 'Cursor', kind: 'app' },
  gemini: { label: 'Gemini CLI', kind: 'cli' },
  vscode: { label: 'VS Code (Copilot)', kind: 'app' },
};

function claudeDesktopConfig() {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(appData, 'Claude', 'claude_desktop_config.json');
}
const codexConfig = () => path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
const cursorConfig = () => path.join(home, '.cursor', 'mcp.json');
const geminiConfig = () => path.join(home, '.gemini', 'settings.json');
const vscodeConfig = () => (process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json') : path.join(appData, 'Code', 'User', 'mcp.json'));

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, shell: false, ...opts });
    let out = '', err = '';
    p.stdout?.on('data', (d) => { out += d; });
    p.stderr?.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

function upsertJson(file, mutate) {
  let data = readJson(file, {}) || {};
  if (exists(file) && !data) throw new Error(`${file} is not valid JSON — fix it first.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists(file)) fs.copyFileSync(file, `${file}.aicut-backup`);
  data = mutate(data) || data;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const tomlStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function upsertTomlSection(file, header, body) {
  let txt = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  if (exists(file)) fs.copyFileSync(file, `${file}.aicut-backup`);
  const lines = txt.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${header}]`);
  const block = [`[${header}]`, ...body];
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    // also drop sub-tables like [mcp_servers.aicut.env]
    while (end < lines.length && lines[end].trim().startsWith(`[${header}.`)) {
      end++;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    }
    lines.splice(start, end - start, ...block, '');
    txt = lines.join('\n');
  } else {
    txt = `${txt.replace(/\s*$/, '')}${txt.trim() ? '\n\n' : ''}${block.join('\n')}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, txt);
}

/** Is "aicut" configured in Claude Code (user scope, local scope of the project folder, or the project's .mcp.json)? */
function claudeCodeHasAicut() {
  const cfg = readJson(path.join(home, '.claude.json'), null);
  if (cfg?.mcpServers?.aicut) return true;
  const dir = store.dir ? path.resolve(store.dir) : null;
  if (dir && cfg?.projects) {
    for (const [k, v] of Object.entries(cfg.projects)) if (path.resolve(k).toLowerCase() === dir.toLowerCase() && v?.mcpServers?.aicut) return true;
  }
  if (dir && readJson(path.join(dir, '.mcp.json'), null)?.mcpServers?.aicut) return true;
  return false;
}

export async function clientStatus() {
  const url = mcpUrl();
  const claude = which('claude');
  const codex = which('codex');
  const gemini = which('gemini');
  const out = [];
  // read Claude Code's config instead of running `claude mcp get`: that command health-checks the server, i.e. opens
  // and closes a real MCP session — the editor then showed "Claude Code connected" / gone every time this ran
  const claudeConnected = claudeCodeHasAicut();
  out.push({ id: 'claude-code', ...CLIENTS['claude-code'], installed: !!claude, connected: claudeConnected, path: claude });
  const codexTxt = exists(codexConfig()) ? fs.readFileSync(codexConfig(), 'utf8') : '';
  out.push({ id: 'codex', ...CLIENTS.codex, installed: !!codex, connected: /\[mcp_servers\.aicut\]/.test(codexTxt), path: codex });
  const cd = readJson(claudeDesktopConfig(), null);
  out.push({ id: 'claude-desktop', ...CLIENTS['claude-desktop'], installed: exists(path.dirname(claudeDesktopConfig())), connected: !!cd?.mcpServers?.aicut });
  const cu = readJson(cursorConfig(), null);
  out.push({ id: 'cursor', ...CLIENTS.cursor, installed: exists(path.join(home, '.cursor')), connected: !!cu?.mcpServers?.aicut });
  const ge = readJson(geminiConfig(), null);
  out.push({ id: 'gemini', ...CLIENTS.gemini, installed: !!gemini || exists(path.join(home, '.gemini')), connected: !!ge?.mcpServers?.aicut });
  const vs = readJson(vscodeConfig(), null);
  out.push({ id: 'vscode', ...CLIENTS.vscode, installed: exists(path.dirname(vscodeConfig())), connected: !!vs?.servers?.aicut });
  return { url, clients: out };
}

/** Configure a client to use the AI.cut MCP server. */
export async function connectClient(id) {
  const url = mcpUrl();
  const stdio = stdioCommand();
  switch (id) {
    case 'claude-code': {
      const claude = which('claude');
      if (!claude) throw new Error(tr('Claude Code introuvable. Installe-le : npm install -g @anthropic-ai/claude-code (ou voir claude.com/claude-code).', 'Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code (or see claude.com/claude-code).'));
      await run(claude, ['mcp', 'remove', 'aicut', '-s', 'user']);
      const r = await run(claude, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'aicut', url]);
      if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.err || r.out).trim()}`);
      return { ok: true, message: tr('Claude Code : serveur "aicut" ajouté (scope user). Lance `claude` et demande ton montage !', 'Claude Code: "aicut" server added (user scope). Run `claude` and ask for your edit!') };
    }
    case 'codex': {
      const body = [`command = ${tomlStr(stdio.command)}`, `args = [${stdio.args.map(tomlStr).join(', ')}]`, 'startup_timeout_sec = 20', 'tool_timeout_sec = 120'];
      if (Object.keys(stdio.env).length) body.push(`env = { ${Object.entries(stdio.env).map(([k, v]) => `${k} = ${tomlStr(v)}`).join(', ')} }`);
      upsertTomlSection(codexConfig(), 'mcp_servers.aicut', body);
      return { ok: true, message: tr(`Codex : [mcp_servers.aicut] écrit dans ${codexConfig()}. Relance codex.`, `Codex: [mcp_servers.aicut] written to ${codexConfig()}. Restart codex.`) };
    }
    case 'claude-desktop': {
      upsertJson(claudeDesktopConfig(), (d) => { d.mcpServers = { ...(d.mcpServers || {}), aicut: { command: stdio.command, args: stdio.args, ...(Object.keys(stdio.env).length ? { env: stdio.env } : {}) } }; return d; });
      return { ok: true, message: tr('Claude Desktop configuré. Quitte complètement Claude Desktop puis relance-le.', 'Claude Desktop configured. Fully quit Claude Desktop, then restart it.') };
    }
    case 'cursor': {
      upsertJson(cursorConfig(), (d) => { d.mcpServers = { ...(d.mcpServers || {}), aicut: { url } }; return d; });
      return { ok: true, message: tr('Cursor configuré (~/.cursor/mcp.json).', 'Cursor configured (~/.cursor/mcp.json).') };
    }
    case 'gemini': {
      upsertJson(geminiConfig(), (d) => { d.mcpServers = { ...(d.mcpServers || {}), aicut: { httpUrl: url, timeout: 120000 } }; return d; });
      return { ok: true, message: tr('Gemini CLI configuré (~/.gemini/settings.json).', 'Gemini CLI configured (~/.gemini/settings.json).') };
    }
    case 'vscode': {
      upsertJson(vscodeConfig(), (d) => { d.servers = { ...(d.servers || {}), aicut: { type: 'http', url } }; return d; });
      return { ok: true, message: tr('VS Code configuré (mcp.json utilisateur).', 'VS Code configured (user mcp.json).') };
    }
    default: throw new Error(`Unknown client ${id}`);
  }
}

export async function disconnectClient(id) {
  switch (id) {
    case 'claude-code': { const c = which('claude'); if (c) await run(c, ['mcp', 'remove', 'aicut', '-s', 'user']); break; }
    case 'codex': {
      const f = codexConfig();
      if (exists(f)) {
        const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
        const s = lines.findIndex((l) => l.trim() === '[mcp_servers.aicut]');
        if (s >= 0) { let e = s + 1; while (e < lines.length && !/^\s*\[/.test(lines[e])) e++; lines.splice(s, e - s); fs.writeFileSync(f, lines.join('\n')); }
      }
      break;
    }
    case 'claude-desktop': upsertJson(claudeDesktopConfig(), (d) => { if (d.mcpServers) delete d.mcpServers.aicut; return d; }); break;
    case 'cursor': upsertJson(cursorConfig(), (d) => { if (d.mcpServers) delete d.mcpServers.aicut; return d; }); break;
    case 'gemini': upsertJson(geminiConfig(), (d) => { if (d.mcpServers) delete d.mcpServers.aicut; return d; }); break;
    case 'vscode': upsertJson(vscodeConfig(), (d) => { if (d.servers) delete d.servers.aicut; return d; }); break;
    default: break;
  }
  return { ok: true };
}

/** Manual configuration snippets. */
export function configSnippets() {
  const url = mcpUrl();
  const st = stdioCommand();
  const stdioJson = { command: st.command, args: st.args, ...(Object.keys(st.env).length ? { env: st.env } : {}) };
  return {
    url,
    claudeCode: `claude mcp add --scope user --transport http aicut ${url}`,
    codex: `[mcp_servers.aicut]\ncommand = ${tomlStr(st.command)}\nargs = [${st.args.map(tomlStr).join(', ')}]\ntool_timeout_sec = 120${Object.keys(st.env).length ? `\nenv = { ${Object.entries(st.env).map(([k, v]) => `${k} = ${tomlStr(v)}`).join(', ')} }` : ''}`,
    codexHttp: `[mcp_servers.aicut]\nurl = "${url}"`,
    claudeDesktop: JSON.stringify({ mcpServers: { aicut: stdioJson } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { aicut: { url } } }, null, 2),
    gemini: JSON.stringify({ mcpServers: { aicut: { httpUrl: url } } }, null, 2),
    generic: JSON.stringify({ mcpServers: { aicut: { type: 'http', url } } }, null, 2),
    rest: `node "${path.join(BIN_SCRIPTS_DIR, 'aicut.cjs')}" call get_project`,
  };
}

/** Open a terminal in the project folder running the AI CLI (claude / codex / gemini). */
export async function openTerminal(cli = 'claude') {
  const dir = store.dir || home;
  const exe = which(cli);
  if (!exe) throw new Error(`${cli} not found on PATH.`);
  if (process.platform === 'win32') {
    const wt = which('wt');
    if (wt) spawn(wt, ['-d', dir, 'cmd', '/k', cli], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd.exe', ['/c', 'start', '"AI.cut"', 'cmd', '/k', `cd /d "${dir}" && ${cli}`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "cd ${JSON.stringify(dir)} && ${cli}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const term = which('x-terminal-emulator') || which('gnome-terminal') || which('konsole') || which('xterm');
    if (!term) throw new Error('No terminal emulator found');
    spawn(term, ['-e', `bash -lc 'cd "${dir}" && ${cli}; exec bash'`], { detached: true, stdio: 'ignore' }).unref();
  }
  log.info('opened terminal', cli, dir);
  return { ok: true, dir };
}

export function openUrl(u) { return shell.openExternal(u); }
