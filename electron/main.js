// AI.cut — Electron main process.
import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { registerSchemePrivileges, installProtocol, fileUrl } from './media/protocol.js';
import { log } from './core/log.js';
import { bus } from './core/bus.js';
import { jobs, snapshot } from './core/jobs.js';
import { getSettings, setSettings, uiLanguage, systemLanguage, tr, removeRecentProject } from './core/settings.js';
import { userDir, RESOURCES_DIR, tempDir, APP_ROOT } from './core/paths.js';
import { exists, sleep } from './core/util.js';
import { killAllChildren } from './core/proc.js';
import { store } from './project/store.js';
import { RESOLUTION_PRESETS } from './project/schema.js';
import { importPaths, relinkMedia, setRendererCaps, waitForProbe } from './media/service.js';
import { ffmpegPath, detectEncoders } from './media/ffmpeg.js';
import { composeHtmlClip, motionTemplates } from './render/html.js';
import { analyzeMedia, autoAnalyze, loadAnalysis, clearAnalysisCache } from './analysis/index.js';
import { modelStatus, ensureModel, whisperInfo, stopWhisper, WHISPER_MODELS } from './analysis/transcribe.js';
import { searchLibrary, previewSource, creditsText, builtinItems, packMusicItems, isLocalLibraryId, SFX_CATEGORIES, MEME_CATEGORIES, MUSIC_CATEGORIES } from './library/library.js';
import { importMotionFiles, removeUserTemplate } from './library/motion-library.js';
import { ensureStarterBank } from './library/memebank.js';
import { templateThumb } from './render/thumbs.js';
import { searchYoutube, ytdlpPath, ensureYtdlp, ytdlpVersion } from './youtube/ytdlp.js';
import { EXPORT_PRESETS } from './export/presets.js';
import { startMcpServer, stopMcpServer, mcpStatus, activityLog, callTool, setDebugHandler } from './ai/mcp-server.js';
import { clientStatus, connectClient, disconnectClient, configSnippets, openTerminal } from './ai/connect.js';
import * as copilot from './ai/copilot.js';
import * as S from './services.js';
import * as CR from './creative.js';
import { stopTrackingWorker } from './tracking/tracker.js';
import { startCutout, cutoutStatus, placeBehind } from './segment/cutout.js';
import { separateStems } from './segment/stems.js';
import { analyzeStyleJob, styleRef, styleRecipe } from './style/reference.js';
import { clipById } from '../shared/timeline.js';
import { SUBTITLE_PRESETS } from '../shared/subtitles.js';
import { TRANSITIONS } from '../shared/transitions.js';
import { BUNDLED_FONTS } from '../shared/fonts.js';

if (process.env.AICUT_USER_DATA) app.setPath('userData', process.env.AICUT_USER_DATA);
registerSchemePrivileges();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let monitorWin = null; // external program monitor (second screen)
const isDev = !!process.env.VITE_DEV_SERVER_URL;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function sendMonitor(channel, payload) {
  if (monitorWin && !monitorWin.isDestroyed()) monitorWin.webContents.send(channel, payload);
}

// ------------------------------------------------------------------------------- bus → renderer
let pendingProject = null;
let projectTimer = null;
bus.on('project:changed', (project, meta) => {
  pendingProject = { project, meta };
  if (projectTimer) return;
  projectTimer = setTimeout(() => {
    projectTimer = null;
    const p = pendingProject;
    pendingProject = null;
    if (p) {
      send('project', { project: p.project, meta: p.meta, file: store.file, dir: store.dir });
      sendMonitor('project', { project: p.project });
    }
  }, 16);
});
bus.on('project:closed', () => { send('project', { project: null }); sendMonitor('project', { project: null }); });
bus.on('jobs:update', (j) => send('jobs', j));
bus.on('ai:activity', (a) => send('activity', a));
bus.on('ai:sessions', (s) => send('sessions', s));
bus.on('toast', (t) => send('toast', t));
bus.on('player:command', (c) => send('player', c));
bus.on('copilot:update', (s) => send('copilot', s));
bus.on('settings:changed', (s) => send('settings', s));
bus.on('media:ready', (mediaId) => autoAnalyze(mediaId));
bus.on('project:opened', () => clearAnalysisCache());

