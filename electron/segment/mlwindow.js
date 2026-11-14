// ONNX models. Person matting (RVM) runs in a hidden window with ONNX Runtime Web on WebGPU (fast there: ~80 ms/frame).
// Object segmentation (MobileSAM) and voice / music separation (MDX-Net) run in a utility process with native ONNX
// Runtime (ml-worker.js): measured on an RTX 2070, WebGPU needed 80-120 s per SAM frame and ~20 s per MDX chunk,
// native DirectML / CPU 0.2 s and 4 s.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ipcMain, utilityProcess } from 'electron';
import { modelsDir } from '../core/paths.js';
import { download, exists, uid } from '../core/util.js';
import { log } from '../core/log.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const MODELS = {
  rvm: { url: 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx', file: 'rvm_mobilenetv3_fp32.onnx', size: 14975696 },
  samEncoder: { url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx', file: 'mobile_sam_image_encoder.onnx', size: 28157093 },
  samDecoder: { url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_multi.onnx', file: 'sam_mask_decoder_multi.onnx', size: 16496559 },
  mdx: { url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx', file: 'Kim_Vocal_2.onnx', size: 66759214 },
};

export const modelFile = (key) => path.join(modelsDir(), MODELS[key].file);
export function modelReady(key) {
  const f = modelFile(key);
  return exists(f) && fs.statSync(f).size >= MODELS[key].size * 0.99;
}

/** Download a model on first use. */
export async function ensureModel(key, onProgress, signal) {
  const f = modelFile(key);
  if (modelReady(key)) return f;
  log.info('downloading model', MODELS[key].url);
  await download(MODELS[key].url, `${f}.part`, { onProgress, signal });
  fs.renameSync(`${f}.part`, f);
  return f;
}

export class MLWindow {
  async open() {
    this.win = new BrowserWindow({
      show: false, width: 320, height: 240,
      webPreferences: { preload: path.join(here, 'seg-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, sandbox: false },
    });
    this.pending = new Map();
    this.onRes = (e, msg) => {
      if (e.sender !== this.win?.webContents) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
    };
    ipcMain.on('seg:res', this.onRes);
    const ready = new Promise((resolve) => {
      this.onReady = (e) => { if (e.sender === this.win?.webContents) resolve(); };
      ipcMain.on('seg:ready', this.onReady);
    });
    this.win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning' || e.level === 3 || e.level === 2) log.warn('[ml page]', String(e.message).slice(0, 400)); });
    const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`ML page: ${what} (timeout)`)), ms));
    await Promise.race([this.win.loadURL('aicut://res/runtime/segment.html'), timeout(30000, 'load')]);
    await Promise.race([ready, timeout(30000, 'start')]);
  }

  request(type, data, timeoutMs = 0) {
    const id = uid('ml', 8);
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.win.webContents.send('seg:req', { id, type, data });
    });
    if (!timeoutMs) return p;
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${type}: timeout`)), timeoutMs))]);
  }

  close() {
    ipcMain.removeListener('seg:res', this.onRes);
    ipcMain.removeListener('seg:ready', this.onReady);
    for (const p of this.pending.values()) p.reject(new Error('closed'));
    this.pending.clear();
    try { this.win?.destroy(); } catch { /* */ }
    this.win = null;
  }
}

/** Utility process with native ONNX Runtime (ml-worker.js). Same request / close API as MLWindow. */
export class NativeML {
  async open() {
    this.pending = new Map();
    this.proc = utilityProcess.fork(path.join(here, 'ml-worker.js'), [], { serviceName: 'AI.cut ML', stdio: 'pipe' });
    this.proc.stderr?.on('data', (d) => { const s = String(d).trim(); if (s && !/VerifyEachNodeIsAssignedToAnEp|Rerunning with verbose/.test(s)) log.warn('[ml worker]', s.slice(0, 400)); });
    this.proc.on('message', (msg) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
    });
    this.proc.on('exit', (code) => { for (const p of this.pending.values()) p.reject(new Error(`ML worker stopped (${code})`)); this.pending.clear(); this.proc = null; });
  }
  request(type, data, timeoutMs = 0) {
    const id = uid('nm', 8);
    const p = new Promise((resolve, reject) => {
      if (!this.proc) { reject(new Error('ML worker not running')); return; }
      this.pending.set(id, { resolve, reject });
      this.proc.postMessage({ id, type, data });
    });
    if (!timeoutMs) return p;
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${type}: timeout`)), timeoutMs))]);
  }
  close() { try { this.proc?.kill(); } catch { /* */ } this.proc = null; }
}
