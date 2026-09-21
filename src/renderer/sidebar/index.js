// Placeholder sidebar UI — swap in the Figma design here (spec section 9,
// step 7). This just needs to prove app switching / adding / removing /
// reordering / grouping apps works, with each app's live favicon + title
// tooltip.

const sidebar = document.getElementById('sidebar');

// Without this, dropping a file-like drag (or a stray native image drag —
// see the img.draggable fix below) anywhere our own handlers don't
// explicitly own would fall through to Chromium's default action: saving
// the file or navigating the window to it. Catch it everywhere by default;
// our specific handlers still run first and can opt in via preventDefault
// of their own.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

document.getElementById('hamburger-button').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  window.electronAPI.openAppMenu({ x: Math.round(rect.left), y: Math.round(rect.bottom) });
});

const navBackButton = document.getElementById('nav-back');
const navForwardButton = document.getElementById('nav-forward');
const navReloadButton = document.getElementById('nav-reload');

navBackButton.addEventListener('click', () => window.electronAPI.navBack());
navForwardButton.addEventListener('click', () => window.electronAPI.navForward());
navReloadButton.addEventListener('click', () => window.electronAPI.navReload());

function updateNavButtons({ canGoBack, canGoForward }) {
  navBackButton.disabled = !canGoBack;
  navForwardButton.disabled = !canGoForward;
}

window.electronAPI.onNavStateChanged(({ appId, ...navState }) => {
  if (appId === activeAppId) updateNavButtons(navState);
});

// --- State mirrored from main (see GET_APPS: { apps, groups, items }) ---

let items = []; // sidebar order: { type: 'app' | 'group', id }[]
const appsById = new Map(); // appId -> latest known app data
const groupsById = new Map(); // groupId -> { id, label, appIds }
const buttonsByAppId = new Map(); // appId -> the clickable element representing it (standalone or group-member)

let activeAppId = null;
let activeButtonEl = null;

function isAppInGroup(appId) {
  for (const group of groupsById.values()) {
    if (group.appIds.includes(appId)) return true;
  }
  return false;
}

function highlightActive(appId) {
  activeButtonEl = buttonsByAppId.get(appId) || null;
  if (activeButtonEl) activeButtonEl.classList.add('active');
}

function setActive(appId) {
  if (activeButtonEl) activeButtonEl.classList.remove('active');
  activeAppId = appId;
  highlightActive(appId);
}

function faviconFallbackText(app) {
  try {
    return new URL(app.url).hostname.replace(/^www\./, '').charAt(0).toUpperCase();
  } catch {
    return '?';
  }
}

// --- Custom tooltip (native `title` delay isn't tunable, so we roll our own) ---

const TOOLTIP_DELAY_MS = 500;
const tooltip = document.createElement('div');
tooltip.id = 'app-tooltip';
tooltip.hidden = true;
document.body.appendChild(tooltip);

let tooltipTimer = null;

function showTooltip(button, text) {
  if (!text) return;
  tooltip.textContent = text;
  tooltip.hidden = false;
  const rect = button.getBoundingClientRect();
  tooltip.style.left = `${rect.right + 8}px`;
  tooltip.style.top = `${rect.top + rect.height / 2}px`;
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltip.hidden = true;
}

function attachTooltip(button, getText) {
  button.addEventListener('mouseenter', () => {
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => showTooltip(button, getText()), TOOLTIP_DELAY_MS);
  });
  button.addEventListener('mouseleave', hideTooltip);
  button.addEventListener('mousedown', hideTooltip);
}

// --- App buttons: meta rendering shared between standalone and grouped ---

function applyAppMeta(button, app) {
  button.replaceChildren();
  if (app.faviconUrl) {
    const img = document.createElement('img');
    img.className = 'app-favicon';
    img.src = app.faviconUrl;
    img.alt = '';
    // <img> is natively draggable in Chromium independent of the button's
    // own draggable=true — left unchecked, grabbing the icon lets the OS
    // treat it as a file drag (downloading and dropping favicon.ico
    // wherever the drag is released, e.g. the desktop) instead of our own
    // reorder/merge handling.
    img.draggable = false;
    button.appendChild(img);
  } else {
    button.textContent = faviconFallbackText(app);
  }

  if (app.unreadCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'app-badge';
    badge.textContent = app.unreadCount > 99 ? '99+' : String(app.unreadCount);
    button.appendChild(badge);
  }
}

