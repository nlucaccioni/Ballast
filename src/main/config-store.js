const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const Store = require('electron-store');
const { rootDomain, looksLikeAuthFlow } = require('./url-utils');

const seedPath = path.join(__dirname, '..', '..', 'config', 'default-apps.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

const store = new Store({
  name: 'apps-config',
  defaults: seed,
});

function getApps() {
  return store.get('apps');
}

// 'system' (default), 'light', or 'dark' — what the user picked from the
// Theme submenu (see main/index.js). Not seeded in default-apps.json since
// every existing install predates this and should just fall back to
// 'system' rather than needing a migration.
function getThemePreference() {
  return store.get('theme', 'system');
}

function setThemePreference(theme) {
  store.set('theme', theme);
}

// Global hibernation defaults (see ViewManager.checkIdleViews) — same
// get/set-with-fallback shape as theme above, no migration needed since
// every existing install just falls back to the safe defaults (protected
// apps, tabs still hibernate) until the user visits the settings page.
function getHibernationMode() {
  return store.get('hibernationMode', 'opt-in');
}

function setHibernationMode(mode) {
  store.set('hibernationMode', mode);
}

function getHibernateTabsEnabled() {
  return store.get('hibernateTabsEnabled', true);
}

function setHibernateTabsEnabled(enabled) {
  store.set('hibernateTabsEnabled', enabled);
}

function getHibernationIdleMinutes() {
  return store.get('hibernationIdleMinutes', 20);
}

function setHibernationIdleMinutes(minutes) {
  store.set('hibernationIdleMinutes', minutes);
}

function getGroups() {
  return store.get('groups');
}

function getApp(appId) {
  return getApps().find((app) => app.id === appId);
}

function setApps(apps) {
  store.set('apps', apps);
}

function setGroups(groups) {
  store.set('groups', groups);
}

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
}

function uniqueId(base, existingIds) {
  if (!existingIds.has(base)) return base;
  let i = 2;
  while (existingIds.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function normalizeUrl(url) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

// Root domains treated as "search engine, not a destination" — used both to
// decide when add-app input should become a search and to detect when a
// pinned search-results app has been "graduated" to a real site by
// clicking through (see ViewManager's maybeGraduateFromSearch).
const SEARCH_ENGINE_ROOT_DOMAINS = new Set(['google.com', 'bing.com', 'duckduckgo.com']);

function searchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// Add-app input doubles as an omnibox: a bare domain/URL is normalized and
// used directly, anything else (e.g. "telegram web") becomes a search so
// apps whose exact URL isn't known can still be found and pinned.
function looksLikeUrlInput(input) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return true;
  if (/\s/.test(input)) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#].*)?$/i.test(input);
}

function resolveAppUrl(input) {
  return looksLikeUrlInput(input) ? normalizeUrl(input) : searchUrl(input);
}

// gmail.com and mail.google.com are different registrable domains under
// partitionForUrl's heuristic, even though Google permanently redirects one
// to the other — pinning "gmail.com" as typed would land the new app on a
// different session partition than an existing mail.google.com/
// calendar.google.com app, showing a fresh login instead of the account
// that's already signed in. Following the actual redirect chain before
// assigning a partition avoids that regardless of which host name the
// provider happens to redirect from. Falls back to the input URL on any
// network error or after `timeoutMs`.
function resolveFinalUrl(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let finalUrl = url;
    let settled = false;
    let request;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      request?.abort();
      finish(finalUrl);
    }, timeoutMs);

    try {
      request = net.request({ method: 'GET', url });
    } catch {
      finish(url);
      return;
    }

    request.on('redirect', (statusCode, method, redirectUrl) => {
      // A redirect landing on what looks like a third-party identity
      // provider means the app needs sign-in, not that the identity
      // provider IS the app — e.g. an SSO-only Slack workspace 302s an
      // unauthenticated request through to accounts.google.com before ever
      // reaching Slack's own URL. Stop and keep whatever we'd resolved to
      // so far instead of following into it, or the app ends up pinned,
      // identified, and session-partitioned as the identity provider.
      let parsedRedirect;
      try {
        parsedRedirect = new URL(redirectUrl);
      } catch {
        request.abort();
        finish(finalUrl);
        return;
      }
      if (looksLikeAuthFlow(parsedRedirect)) {
        request.abort();
        finish(finalUrl);
        return;
      }
      finalUrl = redirectUrl;
      request.followRedirect();
    });
    request.on('response', () => {
      request.abort();
      finish(finalUrl);
    });
    request.on('error', () => finish(finalUrl));
    request.end();
  });
}

