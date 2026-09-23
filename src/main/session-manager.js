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

// Short display names for the per-app "Site permissions" menu (see ipc.js) —
// PERMISSION_LABELS above is phrased for the prompt sentence instead
// ("wants to use your camera and microphone"), too long for a menu row.
const PERMISSION_MENU_LABELS = {
  media: 'Camera & Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard',
  'display-capture': 'Screen Sharing',
};

// Inner SVG shape markup (no wrapping <svg> tag) for each permission's icon
// in the permission-menu/permissions-page overlays — lucide-static icons
// (ISC license), copied inline the same way sidebar/index.html's own icons
// are (see that file's comment): no bundler, so these can't be loaded from
// node_modules at runtime; see node_modules/lucide-static/icons for the
// originals (camera.svg, map-pin.svg, bell.svg, clipboard.svg,
// screen-share.svg). There's no separate 'camera'/'microphone' pair to
// split media's icon between — see the 'media' comment on PERMISSION_LABELS.
const PERMISSION_ICONS = {
  media:
    '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" /><circle cx="12" cy="13" r="3" />',
  geolocation:
    '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" />',
  notifications:
    '<path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />',
  'clipboard-read':
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />',
  'display-capture':
    '<path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" /><path d="M8 21h8" /><path d="M12 17v4" /><path d="m17 8 5-5" /><path d="M17 3h5v5" />',
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

function deleteGrant(key) {
  const grants = loadGrants();
  delete grants[key];
  permissionStore.set('grants', grants);
}

// Reads/writes a grant by app rather than by raw origin — for the "Site
// permissions" submenu (see ipc.js), which only ever deals with an app's own
// primary origin, not the requestingUrl an in-page permission prompt saw
// (which could technically differ, e.g. an embedded iframe's origin; not
// worth exposing that distinction in a menu meant to unblock "I fat-fingered
// Block on this app").
function getAppPermissionState(app, permission) {
  const origin = originFromUrl(app.lastUrl || app.url);
  if (!origin) return 'ask';
  const key = grantKey(app.partition, origin, permission);
  const grants = loadGrants();
  if (!(key in grants)) return 'ask';
  return grants[key] ? 'allow' : 'block';
}

function setAppPermissionState(app, permission, state) {
  const origin = originFromUrl(app.lastUrl || app.url);
  if (!origin) return;
  const key = grantKey(app.partition, origin, permission);
  if (state === 'ask') {
    deleteGrant(key);
  } else {
    saveGrant(key, state === 'allow');
  }
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

module.exports = {
  getSessionForApp,
  PROMPT_PERMISSIONS,
  PERMISSION_MENU_LABELS,
  PERMISSION_ICONS,
  getAppPermissionState,
  setAppPermissionState,
};
