const { contextBridge, ipcRenderer } = require('electron');

// Set on this view's webPreferences.additionalArguments only for an
// unpackaged (dev) run — see view-manager.js's DEV_PRELOAD_ARGS — so the
// debug logging below never ships in a built release.
const isDev = process.argv.includes('--ballast-dev');

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
// Telegram Web and other PWA-style apps report unread counts via the
// Badging API instead of the document.title "(N)" trick unread-tracker.js's
// watchTitleCount watches for — Electron implements the real
// navigator.setAppBadge/clearAppBadge itself (it just sets the OS
// dock/taskbar badge for the whole app), so overriding them here still
// leaves that native behavior in place; this only adds forwarding the count
// to main so the sidebar can show it per pinned app. Same
// executeInMainWorld/window.electronAPI pattern as the WebAuthn override
// below — see contextIsolation.
contextBridge.executeInMainWorld({
  func: (debugLogging) => {
    // Dev-only debug logging for the Discord stuck-badge investigation —
    // see the isDev comment above for how this stays out of a release
    // build. Logged here (main world) rather than the preload's own
    // isolated-world scope so it shows up in DevTools' default console.
    if (debugLogging) {
      console.log('[Ballast debug] badge override installed; visibilityState=', document.visibilityState, 'hidden=', document.hidden);
      document.addEventListener('visibilitychange', () => {
        console.log('[Ballast debug] visibilitychange ->', document.visibilityState, 'hidden=', document.hidden);
      });
    }
    if (navigator.setAppBadge) {
      const originalSetAppBadge = navigator.setAppBadge.bind(navigator);
      navigator.setAppBadge = (contents) => {
        if (debugLogging) console.log('[Ballast debug] setAppBadge(', contents, ') at', new Date().toISOString());
        window.electronAPI.reportUnread(typeof contents === 'number' ? contents : 1);
        return originalSetAppBadge(contents);
      };
    }
    if (navigator.clearAppBadge) {
      const originalClearAppBadge = navigator.clearAppBadge.bind(navigator);
      navigator.clearAppBadge = () => {
        if (debugLogging) console.log('[Ballast debug] clearAppBadge() at', new Date().toISOString());
        window.electronAPI.reportUnread(0);
        return originalClearAppBadge();
      };
    }
  },
  args: [isDev],
});

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
