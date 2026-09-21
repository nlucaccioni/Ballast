const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const Store = require('electron-store');
const { rootDomain } = require('./url-utils');

const seedPath = path.join(__dirname, '..', '..', 'config', 'default-apps.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

const store = new Store({
  name: 'apps-config',
  defaults: seed,
});

function getApps() {
  return store.get('apps');
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

// Drag appIdA onto standalone appIdB: merges both into a new group,
// replacing appIdB's sidebar slot.
function createGroupFromApps(appIdA, appIdB) {
  if (appIdA === appIdB) return null;
  detachFromGroup(appIdA);

  const newGroup = { id: generateGroupId(), label: '', appIds: [appIdA, appIdB] };
  setGroups([...getGroups(), newGroup]);

  const order = getSidebarOrder().filter((item) => !(item.type === 'app' && (item.id === appIdA || item.id === appIdB)));
  const targetIndex = getSidebarOrder().findIndex((item) => item.type === 'app' && item.id === appIdB);
  const insertAt = Math.min(targetIndex === -1 ? order.length : targetIndex, order.length);
  order.splice(insertAt, 0, { type: 'group', id: newGroup.id });
  setSidebarOrder(order);
  return newGroup;
}

// Drag standalone appId onto an existing group container.
function addAppToGroup(groupId, appId) {
  const groups = getGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group || group.appIds.includes(appId)) return;
  detachFromGroup(appId);
  setGroups(getGroups().map((g) => (g.id === groupId ? { ...g, appIds: [...g.appIds, appId] } : g)));
  setSidebarOrder(getSidebarOrder().filter((item) => !(item.type === 'app' && item.id === appId)));
}

function reorderGroupMembers(groupId, appIds) {
  setGroups(getGroups().map((g) => (g.id === groupId ? { ...g, appIds } : g)));
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
  removeApp,
  getSidebarOrder,
  setSidebarOrder,
  getFirstApp,
  createGroupFromApps,
  addAppToGroup,
  removeAppFromGroup,
  reorderGroupMembers,
  SEARCH_ENGINE_ROOT_DOMAINS,
};
