// Placeholder sidebar UI — swap in the Figma design here (spec section 9,
// step 7). This just needs to prove app switching / adding / removing /
// reordering / grouping apps works, with each app's live favicon + title
// tooltip.

const sidebar = document.getElementById('sidebar');

// macOS's traffic-light window controls always sit top-left, unlike
// Windows' titleBarOverlay (top-right) — see styles.css's
// body.platform-darwin rules for the resulting titlebar layout shift.
if (window.electronAPI.platform === 'darwin') {
  document.body.classList.add('platform-darwin');
}

// electronAPI.initialTheme was resolved synchronously in the preload, at
// module load — set before this script's first paint, unlike future
// changes (see onThemeChanged below), which arrive as an async push.
document.body.dataset.theme = window.electronAPI.initialTheme;
window.electronAPI.onThemeChanged(({ theme }) => {
  document.body.dataset.theme = theme;
});

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

// Main only ever reports nav state for whichever view (a pinned app's own
// primary view, or one of its tabs) is currently focused, so there's no
// appId to check here — whatever arrives is always about what's on screen.
window.electronAPI.onNavStateChanged((navState) => updateNavButtons(navState));

// --- State mirrored from main (see GET_APPS: { apps, groups, items }) ---

let items = []; // sidebar order: { type: 'app' | 'group', id }[]
const appsById = new Map(); // appId -> latest known app data (includes .tabs)
const groupsById = new Map(); // groupId -> { id, label, appIds }
const buttonsByAppId = new Map(); // appId -> the clickable element representing it (standalone or group-member)

let activeAppId = null;
let activeTabId = null; // null = the active app's own primary view, not one of its tabs
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

// --- Custom tooltip (native `title` delay isn't tunable, so we roll our
// own) — rendered via a native overlay view (see main/view-manager.js's
// showTooltip), not a plain HTML element in this page: a plain element
// would render *underneath* the active app view wherever the two overlap,
// which is most of a tooltip's width now that the sidebar is this narrow.

const TOOLTIP_DELAY_MS = 250;
let tooltipTimer = null;

// content is { title, label? } — label (a group name) renders as its own
// line above the title rather than appended onto it, so a long title's own
// truncation can't push the label off the end (see tooltip-overlay for the
// two-line layout).
function showTooltip(button, content) {
  if (!content?.title) return;
  const rect = button.getBoundingClientRect();
  window.electronAPI.showTooltip(content, rect.right + 8, rect.top + rect.height / 2);
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  window.electronAPI.hideTooltip();
}

function attachTooltip(button, getContent) {
  button.addEventListener('mouseenter', () => {
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => showTooltip(button, getContent()), TOOLTIP_DELAY_MS);
  });
  button.addEventListener('mouseleave', hideTooltip);
  button.addEventListener('mousedown', hideTooltip);
}

// --- Tab strip: the active app's own primary view plus any tabs opened
// from links inside it (see main/view-manager.js's attachWindowOpenHandler
// and openTab). Only ever shows the currently active app's own tabs —
// switching pinned apps swaps the whole strip, it doesn't accumulate.

const tabStripEl = document.getElementById('tab-strip');

function closeIconSvg() {
  return (
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>'
  );
}

function buildTabChip({ label, faviconUrl, isActive, onSelect, onContextMenu, onClose }) {
  const chip = document.createElement('button');
  chip.className = isActive ? 'tab-chip active' : 'tab-chip';
  chip.type = 'button';

  if (faviconUrl) {
    const img = document.createElement('img');
    img.className = 'tab-chip-favicon';
    img.src = faviconUrl;
    img.alt = '';
    img.draggable = false;
    chip.appendChild(img);
  }

  const titleEl = document.createElement('span');
  titleEl.className = 'tab-chip-title';
  titleEl.textContent = label;
  chip.appendChild(titleEl);

  if (onClose) {
    const closeEl = document.createElement('span');
    closeEl.className = 'tab-chip-close';
    closeEl.innerHTML = closeIconSvg();
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      onClose();
    });
    chip.appendChild(closeEl);
  }

  chip.addEventListener('click', (e) => onSelect(e));
  if (onContextMenu) {
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      onContextMenu(e);
    });
  }
  return chip;
}