async function removeApp(appId) {
  const { newActiveId } = await window.electronAPI.removeApp(appId);
  await refreshLayout();
  if (newActiveId) setActive(newActiveId);
}

// Every app button is built identically and sized identically (.app-button)
// whether it's alone in its own container or one of several in a group —
// see buildContainer. A second, smaller "grouped" button class used to
// exist and is exactly why badges/favicons shrank when an app got grouped;
// one shared path means there's nothing left to diverge.
function buildAppButton(app) {
  const button = document.createElement('button');
  button.className = 'app-button';
  button.dataset.appId = app.id;
  applyAppMeta(button, app);
  attachTooltip(button, () => {
    const current = appsById.get(app.id);
    return current?.title || current?.name || current?.url;
  });
  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.electronAPI.switchApp(app.id);
    setActive(app.id);
  });
  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideTooltip();
    window.electronAPI.openAppContextMenu(
      app.id,
      { x: Math.round(e.clientX), y: Math.round(e.clientY) },
      isAppInGroup(app.id)
    );
  });
  buttonsByAppId.set(app.id, button);
  return button;
}

// Every top-level sidebar item — a lone app or a real multi-app group — is
// wrapped in the same .app-group container, again so there's only one
// rendering path to keep in sync rather than two that can drift apart.
function buildContainer(item) {
  const container = document.createElement('div');
  container.className = 'app-group';
  container.dataset.itemType = item.type;
  container.dataset.itemId = item.id;

  const group = item.type === 'group' ? groupsById.get(item.id) : null;
  const appIds = group ? group.appIds : [item.id];

  appIds.forEach((appId) => {
    const app = appsById.get(appId);
    if (!app) return;
    const button = buildAppButton(app);
    if (group) attachGroupMemberDragHandlers(button, group, appId);
    container.appendChild(button);
  });

  attachDragHandlers(container, item);
  return container;
}

// --- Drag-and-drop: reorder (drop near an edge) vs. merge into a group
// (drop in the middle of another standalone app or an existing group).
// Reordering shows a horizontal bar *between* items rather than a highlight
// on the item itself. Merging still highlights the target directly, since
// that's a "drop onto this" gesture.
//
// Top-level hit-testing (which item, which zone) is delegated to #sidebar
// itself rather than each item owning its own dragover/drop: with per-item
// listeners, drifting off an item's exact bounds mid-drag (a gap, past the
// last item, near the very top) lands on an element with no handler and the
// drop silently does nothing even though the indicator still shows. The
// container computes the nearest valid target from the cursor position
// instead, so every position in the list resolves to something.
//
// Icons inside a group can only reorder within that same group; dragging
// one out to merge/extract isn't supported — use the right-click "Remove
// from group" action for that instead.

const SIDEBAR_GAP = 4; // must match #sidebar's `gap` in styles.css
const GROUP_GAP = 2; // must match .app-group's `gap` in styles.css

// Positioned via `position: fixed` from the target's own
// getBoundingClientRect() rather than inserted into the flex flow — an
// inline sibling would shift later items during the same drag, moving the
// target out from under the cursor mid-hover.
const dropIndicator = document.createElement('div');
dropIndicator.className = 'drop-indicator';
dropIndicator.hidden = true;
document.body.appendChild(dropIndicator);

let mergeTargetEl = null;

// Centers the bar in the actual gap between items rather than flush against
// one of them.
function positionIndicator(referenceEl, before, gap) {
  const rect = referenceEl.getBoundingClientRect();
  const y = before ? rect.top - gap / 2 : rect.bottom + gap / 2;
  dropIndicator.style.top = `${Math.round(y)}px`;
  dropIndicator.style.left = `${Math.round(rect.left)}px`;
  dropIndicator.style.width = `${Math.round(rect.width)}px`;
  dropIndicator.hidden = false;
}

function clearDropState() {
  dropIndicator.hidden = true;
  if (mergeTargetEl) mergeTargetEl.classList.remove('drop-merge');
  mergeTargetEl = null;
  currentZone = null;
  currentTargetItem = null;
}

function itemForElement(el) {
  return { type: el.dataset.itemType, id: el.dataset.itemId };
}

