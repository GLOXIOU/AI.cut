import { app } from 'electron';
import { userDir } from './paths.js';
import { readJson, writeJson } from './util.js';
import { bus } from './bus.js';

const DEFAULTS = {
  language: null, // 'fr' | 'en' | null = system
  mcpPort: 7777,
  ffmpegPath: null,
  ffprobePath: null,
  ytdlpPath: null,
  whisperModel: 'auto', // auto | tiny | base | small | medium | large-v3-turbo
  whisperBackend: 'auto', // auto | vulkan | cpu
  whisperLanguage: 'auto',
  autoAnalyze: true, // transcribe + scenes on import
  proxyMode: 'auto', // auto | always | never
  defaultProjectsDir: null,
  recentProjects: [], // [{path, name, openedAt}]
  exportDefaults: { preset: 'youtube-1080p', quality: 'high', hardware: true },
  copilot: { provider: 'claude', model: '', permissionMode: 'default' },
  openverseLicense: 'cc0', // cc0 | commercial
  theme: 'dark',
  shortcuts: {}, // { actionId: ['Ctrl+K', …] } — only the shortcuts the user changed (src/app/shortcuts.js)
};

let settings = null;
const file = () => userDir('settings.json');

export function getSettings() {
  if (!settings) {
    const saved = readJson(file(), {});
    settings = { ...DEFAULTS, ...saved, exportDefaults: { ...DEFAULTS.exportDefaults, ...(saved.exportDefaults || {}) }, copilot: { ...DEFAULTS.copilot, ...(saved.copilot || {}) } };
  }
  return settings;
}

export function setSettings(patch) {
  const s = getSettings();
  Object.assign(s, patch || {});
  writeJson(file(), s);
  bus.emit('settings:changed', s);
  return s;
}

/** Language of the OS ('fr' for any French locale, else 'en' — English is the default). */
export function systemLanguage() {
  try {
    const loc = app.getLocale() || 'en';
    return loc.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}

/** Interface language: the user's choice (settings.language) or the system's. Only the UI follows it, never the AI. */
export function uiLanguage() {
  const s = getSettings();
  return s.language === 'fr' || s.language === 'en' ? s.language : systemLanguage();
}

/** Pick the interface-language variant of a user-facing message (toasts, job titles, dialogs). */
export const tr = (fr, en) => (uiLanguage() === 'fr' ? fr : en);

export function addRecentProject(p, name) {
  const s = getSettings();
  const list = (s.recentProjects || []).filter((r) => r.path !== p);
  list.unshift({ path: p, name, openedAt: new Date().toISOString() });
  setSettings({ recentProjects: list.slice(0, 20) });
}

export function removeRecentProject(p) {
  const s = getSettings();
  setSettings({ recentProjects: (s.recentProjects || []).filter((r) => r.path !== p) });
}
