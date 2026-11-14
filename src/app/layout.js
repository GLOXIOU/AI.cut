// Panel layout model (Premiere-style workspaces). Pure data + immutable helpers, no React.
//
// layout = { timeline: <px>, cols: [ { id, w, groups: [ { id, tabs: [panelId…], active, min, h } ] } ] }
//  - the upper area is a row of columns; each column stacks one or more tab groups vertically;
//  - the column holding the program monitor ('player') is the flexible one, the others keep their width w;
//  - a minimised group shows only its tab bar; a column whose groups are all minimised becomes a thin strip;
//  - the timeline stays full width at the bottom (its height is part of the layout).

export const LIBRARY = ['media', 'transcript', 'motion', 'audio', 'memes', 'subtitles', 'auto', 'youtube'];
export const TOOLS = ['tracking', 'blur', 'mask', 'color', 'cutout', 'videotools', 'animation', 'audiofx'];
export const AI_PANELS = ['chat', 'ideas', 'style'];
export const ALL_PANELS = [...LIBRARY, 'inspector', ...TOOLS, ...AI_PANELS, 'player'];

export const COL_MIN = 220; // narrowest a docked column gets when the window is small
export const PLAYER_MIN = 300;
export const STRIP_W = 34; // width of a minimised column
export const GROUP_MIN_H = 110;

let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const grp = (tabs, extra = {}) => ({ id: uid('g'), tabs, active: tabs[0], min: false, h: 1, ...extra });
const col = (w, ...groups) => ({ id: uid('c'), w, groups });
const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

/** Built-in arrangements, one per default workspace. */
export function defaultLayout(preset) {
  switch (preset) {
    case 'text':
      return { timeline: 260, cols: [col(400, grp(['transcript', 'subtitles', 'media'])), col(0, grp(['player'])), col(360, grp([...AI_PANELS], { h: 1.4 }), grp(['inspector']))] };
    case 'effects':
      return { timeline: 300, cols: [col(320, grp(['motion', 'animation', 'media'])), col(0, grp(['player'])), col(360, grp(['inspector', 'color', 'mask', 'blur', 'tracking', 'cutout', 'videotools'])), col(340, grp([...AI_PANELS], { min: true }))] };
    case 'captions':
      return { timeline: 280, cols: [col(380, grp(['subtitles', 'transcript'])), col(0, grp(['player'])), col(340, grp(['inspector'])), col(340, grp([...AI_PANELS], { min: true }))] };
    case 'audio':
      return { timeline: 380, cols: [col(340, grp(['audio', 'memes', 'media'])), col(0, grp(['player'])), col(340, grp(['audiofx', 'inspector'])), col(340, grp([...AI_PANELS], { min: true }))] };
    case 'auto':
      return { timeline: 300, cols: [col(340, grp(['auto', 'youtube', 'media'])), col(0, grp(['player'])), col(380, grp([...AI_PANELS], { h: 1.4 }), grp(['inspector']))] };
    case 'edit':
    default:
      // the main workspace: every feature one click away — on the left the libraries (files, text, effects, sounds…)
      // above the clip tools (tracking, blur, mask, audio effects, colour, cutout, video tools), then the monitor,
      // the effect controls, and the AI (folded)
      return {
        timeline: 300,
        cols: [
          col(330, grp([...LIBRARY], { h: 1.5 }), grp(['tracking', 'blur', 'mask', 'audiofx', 'color', 'cutout', 'videotools'])),
          col(0, grp(['player'])),
          col(350, grp(['inspector', 'animation'])),
          col(340, grp([...AI_PANELS], { min: true })), // the AI stays folded until asked for (top-bar AI button)
        ],
      };
  }
}

/** Bumped when a built-in layout changes: saved workspaces of that preset are upgraded once (upgradeLayout). */
export const PRESET_REV = { edit: 4 };

/** Brings a saved built-in layout up to date without losing what the user arranged when possible. */
export function upgradeLayout(preset, layout, fromRev) {
  if (preset === 'edit' && fromRev < 4) return defaultLayout('edit'); // rev 4: clip tools under the libraries, AI folded
  let L = layout;
  if (preset === 'edit' && fromRev < 3) { // rev 3: AI panels folded by default
    L = clone(L);
    for (const c of L.cols) for (const g of c.groups) if (g.tabs.some((p) => AI_PANELS.includes(p))) g.min = true;
  }
  return L;
}

