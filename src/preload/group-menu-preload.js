const { contextBridge, ipcRenderer } = require('electron');

// Channel names inlined rather than requiring shared/ipc-channels.js — see
// tooltip-preload.js for why. Which group this menu is currently open for is
// tracked on the main-process side (ViewManager.groupMenuContext), not
// passed back through these calls, since it's always exactly "whichever
// group this overlay is currently positioned for."
contextBridge.exposeInMainWorld('groupMenuAPI', {
  onOpen: (callback) => ipcRenderer.on('group-menu:open', (_event, payload) => callback(payload)),
  onClose: (callback) => ipcRenderer.on('group-menu:close', () => callback()),
  setColor: (color) => ipcRenderer.send('group-menu:set-color', color),
  setLabel: (label) => ipcRenderer.send('group-menu:set-label', label),
  close: () => ipcRenderer.send('group-menu:close'),
  onThemeChanged: (callback) => {
    ipcRenderer.on('app:theme-changed', (_event, payload) => callback(payload));
  },
});
