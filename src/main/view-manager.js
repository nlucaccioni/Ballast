const { WebContentsView, shell } = require('electron');
const path = require('path');
const { getSessionForApp } = require('./session-manager');
const { rootDomain } = require('./url-utils');
const { watchTitleCount } = require('./unread-tracker');
const configStore = require('./config-store');
const { APP_META_CHANGED, NAV_STATE_CHANGED, UNREAD_CHANGED } = require('../renderer/shared/ipc-channels');

const SIDEBAR_WIDTH = 46; // adjust to final design; must match --sidebar-width in sidebar/styles.css
const TITLEBAR_HEIGHT = 36; // must match --titlebar-height in sidebar/styles.css
// Matches the sidebar app-button's border-radius (styles.css .app-button);
// adjust the value here and in corner-mask/index.html together if it looks off.
const CORNER_RADIUS = 7;

// Hostnames that look like an identity provider (accounts.google.com,
// login.microsoftonline.com, ...) even when they're on a different root
// domain than the app itself — covers third-party/federated SSO.
const AUTH_SUBDOMAIN_PATTERN = /^(accounts|login|signin|auth|sso|id)\./i;

class ViewManager {
  constructor(win) {
    this.win = win;
    this.views = new Map(); // appId -> WebContentsView
    this.meta = new Map(); // appId -> { title, faviconUrl }
    this.unread = new Map(); // appId -> count
    this.activeId = null;

    this.win.on('resize', () => {
      if (this.activeId) this.layout(this.views.get(this.activeId));
    });

    // Electron has no API to round a WebContentsView's own corner, so this
    // is a small transparent overlay painted with an inverse-rounded-corner
    // shape, sitting exactly over the content view's top-left corner.
    this.cornerMask = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    this.cornerMask.setBackgroundColor('#00000000');
    this.cornerMask.webContents.loadFile(
      path.join(__dirname, '..', 'renderer', 'corner-mask', 'index.html')
    );
    this.cornerMask.setBounds({
      x: SIDEBAR_WIDTH,
      y: TITLEBAR_HEIGHT,
      width: CORNER_RADIUS,
      height: CORNER_RADIUS,
    });
    this.win.contentView.addChildView(this.cornerMask);
  }

  // Re-adding an existing child view moves it to the top of the z-order, so
  // call this after any addChildView() that might otherwise bury the mask
  // under the app view it just attached.
  raiseCornerMask() {
    this.win.contentView.addChildView(this.cornerMask);
  }