/** Are the panels of this list docked, and is at least one of their groups unfolded? */
export function panelsShown(L, panels) {
  const groups = L.cols.flatMap((c) => c.groups).filter((g) => g.tabs.some((p) => panels.includes(p)));
  return { docked: groups.length > 0, open: groups.some((g) => !g.min) };
}

/** Fold / unfold every group holding one of these panels. */
export function setPanelsFolded(L0, panels, folded) {
  const L = clone(L0);
  for (const c of L.cols) for (const g of c.groups) if (g.tabs.some((p) => panels.includes(p))) g.min = folded;
  return L;
}

export const DEFAULT_WORKSPACES = [['edit', 'wsEdit'], ['text', 'wsText'], ['effects', 'wsEffects'], ['captions', 'wsCaptions'], ['audio', 'wsAudio'], ['auto', 'wsAuto']];
export function defaultWorkspaces() {
  return DEFAULT_WORKSPACES.map(([preset, nameKey]) => ({ id: uid('ws'), preset, nameKey, name: null, rev: PRESET_REV[preset] || 1, layout: defaultLayout(preset) }));
}
export function newWorkspace(name, layout) {
  const l = normalize(clone(layout));
  return { id: uid('ws'), preset: null, nameKey: null, name, layout: l, base: clone(l) };
}

/** Repairs a layout read from storage or produced by an edit: known panels only, each once, the program monitor always present. */
export function normalize(input) {
  const L = { timeline: 320, cols: [], ...(input && typeof input === 'object' ? clone(input) : {}) };
  L.timeline = Math.max(150, Math.min(900, Number(L.timeline) || 320));
  const seen = new Set();
  L.cols = (Array.isArray(L.cols) ? L.cols : []).map((c) => ({
    id: c?.id || uid('c'),
    w: Math.max(COL_MIN, Math.min(900, Number(c?.w) || 320)),
    groups: (Array.isArray(c?.groups) ? c.groups : []).map((g) => {
      const tabs = (Array.isArray(g?.tabs) ? g.tabs : []).filter((p) => ALL_PANELS.includes(p) && !seen.has(p) && seen.add(p));
      // the program monitor never shares its group
      const out = tabs.includes('player') && tabs.length > 1 ? ['player'] : tabs;
      for (const p of tabs) if (!out.includes(p)) seen.delete(p);
      return { id: g?.id || uid('g'), tabs: out, active: out.includes(g?.active) ? g.active : out[0], min: !!g?.min && !out.includes('player'), h: Math.max(0.1, Number(g?.h) || 1) };
    }).filter((g) => g.tabs.length),
  })).filter((c) => c.groups.length);
  if (!seen.has('player')) L.cols.splice(Math.min(1, L.cols.length), 0, col(0, grp(['player'])));
  return L;
}

export function locate(L, panel) {
  for (let ci = 0; ci < L.cols.length; ci++) {
    const gi = L.cols[ci].groups.findIndex((g) => g.tabs.includes(panel));
    if (gi >= 0) return { ci, gi, col: L.cols[ci], group: L.cols[ci].groups[gi] };
  }
  return null;
}
export const hasPanel = (L, panel) => !!locate(L, panel);
export const isPlayerCol = (c) => c.groups.some((g) => g.tabs.includes('player'));
export const isStrip = (c) => c.groups.every((g) => g.min);
const findGroup = (L, gid) => {
  for (const c of L.cols) { const g = c.groups.find((x) => x.id === gid); if (g) return { col: c, group: g }; }
  return null;
};
function prune(L) {
  for (const c of L.cols) {
    for (const g of c.groups) if (!g.tabs.includes(g.active)) g.active = g.tabs[0];
    c.groups = c.groups.filter((g) => g.tabs.length);
  }
  L.cols = L.cols.filter((c) => c.groups.length);
  return L;
}

/** Can `panel` be dropped on group `gid` at `zone` ('center' = join its tabs, or an edge = new group / column)? */
export function canDrop(L, panel, fromGid, gid, zone) {
  const t = findGroup(L, gid);
  if (!t) return false;
  const src = findGroup(L, fromGid);
  if (zone === 'center') return t.group.id !== fromGid && panel !== 'player' && !t.group.tabs.includes('player');
  // moving the only tab of a group next to itself changes nothing
  if (src && src.group.id === gid && src.group.tabs.length === 1) return false;
  return true;
}

