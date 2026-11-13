import { create } from 'zustand';

let toastId = 0;
export function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function localSet(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } }

/** Workspaces (Premiere-style): each one arranges the panels for a task. */
export const WORKSPACES = [
  { id: 'edit', fr: 'Montage', en: 'Editing', left: 'media', right: 'inspector' },
  { id: 'text', fr: 'Texte', en: 'Text', left: 'transcript', right: 'inspector' },
  { id: 'effects', fr: 'Effets', en: 'Effects', left: 'motion', right: 'inspector' },
  { id: 'captions', fr: 'Sous-titres', en: 'Captions', left: 'subtitles', right: 'inspector' },
  { id: 'audio', fr: 'Audio', en: 'Audio', left: 'audio', right: 'inspector' },
  { id: 'auto', fr: 'Auto', en: 'Auto', left: 'auto', right: 'inspector' },
  { id: 'ai', fr: 'IA', en: 'AI', left: 'media', right: 'ai' },
];

export const useStore = create((set, get) => ({
  info: null,
  settings: null,
  // interface language until the main process answers (French locale → 'fr', anything else → English)
  lang: (() => { try { return String(navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en'; } catch { return 'en'; } })(),

  project: null,
  file: null,
  dir: null,
  rev: 0,
  canUndo: false,
  canRedo: false,
  lastMeta: null,
  aiFlash: {}, // clipId -> timestamp (recently changed by AI)

  selection: [],
  selectedCue: null,
  selectedMedia: null,
  zoom: 70, // px / second
  tool: 'select',
  snapping: true,
  leftTab: 'media',
  rightTab: 'inspector',
  workspace: 'edit',
  timelineHeight: Number(localGet('aicut.timelineHeight')) || 320,
  leftWidth: Number(localGet('aicut.leftWidth')) || 330,
  rightWidth: Number(localGet('aicut.rightWidth')) || 340,
  mediaView: localGet('aicut.mediaView') || 'grid',

  jobs: {},
  activity: [],
  sessions: [],
  copilot: null,
  toasts: [],
  dialog: null, // 'export' | 'settings' | 'connect' | null

  setProject(payload) {
    const prev = get().project;
    const project = payload.project;
    const meta = payload.meta || {};
    let aiFlash = get().aiFlash;
    if (project && prev && meta.source === 'ai') {
      const before = new Map(prev.clips.map((c) => [c.id, JSON.stringify(c)]));
      const now = Date.now();
      aiFlash = { ...aiFlash };
      for (const c of project.clips) if (before.get(c.id) !== JSON.stringify(c)) aiFlash[c.id] = now;
    }
    const sel = project ? get().selection.filter((id) => project.clips.some((c) => c.id === id)) : [];
    set({
      project, file: payload.file ?? get().file, dir: payload.dir ?? get().dir, rev: meta.rev ?? get().rev + 1,
      canUndo: meta.canUndo ?? get().canUndo, canRedo: meta.canRedo ?? get().canRedo, lastMeta: meta, aiFlash, selection: sel,
    });
  },
  select(ids, mode = 'set') {
    const cur = get().selection;
    let next;
    if (mode === 'toggle') next = ids.reduce((acc, id) => (acc.includes(id) ? acc.filter((x) => x !== id) : [...acc, id]), cur);
    else if (mode === 'add') next = [...new Set([...cur, ...ids])];
    else next = ids;
    set({ selection: next, selectedCue: null });
  },
  setJob(job) { set({ jobs: { ...get().jobs, [job.id]: job } }); },
  pushActivity(a) {
    const list = get().activity.filter((x) => x.id !== a.id);
    list.push(a);
    set({ activity: list.slice(-150) });
  },
  toast(level, message, extra = {}) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, level, message, ...extra }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), level === 'error' ? 9000 : 5000);
  },
  dismissToast(id) { set({ toasts: get().toasts.filter((t) => t.id !== id) }); },
}));
