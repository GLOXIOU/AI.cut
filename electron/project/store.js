// Project store: single source of truth for the open project (UI and AI both edit through it).
import fs from 'node:fs';
import path from 'node:path';
import { bus } from '../core/bus.js';
import { log } from '../core/log.js';
import { readJson, writeJsonAsync, writeJson, debounce, safeFileName, uniquePath, exists } from '../core/util.js';
import { addRecentProject } from '../core/settings.js';
import { createProject, normalizeProject } from './schema.js';
import { OPS, OpError } from './ops.js';
import { getTemplate } from '../render/html.js';
import { currentCall } from '../core/callctx.js';
import { recordProposalDiff } from '../../shared/proposals.js';

const HISTORY_LIMIT = 200;
export const PROJECT_EXT = '.aicut';

class ProjectStore {
  constructor() {
    this.project = null;
    this.file = null;
    this.dir = null;
    this.history = [];
    this.future = [];
    this.derived = new Map();
    this.rev = 0;
    this.savedRev = 0;
    this.saveSoon = debounce(() => this.save().catch((e) => log.error('autosave failed', e)), 800);
  }

  get isOpen() { return !!this.project; }

  /** Create a new project folder + file. */
  create({ name = 'Untitled', parentDir, preset = '1080p', fps = 60 }) {
    const folderName = safeFileName(name, 60);
    const dir = uniquePath(path.join(parentDir, folderName));
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.aicut-cache'), { recursive: true });
    const project = createProject({ name, preset, fps });
    const file = path.join(dir, `${folderName}${PROJECT_EXT}`);
    writeJson(file, project);
    return this.open(file);
  }

  open(file) {
    const data = readJson(file);
    if (!data || !data.settings) throw new Error(`Not a valid AI.cut project: ${file}`);
    this.project = normalizeProject(data);
    this.file = file;
    this.dir = path.dirname(file);
    this.history = [];
    this.future = [];
    this.derived.clear();
    for (const m of this.project.media) {
      m.offline = !!(m.path && !exists(m.path));
    }
    this.rev++;
    this.savedRev = this.rev;
    addRecentProject(file, this.project.name);
    bus.emit('project:opened', this.project);
    this.emitChange({ label: 'open', source: 'system' });
    return this.project;
  }

  close() {
    if (!this.project) return;
    try { this.saveSync(); } catch (e) { log.error('save on close failed', e); }
    const closed = { id: this.project.id, file: this.file, dir: this.dir };
    this.project = null;
    this.file = null;
    this.dir = null;
    this.history = [];
    this.future = [];
    bus.emit('project:closed', closed);
  }

  async save() {
    if (!this.project || !this.file) return;
    if (this.savedRev === this.rev) return;
    const rev = this.rev;
    this.project.updatedAt = new Date().toISOString();
    await writeJsonAsync(this.file, this.project);
    this.savedRev = rev;
    bus.emit('project:saved', { rev });
  }

  saveSync() {
    if (!this.project || !this.file || this.savedRev === this.rev) return;
    this.project.updatedAt = new Date().toISOString();
    writeJson(this.file, this.project);
    this.savedRev = this.rev;
  }

  requireOpen() {
    if (!this.project) throw new OpError('No project is open. Create or open a project first (create_project / open_project).');
    return this.project;
  }

  makeCtx(warnings) {
    return {
      warn: (m) => warnings.push(m),
      template: (id) => getTemplate(id),
    };
  }

  /** Apply a named op as one undoable step. */
  apply(name, args = {}, meta = {}) {
    const op = OPS[name];
    if (!op) throw new OpError(`Unknown operation ${name}`);
    return this.transaction(meta.label || name, (draft, ctx) => op(draft, args, ctx), meta);
  }

  /** Run several mutations atomically as one undo step. fn(draft, ctx) */
  transaction(label, fn, meta = {}) {
    this.requireOpen();
    const before = structuredClone(this.project);
    const draft = structuredClone(this.project);
    const warnings = [];
    const ctx = this.makeCtx(warnings);
    const result = fn(draft, ctx);
    normalizeProject(draft);
    // an AI session recording a proposal: every change it makes belongs to that proposal (accept / reject later)
    const call = currentCall();
    if (call?.proposal && !meta.noProposal) {
      const prop = draft.proposals.find((x) => x.id === call.proposal && x.status === 'recording');
      if (prop) recordProposalDiff(prop, before.clips, draft.clips);
    }
    this.history.push({ label, source: meta.source || 'ui', client: meta.client || null, at: Date.now(), snapshot: before });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.project = draft;
    this.reapplyDerived();
    this.rev++;
    this.emitChange({ label, source: meta.source || 'ui', client: meta.client || null });
    this.saveSoon();
    return { result, warnings };
  }