/** Drag & drop: move a panel tab into another group, or beside / above / below it. */
export function moveTab(L0, panel, fromGid, gid, zone) {
  if (!canDrop(L0, panel, fromGid, gid, zone)) return L0;
  const L = clone(L0);
  const src = findGroup(L, fromGid);
  const dst = findGroup(L, gid);
  if (!src || !dst) return L0;
  src.group.tabs = src.group.tabs.filter((p) => p !== panel);
  if (zone === 'center') {
    dst.group.tabs.push(panel);
    dst.group.active = panel;
    dst.group.min = false;
  } else if (zone === 'left' || zone === 'right') {
    const ci = L.cols.indexOf(dst.col);
    const width = src.col !== dst.col || src.col.groups.length > 1 ? (isPlayerCol(src.col) ? 340 : src.col.w) : 320;
    L.cols.splice(zone === 'left' ? ci : ci + 1, 0, col(width, grp([panel])));
  } else {
    const gi = dst.col.groups.indexOf(dst.group);
    const h = dst.group.h / 2;
    dst.group.h = h;
    dst.group.min = false;
    dst.col.groups.splice(zone === 'top' ? gi : gi + 1, 0, grp([panel], { h }));
  }
  return prune(L);
}

/** Whole-group drag (grabbed by the empty part of its tab bar). */
export function canDropGroup(L, fromGid, gid, zone) {
  const src = findGroup(L, fromGid), t = findGroup(L, gid);
  if (!src || !t || fromGid === gid) return false;
  if (zone === 'center') return !src.group.tabs.includes('player') && !t.group.tabs.includes('player');
  // a lone group next to itself (same single-group column, left/right) changes nothing
  if (src.col === t.col && src.col.groups.length === 1) return false;
  return true;
}

export function moveGroup(L0, fromGid, gid, zone) {
  if (!canDropGroup(L0, fromGid, gid, zone)) return L0;
  const L = clone(L0);
  const src = findGroup(L, fromGid), dst = findGroup(L, gid);
  const moved = { ...src.group, tabs: [...src.group.tabs], min: false };
  const width = isPlayerCol(src.col) ? 340 : src.col.w;
  src.group.tabs = []; // pruned below
  if (zone === 'center') {
    dst.group.tabs.push(...moved.tabs);
    dst.group.active = moved.active;
    dst.group.min = false;
  } else if (zone === 'left' || zone === 'right') {
    const ci = L.cols.indexOf(dst.col);
    L.cols.splice(zone === 'left' ? ci : ci + 1, 0, col(width, { ...moved, id: uid('g'), h: 1 }));
  } else {
    const gi = dst.col.groups.indexOf(dst.group);
    const h = dst.group.h / 2;
    dst.group.h = h;
    dst.col.groups.splice(zone === 'top' ? gi : gi + 1, 0, { ...moved, id: uid('g'), h });
  }
  return prune(L);
}

export function closePanel(L0, panel) {
  if (panel === 'player') return L0;
  const at = locate(L0, panel);
  if (!at) return L0;
  const L = clone(L0);
  const g = L.cols[at.ci].groups[at.gi];
  g.tabs = g.tabs.filter((p) => p !== panel);
  return prune(L);
}

/** Shows a panel: activates it where it is, or docks it (with `with` panels in the same group) as a new column. */
export function openPanel(L0, panel, { side = 'end', with: together = [], width = 340 } = {}) {
  const at = locate(L0, panel);
  const L = clone(L0);
  if (at) {
    const g = L.cols[at.ci].groups[at.gi];
    g.active = panel;
    g.min = false;
    return L;
  }
  const tabs = [panel, ...together.filter((p) => p !== panel && !locate(L, p))];
  L.cols.splice(side === 'start' ? 0 : L.cols.length, 0, col(width, grp(tabs)));
  return L;
}

/** Adds a panel to the first library group (left-most non-monitor group), or as a new left column. */
export function addPanelToLibrary(L0, panel) {
  if (locate(L0, panel)) return openPanel(L0, panel);
  const L = clone(L0);
  const target = L.cols.flatMap((c) => c.groups).find((g) => !g.tabs.includes('player') && g.tabs.some((p) => LIBRARY.includes(p) || TOOLS.includes(p)))
    || L.cols.flatMap((c) => c.groups).find((g) => !g.tabs.includes('player'));
  if (!target) { L.cols.unshift(col(320, grp([panel]))); return L; }
  target.tabs.push(panel);
  target.active = panel;
  target.min = false;
  return L;
}

export function updateGroup(L0, gid, patch) {
  const L = clone(L0);
  const f = findGroup(L, gid);
  if (!f) return L0;
  Object.assign(f.group, patch);
  if (f.group.tabs.includes('player')) f.group.min = false;
  return L;
}
