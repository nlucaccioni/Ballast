const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const ViewManager = require('./view-manager');
const { registerIpcHandlers } = require('./ipc');
const configStore = require('./config-store');

let mainWindow;

// Placeholder menu contents — just enough to reload/inspect/quit while
// iterating. Opened from the sidebar's hamburger button instead of a menu
// bar; see index.js's OPEN_APP_MENU handler in ipc.js.
const appMenu = Menu.buildFromTemplate([
  { role: 'reload' },
  { role: 'forceReload' },
  { role: 'toggleDevTools' },
  { type: 'separator' },
  { role: 'resetZoom' },
  { role: 'zoomIn' },
  { role: 'zoomOut' },
  { type: 'separator' },
  { role: 'togglefullscreen' },
  { type: 'separator' },
  { role: 'quit' },
]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Ballast',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1e1e1e',
      symbolColor: '#e8e8e8',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'sidebar-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'sidebar', 'index.html'));

  const viewManager = new ViewManager(mainWindow);
  registerIpcHandlers(viewManager, mainWindow, appMenu);

  const apps = configStore.getApps();
  viewManager.warmUp(apps);
  const firstApp = configStore.getFirstApp();
  if (firstApp) viewManager.show(firstApp.id, firstApp);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
