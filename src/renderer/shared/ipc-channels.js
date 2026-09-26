module.exports = {
  SWITCH_APP: 'app:switch',
  GET_APPS: 'app:list',
  ADD_APP: 'app:add',
  REMOVE_APP: 'app:remove',
  MOVE_SIDEBAR_ITEM: 'app:move-sidebar-item', // top-level reorder, extracting from a group first if needed
  CREATE_GROUP: 'app:create-group', // drag app onto app -> merge into a new group, at a given position
  MERGE_INTO_GROUP: 'app:merge-into-group', // drag app onto/into an existing group, at a given position
  REORDER_GROUP_MEMBERS: 'app:reorder-group-members', // drag one group member onto another in the same group
  UNGROUP_APP: 'app:ungroup',
  APP_CONTEXT_MENU_UNGROUP: 'app:context-menu-ungroup', // main -> renderer push
  UNREAD_CHANGED: 'app:unread-changed', // main -> renderer push
  REPORT_UNREAD: 'app:report-unread', // webview-preload -> main
  HIDE_ACTIVE_VIEW: 'view:hide-active', // sidebar -> main, for full-window dialogs
  SHOW_ACTIVE_VIEW: 'view:show-active',
  SHOW_TOOLTIP: 'view:show-tooltip', // sidebar -> main, positions/shows the tooltip overlay
  HIDE_TOOLTIP: 'view:hide-tooltip',
  APP_META_CHANGED: 'app:meta-changed', // main -> renderer push (favicon/title)
  OPEN_APP_MENU: 'app:open-menu', // sidebar hamburger button -> main
  OPEN_APP_CONTEXT_MENU: 'app:open-context-menu', // right-click on a favicon -> main
  OPEN_GROUP_CONTEXT_MENU: 'app:open-group-context-menu', // right-click on empty space in a group's container -> main
  GROUP_MENU_OPENED: 'app:group-menu-opened', // main -> renderer push; the group popover opened via *any* trigger (this container's own right-click, or a member app's "Customize group..."), so the sidebar knows to close it on the next click elsewhere
  PERMISSION_MENU_OPENED: 'app:permission-menu-opened', // main -> renderer push; the per-app site-permissions popover opened (always via the native "Site permissions..." context menu item), so the sidebar knows to close it on the next click elsewhere
  APP_CONTEXT_MENU_REMOVE: 'app:context-menu-remove', // main -> renderer push
  NAV_BACK: 'view:nav-back',
  NAV_FORWARD: 'view:nav-forward',
  NAV_RELOAD: 'view:nav-reload',
  NAV_STATE_CHANGED: 'view:nav-state-changed', // main -> renderer push
  NAV_GET_STATE: 'view:get-nav-state', // renderer -> main, for initial state on load
  SWITCH_TAB: 'tabs:switch', // renderer -> main; tabId null means the app's own primary view
  CLOSE_TAB: 'tabs:close', // renderer -> main
  REORDER_TABS: 'tabs:reorder', // renderer -> main, drag-to-reorder the secondary tabs
  TABS_CHANGED: 'tabs:changed', // main -> renderer push (a tab opened/closed, or one's title/favicon updated)
  ACTIVE_VIEW_CHANGED: 'view:active-changed', // main -> renderer push, e.g. a link click opened a new tab
  OPEN_TAB_MENU: 'tab-menu:show', // sidebar -> main, clicking an already-active tab chip
  OPEN_NEW_TAB_MENU: 'tab-menu:show-new', // sidebar -> main, the tab strip's own "+" button
  CLOSE_TAB_MENU: 'tab-menu:hide', // sidebar -> main
  TAB_MENU_CLOSED: 'tab-menu:closed', // main -> renderer push; the overlay closed for *any* reason (submit, toggle-close, clicking away in the sidebar or in a pinned app's own view, switching focus elsewhere) — keeps the sidebar's tabMenuOpenKey mirror from going stale when main closes it on its own (see ViewManager.closeTabMenu)
  OPEN_TAB_CONTEXT_MENU: 'tabs:context-menu', // sidebar -> main, right-clicking a chip (any chip, active or not)
  APPS_CHANGED: 'app:list-changed', // main -> renderer push; a new app was pinned outside a direct sidebar request (see ViewManager.tabMenuPromote), or a group's color changed
  GET_THEME: 'app:get-theme', // sidebar -> main, for initial state on load
  THEME_CHANGED: 'app:theme-changed', // main -> renderer push (sidebar, and inlined as the same raw string in the tooltip/tab-menu/corner-mask overlays' own preloads)
};