// ------------------------------------------------------------------------------- API (renderer → main)
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const API = {
  'app:info': async () => ({
    version: app.getVersion(), platform: process.platform, language: uiLanguage(), systemLanguage: systemLanguage(), isDev,
    mcp: mcpStatus(), ffmpeg: ffmpegPath(), userData: app.getPath('userData'),
    presets: RESOLUTION_PRESETS, exportPresets: EXPORT_PRESETS, subtitlePresets: SUBTITLE_PRESETS, transitions: TRANSITIONS, fonts: BUNDLED_FONTS,
  }),
  'app:encoders': () => detectEncoders(),
  'settings:get': () => getSettings(),
  'settings:set': (patch) => setSettings(patch),

  'project:recent': () => (getSettings().recentProjects || []).map((r) => ({ ...r, exists: exists(r.path) })),
  'project:forget': ({ path: p }) => { removeRecentProject(p); return true; },
  'project:delete': ({ path: p }) => deleteProject(p),
  'project:create': (a) => { const r = S.createProject(a); return { file: r.file, dir: r.dir }; },
  'project:open': ({ path: p }) => { const r = S.openProject(p); return { file: r.file, dir: r.dir }; },
  'project:close': () => { store.close(); return true; },
  'project:get': () => ({ project: store.project, file: store.file, dir: store.dir, canUndo: store.canUndo(), canRedo: store.canRedo() }),
  'project:save': async () => { await store.save(); return true; },
  'project:op': ({ name, args, label }) => store.apply(name, args || {}, { source: 'ui', label }),
  'project:undo': () => store.undo(),
  'project:redo': () => store.redo(),
  'project:history': () => store.historyList(),
  'project:revertTo': ({ index }) => store.revertTo(index),
  'project:checkpoint': ({ name }) => store.createCheckpoint(name),
  'project:checkpoints': () => store.listCheckpoints(),
  'project:restoreCheckpoint': ({ id }) => store.restoreCheckpoint(id, { source: 'ui' }),
  'project:credits': () => (store.project ? creditsText(store.project) : ''),

  'media:import': ({ paths }) => importPaths(paths, { source: 'ui' }).map((m) => m.id),
  'media:peaks': ({ mediaId }) => {
    const m = store.project?.media.find((x) => x.id === mediaId);
    if (!m?.peaks || !exists(m.peaks)) return null;
    return new Uint8Array(fs.readFileSync(m.peaks));
  },
  'media:analysis': ({ mediaId }) => loadAnalysis(mediaId),
  'media:analyze': ({ mediaId, opts }) => snapshot(analyzeMedia(mediaId, { force: true, ...(opts || {}) })),
  'media:relink': ({ mediaId, path: p }) => relinkMedia(mediaId, p).id,
  'media:url': ({ path: p }) => fileUrl(p),

  'dialog:openFiles': async ({ title, filters, multi = true, folder = false } = {}) => {
    const r = await dialog.showOpenDialog(win, { title, properties: [folder ? 'openDirectory' : 'openFile', ...(multi ? ['multiSelections'] : [])], filters });
    return r.canceled ? [] : r.filePaths;
  },
  'dialog:saveFile': async ({ title, defaultPath, filters } = {}) => {
    const r = await dialog.showSaveDialog(win, { title, defaultPath, filters });
    return r.canceled ? null : r.filePath;
  },
  'shell:reveal': ({ path: p }) => { shell.showItemInFolder(p); return true; },
  'shell:open': ({ path: p }) => shell.openPath(p),
  'shell:external': ({ url }) => shell.openExternal(url),

  'library:search': (opts) => searchLibrary(opts),
  'library:preview': ({ id }) => { const s = previewSource(id); return s?.file ? fileUrl(s.file) : s?.url || null; },
  'library:add': async ({ id, place }) => {
    if (isLocalLibraryId(id)) return S.addLibraryAudio(id, place, { source: 'ui' });
    return snapshot(S.addLibraryAudioJob(id, place, { source: 'ui' }));
  },
  'youtube:search': ({ query, limit, creativeCommons }) => searchYoutube(query, { limit, creativeCommons }),
  'youtube:download': ({ url, ...o }) => snapshot(S.youtubeDownloadJob(url, o, { source: 'ui' })),

  'motion:templates': () => motionTemplates(),
  'motion:import': ({ paths }) => importMotionFiles(paths),
  'motion:remove': ({ id }) => removeUserTemplate(id),
  'motion:thumb': ({ id }) => templateThumb(id),
  'library:builtin': () => ({ items: builtinItems(), categories: SFX_CATEGORIES, memeCategories: MEME_CATEGORIES, music: packMusicItems(), musicCategories: MUSIC_CATEGORIES }),
  'stickers:search': (o) => S.searchStickersSvc(o || {}),
  'stickers:add': ({ id, ...o }) => S.addSticker(id, o, { source: 'ui' }),
  'memes:apply': ({ id, time }) => S.applyMeme(id, { time }, { source: 'ui' }),
  'memes:search': (o) => S.searchMemeBank(o || {}),
  'memes:addImage': ({ id, ...o }) => S.addMemeImage(id, o, { source: 'ui' }),
  'memes:addVideo': ({ id, url, ...o }) => (id ? S.addMemeVideo(id, o, { source: 'ui' }) : snapshot(S.addGreenScreenMeme(url, o, { source: 'ui' }))),
  'memes:starter': () => { const j = ensureStarterBank(); return j ? snapshot(j) : null; },
  'subtitles:generate': (o) => S.generateSubtitles(o, { source: 'ui' }),
  'subtitles:rescore': () => S.rescoreSubtitleWords({ source: 'ui' }),
  'edit:removeSilences': (o) => S.removeSilences(o, { source: 'ui' }),
  'edit:duckMusic': (o) => S.duckMusic(o, { source: 'ui' }),
  'edit:autoSfx': (o) => S.autoSfx(o || {}, { source: 'ui' }),
  'edit:transcript': () => S.sequenceTranscript(),
  'edit:deleteWords': ({ ranges }) => S.deleteWords(ranges, { source: 'ui', label: 'delete words' }),
  'edit:removeFillers': (o) => S.removeFillers(o || {}, { source: 'ui' }),
  'edit:autoZooms': (o) => S.autoZooms(o || {}, { source: 'ui' }),
  'edit:freezeFrame': (o) => S.freezeFrame(o || {}, { source: 'ui' }),
  'edit:beatMarkers': (o) => S.beatMarkers(o || {}, { source: 'ui' }),
  'edit:chapters': () => S.youtubeChapters(),
  'edit:animateBroll': (o) => S.animateBroll(o || {}, { source: 'ui' }),
  'edit:enhanceVoices': ({ preset }) => S.enhanceVoices(preset, { source: 'ui' }),
  'edit:recipe': ({ id }) => S.applyRecipe(id, { source: 'ui' }),
  'render:frame': async ({ time, width, out }) => {
    const img = (await S.renderFrames([time], { width }))?.image;
    if (out && img) { fs.copyFileSync(img, out); return out; }
    return img;
  },

  // tracking / attached elements / effects that follow a tracking
  'track:start': (a) => snapshot(CR.trackObject(a, { source: 'ui' })),
  'track:faces': (a) => CR.facesAt(a),
  'track:list': () => CR.listTrackings(),
  'track:attach': (a) => CR.attachToTracking(a, { source: 'ui' }).result,
  'track:effect': (a) => CR.effectOnTracking(a, { source: 'ui' }).result,
  'ai:askHere': (a) => CR.askAiHere(a, { source: 'ui' }),
  'edit:autoReframe': async (a) => (await CR.autoReframe(a, { source: 'ui' })).result,
  'edit:derive': (a) => snapshot(CR.deriveClip(a, { source: 'ui' })),
  'cutout:start': (a) => snapshot(startCutout(a, { source: 'ui' })),
  'cutout:status': () => cutoutStatus(),
  'stems:start': (a) => snapshot(separateStems(a, { source: 'ui' })),
  'style:analyze': (a) => snapshot(analyzeStyleJob(a, { source: 'ui' })),
  'style:apply': ({ id, text, target }) => {
    const ref = styleRef(id);
    const ask = `${text ? `${text}\n\n` : ''}Monte la vidéo en copiant le style de montage de la référence « ${ref.name} » (get_style_reference id ${ref.id} : regarde les planches et suis la recette). Crée tes propres textes et tes propres motion designs dans ce style.`;
    return CR.askAiHere({ text: ask, time: 0, target }, { source: 'ui' });
  },
  'cutout:behind': async (a) => { if (a.mediaId) await waitForProbe(a.mediaId); return placeBehind(a, { source: 'ui' }); },

  'export:start': (opts) => snapshot(S.startExport(opts, { source: 'ui' })),
  'jobs:list': () => jobs.list().slice(0, 50).map(snapshot),
  'jobs:cancel': ({ id }) => jobs.cancel(id),

  'ai:status': async () => ({ mcp: mcpStatus(), ...(await clientStatus()) }),
  'ai:connect': ({ id }) => connectClient(id),
  'ai:disconnect': ({ id }) => disconnectClient(id),
  'ai:snippets': () => configSnippets(),
  'ai:terminal': ({ cli }) => openTerminal(cli),
  'ai:activity': () => activityLog(),
  'ai:call': ({ name, args }) => callTool(name, args, { client: 'AI.cut UI' }),

  'copilot:state': () => copilot.state(),
  'copilot:send': ({ text, ui }) => copilot.send(text, { ui }),
  'copilot:stop': () => copilot.stop(),
  'copilot:reset': () => copilot.reset(),

  'ui:state': (s) => { S.setUiState(s); return true; },

  // external program monitor (second screen)
  'monitor:toggle': () => (monitorWin && !monitorWin.isDestroyed() ? closeMonitor() : openMonitor()),
  'monitor:open': () => openMonitor(),
  'monitor:close': () => closeMonitor(),
  'monitor:status': () => monitorStatus(),
  'monitor:sync': (m) => { sendMonitor('monitor', m); return true; },
  'monitor:ready': () => { send('monitor:state', { ...monitorStatus(), ready: true }); return true; },
  'monitor:command': ({ action, key, shift }) => {
    if (action === 'toggle') send('player', { action: 'toggle' });
    else if (action === 'key') send('player', { action: 'key', key, shift });
    else if (action === 'fullscreen' && monitorWin && !monitorWin.isDestroyed()) monitorWin.setFullScreen(!monitorWin.isFullScreen());
    else if (action === 'escape' && monitorWin && !monitorWin.isDestroyed()) {
      if (monitorWin.isFullScreen()) monitorWin.setFullScreen(false); else closeMonitor();
    }
    return true;
  },
  'ui:caps': (caps) => { setRendererCaps(caps); return true; },

  'tools:status': async () => ({
    ffmpeg: ffmpegPath(), ytdlp: ytdlpPath(), ytdlpVersion: ytdlpPath() ? await ytdlpVersion() : null,
    whisper: whisperInfo(), models: modelStatus(), encoders: await detectEncoders(),
  }),
  'tools:installYtdlp': () => snapshot(jobs.create('download', tr('Installation de yt-dlp', 'Install yt-dlp'), (ctx) => ensureYtdlp({ onProgress: (p) => ctx.progress(p), signal: ctx.signal }), { queue: 'download' })),
  'tools:downloadModel': ({ name }) => snapshot(jobs.create('download', `${tr('Modèle Whisper', 'Whisper model')} ${name}`, (ctx) => ensureModel(name, { onProgress: (p) => ctx.progress(p), signal: ctx.signal }), { queue: 'download' })),
  'tools:models': () => ({ models: modelStatus(), list: WHISPER_MODELS }),
  'tts:voices': () => S.listVoices(),
  'tts:generate': ({ text, voice, rate, place }) => S.generateVoiceover(text, { voice, rate, place }, { source: 'ui' }),
};

