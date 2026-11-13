// Runs inside an Electron utilityProcess: keeps a whisper.cpp context warm and transcribes WAV files.
// Messages in:  {type:'transcribe', id, model, variant, file, language, threads}
// Messages out: {type:'progress', id, p} | {type:'result', id, result} | {type:'error', id, message}
import { initWhisper } from '@fugood/whisper.node';

let ctx = null;
let ctxKey = null;
let busy = false;

async function getContext(model, variant) {
  const key = `${model}|${variant}`;
  if (ctx && ctxKey === key) return ctx;
  if (ctx) { try { await ctx.release(); } catch { /* ignore */ } ctx = null; }
  ctx = await initWhisper({ filePath: model, useGpu: variant !== 'default' }, variant);
  ctxKey = key;
  return ctx;
}

const port = process.parentPort;
port.on('message', async (e) => {
  const msg = e.data;
  if (msg.type === 'ping') { port.postMessage({ type: 'pong' }); return; }
  if (msg.type !== 'transcribe') return;
  if (busy) { port.postMessage({ type: 'error', id: msg.id, message: 'busy' }); return; }
  busy = true;
  try {
    const t0 = Date.now();
    const c = await getContext(msg.model, msg.variant || 'default');
    const tInit = Date.now() - t0;
    const opts = {
      maxLen: 1, tokenTimestamps: true, temperatureInc: 0.2, maxThreads: msg.threads || 6,
      onProgress: (p) => port.postMessage({ type: 'progress', id: msg.id, p: p / 100 }),
    };
    if (msg.language && msg.language !== 'auto') opts.language = msg.language;
    else opts.language = 'auto';
    if (msg.prompt) opts.prompt = msg.prompt;
    const { promise } = c.transcribeFile(msg.file, opts);
    const res = await promise;
    port.postMessage({ type: 'result', id: msg.id, result: { ...res, initMs: tInit, ms: Date.now() - t0 } });
  } catch (err) {
    port.postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
    try { await ctx?.release(); } catch { /* ignore */ }
    ctx = null; ctxKey = null;
  } finally {
    busy = false;
  }
});
port.postMessage({ type: 'ready' });
