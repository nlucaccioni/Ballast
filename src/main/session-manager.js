const { session } = require('electron');

function getSessionForApp(app) {
  // 'persist:xxx' survives restarts; without 'persist:' it's in-memory only
  return session.fromPartition(app.partition, { cache: true });
}

module.exports = { getSessionForApp };
