const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tooltipAPI', {
  onUpdate: (callback) => {
    ipcRenderer.on('tooltip:update', (_event, payload) => callback(payload));
  },
});
