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
// loads, and Electron appears to escalate that straight to the native
// Windows Security dialog rather than staying silent the way a fully
// WebAuthn-conditional-UI-capable browser would (disabling the
// WebAuthenticationConditionalMediation Chromium feature didn't stop it).
// We don't support in-app passkey login, so just report no platform
// authenticator is available — sites fall back to their normal
// password/2FA flow instead. contextBridge.executeInMainWorld is needed
// (not a plain assignment here) because this preload's own `window` is a
// separate, isolated-world object from the page's — see contextIsolation.
contextBridge.executeInMainWorld({
  func: () => {
    if (window.PublicKeyCredential) {
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
      if (window.PublicKeyCredential.isConditionalMediationAvailable) {
        window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
      }
    }
    if (navigator.credentials) {
      const originalGet = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = (options) => {
        if (options && options.publicKey) {
          return Promise.reject(new DOMException('WebAuthn is disabled in this app', 'NotAllowedError'));
        }
        return originalGet(options);
      };
    }
  },
});