// Finds the top-level item whose vertical span contains clientY, or — if
// the cursor is above the first item, below the last, or in a gap between
// two — the nearest one, so there's always a usable target.
function resolveTopLevelTarget(clientY) {
  const children = Array.from(sidebar.children).filter((el) => el !== addButton);
  if (children.length === 0) return null;

  for (const child of children) {
    const rect = child.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) return { el: child, rect, withinBounds: true };
  }

  const firstRect = children[0].getBoundingClientRect();
  if (clientY < firstRect.top) return { el: children[0], rect: firstRect, withinBounds: false, edge: 'top' };

  const lastRect = children[children.length - 1].getBoundingClientRect();
  if (clientY > lastRect.bottom) {
    return { el: children[children.length - 1], rect: lastRect, withinBounds: false, edge: 'bottom' };
  }

  for (let i = 0; i < children.length - 1; i += 1) {
    const r1 = children[i].getBoundingClientRect();
    const r2 = children[i + 1].getBoundingClientRect();
    if (clientY >= r1.bottom && clientY <= r2.top) {
      const closerToFirst = clientY - r1.bottom < r2.top - clientY;
      return closerToFirst
        ? { el: children[i], rect: r1, withinBounds: false, edge: 'bottom' }
        : { el: children[i + 1], rect: r2, withinBounds: false, edge: 'top' };
    }
  }
  return null;
}

let draggedItem = null; // { type, id }
let currentZone = null; // 'before' | 'after' | 'merge'
let currentTargetItem = null;

function attachDragHandlers(el, item) {
  el.draggable = true;
  el.addEventListener('dragstart', () => {
    draggedItem = item;
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearDropState();
    draggedItem = null;
  });
}

sidebar.addEventListener('dragover', (e) => {
  if (!draggedItem) return;
  e.preventDefault();

  const resolved = resolveTopLevelTarget(e.clientY);
  if (!resolved) {
    clearDropState();
    return;
  }
  const { el, rect, withinBounds, edge } = resolved;
  const item = itemForElement(el);
  if (draggedItem.type === item.type && draggedItem.id === item.id) {
    clearDropState();
    return;
  }

  let zone;
  if (!withinBounds) {
    zone = edge === 'top' ? 'before' : 'after';
  } else {
    const offsetY = e.clientY - rect.top;
    const canMerge = draggedItem.type === 'app';
    if (offsetY < rect.height * 0.25) zone = 'before';
    else if (offsetY > rect.height * 0.75) zone = 'after';
    else if (canMerge) zone = 'merge';
    else zone = offsetY < rect.height / 2 ? 'before' : 'after';
  }

  currentZone = zone;
  currentTargetItem = item;

  if (zone === 'merge') {
    dropIndicator.hidden = true;
    if (mergeTargetEl && mergeTargetEl !== el) mergeTargetEl.classList.remove('drop-merge');
    mergeTargetEl = el;
    el.classList.add('drop-merge');
  } else {
    if (mergeTargetEl) {
      mergeTargetEl.classList.remove('drop-merge');
      mergeTargetEl = null;
    }
    positionIndicator(el, zone === 'before', SIDEBAR_GAP);
  }
});

// Without this, the indicator from the last valid hover inside #sidebar
// stays put once the cursor moves into the titlebar or off the window
// entirely — it keeps showing a "drop here" position that dropping on
// won't actually do anything.
sidebar.addEventListener('dragleave', (e) => {
  if (!sidebar.contains(e.relatedTarget)) clearDropState();
});

sidebar.addEventListener('drop', async (e) => {
  if (!draggedItem || !currentTargetItem) return;
  e.preventDefault();
  const source = draggedItem;
  const item = currentTargetItem;
  const zone = currentZone;
  clearDropState();

  if (zone === 'merge') {
    if (item.type === 'app') {
      await window.electronAPI.createGroup(source.id, item.id);
    } else {
      await window.electronAPI.mergeIntoGroup(item.id, source.id);
    }
  } else {
    const newOrder = items.filter((i) => !(i.type === source.type && i.id === source.id));
    const targetIdx = newOrder.findIndex((i) => i.type === item.type && i.id === item.id);
    const insertAt = zone === 'before' ? targetIdx : targetIdx + 1;
    newOrder.splice(insertAt, 0, source);
    await window.electronAPI.reorderSidebar(newOrder);
  }
  await refreshLayout();
});

let draggedMember = null; // { groupId, appId }