// Which tab (if any) the URL/duplicate/promote/open-externally menu is
// currently open for — a *renderer-side* mirror of main's own tabMenuContext
// (see view-manager.js), kept in sync via onActiveViewChanged below, so a
// second click on the same already-active chip toggles it closed rather than
// re-opening what's already open.
// undefined = no menu open; null = the primary chip's; else a tab id —
// mirrors main's own ViewManager.tabMenuContext.tabId representation.
let tabMenuOpenKey;

// Whether the group color/label popover is currently open — set via a main
// push (GROUP_MENU_OPENED) rather than at its trigger site directly, since
// it has two: this container's own right-click (below), and a member app's
// "Customize group..." entry, which lives in a native menu handled entirely
// in the main process. Unlike the tab menu, it isn't toggled by its own
// trigger — right-clicking always (re)opens it at the new position — so
// this only needs to know whether a click elsewhere in the sidebar should
// close it. Clicks inside the popover itself never reach this listener at
// all: it's a separate WebContentsView layered on top, not part of this
// document.
let groupMenuOpen = false;
window.electronAPI.onGroupMenuOpened(() => {
  groupMenuOpen = true;
});
document.addEventListener('click', () => {
  if (!groupMenuOpen) return;
  window.electronAPI.closeGroupMenu();
  groupMenuOpen = false;
});

function openTabMenuFor(key, chipEl) {
  const rect = chipEl.getBoundingClientRect();
  window.electronAPI.openTabMenu(activeAppId, key, {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.bottom),
  });
  tabMenuOpenKey = key;
}

// Shared by both the primary chip and tab chips: a click either switches to
// that chip (if it isn't already active) or toggles its menu (if it is —
// there's nothing left to "switch to").
function handleChipClick(key, chipEl, isCurrentlyActive) {
  if (!isCurrentlyActive) {
    window.electronAPI.switchTab(activeAppId, key);
    return;
  }
  if (tabMenuOpenKey === key) {
    window.electronAPI.closeTabMenu();
    tabMenuOpenKey = undefined;
  } else {
    openTabMenuFor(key, chipEl);
  }
}

// A plain OS right-click menu with the same actions, at the cursor —
// doesn't touch which chip is active, unlike the click-driven overlay above.
function handleChipContextMenu(key, e) {
  window.electronAPI.openTabContextMenu(activeAppId, key, {
    x: Math.round(e.clientX),
    y: Math.round(e.clientY),
  });
}

// --- Tab reorder (secondary tabs only — the primary chip isn't a drag
// source or a drop target). Indicator styling matches the sidebar's own
// reorder bar exactly (see positionIndicator), just rotated: a vertical bar
// sized to the chip's height, positioned in the gap outside it rather than
// overlapping the chip's own rounded corners.
//
// Delegated on #tab-strip itself rather than per-chip dragover/drop — a
// per-chip listener only fires while the cursor is directly over that
// chip, so dragging past the first (or last) one left the indicator
// showing a position drop wouldn't actually land on, the same bug the
// sidebar's own reorder had before it moved to a delegated listener (see
// resolveTopLevelTarget's comment there).

const tabDropIndicator = document.createElement('div');
tabDropIndicator.className = 'drop-indicator';
tabDropIndicator.hidden = true;
document.body.appendChild(tabDropIndicator);

let draggedTabId = null;
let tabDropTarget = null; // { tabId, before } | null

function positionTabDropIndicator(chip, before) {
  const rect = chip.getBoundingClientRect();
  const gap = 4; // must match #tab-strip's gap in styles.css
  const x = before ? rect.left - gap / 2 : rect.right + gap / 2;
  tabDropIndicator.style.top = `${Math.round(rect.top)}px`;
  tabDropIndicator.style.left = `${Math.round(x)}px`;
  tabDropIndicator.style.width = '2px';
  tabDropIndicator.style.height = `${Math.round(rect.height)}px`;
  tabDropIndicator.hidden = false;
}

