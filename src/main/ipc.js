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
    configStore.removeApp(appId);
    viewManager.destroy(appId);

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

  ipcMain.on(channels.SHOW_TOOLTIP, (event, { text, x, y }) => viewManager.showTooltip(text, x, y));
  ipcMain.on(channels.HIDE_TOOLTIP, () => viewManager.hideTooltip());

  ipcMain.on(channels.OPEN_APP_MENU, (event, position) => {
    appMenu.popup({ window: mainWindow, x: position?.x, y: position?.y });
  });

  ipcMain.on(channels.OPEN_APP_CONTEXT_MENU, (event, { appId, x, y, inGroup }) => {
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
    ]);
    contextMenu.popup({ window: mainWindow, x, y });
  });

  ipcMain.on(channels.NAV_BACK, () => viewManager.navBack());
  ipcMain.on(channels.NAV_FORWARD, () => viewManager.navForward());
  ipcMain.on(channels.NAV_RELOAD, () => viewManager.navReload());
  ipcMain.handle(channels.NAV_GET_STATE, () => viewManager.getNavState());

  // REPORT_UNREAD handler lands in a later step (unread-tracker.js).
}

module.exports = { registerIpcHandlers };
