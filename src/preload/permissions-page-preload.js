const { contextBridge, ipcRenderer } = require('electron');

// Channel names inlined — same convention as the other overlays' own
// preloads (see group-menu-preload.js's comment for why).
contextBridge.exposeInMainWorld('permissionsPageAPI', {
  onOpen: (callback) => ipcRenderer.on('permissions-page:open', (_event, payload) => callback(payload)),
  onClose: (callback) => ipcRenderer.on('permissions-page:close', () => callback()),
  setState: (appId, permission, state) => ipcRenderer.send('permissions-page:set-state', { appId, permission, state }),
  close: () => ipcRenderer.send('permissions-page:close'),
  onThemeChanged: (callback) => {
    ipcRenderer.on('app:theme-changed', (_event, payload) => callback(payload));
  },
});