ipcMain.handle('api', async (_e, method, args) => {
  const fn = API[method];
  if (!fn) return { ok: false, error: `Unknown API ${method}` };
  try {
    const data = await fn(args || {});
    return { ok: true, data };
  } catch (e) {
    log.warn(`API ${method} failed:`, e.message);
    return { ok: false, error: e.message };
  }
});

// ------------------------------------------------------------------------------- delete project
/** Ask, then send the project to the Recycle Bin (its own folder: cache, proxies, downloads, exports). */
async function deleteProject(file) {
  if (!file || !exists(file)) { removeRecentProject(file); return { deleted: false, removed: true }; }
  const fr = uiLanguage() === 'fr';
  const recent = (getSettings().recentProjects || []).find((r) => r.path === file);
  const name = recent?.name || path.basename(file, path.extname(file));
  const target = S.projectTrashTarget(file);
  const detail = target.kind === 'folder'
    ? (fr
      ? `Le dossier du projet va être mis à la corbeille avec tout son contenu : fichier projet, cache (proxys, analyses), médias téléchargés et exports.\n\n${target.path}\n\nLes vidéos importées depuis un autre dossier ne sont pas touchées.`
      : `The project folder will be moved to the Recycle Bin with everything inside: project file, cache (proxies, analysis), downloaded media and exports.\n\n${target.path}\n\nVideos imported from other folders are not touched.`)
    : (fr
      ? `Le fichier projet va être mis à la corbeille :\n${target.path}\n\nIl n'est pas dans un dossier de projet AI.cut dédié : rien d'autre n'est supprimé.`
      : `The project file will be moved to the Recycle Bin:\n${target.path}\n\nIt is not in a dedicated AI.cut project folder: nothing else is deleted.`);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: fr ? 'Supprimer le projet' : 'Delete project',
    message: fr ? `Supprimer « ${name} » ?` : `Delete "${name}"?`,
    detail,
    buttons: fr ? ['Mettre à la corbeille', 'Retirer de la liste seulement', 'Annuler'] : ['Move to Recycle Bin', 'Remove from list only', 'Cancel'],
    defaultId: 2, cancelId: 2, noLink: true,
  });
  if (response === 2) return { deleted: false, canceled: true };
  if (response === 1) { removeRecentProject(file); return { deleted: false, removed: true }; }
  if (store.isOpen && path.resolve(store.file).toLowerCase() === path.resolve(file).toLowerCase()) store.close();
  try {
    await shell.trashItem(target.path);
  } catch {
    await sleep(1200); // a just-canceled ffmpeg may still hold a cache file for a moment
    await shell.trashItem(target.path);
  }
  removeRecentProject(file);
  log.info('project moved to the Recycle Bin', target.path);
  return { deleted: true, path: target.path };
}