// Apps on the same root domain (mail.google.com, calendar.google.com, ...)
// share a session partition so logging into one signs you into the others —
// same idea as being logged into one Google account across Google's own
// tabs in a regular browser. Doesn't handle a provider spanning multiple
// root domains (e.g. Microsoft's teams.microsoft.com vs outlook.office.com);
// that'd need explicit per-app grouping, not worth it until it comes up.
function partitionForUrl(url) {
  return `persist:${rootDomain(new URL(url).hostname)}`;
}

async function addApp({ url }) {
  const trimmed = url.trim();
  const isDirectUrl = looksLikeUrlInput(trimmed);
  let finalUrl = resolveAppUrl(trimmed);
  // Only direct URLs get redirect-resolved — a search-results URL is meant
  // to stay a search-results URL until the user clicks through (see
  // ViewManager.maybeGraduateFromSearch).
  if (isDirectUrl) finalUrl = await resolveFinalUrl(finalUrl);

  const apps = getApps();
  const hostname = new URL(finalUrl).hostname.replace(/^www\./, '');
  const id = uniqueId(slugify(hostname), new Set(apps.map((app) => app.id)));

  const newApp = {
    id,
    // Fallback label only (e.g. window title, alt text) — the sidebar shows
    // the page's live favicon + <title> tooltip instead of an app name.
    name: hostname,
    url: finalUrl,
    partition: partitionForUrl(finalUrl),
    unreadStrategy: 'title-count',
  };

  setApps([...apps, newApp]);
  setSidebarOrder([...getSidebarOrder(), { type: 'app', id }]);
  return newApp;
}

// Repoints a pinned app at a new URL/partition once the user has navigated
// it somewhere else (see ViewManager.maybeGraduateFromSearch) — e.g. a
// search-results placeholder becoming the real site the user landed on.
// The already-open WebContentsView keeps its original session until the
// next launch, when it's recreated under the new partition.
function updateAppUrl(appId, url) {
  setApps(getApps().map((app) => (app.id === appId ? { ...app, url, partition: partitionForUrl(url) } : app)));
}

// Persists the last-known favicon/title so the sidebar can show it
// immediately on next launch instead of a fallback letter while each app's
// page reloads over the network (see ViewManager.updateMeta).
function updateAppMeta(appId, partial) {
  setApps(getApps().map((app) => (app.id === appId ? { ...app, ...partial } : app)));
}

// Where a pinned app reopens to on next launch — kept separate from `url`
// (the pinned "home"/identity URL that partitioning and the search-
// graduation check key off) so that ordinary navigation, like switching
// which Google account slot (mail.google.com/mail/u/0/ vs u/1/) a Gmail
// app is on, doesn't get treated as re-pinning the app somewhere new.
function updateAppLastUrl(appId, lastUrl) {
  setApps(getApps().map((app) => (app.id === appId ? { ...app, lastUrl } : app)));
}

// Per-app override of the global hibernation mode above — 'default'
// (inherit whatever getHibernationMode() says), 'always' (hibernate this
// app when idle regardless of the global mode), or 'never' (protect it
// regardless). Absent entirely on every app until the user visits the
// hibernation settings page, which reads that the same way as 'default'.
function setAppHibernatePolicy(appId, policy) {
  setApps(getApps().map((app) => (app.id === appId ? { ...app, hibernatePolicy: policy } : app)));
}

// "Mute sound" in the app's right-click menu — applies webContents'
// built-in audio-muting (see ViewManager.getOrCreate/setAppAudioMuted)
// rather than anything permission-related, so it's a hard mute regardless
// of what the page itself thinks its audio permissions are.
function setAppAudioMuted(appId, muted) {
  setApps(getApps().map((app) => (app.id === appId ? { ...app, audioMuted: muted } : app)));
}

// --- Sidebar order: the single source of truth for top-level sidebar item
// order (apps.json order / groups[].appIds order no longer drive rendering
// order — this interleaves standalone apps and group containers). Each
// entry is { type: 'app' | 'group', id }.

function getSidebarOrder() {
  return store.get('sidebarOrder');
}

function setSidebarOrder(order) {
  store.set('sidebarOrder', order);
}

// First app in sidebar order — resolves into a group to its first member.
// Used to pick what to show on launch and what to fall back to when the
// active app gets removed.
function getFirstApp() {
  for (const item of getSidebarOrder()) {
    if (item.type === 'app') return getApp(item.id);
    if (item.type === 'group') {
      const group = getGroups().find((g) => g.id === item.id);
      const app = group && getApp(group.appIds[0]);
      if (app) return app;
    }
  }
  return null;
}

