// Keyboard shortcuts: the action list with their default keys, the user's overrides (settings.shortcuts) and the
// helpers to read a key event / show a combo. Combos are written "Ctrl+Shift+E", "Space", "ArrowLeft", "+".
import { useStore } from './store.js';

/** Every remappable action (Premiere-like defaults). keys: one or more combos. */
export const SHORTCUTS = [
  { id: 'playPause', group: 'playback', keys: ['Space'] },
  { id: 'shuttleBack', group: 'playback', keys: ['J'] },
  { id: 'shuttleStop', group: 'playback', keys: ['K'] },
  { id: 'shuttleFwd', group: 'playback', keys: ['L'] },
  { id: 'prevFrame', group: 'navigation', keys: ['ArrowLeft'] },
  { id: 'nextFrame', group: 'navigation', keys: ['ArrowRight'] },
  { id: 'back1s', group: 'navigation', keys: ['Shift+ArrowLeft'] },
  { id: 'fwd1s', group: 'navigation', keys: ['Shift+ArrowRight'] },
  { id: 'prevEdit', group: 'navigation', keys: ['ArrowUp'] },
  { id: 'nextEdit', group: 'navigation', keys: ['ArrowDown'] },
  { id: 'goStart', group: 'navigation', keys: ['Home'] },
  { id: 'goEnd', group: 'navigation', keys: ['End'] },
  { id: 'markIn', group: 'navigation', keys: ['I'] },
  { id: 'markOut', group: 'navigation', keys: ['O'] },
  { id: 'clearInOut', group: 'navigation', keys: ['Ctrl+Shift+X'] },
  { id: 'split', group: 'editing', keys: ['S', 'Ctrl+K'] },
  { id: 'rippleTrimStart', group: 'editing', keys: ['Q'] },
  { id: 'rippleTrimEnd', group: 'editing', keys: ['W'] },
  { id: 'deleteSel', group: 'editing', keys: ['Delete', 'Backspace'] },
  { id: 'rippleDelete', group: 'editing', keys: ['Shift+Delete', 'Shift+Backspace'] },
  { id: 'duplicate', group: 'editing', keys: ['Ctrl+D'] },
  { id: 'copy', group: 'editing', keys: ['Ctrl+C'] },
  { id: 'paste', group: 'editing', keys: ['Ctrl+V'] },
  { id: 'selectAll', group: 'editing', keys: ['Ctrl+A'] },
  { id: 'addMarker', group: 'editing', keys: ['M'] },
  { id: 'undo', group: 'editing', keys: ['Ctrl+Z'] },
  { id: 'redo', group: 'editing', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'] },
  { id: 'toolSelect', group: 'tools', keys: ['V'] },
  { id: 'toolRazor', group: 'tools', keys: ['C'] },
  { id: 'toggleSnap', group: 'tools', keys: ['N'] },
  { id: 'zoomIn', group: 'tools', keys: ['+', '='] },
  { id: 'zoomOut', group: 'tools', keys: ['-'] },
  { id: 'zoomFit', group: 'tools', keys: ['\\'] },
  { id: 'deselect', group: 'tools', keys: ['Escape'] },
  { id: 'save', group: 'file', keys: ['Ctrl+S'] },
  { id: 'exportVideo', group: 'file', keys: ['Ctrl+E'] },
  { id: 'exportFrame', group: 'file', keys: ['Ctrl+Shift+E'] },
];
export const SHORTCUT_GROUPS = ['playback', 'navigation', 'editing', 'tools', 'file'];
const BY_ID = new Map(SHORTCUTS.map((a) => [a.id, a]));

/** Current combos of an action: the user's override if any (an empty list disables it), else the defaults. */
export function combosFor(id, overrides) {
  const o = overrides?.[id];
  return Array.isArray(o) ? o : BY_ID.get(id)?.keys || [];
}

let cache = { overrides: undefined, map: null };
/** combo → action id, for the current overrides (rebuilt only when they change). */
export function bindingMap(overrides) {
  if (cache.map && cache.overrides === overrides) return cache.map;
  const map = new Map();
  for (const a of SHORTCUTS) for (const c of combosFor(a.id, overrides)) if (!map.has(c)) map.set(c, a.id);
  cache = { overrides, map };
  return map;
}

/** "Ctrl+Shift+E" from a keydown event (null for a lone modifier). AltGr characters keep only the character. */
export function comboFromEvent(e) {
  const k = e.key;
  if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(k)) return null;
  const altGr = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
  const single = k.length === 1;
  const letter = single && /[a-z]/i.test(k);
  const key = k === ' ' ? 'Space' : single ? k.toUpperCase() : k;
  const mods = [];
  if ((e.ctrlKey || e.metaKey) && !altGr) mods.push('Ctrl');
  if (e.altKey && !altGr) mods.push('Alt');
  // for symbols the character already says whether Shift was down ("+" vs "=")
  if (e.shiftKey && (!single || letter)) mods.push('Shift');
  return [...mods, key].join('+');
}

const NAMES = {
  fr: { Ctrl: 'Ctrl', Shift: 'Maj', Alt: 'Alt', Space: 'Espace', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Delete: 'Suppr', Backspace: 'Retour arr.', Escape: 'Échap', Home: 'Début', End: 'Fin', Enter: 'Entrée', Tab: 'Tab', PageUp: 'Page ↑', PageDown: 'Page ↓', Insert: 'Inser' },
  en: { Ctrl: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Delete: 'Del', Backspace: 'Backspace', Escape: 'Esc', Home: 'Home', End: 'End', Enter: 'Enter', Tab: 'Tab', PageUp: 'Page ↑', PageDown: 'Page ↓', Insert: 'Ins' },
};
/** Parts of a combo as shown on screen, e.g. ["Ctrl", "Maj", "E"]. */
export function comboParts(combo, lang = 'fr') {
  const n = NAMES[lang === 'en' ? 'en' : 'fr'];
  return String(combo || '').split('+').filter((x, i, a) => x || i === a.length - 1).map((p) => n[p] || p || '+');
}
export const formatCombo = (combo, lang) => comboParts(combo, lang).join('+');

/** Hook: (actionId) → its first shortcut as text ("" if none), kept up to date with the settings. */
export function useShortcut() {
  const overrides = useStore((s) => s.settings?.shortcuts);
  const lang = useStore((s) => s.lang);
  return (id) => { const c = combosFor(id, overrides)[0]; return c ? formatCombo(c, lang) : ''; };
}
