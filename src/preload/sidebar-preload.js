const { contextBridge, ipcRenderer } = require('electron');

// Channel names inlined to match shared/ipc-channels.js (see webview-preload.js
// for why this preload doesn't require the shared module directly).
contextBridge.exposeInMainWorld('electronAPI', {
  getApps: () => ipcRenderer.invoke('app:list'),
  switchApp: (appId) => ipcRenderer.invoke('app:switch', appId),
  addApp: (payload) => ipcRenderer.invoke('app:add', payload),
  removeApp: (appId) => ipcRenderer.invoke('app:remove', appId),
  reorderSidebar: (order) => ipcRenderer.invoke('app:reorder', order),
  createGroup: (sourceAppId, targetAppId) => ipcRenderer.invoke('app:create-group', { sourceAppId, targetAppId }),
  mergeIntoGroup: (groupId, appId) => ipcRenderer.invoke('app:merge-into-group', { groupId, appId }),
  reorderGroupMembers: (groupId, appIds) => ipcRenderer.invoke('app:reorder-group-members', { groupId, appIds }),
  ungroupApp: (appId) => ipcRenderer.invoke('app:ungroup', appId),
  onContextMenuUngroup: (callback) => {
    const listener = (_event, appId) => callback(appId);
    ipcRenderer.on('app:context-menu-ungroup', listener);
    return () => ipcRenderer.removeListener('app:context-menu-ungroup', listener);
  },
  hideActiveView: () => ipcRenderer.send('view:hide-active'),
  showActiveView: () => ipcRenderer.send('view:show-active'),
  openAppMenu: (position) => ipcRenderer.send('app:open-menu', position),
  openAppContextMenu: (appId, position, inGroup) =>
    ipcRenderer.send('app:open-context-menu', { appId, x: position.x, y: position.y, inGroup }),
  onContextMenuRemove: (callback) => {
    const listener = (_event, appId) => callback(appId);
    ipcRenderer.on('app:context-menu-remove', listener);
    return () => ipcRenderer.removeListener('app:context-menu-remove', listener);
  },
  navBack: () => ipcRenderer.send('view:nav-back'),
  navForward: () => ipcRenderer.send('view:nav-forward'),
  navReload: () => ipcRenderer.send('view:nav-reload'),
  getNavState: () => ipcRenderer.invoke('view:get-nav-state'),
  onNavStateChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('view:nav-state-changed', listener);
    return () => ipcRenderer.removeListener('view:nav-state-changed', listener);
  },
  onUnreadChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:unread-changed', listener);
    return () => ipcRenderer.removeListener('app:unread-changed', listener);
  },
  onMetaChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:meta-changed', listener);
    return () => ipcRenderer.removeListener('app:meta-changed', listener);
  },
});