// ------------------------------------------------------------------------------- protocol hooks
function isAllowedFile(abs) {
  const norm = path.normalize(abs).toLowerCase();
  const roots = [userDir(), RESOURCES_DIR, tempDir()].map((r) => path.normalize(r).toLowerCase());
  if (roots.some((r) => norm.startsWith(r))) return true;
  return store.isAllowedPath(abs);
}

function htmlForClip(rel, params) {
  if (rel.startsWith('__tpl__/')) {
    // template preview (motion panel hover)
    const id = rel.slice(8);
    const tpl = motionTemplates().find((x) => x.id === id);
    if (!tpl) return null;
    const W = Number(params?.get('w')) || store.project?.settings.width || 1920;
    const H = Number(params?.get('h')) || store.project?.settings.height || 1080;
    const fake = { id: `tpl_${id}`, type: 'html', duration: tpl.defaultDuration || 4, html: { template: id, params: {} } };
    return composeHtmlClip(fake, { settings: { width: W, height: H, fps: 30 } }, { mode: 'preview' });
  }
  if (!store.project) return null;
  const clipId = rel.split('/')[0];
  const c = clipById(store.project, clipId);
  if (!c || c.type !== 'html') return null;
  return composeHtmlClip(c, store.project, { mode: 'preview' });
}

