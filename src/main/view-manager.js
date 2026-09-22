const { WebContentsView, shell, nativeTheme } = require('electron');
const path = require('path');
const { getSessionForApp } = require('./session-manager');
const { rootDomain, looksLikeAuthFlow } = require('./url-utils');
const { watchTitleCount } = require('./unread-tracker');
const configStore = require('./config-store');
const {
  APP_META_CHANGED,
  NAV_STATE_CHANGED,
  UNREAD_CHANGED,
  TABS_CHANGED,
  ACTIVE_VIEW_CHANGED,
  APPS_CHANGED,
} = require('../renderer/shared/ipc-channels');

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
// No native auto-sizing across the WebContentsView boundary, so this box is
// sized here to exactly fit tab-menu/index.html's content — these must
// match that file's own #menu padding/gap and row heights (see its comment).
const TAB_MENU_WIDTH = 280;
const TAB_MENU_ROW_HEIGHT = 30;
const TAB_MENU_GAP = 6;
const TAB_MENU_PADDING = 8;
// Rows below the URL field: primary view only offers duplicate/open-
// externally; a tab also offers promoting itself to an app or to primary.
function tabMenuHeight(isPrimary) {
  const actionRows = isPrimary ? 2 : 4;
  const rows = 1 + actionRows; // + the URL field itself
  return TAB_MENU_PADDING * 2 + rows * TAB_MENU_ROW_HEIGHT + (rows - 1) * TAB_MENU_GAP;
}

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
    this.views = new Map(); // appId -> WebContentsView (each pinned app's own primary view)
    this.tabViews = new Map(); // tabId -> WebContentsView (lazily created — see getOrCreateTabView)
    this.activeTabByApp = new Map(); // appId -> tabId | null (null = that app's own primary view)
    this.focusedView = null; // whichever view (primary or tab) is currently attached/visible
    this.meta = new Map(); // appId -> { title, faviconUrl }
    this.unread = new Map(); // appId -> count
    this.activeId = null; // which pinned app is selected in the sidebar
    this.theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; // kept current by setTheme(), read by any overlay that (re)loads later

    this.win.on('resize', () => {
      if (this.focusedView) this.layout(this.focusedView);
    });

    // Electron has no API to round a WebContentsView's own corner, so this
    // is a small transparent overlay painted with an inverse-rounded-corner
    // shape, sitting exactly over the content view's top-left corner.
    this.cornerMask = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'corner-mask-preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.cornerMask.setBackgroundColor('#00000000');
    this.cornerMask.webContents.loadFile(
      path.join(__dirname, '..', 'renderer', 'corner-mask', 'index.html')
    );
    // Sending the initial theme right after loadFile() would race the
    // page's own preload/script registering its listener (loadFile is
    // async); waiting for did-finish-load guarantees it's actually ready.
    this.cornerMask.webContents.once('did-finish-load', () => this.sendThemeTo(this.cornerMask));
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
    this.tooltipOverlay.webContents.once('did-finish-load', () => this.sendThemeTo(this.tooltipOverlay));
    this.win.contentView.addChildView(this.tooltipOverlay);

    // Same technique again for the per-tab menu (URL field + duplicate/
    // promote/open-externally actions) — needs to float above whatever tab
    // is currently showing rather than replacing it. Starts at zero size
    // (invisible) until openTabMenu() positions and sizes it.
    this.tabMenuOverlay = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'tab-menu-preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.tabMenuOverlay.setBackgroundColor('#00000000');
    this.tabMenuOverlay.webContents.loadFile(
      path.join(__dirname, '..', 'renderer', 'tab-menu', 'index.html')
    );
    this.tabMenuOverlay.webContents.once('did-finish-load', () => this.sendThemeTo(this.tabMenuOverlay));
    this.win.contentView.addChildView(this.tabMenuOverlay);
    this.tabMenuContext = null; // { appId, tabId } while open, else null
  }

  sendThemeTo(view) {
    view.webContents.send('app:theme-changed', { theme: this.theme });
  }

  // Called from main/index.js whenever nativeTheme resolves to a different
  // theme (a menu selection, or the OS itself changing while "System" is
  // selected) — propagates to every overlay view; the sidebar's own copy
  // (mainWindow.webContents) is pushed separately by the caller, since it's
  // not one of these overlay views.
  setTheme(theme) {
    this.theme = theme;
    this.sendThemeTo(this.cornerMask);
    this.sendThemeTo(this.tooltipOverlay);
    this.sendThemeTo(this.tabMenuOverlay);
  }

  // Re-adding an existing child view moves it to the top of the z-order, so
  // call this after any addChildView() that might otherwise bury an overlay
  // under the app view it just attached.
  raiseOverlays() {
    this.win.contentView.addChildView(this.cornerMask);
    this.win.contentView.addChildView(this.tooltipOverlay);
    this.win.contentView.addChildView(this.tabMenuOverlay);
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

  // Opened by clicking a chip that's already active (see sidebar index.js)
  // — the app's own primary chip or one of its tabs — a small menu
  // centered below it for editing the current URL directly, duplicating
  // it, promoting a tab to its own pinned app or to primary, or handing it
  // off to the OS browser. tabId is null for the primary view's own menu.
  openTabMenu(appId, tabId, x, y) {
    const isPrimary = !tabId;
    let url;
    if (isPrimary) {
      const view = this.views.get(appId);
      const app = configStore.getApp(appId);
      if (!view || !app) return;
      url = view.webContents.getURL() || app.lastUrl || app.url;
    } else {
      const tab = configStore.getTabs(appId).find((t) => t.id === tabId);
      if (!tab) return;
      url = this.tabViews.get(tabId)?.webContents.getURL() || tab.url;
    }

    this.tabMenuContext = { appId, tabId: isPrimary ? null : tabId };
    const [contentWidth] = this.win.getContentSize();
    const centeredX = Math.round(x) - TAB_MENU_WIDTH / 2;
    const clampedX = Math.max(8, Math.min(centeredX, contentWidth - TAB_MENU_WIDTH - 8));
    this.tabMenuOverlay.setBounds({
      x: clampedX,
      y: Math.round(y) + 4,
      width: TAB_MENU_WIDTH,
      height: tabMenuHeight(isPrimary),
    });
    this.tabMenuOverlay.webContents.send('tab-menu:open', { url, isPrimary });
    this.raiseOverlays();
  }

  closeTabMenu() {
    this.tabMenuContext = null;
    this.tabMenuOverlay.webContents.send('tab-menu:close');
    // Parked off-screen at a real size rather than collapsed to 0x0 — a
    // zero-size WebContentsView appears to stop compositing updates
    // entirely while hidden, which silently swallowed the animation-reset
    // DOM change sent above before it ever got a chance to actually paint;
    // by the time this reopened, the compositor's last real frame was
    // still the old fully-visible one. Keeping a real, constant viewport
    // size — just off the visible window — keeps it rendering normally
    // the whole time it's "closed".
    this.tabMenuOverlay.setBounds({ x: -10000, y: -10000, width: TAB_MENU_WIDTH, height: tabMenuHeight(false) });
  }

  // Resolves whichever view/url a given tab (or, tabId === null, the app's
  // own primary view) refers to right now. Reads its *live* current page
  // rather than the stored record, which only reflects the last explicit
  // navigation (see attachWindowOpenHandler for the same reasoning) —
  // organic in-tab navigation shouldn't leave these actions acting on a
  // stale address. Shared by both the URL-field overlay's actions (which
  // key off whichever chip it's currently open for — see tabMenuContext)
  // and the plain right-click context menu (which acts on a specific
  // chip directly, without requiring the overlay to be open or switching
  // focus to it first — see sidebar index.js's handleChipContextMenu).
  resolveTarget(appId, tabId) {
    const view = tabId === null ? this.views.get(appId) : this.tabViews.get(tabId);
    if (!view) return null;
    const url = view.webContents.getURL();
    if (!url) return null;
    return { appId, tabId, view, url };
  }

  duplicateTab(appId, tabId) {
    const target = this.resolveTarget(appId, tabId);
    if (target) this.openTab(target.appId, { url: target.url });
  }

  // Pins the tab's current URL as a new, permanent sidebar app and closes
  // the tab it came from — the content moves to its new home rather than
  // existing in both places at once. Not offered for the primary view
  // itself (already a pinned app).
  async promoteTab(appId, tabId) {
    const target = this.resolveTarget(appId, tabId);
    if (!target || target.tabId === null) return;

    const newApp = await configStore.addApp({ url: target.url });
    this.warmUp([newApp]);
    this.closeTab(target.appId, target.tabId);
    this.show(newApp.id, newApp);
    this.win.webContents.send(APPS_CHANGED);
  }

  // Swaps a tab and the app's primary view: the tab's page becomes what
  // the app's own chip shows, and the primary's prior page becomes a new
  // (dormant, lazily-reloaded) tab in its place — nothing is lost, they
  // just trade roles. Reuses the existing primary WebContents (navigating
  // it via loadURL) rather than re-registering the tab's own view under a
  // new role, since every listener on a view is bound to the id it was
  // created for (see getOrCreate/getOrCreateTabView) and moving the object
  // itself would leave those reporting to the wrong place. Doesn't switch
  // focus to it unless the tab already was focused — this can be invoked
  // from a right-click without ever having made the tab active.
  setTabPrimary(appId, tabId) {
    const target = this.resolveTarget(appId, tabId);
    if (!target || target.tabId === null) return;
    const { url: tabUrl } = target;

    const primaryView = this.views.get(appId);
    if (!primaryView) return;
    const oldPrimaryUrl = primaryView.webContents.getURL() || configStore.getApp(appId)?.url;
    const oldMeta = this.meta.get(appId) || {};
    const wasFocusedOnTab = this.focusedView === this.tabViews.get(tabId);

    configStore.removeTab(appId, tabId);
    this.tabViews.delete(tabId);
    if (wasFocusedOnTab) this.focusedView = null;

    if (oldPrimaryUrl) {
      configStore.addTab(appId, { url: oldPrimaryUrl, title: oldMeta.title, faviconUrl: oldMeta.faviconUrl });
    }

    primaryView.webContents.loadURL(tabUrl);
    configStore.updateAppLastUrl(appId, tabUrl);
    this.emitTabsChanged(appId);

    if (wasFocusedOnTab) {
      this.activeTabByApp.set(appId, null);
      this.setFocusedView(primaryView);
      this.emitActiveChanged();
      this.emitNavStateForFocused();
    }
  }

  openTabExternal(appId, tabId) {
    const target = this.resolveTarget(appId, tabId);
    if (target) shell.openExternal(target.url);
  }

  // The URL-field overlay's own actions — thin wrappers around the above,
  // keyed off whichever chip it's currently open for (tabMenuContext) and
  // closing it afterward. Captured before closeTabMenu() clears it.
  tabMenuNavigate(rawUrl) {
    const ctx = this.tabMenuContext;
    this.closeTabMenu();
    if (!ctx) return;
    const target = this.resolveTarget(ctx.appId, ctx.tabId);
    if (target) target.view.webContents.loadURL(configStore.resolveAppUrl(rawUrl));
  }

  tabMenuDuplicate() {
    const ctx = this.tabMenuContext;
    this.closeTabMenu();
    if (ctx) this.duplicateTab(ctx.appId, ctx.tabId);
  }

  async tabMenuPromote() {
    const ctx = this.tabMenuContext;
    this.closeTabMenu();
    if (ctx) await this.promoteTab(ctx.appId, ctx.tabId);
  }

  tabMenuSetPrimary() {
    const ctx = this.tabMenuContext;
    this.closeTabMenu();
    if (ctx) this.setTabPrimary(ctx.appId, ctx.tabId);
  }

  tabMenuOpenExternal() {
    const ctx = this.tabMenuContext;
    this.closeTabMenu();
    if (ctx) this.openTabExternal(ctx.appId, ctx.tabId);
  }

  // window.open() (Google's account chooser, SSO redirects, "open in new
  // tab" links, ...) would otherwise spawn an unmanaged native BrowserWindow
  // outside the app shell. Auth-flow-like or same-site targets navigate this
  // same view in place so login completes without leaving it; anything else
  // is treated as separate content and opens as a new tab under ownerAppId
  // rather than either hijacking this view or kicking out to the OS browser.
  // Shared by both a pinned app's own primary view and any tab view, so a
  // link clicked inside a tab spawns another tab alongside it (flat, not
  // nested) instead of being judged against the pinned app's own site.
  attachWindowOpenHandler(view, ownerAppId) {
    view.webContents.setWindowOpenHandler(({ url, disposition }) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { action: 'deny' };
      }
      // Page content could window.open() a file:// or custom-protocol URI —
      // only ever act on ordinary web URLs; anything else is silently
      // dropped.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { action: 'deny' };
      }

      // A real target="_blank" link (or middle/ctrl-click) always means
      // "open this as a new tab" — that's the page's own stated intent via
      // disposition, and it holds regardless of which domain the link
      // happens to point at. Judging by domain instead breaks e.g. Gmail,
      // which wraps outbound links through a google.com redirect page
      // before they reach their real destination: that redirect looks
      // "same site" as Gmail, so loading it into Gmail's own view (the old
      // approach here) let its own follow-up redirect hijack Gmail's view
      // right along with it, instead of landing in its own tab the way it
      // does in a real browser.
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        this.openTab(ownerAppId, { url });
        return { action: 'deny' };
      }

      // Anything else here is an explicit popup window — window.open(url,
      // name, 'width=...,height=...') — which is how Google's account
      // chooser and other OAuth/SSO continuations open. Those are meant to
      // complete the *current* page's sign-in (and rely on the opener
      // relationship to do it), not present new content, so same-site or
      // auth-flow-shaped targets stay in this same view; anything else
      // still becomes a tab rather than reaching the OS browser.
      let currentRoot = null;
      try {
        currentRoot = rootDomain(new URL(view.webContents.getURL()).hostname);
      } catch {
        // no current page yet (e.g. still on the very first load) — fall
        // through and treat the target as a new site below
      }
      const isSameSite = currentRoot !== null && rootDomain(parsed.hostname) === currentRoot;
      const looksLikeAuth = looksLikeAuthFlow(parsed);

      if (isSameSite || looksLikeAuth) {
        view.webContents.loadURL(url);
      } else {
        this.openTab(ownerAppId, { url });
      }
      return { action: 'deny' };
    });
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

    this.attachWindowOpenHandler(view, app.id);

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
      if (this.focusedView === view) this.emitNavStateForFocused();
      this.maybeGraduateFromSearch(app.id, url);
      configStore.updateAppLastUrl(app.id, url);
    });
    view.webContents.on('did-navigate-in-page', () => {
      if (this.focusedView === view) this.emitNavStateForFocused();
    });

    this.views.set(app.id, view);
    return view;
  }

  // Lazily creates a tab's view on first visit (see showTab) — a tab
  // restored from disk on launch is just its url/title/favicon until then,
  // with no browser process behind it at all.
  getOrCreateTabView(appId, tab) {
    if (this.tabViews.has(tab.id)) return this.tabViews.get(tab.id);

    const app = configStore.getApp(appId);
    const view = new WebContentsView({
      webPreferences: {
        // Shares the parent app's session rather than getting its own —
        // this is content reached *from* that app (a tracking link in an
        // email, say), so any login state it needs should already be
        // there, and it's not worth scattering more persisted partitions
        // on disk for what's usually a one-off page.
        session: getSessionForApp(app, this.win),
        preload: path.join(__dirname, '..', 'preload', 'webview-preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    view.webContents.setUserAgent(DESKTOP_USER_AGENT);
    view.webContents.loadURL(tab.url);

    this.attachWindowOpenHandler(view, appId);

    view.webContents.on('page-favicon-updated', (event, favicons) => {
      this.updateTabMeta(appId, tab.id, { faviconUrl: favicons[0] || null });
    });
    view.webContents.on('page-title-updated', (event, title) => {
      this.updateTabMeta(appId, tab.id, { title });
    });
    view.webContents.on('did-navigate', (event, url) => {
      if (this.focusedView === view) this.emitNavStateForFocused();
      // Keeps the stored record current for organic in-tab navigation (not
      // just the address-bar edit in tabMenuNavigate), so e.g. a dormant
      // tab restored after relaunch reopens wherever it was actually left,
      // not just where it started.
      this.updateTabMeta(appId, tab.id, { url });
    });
    view.webContents.on('did-navigate-in-page', () => {
      if (this.focusedView === view) this.emitNavStateForFocused();
    });

    this.tabViews.set(tab.id, view);
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

  emitNavStateForFocused() {
    if (!this.focusedView) return;
    const { navigationHistory } = this.focusedView.webContents;
    this.win.webContents.send(NAV_STATE_CHANGED, {
      canGoBack: navigationHistory.canGoBack(),
      canGoForward: navigationHistory.canGoForward(),
    });
  }

  navBack() {
    this.focusedView?.webContents.navigationHistory.goBack();
  }

  navForward() {
    this.focusedView?.webContents.navigationHistory.goForward();
  }

  navReload() {
    this.focusedView?.webContents.reload();
  }

  getNavState() {
    if (!this.focusedView) return { canGoBack: false, canGoForward: false };
    const { navigationHistory } = this.focusedView.webContents;
    return {
      canGoBack: navigationHistory.canGoBack(),
      canGoForward: navigationHistory.canGoForward(),
    };
  }

  // Create (and start loading) every configured app's view up front so
  // sidebar favicons/titles are available without requiring a click first.
  // Only one view is ever attached/visible at a time — see show(). Tabs are
  // deliberately not warmed up here; they stay dormant until visited.
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

  updateTabMeta(appId, tabId, partial) {
    configStore.updateTab(appId, tabId, partial);
    this.emitTabsChanged(appId);
  }

  emitTabsChanged(appId) {
    this.win.webContents.send(TABS_CHANGED, { appId, tabs: configStore.getTabs(appId) });
  }

  reorderTabs(appId, tabIds) {
    configStore.reorderTabs(appId, tabIds);
    this.emitTabsChanged(appId);
  }

  emitActiveChanged() {
    this.win.webContents.send(ACTIVE_VIEW_CHANGED, {
      appId: this.activeId,
      tabId: this.activeId ? this.activeTabByApp.get(this.activeId) ?? null : null,
    });
  }

  // Attaches `view` as the one visible content view, detaching whatever was
  // focused before. Shared by every path that changes what's on screen
  // (switching pinned apps, switching tabs, opening a new one, closing the
  // focused one) so there's a single place that owns the attach/detach and
  // layering, rather than each of those duplicating it.
  setFocusedView(view) {
    if (this.focusedView !== view) {
      // Anchored to a specific tab's chip — stale once focus moves anywhere
      // else, including a tabMenu action itself already having closed it.
      this.closeTabMenu();
    }
    if (this.focusedView && this.focusedView !== view) {
      this.win.contentView.removeChildView(this.focusedView);
    }
    if (this.focusedView !== view) {
      this.win.contentView.addChildView(view);
    }
    this.layout(view);
    this.raiseOverlays();
    this.focusedView = view;
  }

  // Switching to a pinned app restores whichever of its tabs (or its own
  // primary view) was last focused, rather than always resetting to the
  // primary view — matches a browser window remembering which tab you were
  // on when you switch back to it.
  show(appId, app) {
    const tabId = this.activeTabByApp.get(appId) ?? null;
    if (tabId) {
      const tab = (configStore.getApp(appId)?.tabs || []).find((t) => t.id === tabId);
      if (tab) {
        this.showTab(appId, tab);
        return;
      }
      this.activeTabByApp.delete(appId); // stale reference (tab closed elsewhere) — fall through
    }

    const view = this.getOrCreate(app);
    this.setFocusedView(view);
    this.activeId = appId;
    this.emitActiveChanged();
    this.emitNavStateForFocused();
  }

  showTab(appId, tab) {
    const view = this.getOrCreateTabView(appId, tab);
    this.setFocusedView(view);
    this.activeId = appId;
    this.activeTabByApp.set(appId, tab.id);
    this.emitActiveChanged();
    this.emitNavStateForFocused();
  }

  showAppPrimary(appId) {
    this.activeTabByApp.set(appId, null);
    const app = configStore.getApp(appId);
    if (app) this.show(appId, app);
  }

  // A link that isn't the same site as (and doesn't look like an auth hop
  // from) the view it was clicked in — see attachWindowOpenHandler.
  openTab(appId, { url }) {
    const tab = configStore.addTab(appId, { url, title: url, faviconUrl: null });
    this.emitTabsChanged(appId);
    this.showTab(appId, tab);
  }

  closeTab(appId, tabId) {
    if (this.tabMenuContext?.tabId === tabId) this.closeTabMenu();

    const view = this.tabViews.get(tabId);
    const wasFocused = this.focusedView === view;

    if (wasFocused) {
      this.activeTabByApp.set(appId, null);
      const app = configStore.getApp(appId);
      if (app) this.setFocusedView(this.getOrCreate(app));
    }

    if (view) this.tabViews.delete(tabId);
    configStore.removeTab(appId, tabId);
    this.emitActiveChanged();
    this.emitTabsChanged(appId);
    if (wasFocused) this.emitNavStateForFocused();
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
    if (this.focusedView) this.win.contentView.removeChildView(this.focusedView);
  }

  showActive() {
    if (!this.focusedView) return;
    this.win.contentView.addChildView(this.focusedView);
    this.layout(this.focusedView);
    this.raiseOverlays();
  }

  // WebContentsView has no explicit destroy() — dropping the last reference
  // (after detaching it here) is what lets Electron tear down its WebContents.
  destroy(appId) {
    if (this.tabMenuContext?.appId === appId) this.closeTabMenu();

    const view = this.views.get(appId);
    if (view) {
      if (this.focusedView === view) {
        this.win.contentView.removeChildView(view);
        this.focusedView = null;
      }
      this.views.delete(appId);
    }

    for (const tab of configStore.getTabs(appId)) {
      const tabView = this.tabViews.get(tab.id);
      if (!tabView) continue;
      if (this.focusedView === tabView) {
        this.win.contentView.removeChildView(tabView);
        this.focusedView = null;
      }
      this.tabViews.delete(tab.id);
    }
    this.activeTabByApp.delete(appId);

    if (this.activeId === appId) this.activeId = null;
    this.meta.delete(appId);
    this.unread.delete(appId);
  }
}

module.exports = ViewManager;
