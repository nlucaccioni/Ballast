const { contextBridge, ipcRenderer } = require('electron');

// Channel names inlined rather than required from shared/ipc-channels.js —
// this overlay's own open/close/action channels are internal to it, same
// convention as tab-menu-preload.js/group-menu-preload.js (see their own
// comments for why).
contextBridge.exposeInMainWorld('permissionMenuAPI', {
  onOpen: (callback) => ipcRenderer.on('permission-menu:open', (_event, payload) => callback(payload)),
  onClose: (callback) => ipcRenderer.on('permission-menu:close', () => callback()),
  setState: (permission, state) => ipcRenderer.send('permission-menu:set-state', { permission, state }),
  close: () => ipcRenderer.send('permission-menu:close'),
  onThemeChanged: (callback) => {
    ipcRenderer.on('app:theme-changed', (_event, payload) => callback(payload));
  },
});
