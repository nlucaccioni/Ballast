const { ipcMain, Menu } = require('electron');
const channels = require('../renderer/shared/ipc-channels');
const configStore = require('./config-store');

function registerIpcHandlers(viewManager, mainWindow, appMenu) {
  ipcMain.handle(channels.GET_APPS, () => ({
    apps: configStore.getApps().map((app) => ({
      ...app,
      ...viewManager.getMeta(app.id),
      unreadCount: viewManager.getUnreadCount(app.id),
    })),
    groups: configStore.getGroups(),
    items: configStore.getSidebarOrder(),
  }));

  ipcMain.handle(channels.SWITCH_APP, (event, appId) => {
    const app = configStore.getApp(appId);
    if (!app) throw new Error(`Unknown app id: ${appId}`);
    viewManager.show(appId, app);
    return { activeId: appId };
  });

  ipcMain.handle(channels.ADD_APP, async (event, { url }) => {
    if (!url) throw new Error('addApp requires a url');
    const app = await configStore.addApp({ url });
    viewManager.warmUp([app]);
    return app;
  });

  ipcMain.handle(channels.REMOVE_APP, (event, appId) => {
    const wasActive = viewManager.activeId === appId;
    // destroy() looks up this app's open tabs to tear them down too — it
    // has to run before the app record (and those tabs with it) is deleted.
    viewManager.destroy(appId);
    configStore.removeApp(appId);

    let newActiveId = null;
    if (wasActive) {
      const nextApp = configStore.getFirstApp();
      if (nextApp) {
        newActiveId = nextApp.id;
        viewManager.show(nextApp.id, nextApp);
      }
    }
    return { removedId: appId, newActiveId };
  });

  ipcMain.handle(channels.MOVE_SIDEBAR_ITEM, (event, { itemType, itemId, referenceType, referenceId, before }) => {
    configStore.moveSidebarItem(itemType, itemId, referenceType, referenceId, before);
    return {};
  });

  ipcMain.handle(channels.CREATE_GROUP, (event, { sourceAppId, targetAppId, before }) => {
    const group = configStore.createGroupFromApps(sourceAppId, targetAppId, before);
    return { group };
  });

  ipcMain.handle(channels.MERGE_INTO_GROUP, (event, { groupId, appId, referenceAppId, before }) => {
    configStore.addAppToGroup(groupId, appId, referenceAppId, before);
    return {};
  });

  ipcMain.handle(channels.UNGROUP_APP, (event, appId) => {
    configStore.removeAppFromGroup(appId);
    return {};
  });

  ipcMain.handle(channels.REORDER_GROUP_MEMBERS, (event, { groupId, appIds }) => {
    configStore.reorderGroupMembers(groupId, appIds);
    return {};
  });

  ipcMain.on(channels.HIDE_ACTIVE_VIEW, () => viewManager.hideActive());
  ipcMain.on(channels.SHOW_ACTIVE_VIEW, () => viewManager.showActive());

  ipcMain.on(channels.SHOW_TOOLTIP, (event, { title, label, x, y }) => viewManager.showTooltip(title, label, x, y));
  ipcMain.on(channels.HIDE_TOOLTIP, () => viewManager.hideTooltip());

  ipcMain.on(channels.OPEN_APP_MENU, (event, position) => {
    appMenu.popup({ window: mainWindow, x: position?.x, y: position?.y });
  });

  ipcMain.on(channels.OPEN_APP_CONTEXT_MENU, (event, { appId, x, y, inGroup }) => {
    const group = inGroup ? configStore.getGroups().find((g) => g.appIds.includes(appId)) : null;
    const contextMenu = Menu.buildFromTemplate([
      ...(inGroup
        ? [
            {
              label: 'Remove from group',
              click: () => mainWindow.webContents.send(channels.APP_CONTEXT_MENU_UNGROUP, appId),
            },
          ]
        : []),
      {
        label: 'Remove from sidebar',
        click: () => mainWindow.webContents.send(channels.APP_CONTEXT_MENU_REMOVE, appId),
      },
      ...(group
        ? [{ type: 'separator' }, { label: 'Customize group...', click: () => viewManager.openGroupMenu(group.id, x, y) }]
        : []),
    ]);
    contextMenu.popup({ window: mainWindow, x, y });
  });

  // Right-clicking empty space inside a group's own container (not one of
  // its app buttons, which have their own menu above) — opens the same
  // color/label popover directly, with nothing else to pick from a native
  // menu first.
  ipcMain.on(channels.OPEN_GROUP_CONTEXT_MENU, (event, { groupId, x, y }) => {
    viewManager.openGroupMenu(groupId, x, y);
  });

  ipcMain.on(channels.NAV_BACK, () => viewManager.navBack());
  ipcMain.on(channels.NAV_FORWARD, () => viewManager.navForward());
  ipcMain.on(channels.NAV_RELOAD, () => viewManager.navReload());
  ipcMain.handle(channels.NAV_GET_STATE, () => viewManager.getNavState());

  ipcMain.handle(channels.SWITCH_TAB, (event, { appId, tabId }) => {
    if (!tabId) {
      viewManager.showAppPrimary(appId);
      return {};
    }
    const tab = configStore.getTabs(appId).find((t) => t.id === tabId);
    if (tab) viewManager.showTab(appId, tab);
    return {};
  });

  ipcMain.handle(channels.CLOSE_TAB, (event, { appId, tabId }) => {
    viewManager.closeTab(appId, tabId);
    return {};
  });

  ipcMain.handle(channels.REORDER_TABS, (event, { appId, tabIds }) => {
    viewManager.reorderTabs(appId, tabIds);
    return {};
  });

  ipcMain.on(channels.OPEN_TAB_MENU, (event, { appId, tabId, x, y }) => viewManager.openTabMenu(appId, tabId, x, y));
  ipcMain.on(channels.CLOSE_TAB_MENU, () => viewManager.closeTabMenu());

  // Plain OS right-click menu — doesn't switch focus to the chip first,
  // unlike the URL-field overlay above (which needs to be looking at a
  // live view to show its current address).
  ipcMain.on(channels.OPEN_TAB_CONTEXT_MENU, (event, { appId, tabId, x, y }) => {
    const isPrimary = !tabId;
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Duplicate tab', click: () => viewManager.duplicateTab(appId, tabId) },
      ...(isPrimary
        ? []
        : [
            { label: 'Open as new app', click: () => viewManager.promoteTab(appId, tabId) },
            { label: 'Set as primary', click: () => viewManager.setTabPrimary(appId, tabId) },
          ]),
      { label: 'Open in default browser', click: () => viewManager.openTabExternal(appId, tabId) },
    ]);
    contextMenu.popup({ window: mainWindow, x, y });
  });

  // These come from the tab-menu overlay's own preload (tab-menu-preload.js),
  // which inlines its channel names rather than requiring shared/ipc-channels
  // (see tooltip-preload.js for why) — not from channels.* above.
  ipcMain.on('tab-menu:navigate', (event, url) => viewManager.tabMenuNavigate(url));
  ipcMain.on('tab-menu:duplicate', () => viewManager.tabMenuDuplicate());
  ipcMain.on('tab-menu:promote', () => viewManager.tabMenuPromote());
  ipcMain.on('tab-menu:set-primary', () => viewManager.tabMenuSetPrimary());
  ipcMain.on('tab-menu:open-external', () => viewManager.tabMenuOpenExternal());

  // Same deal for the group color/label popover's own preload
  // (group-menu-preload.js) — 'group-menu:close' is also sent from the
  // sidebar's own preload (see sidebar-preload.js's closeGroupMenu) when a
  // click lands elsewhere in the sidebar; both land here identically since
  // closing doesn't need to know which one asked.
  ipcMain.on('group-menu:set-color', (event, color) => viewManager.groupMenuSetColor(color));
  ipcMain.on('group-menu:set-label', (event, label) => viewManager.groupMenuSetLabel(label));
  ipcMain.on('group-menu:close', () => viewManager.closeGroupMenu());

  // GET_THEME is handled synchronously in main/index.js itself (ipcMain.on
  // + event.returnValue), not here — see its own comment for why.

  // REPORT_UNREAD is handled per-view via webContents.ipc, not here — see
  // unread-tracker.js's watchAppBadge for why (it needs the view's own
  // appId, which a shared ipcMain handler here doesn't have without extra
  // event.sender bookkeeping).
}

module.exports = { registerIpcHandlers };