// ------------------------------------------------------------------------------- external monitor
function monitorStatus() {
  const open = !!(monitorWin && !monitorWin.isDestroyed());
  const displays = screen.getAllDisplays().length;
  return { open, displays, fullscreen: open ? monitorWin.isFullScreen() : false };
}

/** Open the program monitor: full screen on another display when there is one, a normal window otherwise. */
function openMonitor() {
  if (monitorWin && !monitorWin.isDestroyed()) { monitorWin.show(); monitorWin.focus(); return monitorStatus(); }
  const main = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const other = screen.getAllDisplays().find((d) => d.id !== main.id);
  const target = other || main;
  const wa = target.workArea;
  const w = Math.min(1280, Math.round(wa.width * 0.6)), h = Math.round((w * 9) / 16);
  monitorWin = new BrowserWindow({
    x: other ? target.bounds.x : wa.x + Math.round((wa.width - w) / 2), y: other ? target.bounds.y : wa.y + Math.round((wa.height - h) / 2),
    width: other ? target.bounds.width : w, height: other ? target.bounds.height : h,
    fullscreen: !!other, backgroundColor: '#000000', title: 'AI.cut — Programme', icon: path.join(RESOURCES_DIR, 'icon.png'),
    autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false,
    },
  });
  monitorWin.setMenu(null);
  // the editor keeps the keyboard focus (and the user's place) when the monitor opens on another screen
  monitorWin.once('ready-to-show', () => { if (other || process.env.AICUT_DEBUG === '1') monitorWin.showInactive(); else monitorWin.show(); });
  monitorWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  monitorWin.on('closed', () => { monitorWin = null; send('monitor:state', monitorStatus()); });
  monitorWin.on('enter-full-screen', () => send('monitor:state', monitorStatus()));
  monitorWin.on('leave-full-screen', () => send('monitor:state', monitorStatus()));
  if (isDev) monitorWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}#monitor`);
  else monitorWin.loadURL('aicut://app/index.html#monitor');
  log.info('program monitor opened', other ? `on display ${target.id} (full screen)` : 'windowed');
  return { ...monitorStatus(), open: true };
}

