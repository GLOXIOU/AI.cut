// Preload: minimal, typed bridge between the renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('aicut', {
  /** Call a main-process API method. Resolves with data or rejects with an Error. */
  call: async (method, args) => {
    const r = await ipcRenderer.invoke('api', method, args);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Unknown error');
    return r.data;
  },
  /** Subscribe to a main → renderer channel. Returns an unsubscribe function. */
  on: (channel, cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  platform: process.platform,
});