  /** Non-undoable mutation (derived/system data such as ingest results). */
  mutateSilently(fn) {
    if (!this.project) return;
    fn(this.project);
    this.rev++;
    this.emitChange({ label: 'system', source: 'system', silent: true });
    this.saveSoon();
  }

  /** Derived media data (thumbnails, peaks, proxies, analysis status) survives undo/redo. */
  setDerived(mediaId, patch) {
    const cur = { ...(this.derived.get(mediaId) || {}), ...patch };
    this.derived.set(mediaId, cur);
    this.mutateSilently((p) => {
      const m = p.media.find((x) => x.id === mediaId);
      if (m) Object.assign(m, patch);
    });
  }

  reapplyDerived() {
    for (const m of this.project.media) {
      const d = this.derived.get(m.id);
      if (d) Object.assign(m, d);
    }
  }

  canUndo() { return this.history.length > 0; }
  canRedo() { return this.future.length > 0; }

  undo() {
    const h = this.history.pop();
    if (!h) return null;
    this.future.push({ ...h, snapshot: structuredClone(this.project) });
    this.project = h.snapshot;
    this.reapplyDerived();
    this.rev++;
    this.emitChange({ label: `undo ${h.label}`, source: 'ui', undo: true });
    this.saveSoon();
    return h.label;
  }

  redo() {
    const f = this.future.pop();
    if (!f) return null;
    this.history.push({ ...f, snapshot: structuredClone(this.project) });
    this.project = f.snapshot;
    this.reapplyDerived();
    this.rev++;
    this.emitChange({ label: `redo ${f.label}`, source: 'ui', redo: true });
    this.saveSoon();
    return f.label;
  }

  historyList() {
    return this.history.map((h, i) => ({ index: i, label: h.label, source: h.source, client: h.client, at: h.at })).reverse();
  }

  /** Undo every step after history index (inclusive) — e.g. "revert all AI changes since X". */
  revertTo(index) {
    let n = 0;
    while (this.history.length > index) { this.undo(); n++; }
    return n;
  }

  // ---- checkpoints (named versions) ----
  checkpointsDir() { return path.join(this.dir, '.aicut-cache', 'checkpoints'); }
  createCheckpoint(name) {
    this.requireOpen();
    const id = `${Date.now()}`;
    const file = path.join(this.checkpointsDir(), `${id}.json`);
    writeJson(file, { id, name: name || new Date().toLocaleString(), at: Date.now(), project: this.project }, false);
    return { id, name };
  }
  listCheckpoints() {
    if (!this.dir) return [];
    try {
      return fs.readdirSync(this.checkpointsDir()).filter((f) => f.endsWith('.json')).map((f) => {
        const d = readJson(path.join(this.checkpointsDir(), f), {});
        return { id: d.id, name: d.name, at: d.at, clips: d.project?.clips?.length || 0 };
      }).sort((a, b) => b.at - a.at);
    } catch { return []; }
  }
  restoreCheckpoint(id, meta = {}) {
    const d = readJson(path.join(this.checkpointsDir(), `${id}.json`));
    if (!d?.project) throw new OpError(`Unknown checkpoint ${id}`);
    return this.transaction(`restore checkpoint ${d.name}`, (draft) => {
      const keepMedia = draft.media;
      Object.keys(draft).forEach((k) => delete draft[k]);
      Object.assign(draft, structuredClone(d.project));
      // keep media imported after the checkpoint
      for (const m of keepMedia) if (!draft.media.some((x) => x.id === m.id)) draft.media.push(m);
      return { restored: d.name };
    }, meta);
  }

  emitChange(meta) {
    bus.emit('project:changed', this.project, { rev: this.rev, canUndo: this.canUndo(), canRedo: this.canRedo(), ...meta });
  }

  /** Paths the protocol may serve: media, project folder. */
  isAllowedPath(abs) {
    if (!this.project) return false;
    const norm = path.normalize(abs).toLowerCase();
    if (this.dir && norm.startsWith(path.normalize(this.dir).toLowerCase())) return true;
    return this.project.media.some((m) => (m.path && path.normalize(m.path).toLowerCase() === norm) || (m.proxy && path.normalize(m.proxy).toLowerCase() === norm)
      // imported HTML animations may load the assets sitting next to them
      || ((m.type === 'html' || m.type === 'lottie') && m.path && norm.startsWith(path.normalize(path.dirname(m.path)).toLowerCase() + path.sep)));
  }

  cacheDir(...p) {
    const d = path.join(this.dir, '.aicut-cache', ...p);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

export const store = new ProjectStore();
