const { contextBridge, ipcRenderer } = require('electron');

// Channel names inlined — same convention as the other overlays' own
// preloads (see group-menu-preload.js's comment for why).
contextBridge.exposeInMainWorld('hibernationPageAPI', {
  onOpen: (callback) => ipcRenderer.on('hibernation-page:open', (_event, payload) => callback(payload)),
  onClose: (callback) => ipcRenderer.on('hibernation-page:close', () => callback()),
  setMode: (mode) => ipcRenderer.send('hibernation-page:set-mode', mode),
  setTabsEnabled: (enabled) => ipcRenderer.send('hibernation-page:set-tabs-enabled', enabled),
  setIdleMinutes: (minutes) => ipcRenderer.send('hibernation-page:set-idle-minutes', minutes),
  setAppPolicy: (appId, policy) => ipcRenderer.send('hibernation-page:set-app-policy', { appId, policy }),
  close: () => ipcRenderer.send('hibernation-page:close'),
  onThemeChanged: (callback) => {
    ipcRenderer.on('app:theme-changed', (_event, payload) => callback(payload));
  },
});
