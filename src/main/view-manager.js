const { WebContentsView, shell } = require('electron');
const path = require('path');
const { getSessionForApp } = require('./session-manager');
const { rootDomain, looksLikeAuthFlow } = require('./url-utils');
const { watchTitleCount } = require('./unread-tracker');
const configStore = require('./config-store');
const { APP_META_CHANGED, NAV_STATE_CHANGED, UNREAD_CHANGED } = require('../renderer/shared/ipc-channels');

const SIDEBAR_WIDTH = 54; // adjust to final design; must match --sidebar-width in sidebar/styles.css
const TITLEBAR_HEIGHT = 36; // must match --titlebar-height in sidebar/styles.css
// Matches the sidebar app-button's border-radius (styles.css .app-button);
// adjust the value here and in corner-mask/index.html together if it looks off.
const CORNER_RADIUS = 7;
// The webview itself can't take a CSS border (it's a native view), so its
// bounds are inset by this much on the top/left and #webview-border-top/
// -left (styles.css) draw a line in the resulting gap.
const BORDER_WIDTH = 1;
// The corner mask's box needs to be this much bigger than CORNER_RADIUS
// alone so its border ring's outer edge lands exactly at the real radius —
// see corner-mask/index.html. Must match --corner-box-size in styles.css.
const CORNER_BOX_SIZE = CORNER_RADIUS + BORDER_WIDTH;
// Generous fixed size for the tooltip overlay box — the tooltip pill inside
// it is left-aligned and sized to its own text (with ellipsis if it doesn't
// fit), so this only needs to be large enough for realistic titles.
const TOOLTIP_WIDTH = 260;
const TOOLTIP_HEIGHT = 24;

// Electron's default UA appends "Electron/x.y.z", which is exactly what
// sites like WhatsApp Web and Teams sniff for to show an "unsupported
// browser, please update" nag — regardless of how current the actual
// Chromium underneath is (see spec section 10). Presenting as plain desktop
// Chrome, at the real Chromium version this build ships, avoids that
// without actually lying about the rendering engine. Windows-only for now;
// revisit the platform string if/when macOS support is added.
const DESKTOP_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${process.versions.chrome} Safari/537.36`;

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
      width: CORNER_BOX_SIZE,
      height: CORNER_BOX_SIZE,
    });
    this.win.contentView.addChildView(this.cornerMask);

    // Same problem, same fix, for tooltips: a plain HTML tooltip in the
    // sidebar's own page renders *underneath* the active app view wherever
    // the two overlap, which is most of a tooltip's width once the sidebar
    // is as narrow as it is. This overlay sits above the app view instead.
    this.tooltipOverlay = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'tooltip-preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.tooltipOverlay.setBackgroundColor('#00000000');
    this.tooltipOverlay.webContents.loadFile(
      path.join(__dirname, '..', 'renderer', 'tooltip-overlay', 'index.html')
    );
    this.win.contentView.addChildView(this.tooltipOverlay);
  }

  // Re-adding an existing child view moves it to the top of the z-order, so
  // call this after any addChildView() that might otherwise bury an overlay
  // under the app view it just attached.
  raiseOverlays() {
    this.win.contentView.addChildView(this.cornerMask);
    this.win.contentView.addChildView(this.tooltipOverlay);
  }

  showTooltip(text, x, y) {
    this.tooltipOverlay.setBounds({
      x: Math.round(x),
      y: Math.round(y - TOOLTIP_HEIGHT / 2),
      width: TOOLTIP_WIDTH,
      height: TOOLTIP_HEIGHT,
    });
    this.tooltipOverlay.webContents.send('tooltip:update', { text, visible: true });
    this.raiseOverlays();
  }

  hideTooltip() {
    this.tooltipOverlay.webContents.send('tooltip:update', { visible: false });
  }

  getOrCreate(app) {
    if (this.views.has(app.id)) return this.views.get(app.id);

    const view = new WebContentsView({
      webPreferences: {
        session: getSessionForApp(app, this.win),
        preload: path.join(__dirname, '..', 'preload', 'webview-preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    view.webContents.setUserAgent(DESKTOP_USER_AGENT);
    // Reopens wherever this app was last left (e.g. which Google account
    // slot a Gmail app was on), falling back to the pinned URL the first
    // time an app is ever opened.
    view.webContents.loadURL(app.lastUrl || app.url);

    // window.open() (Google's account chooser, SSO redirects, "open in new
    // tab" links, ...) would otherwise spawn an unmanaged native
    // BrowserWindow outside the app shell. Auth-flow-like or same-provider
    // targets navigate this same view instead so login completes in place;
    // anything else is treated as an outbound link and opens in the user's
    // regular browser.
    view.webContents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { action: 'deny' };
      }
      // Page content could window.open() a file:// or custom-protocol URI to
      // reach outside the sandbox (e.g. via shell.openExternal below, which
      // hands the string straight to the OS). Only ever act on ordinary web
      // URLs; anything else is silently dropped.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { action: 'deny' };
      }
      // Re-read the app's current URL on every check rather than closing
      // over app.url from when this view was created — an app pinned by
      // typing a bare search term starts out on a Google search-results
      // page and "graduates" to its real URL once the user clicks through
      // (see maybeGraduateFromSearch), which updates the stored app but
      // wouldn't otherwise be seen by a handler that captured the old,
      // pre-graduation root domain once and kept it for the view's
      // lifetime.
      const currentApp = configStore.getApp(app.id) || app;
      const appRootDomain = rootDomain(new URL(currentApp.url).hostname);
      const isSameProvider = rootDomain(parsed.hostname) === appRootDomain;
      const looksLikeAuth = looksLikeAuthFlow(parsed);

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
      configStore.updateAppLastUrl(app.id, url);
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
    // Persisted so next launch can show it immediately instead of a
    // fallback letter while this app's page reloads over the network.
    configStore.updateAppMeta(appId, partial);
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
    this.raiseOverlays();
    this.activeId = appId;
    this.emitNavState(appId);
  }

  layout(view) {
    if (!view) return;
    const [width, height] = this.win.getContentSize();
    view.setBounds({
      x: SIDEBAR_WIDTH + BORDER_WIDTH,
      y: TITLEBAR_HEIGHT + BORDER_WIDTH,
      width: width - SIDEBAR_WIDTH - BORDER_WIDTH,
      height: height - TITLEBAR_HEIGHT - BORDER_WIDTH,
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
    this.raiseOverlays();
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
