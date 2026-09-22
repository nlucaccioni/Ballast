const { session, dialog } = require('electron');
const Store = require('electron-store');

const permissionStore = new Store({ name: 'permissions' });

const configuredPartitions = new Set();

// Sensitive enough that a site shouldn't get them without the user actually
// seeing and approving the request — mirrors what Chrome itself gates
// behind its address-bar permission bubble.
const PROMPT_PERMISSIONS = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'display-capture']);

// None of the apps this is built for (Gmail, Slack, Calendar, ...) have a
// legitimate use for these; deny outright instead of prompting for
// something a user has no context to judge.
const DENY_PERMISSIONS = new Set(['midi', 'midiSysex', 'hid', 'serial', 'usb', 'window-management']);

const PERMISSION_LABELS = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'share your screen',
};

function originFromUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Grants are keyed by partition+origin+permission and stored as a flat
// object (not via electron-store's own dot-notation key addressing, which
// would otherwise mis-parse an origin like "https://mail.google.com" as a
// nested path) so a choice made for one site doesn't leak to another that
// merely shares the same partition/session.
function grantKey(partitionName, origin, permission) {
  return `${partitionName}|${origin}|${permission}`;
}

function loadGrants() {
  return permissionStore.get('grants', {});
}

function saveGrant(key, allow) {
  const grants = loadGrants();
  grants[key] = allow;
  permissionStore.set('grants', grants);
}

function configurePermissions(partitionSession, partitionName, win) {
  if (configuredPartitions.has(partitionName)) return;
  configuredPartitions.add(partitionName);

  partitionSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = originFromUrl(details.requestingUrl || webContents.getURL());
    if (!origin) {
      callback(false);
      return;
    }

    const key = grantKey(partitionName, origin, permission);
    const grants = loadGrants();
    if (key in grants) {
      callback(grants[key]);
      return;
    }

    if (DENY_PERMISSIONS.has(permission)) {
      saveGrant(key, false);
      callback(false);
      return;
    }

    if (!PROMPT_PERMISSIONS.has(permission)) {
      // Low-risk / needed for normal app function (fullscreen, pointer
      // lock, background sync, ...) — allow without prompting. Not
      // persisted, so narrowing this list later doesn't require migrating
      // stored grants.
      callback(true);
      return;
    }

    const label = PERMISSION_LABELS[permission] || permission;
    dialog
      .showMessageBox(win, {
        type: 'question',
        buttons: ['Block', 'Allow'],
        defaultId: 1,
        cancelId: 0,
        title: 'Permission request',
        message: `${origin} wants to ${label}.`,
      })
      .then(({ response }) => {
        const allow = response === 1;
        saveGrant(key, allow);
        callback(allow);
      });
  });

  partitionSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const key = grantKey(partitionName, requestingOrigin, permission);
    const grants = loadGrants();
    if (key in grants) return grants[key];
    return !PROMPT_PERMISSIONS.has(permission) && !DENY_PERMISSIONS.has(permission);
  });
}

const configuredDownloadSessions = new Set();

// Without this, session.downloadURL() (what the context menu's "Save
// as.../Save link as..." use) saves silently straight to the default
// Downloads folder — no prompt at all. A real browser always asks where.
function configureDownloads(partitionSession, win) {
  if (configuredDownloadSessions.has(partitionSession)) return;
  configuredDownloadSessions.add(partitionSession);

  partitionSession.on('will-download', (event, item) => {
    const savePath = dialog.showSaveDialogSync(win, { defaultPath: item.getFilename() });
    if (!savePath) {
      item.cancel();
      return;
    }
    item.setSavePath(savePath);
  });
}

function getSessionForApp(app, win) {
  // 'persist:xxx' survives restarts; without 'persist:' it's in-memory only
  const partitionSession = session.fromPartition(app.partition, { cache: true });
  configurePermissions(partitionSession, app.partition, win);
  configureDownloads(partitionSession, win);
  return partitionSession;
}

module.exports = { getSessionForApp };
