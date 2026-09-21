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

// One targeted exception to "don't touch navigator": Google's login page
// (and others) probes for a platform passkey authenticator the moment it
// loads, via WebAuthn's *conditional* mediation (silent autofill-style
// discovery, no user action) — and Electron appears to escalate that
// straight to the native Windows Security dialog rather than staying quiet
// the way a browser with full conditional-UI support would (disabling the
// WebAuthenticationConditionalMediation Chromium feature alone didn't stop
// it). Only that silent path is blocked here; an explicit passkey sign-in
// the user actually triggers (a real "use a passkey" button, mediation not
// set to 'conditional') is left completely alone. contextBridge
// .executeInMainWorld is needed (not a plain assignment here) because this
// preload's own `window` is a separate, isolated-world object from the
// page's — see contextIsolation.
contextBridge.executeInMainWorld({
  func: () => {
    if (navigator.credentials) {
      const originalGet = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = (options) => {
        if (options && options.publicKey && options.mediation === 'conditional') {
          return Promise.reject(new DOMException('Conditional WebAuthn mediation is disabled in this app', 'NotAllowedError'));
        }
        return originalGet(options);
      };
    }
  },
});