function clearTabDragIndicator() {
  tabDropIndicator.hidden = true;
  tabDropTarget = null;
}

// Finds the tab chip whose position the cursor's X coordinate resolves to
// — directly over one, or (before the first / after the last / in the gap
// between two) the nearest one — so every X position within the strip
// maps to a usable target, not just the exact bounds of each chip.
function resolveTabDropTarget(clientX) {
  const chips = Array.from(tabStripEl.querySelectorAll('.tab-chip[draggable="true"]'));
  if (chips.length === 0) return null;

  for (const chip of chips) {
    const rect = chip.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right) {
      return { chip, before: clientX - rect.left < rect.width / 2 };
    }
  }

  const firstRect = chips[0].getBoundingClientRect();
  if (clientX < firstRect.left) return { chip: chips[0], before: true };

  const lastRect = chips[chips.length - 1].getBoundingClientRect();
  if (clientX > lastRect.right) return { chip: chips[chips.length - 1], before: false };

  for (let i = 0; i < chips.length - 1; i += 1) {
    const r1 = chips[i].getBoundingClientRect();
    const r2 = chips[i + 1].getBoundingClientRect();
    if (clientX >= r1.right && clientX <= r2.left) {
      const closerToFirst = clientX - r1.right < r2.left - clientX;
      return closerToFirst ? { chip: chips[i], before: false } : { chip: chips[i + 1], before: true };
    }
  }
  return null;
}

tabStripEl.addEventListener('dragover', (e) => {
  if (!draggedTabId) return;
  e.preventDefault();

  const resolved = resolveTabDropTarget(e.clientX);
  if (!resolved || resolved.chip.dataset.tabId === draggedTabId) {
    clearTabDragIndicator();
    return;
  }
  positionTabDropIndicator(resolved.chip, resolved.before);
  tabDropTarget = { tabId: resolved.chip.dataset.tabId, before: resolved.before };
});

tabStripEl.addEventListener('dragleave', (e) => {
  if (!tabStripEl.contains(e.relatedTarget)) clearTabDragIndicator();
});

tabStripEl.addEventListener('drop', async (e) => {
  if (!draggedTabId || !tabDropTarget) return;
  e.preventDefault();
  const sourceId = draggedTabId;
  const { tabId: targetId, before } = tabDropTarget;
  clearTabDragIndicator();
  draggedTabId = null;

  const tabs = appsById.get(activeAppId)?.tabs || [];
  const order = tabs.map((t) => t.id);
  const fromIdx = order.indexOf(sourceId);
  if (fromIdx === -1) return;
  order.splice(fromIdx, 1);
  const targetIdx = order.indexOf(targetId);
  if (targetIdx === -1) return;
  order.splice(before ? targetIdx : targetIdx + 1, 0, sourceId);

  await window.electronAPI.reorderTabs(activeAppId, order);
});

function attachTabDragHandlers(chip, tab) {
  chip.draggable = true;
  chip.dataset.tabId = tab.id;

  chip.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    draggedTabId = tab.id;
    chip.classList.add('dragging');
  });

  chip.addEventListener('dragend', (e) => {
    e.stopPropagation();
    chip.classList.remove('dragging');
    clearTabDragIndicator();
    draggedTabId = null;
  });
}