function closeMonitor() {
  if (monitorWin && !monitorWin.isDestroyed()) monitorWin.close();
  monitorWin = null;
  return { ...monitorStatus(), open: false };
}

// ------------------------------------------------------------------------------- window
function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1100, minHeight: 700,
    backgroundColor: '#121212',
    title: 'AI.cut',
    icon: path.join(RESOURCES_DIR, 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#121212', symbolColor: '#b8b8b8', height: 38 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false,
    },
  });
  // automated test runs (AICUT_DEBUG) must not steal the keyboard focus from the user's other windows
  win.once('ready-to-show', () => (process.env.AICUT_DEBUG === '1' ? win.showInactive() : win.show()));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadURL('aicut://app/index.html');
  // offscreen render windows (motion thumbnails, frame renders) must not keep the app alive once the editor is closed
  win.on('closed', () => { win = null; closeMonitor(); app.quit(); });
}

function fileArg(argv) {
  return argv.find((a) => a.toLowerCase().endsWith('.aicut') && exists(a));
}

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const f = fileArg(argv);
  if (f) { try { S.openProject(f); } catch (e) { send('toast', { level: 'error', message: e.message }); } }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  installProtocol({ isAllowedFile, htmlForClip });
  createWindow();
  const port = getSettings().mcpPort || 7777;
  try {
    await startMcpServer(port);
  } catch (e) {
    log.error('MCP server failed to start', e);
    setTimeout(() => send('toast', { level: 'error', message: tr(`Serveur MCP indisponible sur le port ${port} (${e.code || e.message}). Change le port dans les réglages.`, `MCP server unavailable on port ${port} (${e.code || e.message}). Change the port in Settings.`) }), 2500);
  }
  const f = fileArg(process.argv);
  if (f) { try { S.openProject(f); } catch (e) { log.warn(e.message); } }
  detectEncoders().catch(() => {});
  if (process.env.AICUT_DEBUG === '1') installDebugHooks();
});

