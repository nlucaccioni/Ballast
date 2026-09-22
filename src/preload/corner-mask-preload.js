const { contextBridge, ipcRenderer } = require('electron');

// Channel name inlined rather than requiring shared/ipc-channels.js — see
// tooltip-preload.js for why.
contextBridge.exposeInMainWorld('cornerMaskAPI', {
  onThemeChanged: (callback) => {
    ipcRenderer.on('app:theme-changed', (_event, payload) => callback(payload));
  },
});