function attachGroupMemberDragHandlers(el, group, appId) {
  el.draggable = true;

  el.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    draggedMember = { groupId: group.id, appId };
    el.classList.add('dragging');
  });

  el.addEventListener('dragend', (e) => {
    e.stopPropagation();
    el.classList.remove('dragging');
    clearDropState();
    draggedMember = null;
  });

  el.addEventListener('dragover', (e) => {
    // Only intercept drags of a *member of this same group* — anything else
    // (a top-level app/group being dragged over this icon) must bubble up
    // to #sidebar's delegated handler, which does its own geometric hit
    // test and doesn't depend on this element in particular.
    if (!draggedMember || draggedMember.groupId !== group.id || draggedMember.appId === appId) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    currentZone = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
    positionIndicator(el, currentZone === 'before', GROUP_GAP);
  });

  el.addEventListener('drop', async (e) => {
    if (!draggedMember || draggedMember.groupId !== group.id) return;
    e.preventDefault();
    e.stopPropagation();
    const sourceAppId = draggedMember.appId;
    const before = currentZone === 'before';
    clearDropState();

    const newAppIds = group.appIds.filter((id) => id !== sourceAppId);
    const targetIdx = newAppIds.indexOf(appId);
    newAppIds.splice(before ? targetIdx : targetIdx + 1, 0, sourceAppId);
    await window.electronAPI.reorderGroupMembers(group.id, newAppIds);
    draggedMember = null;
    await refreshLayout();
  });
}

// --- Full sidebar (re)render — simplest robust way to reflect merges,
// ungroups, reorders and removals without hand-patching the DOM tree.

function renderSidebar() {
  buttonsByAppId.clear();
  Array.from(sidebar.children).forEach((child) => {
    if (child !== addButton) child.remove();
  });

  items.forEach((item) => {
    sidebar.insertBefore(buildContainer(item), addButton);
  });

  if (activeAppId) highlightActive(activeAppId);
}

async function refreshLayout() {
  const data = await window.electronAPI.getApps();
  appsById.clear();
  groupsById.clear();
  data.apps.forEach((app) => appsById.set(app.id, app));
  data.groups.forEach((group) => groupsById.set(group.id, group));
  items = data.items;
  renderSidebar();
}

window.electronAPI.onMetaChanged(({ appId, ...meta }) => {
  const button = buttonsByAppId.get(appId);
  const app = appsById.get(appId);
  if (!button || !app) return;
  Object.assign(app, meta);
  applyAppMeta(button, app);
});

window.electronAPI.onUnreadChanged(({ appId, count }) => {
  const button = buttonsByAppId.get(appId);
  const app = appsById.get(appId);
  if (!button || !app) return;
  app.unreadCount = count;
  applyAppMeta(button, app);
});

window.electronAPI.onContextMenuRemove((appId) => removeApp(appId));

window.electronAPI.onContextMenuUngroup(async (appId) => {
  await window.electronAPI.ungroupApp(appId);
  await refreshLayout();
});

// --- Add app ---

const addButton = document.createElement('button');
addButton.id = 'add-app-button';
// lucide-static's "plus" icon, inlined (see index.html's comment for why).
addButton.innerHTML =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 12h14" /><path d="M12 5v14" /></svg>';
addButton.title = 'Add app';
addButton.addEventListener('click', () => openAddAppDialog());
sidebar.appendChild(addButton);

function openAddAppDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'add-app-overlay';
  overlay.innerHTML = `
    <form class="add-app-form">
      <label>URL or search<input name="url" type="text" placeholder="Enter a URL or search term" required autocomplete="off" /></label>
      <div class="add-app-actions">
        <button type="button" data-action="cancel">Cancel</button>
        <button type="submit">Add</button>
      </div>
    </form>
  `;
  document.body.appendChild(overlay);
  window.electronAPI.hideActiveView();

  const closeDialog = () => {
    overlay.remove();
    window.electronAPI.showActiveView();
  };

  const form = overlay.querySelector('form');
  overlay.querySelector('[data-action="cancel"]').addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = form.elements.url.value.trim();
    if (!url) return;

    const newApp = await window.electronAPI.addApp({ url });
    closeDialog();

    await refreshLayout();
    await window.electronAPI.switchApp(newApp.id);
    setActive(newApp.id);
  });

  form.elements.url.focus();
}

async function init() {
  await refreshLayout();

  if (items.length > 0) {
    const first = items[0];
    const firstAppId = first.type === 'app' ? first.id : groupsById.get(first.id)?.appIds[0];
    if (firstAppId) setActive(firstAppId);
  }

  const navState = await window.electronAPI.getNavState();
  if (navState.appId === activeAppId) updateNavButtons(navState);
}

init();