// Builds an initial order from apps.json's existing app order the first
// time this runs against a store that predates sidebarOrder — each group
// is placed at its first member's original position. Also discards
// whatever's in `groups` at that point: the grouping UI didn't exist yet,
// so any group data still sitting there (e.g. the scaffold's old example
// seed) was never actually acted on and shouldn't suddenly start rendering.
function migrateSidebarOrder() {
  if (store.has('sidebarOrder')) return;
  setGroups([]);
  const apps = getApps();
  const groups = getGroups();
  const placedGroups = new Set();
  const order = [];
  for (const app of apps) {
    const group = groups.find((g) => g.appIds.includes(app.id));
    if (group) {
      if (placedGroups.has(group.id)) continue;
      placedGroups.add(group.id);
      order.push({ type: 'group', id: group.id });
    } else {
      order.push({ type: 'app', id: app.id });
    }
  }
  setSidebarOrder(order);
}

function generateGroupId() {
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Removes appId from whichever group contains it (if any), dissolving the
// group if that drops it to a single member (that member becomes a
// standalone sidebar entry again). Does not add/remove a sidebar entry for
// appId itself — callers do that based on whether this is an ungroup or a
// full deletion.
function detachFromGroup(appId) {
  const groups = getGroups();
  const group = groups.find((g) => g.appIds.includes(appId));
  if (!group) return;
  const remaining = group.appIds.filter((id) => id !== appId);

  if (remaining.length <= 1) {
    setGroups(groups.filter((g) => g.id !== group.id));
    const order = getSidebarOrder();
    const idx = order.findIndex((item) => item.type === 'group' && item.id === group.id);
    const replacement = remaining.map((id) => ({ type: 'app', id }));
    setSidebarOrder(
      idx === -1 ? [...order, ...replacement] : [...order.slice(0, idx), ...replacement, ...order.slice(idx + 1)]
    );
  } else {
    setGroups(groups.map((g) => (g.id === group.id ? { ...g, appIds: remaining } : g)));
  }
}

// Drag sourceAppId onto standalone targetAppId: merges both into a new
// group, replacing targetAppId's sidebar slot. `before` places sourceAppId
// above/below targetAppId in the new group, matching whichever half of
// targetAppId's icon the drop landed on.
function createGroupFromApps(sourceAppId, targetAppId, before = false) {
  if (sourceAppId === targetAppId) return null;
  detachFromGroup(sourceAppId);

  const appIds = before ? [sourceAppId, targetAppId] : [targetAppId, sourceAppId];
  const newGroup = { id: generateGroupId(), label: '', color: null, appIds };
  setGroups([...getGroups(), newGroup]);

  const order = getSidebarOrder().filter(
    (item) => !(item.type === 'app' && (item.id === sourceAppId || item.id === targetAppId))
  );
  const targetIndex = getSidebarOrder().findIndex((item) => item.type === 'app' && item.id === targetAppId);
  const insertAt = Math.min(targetIndex === -1 ? order.length : targetIndex, order.length);
  order.splice(insertAt, 0, { type: 'group', id: newGroup.id });
  setSidebarOrder(order);
  return newGroup;
}

// Drag appId (standalone, or a member of some other group) onto an
// existing group. Without a referenceAppId it's appended at the end;
// otherwise it's inserted just before/after that member, matching
// whichever half of the member's icon the drop landed on.
function addAppToGroup(groupId, appId, referenceAppId = null, before = false) {
  const group = getGroups().find((g) => g.id === groupId);
  if (!group || group.appIds.includes(appId)) return;
  detachFromGroup(appId);

  const current = getGroups().find((g) => g.id === groupId);
  const appIds = [...current.appIds];
  const refIndex = referenceAppId ? appIds.indexOf(referenceAppId) : -1;
  const insertAt = refIndex === -1 ? appIds.length : before ? refIndex : refIndex + 1;
  appIds.splice(insertAt, 0, appId);

  setGroups(getGroups().map((g) => (g.id === groupId ? { ...g, appIds } : g)));
  setSidebarOrder(getSidebarOrder().filter((item) => !(item.type === 'app' && item.id === appId)));
}

function reorderGroupMembers(groupId, appIds) {
  setGroups(getGroups().map((g) => (g.id === groupId ? { ...g, appIds } : g)));
}

// color is a hex string from the sidebar's fixed swatch list, or null to
// clear back to the default border.
function setGroupColor(groupId, color) {
  setGroups(getGroups().map((g) => (g.id === groupId ? { ...g, color } : g)));
}

function setGroupLabel(groupId, label) {
  setGroups(getGroups().map((g) => (g.id === groupId ? { ...g, label } : g)));
}

// General top-level reordering: positions itemType/itemId just before/after
// referenceType/referenceId in the sidebar. For an app that's currently a
// group member, this also extracts it from that group first — dragging a
// member out to become its own icon (or into a different group's own
// member-relative slot, via addAppToGroup instead) is the same underlying
// "detach, then place" operation as reordering an already-standalone app.
function moveSidebarItem(itemType, itemId, referenceType, referenceId, before) {
  if (itemType === 'app') detachFromGroup(itemId);

  const order = getSidebarOrder().filter((item) => !(item.type === itemType && item.id === itemId));
  const idx = order.findIndex((item) => item.type === referenceType && item.id === referenceId);
  const insertAt = idx === -1 ? order.length : before ? idx : idx + 1;
  order.splice(insertAt, 0, { type: itemType, id: itemId });
  setSidebarOrder(order);
}

// Right-click "Remove from group": appId becomes a standalone icon again.
function removeAppFromGroup(appId) {
  const wasGrouped = getGroups().some((g) => g.appIds.includes(appId));
  if (!wasGrouped) return;
  detachFromGroup(appId);
  if (!getSidebarOrder().some((item) => item.type === 'app' && item.id === appId)) {
    setSidebarOrder([...getSidebarOrder(), { type: 'app', id: appId }]);
  }
}

function removeApp(appId) {
  detachFromGroup(appId);
  setApps(getApps().filter((app) => app.id !== appId));
  setSidebarOrder(getSidebarOrder().filter((item) => !(item.type === 'app' && item.id === appId)));
}

// --- Tabs: links opened from within a pinned app (e.g. a tracking link in
// an email) that shouldn't either hijack the app's own view or kick out to
// the OS browser — see ViewManager.openTab. Live alongside the owning app
// rather than in their own top-level list since they're never a sidebar
// item themselves; only the app that owns them is. Session-scoped by
// intent (see ViewManager) but the *list* (url/title/favicon, not the
// live view) is persisted so the tab strip can restore instantly on
// relaunch without eagerly loading every tab's page.
function generateTabId() {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function getTabs(appId) {
  return getApp(appId)?.tabs || [];
}

function addTab(appId, { url, title, faviconUrl }) {
  const tab = { id: generateTabId(), url, title: title || url, faviconUrl: faviconUrl || null };
  setApps(getApps().map((app) => (app.id === appId ? { ...app, tabs: [...(app.tabs || []), tab] } : app)));
  return tab;
}

function updateTab(appId, tabId, partial) {
  setApps(
    getApps().map((app) =>
      app.id === appId ? { ...app, tabs: (app.tabs || []).map((t) => (t.id === tabId ? { ...t, ...partial } : t)) } : app
    )
  );
}

function removeTab(appId, tabId) {
  setApps(
    getApps().map((app) => (app.id === appId ? { ...app, tabs: (app.tabs || []).filter((t) => t.id !== tabId) } : app))
  );
}

function reorderTabs(appId, tabIds) {
  setApps(
    getApps().map((app) => {
      if (app.id !== appId) return app;
      const byId = new Map((app.tabs || []).map((t) => [t.id, t]));
      return { ...app, tabs: tabIds.map((id) => byId.get(id)).filter(Boolean) };
    })
  );
}

// One-time normalization so apps already persisted under the old
// per-app-id partition scheme pick up the shared-by-root-domain one above.
function migratePartitions() {
  const apps = getApps();
  let changed = false;
  const migrated = apps.map((app) => {
    const partition = partitionForUrl(app.url);
    if (partition === app.partition) return app;
    changed = true;
    return { ...app, partition };
  });
  if (changed) setApps(migrated);
}
migratePartitions();
migrateSidebarOrder();

module.exports = {
  getApps,
  getGroups,
  getApp,
  setApps,
  setGroups,
  addApp,
  updateAppUrl,
  updateAppMeta,
  updateAppLastUrl,
  setAppHibernatePolicy,
  setAppAudioMuted,
  removeApp,
  getSidebarOrder,
  setSidebarOrder,
  getFirstApp,
  createGroupFromApps,
  addAppToGroup,
  removeAppFromGroup,
  reorderGroupMembers,
  setGroupColor,
  setGroupLabel,
  moveSidebarItem,
  getTabs,
  addTab,
  updateTab,
  removeTab,
  reorderTabs,
  resolveAppUrl,
  getThemePreference,
  setThemePreference,
  getHibernationMode,
  setHibernationMode,
  getHibernateTabsEnabled,
  setHibernateTabsEnabled,
  getHibernationIdleMinutes,
  setHibernationIdleMinutes,
  SEARCH_ENGINE_ROOT_DOMAINS,
};
