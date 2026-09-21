module.exports = {
  SWITCH_APP: 'app:switch',
  GET_APPS: 'app:list',
  ADD_APP: 'app:add',
  REMOVE_APP: 'app:remove',
  REORDER_APPS: 'app:reorder', // payload is now the full sidebar order: {type: 'app'|'group', id}[]
  CREATE_GROUP: 'app:create-group', // drag app onto app -> merge into a new group
  MERGE_INTO_GROUP: 'app:merge-into-group', // drag app onto an existing group
  REORDER_GROUP_MEMBERS: 'app:reorder-group-members', // drag one group member onto another in the same group
  UNGROUP_APP: 'app:ungroup',
  APP_CONTEXT_MENU_UNGROUP: 'app:context-menu-ungroup', // main -> renderer push
  UNREAD_CHANGED: 'app:unread-changed', // main -> renderer push
  REPORT_UNREAD: 'app:report-unread', // webview-preload -> main
  HIDE_ACTIVE_VIEW: 'view:hide-active', // sidebar -> main, for full-window dialogs
  SHOW_ACTIVE_VIEW: 'view:show-active',
  APP_META_CHANGED: 'app:meta-changed', // main -> renderer push (favicon/title)
  OPEN_APP_MENU: 'app:open-menu', // sidebar hamburger button -> main
  OPEN_APP_CONTEXT_MENU: 'app:open-context-menu', // right-click on a favicon -> main
  APP_CONTEXT_MENU_REMOVE: 'app:context-menu-remove', // main -> renderer push
  NAV_BACK: 'view:nav-back',
  NAV_FORWARD: 'view:nav-forward',
  NAV_RELOAD: 'view:nav-reload',
  NAV_STATE_CHANGED: 'view:nav-state-changed', // main -> renderer push
  NAV_GET_STATE: 'view:get-nav-state', // renderer -> main, for initial state on load
};
