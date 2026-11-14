// Preload of the hidden segmentation window: request / response bridge with electron/segment/cutout.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seg', {
  ready: () => ipcRenderer.send('seg:ready'),
  onRequest: (handler) => {
    ipcRenderer.on('seg:req', async (_e, { id, type, data }) => {
      try {
        const result = await handler(type, data);
        ipcRenderer.send('seg:res', { id, ok: true, result });
      } catch (err) {
        ipcRenderer.send('seg:res', { id, ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
  },
});
