const { app, BrowserWindow, Menu, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const ViewManager = require('./view-manager');
const { registerIpcHandlers } = require('./ipc');
const configStore = require('./config-store');
const updater = require('./updater');
const { GET_THEME, THEME_CHANGED } = require('../renderer/shared/ipc-channels');

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

// Drives everything theme-related: nativeTheme.shouldUseDarkColors resolves
// 'system' against the OS automatically and fires 'updated' whenever that
// resolution changes, whether from an explicit Light/Dark/System menu pick
// or the OS's own theme changing while 'system' is selected.
nativeTheme.themeSource = configStore.getThemePreference();

// titleBarOverlay is OS-drawn (the window controls), not something CSS can
// reach — kept in sync with styles.css's own --bg/--text values by hand.
const TITLEBAR_COLORS = {
  dark: { color: '#1e1e1e', symbolColor: '#e8e8e8' },
  light: { color: '#ffffff', symbolColor: '#1c1e26' },
};

function currentTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function setThemePreference(pref) {
  configStore.setThemePreference(pref);
  nativeTheme.themeSource = pref; // no-ops if this doesn't actually change the resolved theme
}

// Synchronous on purpose: the sidebar's preload calls this once, at module
// load — before the page has painted anything — so its initial CSS state
// is correct immediately instead of flashing dark (the stylesheet's
// default) and then correcting a moment later once an async round-trip
// resolves.
ipcMain.on(GET_THEME, (event) => {
  event.returnValue = currentTheme();
});

let mainWindow;
let viewManager;

// Placeholder menu contents — just enough to reload/inspect/quit while
// iterating. Opened from the sidebar's hamburger button instead of a menu
// bar; see index.js's OPEN_APP_MENU handler in ipc.js.
const appMenu = Menu.buildFromTemplate([
  { label: 'Check for Updates...', click: () => updater.checkForUpdates({ silent: false }) },
  { type: 'separator' },
  {
    label: 'Theme',
    submenu: [
      { label: 'Light', type: 'radio', checked: configStore.getThemePreference() === 'light', click: () => setThemePreference('light') },
      { label: 'Dark', type: 'radio', checked: configStore.getThemePreference() === 'dark', click: () => setThemePreference('dark') },
      { label: 'System', type: 'radio', checked: configStore.getThemePreference() === 'system', click: () => setThemePreference('system') },
    ],
  },
  { type: 'separator' },
  // viewManager isn't assigned yet at this point (this template is built at
  // module load, before createWindow() runs) — reads it as a closure over
  // the `let viewManager` below instead, which is fine since a real click
  // can't happen until well after createWindow() has assigned it.
  { label: 'Manage site permissions...', click: () => viewManager.openPermissionsPage() },
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
    // Packaged builds get their icon from electron-builder.yml's `icon`
    // (baked into the .exe/.app itself); this is what shows in the
    // Windows taskbar during `npm start` instead of Electron's default —
    // doesn't affect the Dock icon on macOS, which is fixed to the app
    // bundle's icon regardless of this option.
    icon: path.join(__dirname, '..', '..', 'assets', 'icons', 'Ballast_Icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      ...TITLEBAR_COLORS[currentTheme()],
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'sidebar-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'sidebar', 'index.html'));

  viewManager = new ViewManager(mainWindow);
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

// Fires on every resolved-theme change, regardless of source (menu pick or
// the OS itself) — mainWindow/viewManager may not exist yet if this is the
// very first resolution during startup, before createWindow() has run;
// createWindow() already reads currentTheme() fresh for its own initial
// state, so skipping propagation here in that case loses nothing.
nativeTheme.on('updated', () => {
  if (!mainWindow || !viewManager) return;
  const theme = currentTheme();
  // win.setTitleBarOverlay() (the runtime setter, as opposed to the
  // constructor option used above) is documented Windows/Linux only —
  // guarded so an unsupported call on macOS can't take the rest of a
  // theme change down with it.
  try {
    mainWindow.setTitleBarOverlay({ ...TITLEBAR_COLORS[theme], height: 36 });
  } catch {
    // no-op — macOS
  }
  viewManager.setTheme(theme);
  mainWindow.webContents.send(THEME_CHANGED, { theme });
});

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