function renderTabStrip() {
  tabStripEl.replaceChildren();
  if (!activeAppId) return;
  const app = appsById.get(activeAppId);
  const tabs = app?.tabs || [];

  tabStripEl.appendChild(
    buildTabChip({
      label: app.title || app.name || app.url,
      faviconUrl: app.faviconUrl,
      isActive: !activeTabId,
      onSelect: (e) => handleChipClick(null, e.currentTarget, !activeTabId),
      onContextMenu: (e) => handleChipContextMenu(null, e),
    })
  );

  if (tabs.length > 0) {
    const separator = document.createElement('div');
    separator.className = 'tab-strip-separator';
    tabStripEl.appendChild(separator);
  }

  tabs.forEach((tab) => {
    const chip = buildTabChip({
      label: tab.title || tab.url,
      faviconUrl: tab.faviconUrl,
      isActive: activeTabId === tab.id,
      onSelect: (e) => handleChipClick(tab.id, e.currentTarget, activeTabId === tab.id),
      onContextMenu: (e) => handleChipContextMenu(tab.id, e),
      onClose: () => window.electronAPI.closeTab(activeAppId, tab.id),
    });
    // Distinguishes it from the primary chip for the shrink-to-fit and
    // hover-to-reveal-close-button rules in styles.css, which only apply
    // to secondary tabs.
    chip.classList.add('tab-chip-secondary');
    attachTabDragHandlers(chip, tab);
    tabStripEl.appendChild(chip);
  });
}

window.electronAPI.onTabsChanged(({ appId, tabs }) => {
  const app = appsById.get(appId);
  if (app) app.tabs = tabs;
  if (appId === activeAppId) renderTabStrip();
});

// Drives tab-strip/sidebar-highlight sync for every kind of focus change —
// clicking a sidebar app, clicking a tab chip, and a link opening a new tab
// (main-process-initiated, no renderer action to key off of) all funnel
// through here via this one push from main rather than each needing its
// own bespoke handling.
window.electronAPI.onActiveViewChanged(({ appId, tabId }) => {
  if (appId && appId !== activeAppId) setActive(appId);
  activeTabId = tabId;
  // Focus moved away from whichever chip the menu was open for — main
  // closes it automatically in that case (see ViewManager.setFocusedView),
  // so this mirror needs to follow rather than assume it's still open.
  if (tabMenuOpenKey !== undefined && tabMenuOpenKey !== tabId) tabMenuOpenKey = undefined;
  renderTabStrip();
});

window.electronAPI.onAppsChanged(() => refreshLayout());

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
function buildAppButton(app, containerItem) {
  const button = document.createElement('button');
  button.className = 'app-button';
  button.dataset.appId = app.id;
  applyAppMeta(button, app);
  attachTooltip(button, () => {
    const current = appsById.get(app.id);
    const title = current?.title || current?.name || current?.url;
    // containerItem is the *group's* item for every member button (see
    // buildContainer's loop) — so this is the same lookup for any app in
    // the group, not something specific to this one button.
    const group = containerItem.type === 'group' ? groupsById.get(containerItem.id) : null;
    return { title, label: group?.label || null };
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
  attachButtonDragHandlers(button, app.id, containerItem);
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

  if (group?.color) {
    container.style.setProperty('--group-color', group.color);
    container.classList.add('has-color');
  }

  appIds.forEach((appId) => {
    const app = appsById.get(appId);
    if (app) container.appendChild(buildAppButton(app, item));
  });

  // A lone app's "container" is just its one button — dragging that button
  // already sets draggedItem to {type:'app', id}, which is everything the
  // top-level reorder/merge logic below needs, so the wrapper div itself
  // doesn't need to be its own drag source. A real group's whole container
  // *is* a distinct drag source (move the group as a unit, vs. dragging one
  // member button out of it), so only groups get this.
  if (item.type === 'group') {
    attachContainerDragHandlers(container, item);
    // Each app button's own contextmenu handler stops propagation, so this
    // only fires for a right-click on the container's empty padding — not
    // one already handled by a member button above.
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      hideTooltip();
      window.electronAPI.openGroupContextMenu(item.id, { x: Math.round(e.clientX), y: Math.round(e.clientY) });
    });
  }
  return container;
}

