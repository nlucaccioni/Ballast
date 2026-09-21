const { app, dialog, shell, net } = require('electron');
const { autoUpdater } = require('electron-updater');

const REPO = 'nlucaccioni/ballast';

let win = null;
// Only the manually-triggered ("Check for Updates..." menu item) path shows
// a "you're up to date" / error dialog — the quiet startup check should
// only ever surface UI when there's actually something to do.
let manualCheckInFlight = false;

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

function showUpToDate() {
  if (!manualCheckInFlight) return;
  dialog.showMessageBox(win, { type: 'info', title: 'No updates', message: "You're up to date." });
}

function showCheckFailed(detail) {
  if (!manualCheckInFlight) return;
  dialog.showMessageBox(win, {
    type: 'error',
    title: 'Update check failed',
    message: 'Could not check for updates.',
    detail,
  });
}

// Windows: electron-updater/Squirrel can apply an update unsigned, so we
// get the full in-app download-and-install flow — just driven by our own
// prompts instead of the silent default, so nothing installs without the
// user agreeing to it first.
function initWindowsUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `Ballast ${info.version} is available (you have ${app.getVersion()}). Download it now?`,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
      });
  });

  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: 'The update has been downloaded. Restart Ballast to install it?',
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on('update-not-available', showUpToDate);
  autoUpdater.on('error', (err) => showCheckFailed(err?.message));
}

// macOS: Squirrel.Mac refuses to apply an update to an unsigned app no
// matter how the check is triggered — the signature check happens when it
// tries to apply, not just as a "quiet" convenience — and we don't have an
// Apple Developer cert to sign with yet. So instead of electron-updater's
// real apply path, just compare against the latest GitHub release tag and,
// if newer, hand the user to the release page to download the DMG
// themselves.
function checkMacRelease() {
  const request = net.request({
    method: 'GET',
    url: `https://api.github.com/repos/${REPO}/releases/latest`,
  });
  request.setHeader('User-Agent', 'Ballast-Updater');
  request.setHeader('Accept', 'application/vnd.github+json');

  let body = '';
  request.on('response', (response) => {
    response.on('data', (chunk) => {
      body += chunk;
    });
    response.on('end', () => {
      let release;
      try {
        release = JSON.parse(body);
      } catch {
        showCheckFailed();
        return;
      }

      const latestVersion = (release.tag_name || '').replace(/^v/, '');
      const currentVersion = app.getVersion();
      if (!latestVersion || !isNewer(latestVersion, currentVersion)) {
        showUpToDate();
        return;
      }

      dialog
        .showMessageBox(win, {
          type: 'info',
          buttons: ['Open Download Page', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update available',
          message: `Ballast ${latestVersion} is available (you have ${currentVersion}).`,
          detail: 'macOS updates are installed manually — this opens the release page to download the new version.',
        })
        .then(({ response: idx }) => {
          if (idx === 0) shell.openExternal(release.html_url || `https://github.com/${REPO}/releases/latest`);
        });
    });
  });
  request.on('error', () => showCheckFailed());
  request.end();
}

function init(mainWindow) {
  win = mainWindow;
  if (process.platform === 'win32') initWindowsUpdater();
}

function checkForUpdates({ silent = false } = {}) {
  // Unpackaged/dev runs aren't a real published version — nothing to
  // compare against, and electron-updater errors loudly if asked to try.
  if (!app.isPackaged) return;

  manualCheckInFlight = !silent;

  if (process.platform === 'win32') {
    autoUpdater.checkForUpdates().catch((err) => showCheckFailed(err?.message));
  } else if (process.platform === 'darwin') {
    checkMacRelease();
  }
}

module.exports = { init, checkForUpdates };
