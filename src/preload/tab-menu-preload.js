const { contextBridge, ipcRenderer } = require('electron');

// Channel names inlined rather than requiring shared/ipc-channels.js — see
// tooltip-preload.js for why. Which tab this menu is currently open for is
// tracked on the main-process side (ViewManager.tabMenuContext), not passed
// back through these calls, since it's always exactly "whichever tab this
// overlay is currently positioned for."
contextBridge.exposeInMainWorld('tabMenuAPI', {
  onOpen: (callback) => ipcRenderer.on('tab-menu:open', (_event, payload) => callback(payload)),
  onClose: (callback) => ipcRenderer.on('tab-menu:close', () => callback()),
  navigate: (url) => ipcRenderer.send('tab-menu:navigate', url),
  duplicate: () => ipcRenderer.send('tab-menu:duplicate'),
  promote: () => ipcRenderer.send('tab-menu:promote'),
  setPrimary: () => ipcRenderer.send('tab-menu:set-primary'),
  openExternal: () => ipcRenderer.send('tab-menu:open-external'),
  onThemeChanged: (callback) => {
    ipcRenderer.on('app:theme-changed', (_event, payload) => callback(payload));
  },
});