// --- Drag-and-drop ---
//
// Three drag sources, one shared `draggedItem` state:
//   - a lone app's button       -> { type: 'app', id }
//   - a group member's button   -> { type: 'app', id } (identical — which
//     group, if any, it's currently in is server-side state, not something
//     the drag needs to track; see config-store's detachFromGroup)
//   - a group's own container   -> { type: 'group', id }
//
// Two drop behaviors:
//   - Reorder (drop near a container's top/bottom edge, or in the gap
//     between two containers): shows a horizontal bar *between* items and
//     repositions the dragged item at the top level. Handled by #sidebar's
//     delegated dragover/drop — see resolveTopLevelTarget's comment for why
//     it's delegated rather than per-item.
//   - Merge (drop on an app button, anywhere but its outer edge): highlights
//     that button directly and inserts the dragged app immediately
//     before/after it — into a new group if the target is a lone app, or at
//     that exact position in an existing group. Handled per-button, since
//     it needs to know exactly which button and which half of it.
// A group's own container can't be a merge target directly — only the app
// buttons inside it are (including when it has just one).

const SIDEBAR_GAP = 7; // must match #sidebar's `gap` in styles.css
const MEMBER_GAP = 2; // must match .app-group's `gap` in styles.css

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

function setMergeTarget(el) {
  if (mergeTargetEl === el) return;
  if (mergeTargetEl) mergeTargetEl.classList.remove('drop-merge');
  mergeTargetEl = el;
  if (mergeTargetEl) mergeTargetEl.classList.add('drop-merge');
}

function clearDropState() {
  dropIndicator.hidden = true;
  setMergeTarget(null);
  currentZone = null;
  currentTargetItem = null;
  currentMergeReference = null;
}

function itemForElement(el) {
  return { type: el.dataset.itemType, id: el.dataset.itemId };
}

// Finds the top-level item whose vertical span contains clientY, or — if
// the cursor is above the first item, below the last, or in a gap between
// two — the nearest one, so there's always a usable target. Used only for
// the reorder case; merge targeting is handled per-button (see
// attachButtonDragHandlers), since it needs a specific button, not just
// whichever container the cursor happens to be over.
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

let draggedItem = null; // { type: 'app' | 'group', id }
let currentZone = null; // 'before' | 'after' | 'merge'
let currentTargetItem = null; // the container-level item a drop applies to
let currentMergeReference = null; // { appId, before } — set only when currentZone === 'merge'

