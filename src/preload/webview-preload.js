const { contextBridge, ipcRenderer } = require('electron');

// Kept minimal on purpose — see spec section 10: sites can revoke
// notification permission if they detect an automated/headless context,
// so avoid touching `navigator` or other fingerprintable globals here.
// Channel name is inlined (matches shared/ipc-channels.js REPORT_UNREAD)
// rather than required, since sandboxed preloads shouldn't reach outside
// electron/node builtins for local file requires.
contextBridge.exposeInMainWorld('electronAPI', {
  reportUnread: (count) => ipcRenderer.send('app:report-unread', count),
});