/** Test automation hooks (screenshots, renderer eval) — only with AICUT_DEBUG=1. */
function installDebugHooks() {
  const consoleLog = [];
  win.webContents.on('console-message', (e) => {
    consoleLog.push({ level: e.level, message: e.message, at: Date.now() });
    if (consoleLog.length > 300) consoleLog.shift();
  });
  win.webContents.on('render-process-gone', (e, d) => consoleLog.push({ level: 'crash', message: JSON.stringify(d) }));
  setDebugHandler(async (name, body) => {
    if (name === 'console') { const out = consoleLog.slice(); if (body?.clear) consoleLog.length = 0; return out; }
    if (name === 'screenshot') {
      const target = body?.window === 'monitor' ? monitorWin : win;
      if (!target || target.isDestroyed()) throw new Error('window not open');
      const img = await target.webContents.capturePage();
      const out = body?.path || path.join(tempDir(), `aicut_ui_${Date.now()}.png`);
      fs.writeFileSync(out, img.toPNG());
      return { path: out, size: img.getSize() };
    }
    if (name === 'eval') return win.webContents.executeJavaScript(String(body?.js || 'null'), true);
    if (name === 'size') { win.setContentSize(body.width, body.height); return true; }
    // renderer CPU profile (DevTools protocol): {action:'start'} then {action:'stop', path} → .cpuprofile
    if (name === 'profile') {
      const dbg = win.webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      if (body?.action === 'start') {
        await dbg.sendCommand('Profiler.enable');
        await dbg.sendCommand('Profiler.setSamplingInterval', { interval: Number(body.interval) || 250 });
        await dbg.sendCommand('Profiler.start');
        return true;
      }
      const { profile } = await dbg.sendCommand('Profiler.stop');
      const out = body?.path || path.join(tempDir(), `aicut_${Date.now()}.cpuprofile`);
      fs.writeFileSync(out, JSON.stringify(profile));
      return { path: out, nodes: profile.nodes.length };
    }
    if (name === 'quit') { setTimeout(() => app.quit(), 100); return true; }
    throw new Error(`unknown debug command ${name}`);
  });
  log.info('debug hooks installed');
}

app.on('window-all-closed', () => { app.quit(); });

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  // whatever happens during the cleanup, the process is gone within a few seconds
  setTimeout(() => { log.warn('shutdown timeout, forcing exit'); killAllChildren(); app.exit(0); }, 4000);
  shutdown().finally(() => app.exit(0));
});

async function shutdown() {
  try { store.close(); } catch (err) { log.error(err); } // saves the project
  try { jobs.cancelAll(); } catch (err) { log.error(err); } // import / analysis / export ffmpeg processes
  try { stopWhisper(); } catch { /* ignore */ }
  try { stopTrackingWorker(); } catch { /* ignore */ }
  try { copilot.stop(); } catch { /* ignore */ }
  killAllChildren(); // anything not attached to a job (frame renders, yt-dlp searches…)
  try { await stopMcpServer(); } catch { /* ignore */ }
}
process.on('exit', () => killAllChildren());

process.on('uncaughtException', (e) => log.error('uncaught', e));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
