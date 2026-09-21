const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const ViewManager = require('./view-manager');
const { registerIpcHandlers } = require('./ipc');
const configStore = require('./config-store');
const updater = require('./updater');

// Google's login page (and others) proactively probe for available
// passkeys the moment it loads, via WebAuthn's "conditional UI" — in a
// browser that fully supports it this is silent (just an autofill hint),
// but it seems to escalate straight to the native Windows Security passkey
// dialog here, unprompted, before the user's done anything. Must be set
// before app is ready. We don't support in-app passkey login anyway, so
// just disable the proactive check; an explicit "sign in with a passkey"
// button (a user action, not page-load) is unaffected.
app.commandLine.appendSwitch('disable-features', 'WebAuthenticationConditionalMediation');

// Without this, every launch (a second double-click of the installed app,
// running `npm start` while a packaged build is already open, ...) spawns
// a brand new process pointed at the same userData directory instead of
// reusing the one already running — and since every pinned app's session
// partition lives under that same directory, multiple processes fighting
// over the same cache/IndexedDB/lock files there is what produces things
// like "Unable to move the cache" errors and pages failing to load
// correctly. Bail out immediately if another instance already holds the
// lock; that instance's 'second-instance' handler below focuses its
// window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow;

// Placeholder menu contents — just enough to reload/inspect/quit while
// iterating. Opened from the sidebar's hamburger button instead of a menu
// bar; see index.js's OPEN_APP_MENU handler in ipc.js.
const appMenu = Menu.buildFromTemplate([
  { label: 'Check for Updates...', click: () => updater.checkForUpdates({ silent: false }) },
  { type: 'separator' },
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

  updater.init(mainWindow);
  // Delayed so it never competes with initial app/favicon loading for
  // bandwidth or attention; silent, so it only shows UI if there's
  // actually something new.
  setTimeout(() => updater.checkForUpdates({ silent: true }), 10_000);
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

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
