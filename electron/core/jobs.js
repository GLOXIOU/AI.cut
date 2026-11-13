import { uid } from './util.js';
import { bus } from './bus.js';
import { log } from './log.js';

// 'ingest' = light per-file work (probe, thumbnail, keyframe filmstrip, waveform); 'video' = full decodes (proxy +
// shot detection) — one at a time: the GPU decoder / disk are the bottleneck, parallel passes only fight each other.
const QUEUE_LIMITS = { export: 1, transcribe: 1, ingest: 3, video: 1, render: 1, download: 3, analysis: 2, default: 4 };

class JobManager {
  constructor() {
    this.jobs = new Map();
    this.running = new Map(); // queue -> count
    this.pending = []; // jobs waiting for a slot
    this.lastEmit = new Map();
  }

  /**
   * Create & schedule a job. run(ctx) gets { job, progress(p, message), signal, setMeta }.
   * Returns the job record (live object). `job.promise` resolves with the result or rejects.
   */
  create(type, title, run, { queue = 'default', meta = {}, projectId = null } = {}) {
    const ctl = new AbortController();
    const job = {
      id: uid('job'),
      type, title, queue, projectId,
      status: 'queued', progress: 0, message: '',
      meta, result: null, error: null,
      createdAt: Date.now(), startedAt: null, endedAt: null,
    };
    Object.defineProperty(job, '_ctl', { value: ctl, enumerable: false });
    Object.defineProperty(job, '_run', { value: run, enumerable: false });
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {}); // avoid unhandled rejections for fire-and-forget jobs
    Object.defineProperty(job, 'promise', { value: promise, enumerable: false });
    Object.defineProperty(job, '_resolve', { value: resolve, enumerable: false });
    Object.defineProperty(job, '_reject', { value: reject, enumerable: false });
    this.jobs.set(job.id, job);
    this.pending.push(job);
    this.emit(job, true);
    this.pump();
    this.gc();
    return job;
  }

  pump() {
    for (let i = 0; i < this.pending.length; i++) {
      const job = this.pending[i];
      const limit = QUEUE_LIMITS[job.queue] ?? QUEUE_LIMITS.default;
      const n = this.running.get(job.queue) || 0;
      if (n >= limit) continue;
      this.pending.splice(i, 1); i--;
      this.running.set(job.queue, n + 1);
      this.start(job);
    }
  }

  async start(job) {
    if (job._ctl.signal.aborted) { this.finish(job, 'canceled'); return; }
    job.status = 'running';
    job.startedAt = Date.now();
    this.emit(job, true);
    const ctx = {
      job,
      signal: job._ctl.signal,
      progress: (p, message) => {
        if (typeof p === 'number' && Number.isFinite(p)) job.progress = Math.max(0, Math.min(1, p));
        if (message !== undefined) job.message = message;
        this.emit(job);
      },
      setMeta: (m) => { Object.assign(job.meta, m); this.emit(job); },
    };
    try {
      const result = await job._run(ctx);
      if (job._ctl.signal.aborted) return this.finish(job, 'canceled');
      job.result = result ?? null;
      job.progress = 1;
      this.finish(job, 'done');
    } catch (err) {
      if (job._ctl.signal.aborted) return this.finish(job, 'canceled');
      job.error = err?.message || String(err);
      log.error(`job ${job.type} failed:`, err);
      this.finish(job, 'error');
    }
  }

  finish(job, status) {
    if (job.endedAt) return;
    job.status = status;
    job.endedAt = Date.now();
    const n = this.running.get(job.queue) || 0;
    if (job.startedAt) this.running.set(job.queue, Math.max(0, n - 1));
    this.emit(job, true);
    if (status === 'done') job._resolve(job.result);
    else job._reject(new Error(status === 'canceled' ? 'Job canceled' : job.error || 'Job failed'));
    this.pump();
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.endedAt) return false;
    job._ctl.abort();
    const idx = this.pending.indexOf(job);
    if (idx >= 0) { this.pending.splice(idx, 1); this.finish(job, 'canceled'); }
    return true;
  }

  /** Cancel every unfinished job matching pred(job). Returns how many were canceled. */
  cancelWhere(pred) {
    let n = 0;
    for (const j of [...this.jobs.values()]) if (!j.endedAt && pred(j) && this.cancel(j.id)) n++;
    return n;
  }

  cancelAll() { return this.cancelWhere(() => true); }

  get(id) { return this.jobs.get(id) || null; }

  list({ active = false, type = null } = {}) {
    let arr = [...this.jobs.values()];
    if (active) arr = arr.filter((j) => !j.endedAt);
    if (type) arr = arr.filter((j) => j.type === type);
    return arr.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Wait until the job ends or timeout. Returns the job (status may still be running). */
  async wait(id, timeoutMs = 25000) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.endedAt) return job;
    await Promise.race([job.promise.catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))]);
    return job;
  }

  emit(job, force = false) {
    const now = Date.now();
    const last = this.lastEmit.get(job.id) || 0;
    if (!force && now - last < 200) return;
    this.lastEmit.set(job.id, now);
    bus.emit('jobs:update', snapshot(job));
  }

  gc() {
    if (this.jobs.size < 300) return;
    const done = [...this.jobs.values()].filter((j) => j.endedAt).sort((a, b) => a.endedAt - b.endedAt);
    for (const j of done.slice(0, done.length - 150)) { this.jobs.delete(j.id); this.lastEmit.delete(j.id); }
  }
}

export function snapshot(job) {
  if (!job) return null;
  const { id, type, title, status, progress, message, meta, result, error, createdAt, startedAt, endedAt, queue } = job;
  return { id, type, title, status, progress, message, meta, result, error, createdAt, startedAt, endedAt, queue };
}

export const jobs = new JobManager();
