const { contextBridge, ipcRenderer } = require('electron');

// Channel names inlined rather than requiring shared/ipc-channels.js — see
// tooltip-preload.js for why. Which page is being searched is tracked on
// the main-process side (ViewManager.findContext), same as the other
// overlays' contexts.
contextBridge.exposeInMainWorld('findBarAPI', {
  onOpen: (callback) => ipcRenderer.on('find-bar:open', (_event, payload) => callback(payload)),
  onClose: (callback) => ipcRenderer.on('find-bar:close', () => callback()),
  onResult: (callback) => ipcRenderer.on('find-bar:result', (_event, payload) => callback(payload)),
  find: (text, forward) => ipcRenderer.send('find-bar:find', { text, forward }),
  close: () => ipcRenderer.send('find-bar:close'),
  onThemeChanged: (callback) => {
    ipcRenderer.on('app:theme-changed', (_event, payload) => callback(payload));
  },
});
