const { session } = require('electron');

const configuredPartitions = new Set();

// Without an explicit handler here, a page can't be sure whether e.g.
// Notification permission is actually granted in this embedded context —
// which is why Google Calendar's reminder popups were falling back to an
// in-page alert() instead of a real OS notification. Explicitly allowing
// everything makes that guaranteed rather than relying on however
// Electron's own unconfigured default happens to behave, matching what the
// architecture doc's "no extra code required" always assumed would happen.
function configurePermissions(partitionSession, partitionName) {
  if (configuredPartitions.has(partitionName)) return;
  configuredPartitions.add(partitionName);

  partitionSession.setPermissionRequestHandler((webContents, permission, callback) => callback(true));
  partitionSession.setPermissionCheckHandler(() => true);
}

function getSessionForApp(app) {
  // 'persist:xxx' survives restarts; without 'persist:' it's in-memory only
  const partitionSession = session.fromPartition(app.partition, { cache: true });
  configurePermissions(partitionSession, app.partition);
  return partitionSession;
}

module.exports = { getSessionForApp };