  getOrCreate(app) {
    if (this.views.has(app.id)) return this.views.get(app.id);

    const view = new WebContentsView({
      webPreferences: {
        session: getSessionForApp(app),
        preload: path.join(__dirname, '..', 'preload', 'webview-preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    view.webContents.loadURL(app.url);

    // window.open() (Google's account chooser, SSO redirects, "open in new
    // tab" links, ...) would otherwise spawn an unmanaged native
    // BrowserWindow outside the app shell. Auth-flow-like or same-provider
    // targets navigate this same view instead so login completes in place;
    // anything else is treated as an outbound link and opens in the user's
    // regular browser.
    const appRootDomain = rootDomain(new URL(app.url).hostname);
    view.webContents.setWindowOpenHandler(({ url }) => {
      let targetHost;
      try {
        targetHost = new URL(url).hostname;
      } catch {
        return { action: 'deny' };
      }

      const isSameProvider = rootDomain(targetHost) === appRootDomain;
      const looksLikeAuth = AUTH_SUBDOMAIN_PATTERN.test(targetHost);

      if (isSameProvider || looksLikeAuth) {
        view.webContents.loadURL(url);
      } else {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    view.webContents.on('page-favicon-updated', (event, favicons) => {
      this.updateMeta(app.id, { faviconUrl: favicons[0] || null });
    });
    view.webContents.on('page-title-updated', (event, title) => {
      this.updateMeta(app.id, { title });
    });

    if (app.unreadStrategy === 'title-count') {
      watchTitleCount(view, (count) => this.updateUnread(app.id, count));
    }

    view.webContents.on('did-navigate', (event, url) => {
      this.emitNavState(app.id);
      this.maybeGraduateFromSearch(app.id, url);
    });
    view.webContents.on('did-navigate-in-page', () => this.emitNavState(app.id));

    this.views.set(app.id, view);
    return view;
  }

  // If an app is still pinned to a search-results page (from the add-app
  // omnibox not knowing the real URL) and the user clicks through to an
  // actual site, repoint the pinned app at it so it's what reopens next
  // launch. Only fires while the *stored* URL is still a search engine's —
  // once graduated, ordinary in-app navigation never re-triggers this.
  maybeGraduateFromSearch(appId, newUrl) {
    const app = configStore.getApp(appId);
    if (!app) return;
    let currentRoot, newRoot;
    try {
      currentRoot = rootDomain(new URL(app.url).hostname);
      newRoot = rootDomain(new URL(newUrl).hostname);
    } catch {
      return;
    }
    if (!configStore.SEARCH_ENGINE_ROOT_DOMAINS.has(currentRoot) || newRoot === currentRoot) return;
    configStore.updateAppUrl(appId, newUrl);
  }

  emitNavState(appId) {
    const view = this.views.get(appId);
    if (!view) return;
    const { navigationHistory } = view.webContents;
    this.win.webContents.send(NAV_STATE_CHANGED, {
      appId,
      canGoBack: navigationHistory.canGoBack(),
      canGoForward: navigationHistory.canGoForward(),
    });
  }

  navBack() {
    const view = this.views.get(this.activeId);
    view?.webContents.navigationHistory.goBack();
  }

  navForward() {
    const view = this.views.get(this.activeId);
    view?.webContents.navigationHistory.goForward();
  }

  navReload() {
    const view = this.views.get(this.activeId);
    view?.webContents.reload();
  }

  getNavState() {
    const view = this.views.get(this.activeId);
    if (!view) return { appId: null, canGoBack: false, canGoForward: false };
    const { navigationHistory } = view.webContents;
    return {
      appId: this.activeId,
      canGoBack: navigationHistory.canGoBack(),
      canGoForward: navigationHistory.canGoForward(),
    };
  }

  // Create (and start loading) every configured app's view up front so
  // sidebar favicons/titles are available without requiring a click first.
  // Only one view is ever attached/visible at a time — see show().
  warmUp(apps) {
    apps.forEach((app) => this.getOrCreate(app));
  }

  updateMeta(appId, partial) {
    const current = this.meta.get(appId) || {};
    const next = { ...current, ...partial };
    this.meta.set(appId, next);
    this.win.webContents.send(APP_META_CHANGED, { appId, ...next });
  }

  getMeta(appId) {
    return this.meta.get(appId) || {};
  }

  getAllMeta() {
    return Object.fromEntries(this.meta);
  }

  updateUnread(appId, count) {
    this.unread.set(appId, count);
    this.win.webContents.send(UNREAD_CHANGED, { appId, count });
  }

  getUnreadCount(appId) {
    return this.unread.get(appId) || 0;
  }

  show(appId, app) {
    const view = this.getOrCreate(app);
    if (this.activeId && this.activeId !== appId) {
      this.win.contentView.removeChildView(this.views.get(this.activeId));
    }
    if (this.activeId !== appId) {
      this.win.contentView.addChildView(view);
    }
    this.layout(view);
    this.raiseCornerMask();
    this.activeId = appId;
    this.emitNavState(appId);
  }

  layout(view) {
    if (!view) return;
    const [width, height] = this.win.getContentSize();
    view.setBounds({
      x: SIDEBAR_WIDTH,
      y: TITLEBAR_HEIGHT,
      width: width - SIDEBAR_WIDTH,
      height: height - TITLEBAR_HEIGHT,
    });
  }

  // WebContentsViews render as a native layer on top of the sidebar's own
  // page, so full-window sidebar UI (dialogs, etc.) needs the active view
  // detached first or it'll be covered everywhere but the sidebar strip.
  hideActive() {
    if (this.activeId) this.win.contentView.removeChildView(this.views.get(this.activeId));
  }

  showActive() {
    if (!this.activeId) return;
    const view = this.views.get(this.activeId);
    this.win.contentView.addChildView(view);
    this.layout(view);
    this.raiseCornerMask();
  }

  // WebContentsView has no explicit destroy() — dropping the last reference
  // (after detaching it here) is what lets Electron tear down its WebContents.
  destroy(appId) {
    const view = this.views.get(appId);
    if (!view) return;
    if (this.activeId === appId) {
      this.win.contentView.removeChildView(view);
      this.activeId = null;
    }
    this.views.delete(appId);
    this.meta.delete(appId);
    this.unread.delete(appId);
  }
}

module.exports = ViewManager;
