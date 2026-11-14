// Runs inside an Electron utilityProcess: tracking jobs (decode + NCC + face re-anchoring) off the main process.
// in:  {type: 'track', id, opts}  |  {type: 'cancel', id}
// out: {type: 'progress', id, p}  |  {type: 'result', id, points}  |  {type: 'error', id, message}
import fs from 'node:fs';
import { trackCore } from './core.js';
import { parseCascade } from './haar.js';

const port = process.parentPort;
const running = new Map();
const cascades = new Map();
const loadCascade = (file) => {
  if (!file) return null;
  if (!cascades.has(file)) cascades.set(file, parseCascade(fs.readFileSync(file, 'utf8')));
  return cascades.get(file);
};

port.on('message', async (e) => {
  const msg = e.data || {};
  if (msg.type === 'cancel') { running.get(msg.id)?.abort(); return; }
  if (msg.type !== 'track') return;
  const ctl = new AbortController();
  running.set(msg.id, ctl);
  try {
    const o = msg.opts;
    const cas = o.face ? { front: loadCascade(o.cascades?.front), prof: loadCascade(o.cascades?.profile) } : null;
    let last = 0;
    const points = await trackCore({ ...o, cas, signal: ctl.signal, onProgress: (p) => { const now = Date.now(); if (now - last > 200) { last = now; port.postMessage({ type: 'progress', id: msg.id, p }); } } });
    port.postMessage({ type: 'result', id: msg.id, points });
  } catch (err) {
    port.postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  } finally {
    running.delete(msg.id);
  }
});
