const { contextBridge, ipcRenderer } = require('electron');

// Channel names inlined to match shared/ipc-channels.js (see webview-preload.js
// for why this preload doesn't require the shared module directly).
contextBridge.exposeInMainWorld('electronAPI', {
  // Lets styles.css's body.platform-darwin rules account for macOS's
  // traffic-light window controls, which always sit top-left (unlike
  // Windows' titleBarOverlay, which draws them top-right) — see index.js.
  platform: process.platform,
  getApps: () => ipcRenderer.invoke('app:list'),
  switchApp: (appId) => ipcRenderer.invoke('app:switch', appId),
  addApp: (payload) => ipcRenderer.invoke('app:add', payload),
  removeApp: (appId) => ipcRenderer.invoke('app:remove', appId),
  moveSidebarItem: (itemType, itemId, referenceType, referenceId, before) =>
    ipcRenderer.invoke('app:move-sidebar-item', { itemType, itemId, referenceType, referenceId, before }),
  createGroup: (sourceAppId, targetAppId, before) =>
    ipcRenderer.invoke('app:create-group', { sourceAppId, targetAppId, before }),
  mergeIntoGroup: (groupId, appId, referenceAppId, before) =>
    ipcRenderer.invoke('app:merge-into-group', { groupId, appId, referenceAppId, before }),
  reorderGroupMembers: (groupId, appIds) => ipcRenderer.invoke('app:reorder-group-members', { groupId, appIds }),
  ungroupApp: (appId) => ipcRenderer.invoke('app:ungroup', appId),
  onContextMenuUngroup: (callback) => {
    const listener = (_event, appId) => callback(appId);
    ipcRenderer.on('app:context-menu-ungroup', listener);
    return () => ipcRenderer.removeListener('app:context-menu-ungroup', listener);
  },
  hideActiveView: () => ipcRenderer.send('view:hide-active'),
  showActiveView: () => ipcRenderer.send('view:show-active'),
  showTooltip: (text, x, y) => ipcRenderer.send('view:show-tooltip', { text, x, y }),
  hideTooltip: () => ipcRenderer.send('view:hide-tooltip'),
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
  switchTab: (appId, tabId) => ipcRenderer.invoke('tabs:switch', { appId, tabId }),
  closeTab: (appId, tabId) => ipcRenderer.invoke('tabs:close', { appId, tabId }),
  reorderTabs: (appId, tabIds) => ipcRenderer.invoke('tabs:reorder', { appId, tabIds }),
  onTabsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('tabs:changed', listener);
    return () => ipcRenderer.removeListener('tabs:changed', listener);
  },
  onActiveViewChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('view:active-changed', listener);
    return () => ipcRenderer.removeListener('view:active-changed', listener);
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
  openTabMenu: (appId, tabId, position) =>
    ipcRenderer.send('tab-menu:show', { appId, tabId, x: position.x, y: position.y }),
  closeTabMenu: () => ipcRenderer.send('tab-menu:hide'),
  openTabContextMenu: (appId, tabId, position) =>
    ipcRenderer.send('tabs:context-menu', { appId, tabId, x: position.x, y: position.y }),
  onAppsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:list-changed', listener);
    return () => ipcRenderer.removeListener('app:list-changed', listener);
  },
  // Resolved synchronously (blocking, at preload load time — before the
  // page paints) rather than an async invoke, so the sidebar's very first
  // render already has the right theme instead of flashing dark (the
  // stylesheet's default) and correcting a moment later.
  initialTheme: ipcRenderer.sendSync('app:get-theme'),
  onThemeChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:theme-changed', listener);
    return () => ipcRenderer.removeListener('app:theme-changed', listener);
  },
});
