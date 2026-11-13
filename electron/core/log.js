import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from './paths.js';

let stream = null;
let file = null;

function open() {
  if (stream) return;
  try {
    file = path.join(logsDir(), 'main.log');
    try {
      const st = fs.statSync(file);
      if (st.size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
    } catch { /* new file */ }
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch {
    stream = null;
  }
}

function write(level, args) {
  const msg = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'object' ? safeJson(a) : String(a))).join(' ');
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'error') console.error(line); else if (process.env.AICUT_VERBOSE || level !== 'debug') console.log(line);
  open();
  try { stream?.write(line + '\n'); } catch { /* ignore */ }
}

function safeJson(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
}

export const log = {
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  debug: (...a) => write('debug', a),
  file: () => file,
};
