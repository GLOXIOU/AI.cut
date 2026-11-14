import { create } from 'zustand';
import { defaultWorkspaces, defaultLayout, newWorkspace, normalize, PRESET_REV, upgradeLayout, panelsShown, setPanelsFolded, openPanel, closePanel, addPanelToLibrary, hasPanel, AI_PANELS } from './layout.js';

let toastId = 0;
export function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function localSet(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } }

// Workspaces (Premiere-style): each one is a complete, user-editable panel layout. Edits made while a workspace
// is active are kept in it; the six built-in ones can be renamed, deleted or reset, and new ones added.
const WS_KEY = 'aicut.workspaces.v1';
function loadWorkspaces() {
  try {
    const d = JSON.parse(localGet(WS_KEY) || 'null');
    if (Array.isArray(d?.list) && d.list.length) {
      const list = d.list.map((w) => {
        // a built-in layout that changed since it was saved is upgraded once (e.g. the richer "Editing" workspace)
        const rev = PRESET_REV[w.preset] || 1;
        if (w.preset && (w.rev || 1) < rev) return { ...w, rev, layout: normalize(upgradeLayout(w.preset, normalize(w.layout), w.rev || 1)) };
        return { ...w, layout: normalize(w.layout) };
      });
      return { workspaces: list, activeWs: list.some((w) => w.id === d.active) ? d.active : list[0].id };
    }
  } catch { /* corrupted → defaults */ }
  const list = defaultWorkspaces();
  return { workspaces: list, activeWs: list[0].id };
}
let saveTimer = null;
function saveWorkspaces(st) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localSet(WS_KEY, JSON.stringify({ active: st.activeWs, list: st.workspaces })), 250);
}
export const selectLayout = (s) => (s.workspaces.find((w) => w.id === s.activeWs) || s.workspaces[0]).layout;

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
  selectedTrack: null, // track shown in the inspector (mixer + effects)
  inPoint: null, // Premiere-style in / out points (timeline seconds)
  outPoint: null,
  hideProposals: false, // preview without the pending AI proposals
  selectedMedia: null,
  zoom: 70, // px / second
  tool: 'select',
  snapping: true,
  ...loadWorkspaces(),
  settingsTab: 'general', // 'general' | 'connect' | 'jobs' | 'activity'
  tour: null, // guided tour: { part: 'home' | 'editor', step }
  tourPending: false, // the home part was completed: the editor part starts when a project opens
  mediaView: localGet('aicut.mediaView') || 'grid',

  jobs: {},
  activity: [],
  sessions: [],
  copilot: null,
  toasts: [],
  dialog: null, // 'export' | 'settings' | null

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
    set({ selection: next, selectedCue: null, ...(next.length ? { selectedTrack: null } : {}) });
  },
  // ---- layout & workspaces
  setLayout(fn) {
    const st = get();
    const workspaces = st.workspaces.map((w) => (w.id === st.activeWs ? { ...w, layout: normalize(typeof fn === 'function' ? fn(w.layout) : fn) } : w));
    set({ workspaces });
    saveWorkspaces(get());
  },
  switchWorkspace(id) { if (get().workspaces.some((w) => w.id === id)) { set({ activeWs: id }); saveWorkspaces(get()); } },
  addWorkspace(name) {
    const w = newWorkspace(name, selectLayout(get()));
    set({ workspaces: [...get().workspaces, w], activeWs: w.id });
    saveWorkspaces(get());
    return w.id;
  },
  duplicateWorkspace(id, name) {
    const src = get().workspaces.find((w) => w.id === id);
    if (!src) return null;
    const w = newWorkspace(name, src.layout);
    const list = [...get().workspaces];
    list.splice(list.indexOf(src) + 1, 0, w);
    set({ workspaces: list, activeWs: w.id });
    saveWorkspaces(get());
    return w.id;
  },
  renameWorkspace(id, name) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return;
    set({ workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, name: n } : w)) });
    saveWorkspaces(get());
  },
  deleteWorkspace(id) {
    const list = get().workspaces;
    if (list.length <= 1) return;
    const i = list.findIndex((w) => w.id === id);
    const rest = list.filter((w) => w.id !== id);
    set({ workspaces: rest, activeWs: get().activeWs === id ? rest[Math.max(0, i - 1)].id : get().activeWs });
    saveWorkspaces(get());
  },
  resetWorkspace(id) {
    set({ workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, rev: PRESET_REV[w.preset] || w.rev, layout: normalize(w.preset ? defaultLayout(w.preset) : w.base || w.layout) } : w)) });
    saveWorkspaces(get());
  },
  /** Brings a panel to the front wherever it is docked (docking it if the current layout does not have it). */
  focusPanel(panel) {
    const L = selectLayout(get());
    get().setLayout(hasPanel(L, panel) ? openPanel(L, panel) : AI_PANELS.includes(panel) ? openPanel(L, panel, { with: AI_PANELS }) : addPanelToLibrary(L, panel));
  },
  closePanel(panel) { get().setLayout((L) => closePanel(L, panel)); },
  /** Top-bar AI button: shows / hides the AI panels (chat, ideas, style). */
  toggleAi() {
    const L = selectLayout(get());
    const { docked, open } = panelsShown(L, AI_PANELS);
    // docked: fold / unfold in place (the AI keeps its spot in the layout); not docked: dock it on the right
    if (docked) get().setLayout(setPanelsFolded(L, AI_PANELS, open));
    else get().setLayout(openPanel(L, 'chat', { with: AI_PANELS }));
  },
  openSettings(tab = 'general') { set({ dialog: 'settings', settingsTab: tab }); },
  startTour(part) { set({ tour: { part, step: 0 }, tourPending: false }); },
  endTour(continueInEditor = false) { set({ tour: null, tourPending: !!continueInEditor }); },
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