// Whole-group container as a drag source (reorder the group as a unit).
function attachContainerDragHandlers(el, item) {
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

// A single app button, whether alone in its container or a group member —
// both a drag source (this specific app) and, while some other app is being
// dragged, a precise merge target (insert immediately before/after it).
function attachButtonDragHandlers(button, appId, containerItem) {
  button.draggable = true;

  button.addEventListener('dragstart', (e) => {
    e.stopPropagation(); // don't also start the parent group container's own drag
    draggedItem = { type: 'app', id: appId };
    button.classList.add('dragging');
  });

  button.addEventListener('dragend', (e) => {
    e.stopPropagation();
    button.classList.remove('dragging');
    clearDropState();
    draggedItem = null;
  });

  button.addEventListener('dragover', (e) => {
    if (!draggedItem || draggedItem.type !== 'app' || draggedItem.id === appId) return;
    e.preventDefault();
    e.stopPropagation(); // handled precisely here — don't let #sidebar's coarser container-level logic also fire
    const rect = button.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    // The whole group is highlighted (it's where the drop lands), and a
    // thin bar between the buttons shows exactly which position within it —
    // sized to the button, not the container, and sitting in the small gap
    // between icons rather than overlapping either one's own edge, which is
    // what made an earlier version of this look like it was "intersecting".
    positionIndicator(button, before, MEMBER_GAP);
    currentZone = 'merge';
    currentTargetItem = containerItem;
    currentMergeReference = { appId, before };
    setMergeTarget(button.closest('.app-group'));
  });

  button.addEventListener('drop', async (e) => {
    if (!draggedItem || draggedItem.type !== 'app' || draggedItem.id === appId) return;
    e.preventDefault();
    e.stopPropagation();
    const source = draggedItem;
    const { before } = currentMergeReference;
    clearDropState();

    if (containerItem.type === 'group') {
      const group = groupsById.get(containerItem.id);
      if (group?.appIds.includes(source.id)) {
        const newAppIds = group.appIds.filter((id) => id !== source.id);
        const idx = newAppIds.indexOf(appId);
        newAppIds.splice(before ? idx : idx + 1, 0, source.id);
        await window.electronAPI.reorderGroupMembers(group.id, newAppIds);
      } else {
        await window.electronAPI.mergeIntoGroup(containerItem.id, source.id, appId, before);
      }
    } else {
      await window.electronAPI.createGroup(source.id, containerItem.id, before);
    }
    await refreshLayout();
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

  // Reorder-only zone: a fixed band near the container's outer edge (not a
  // fraction of its height — a tall multi-member group shouldn't need a
  // huge edge band just to reorder it, since merge targeting now lives on
  // the individual buttons instead of a big "middle 50%" of the container).
  const EDGE_ZONE_PX = 6;
  let zone;
  if (!withinBounds) {
    zone = edge === 'top' ? 'before' : 'after';
  } else if (e.clientY - rect.top < EDGE_ZONE_PX) {
    zone = 'before';
  } else if (rect.bottom - e.clientY < EDGE_ZONE_PX) {
    zone = 'after';
  } else if (draggedItem.type === 'app') {
    // Cursor is over this container but not over any specific button (e.g.
    // its padding, or gaps between members) — fall back to "merge at the
    // end", same as before per-button merge targeting existed.
    zone = 'merge';
  } else {
    zone = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
  }

  currentZone = zone;
  currentTargetItem = item;
  currentMergeReference = null;

  if (zone === 'merge') {
    dropIndicator.hidden = true;
    setMergeTarget(el);
  } else {
    setMergeTarget(null);
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
      await window.electronAPI.createGroup(source.id, item.id, false);
    } else {
      await window.electronAPI.mergeIntoGroup(item.id, source.id);
    }
  } else {
    await window.electronAPI.moveSidebarItem(source.type, source.id, item.type, item.id, zone === 'before');
  }
  await refreshLayout();
});

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
  renderTabStrip();
}

window.electronAPI.onMetaChanged(({ appId, ...meta }) => {
  const button = buttonsByAppId.get(appId);
  const app = appsById.get(appId);
  if (!button || !app) return;
  Object.assign(app, meta);
  applyAppMeta(button, app);
  // The primary tab chip's label/favicon mirror the app's own meta.
  if (appId === activeAppId && !activeTabId) renderTabStrip();
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
      <div class="add-app-search">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />
        </svg>
        <input name="url" type="text" placeholder="Search or type URL" autocomplete="off" />
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
  const input = form.elements.url;

  // No cancel/add buttons — Enter submits (implicit form submission from a
  // lone text input), Escape backs out, and clicking the empty area around
  // the search box also backs out.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;

    const newApp = await window.electronAPI.addApp({ url });
    closeDialog();

    await refreshLayout();
    await window.electronAPI.switchApp(newApp.id);
    setActive(newApp.id);
  });

  input.focus();
}

async function init() {
  await refreshLayout();

  if (items.length > 0) {
    const first = items[0];
    const firstAppId = first.type === 'app' ? first.id : groupsById.get(first.id)?.appIds[0];
    if (firstAppId) {
      setActive(firstAppId);
      // Tabs never auto-restore focus on launch (see main/view-manager.js's
      // activeTabByApp, which starts empty each process start) — the app's
      // own primary view is always what's showing at this point.
      renderTabStrip();
    }
  } else {
    // Nothing pinned yet (a fresh install) — go straight to adding the
    // first app instead of showing an empty sidebar with just a '+'.
    openAddAppDialog();
  }

  updateNavButtons(await window.electronAPI.getNavState());
}

init();
