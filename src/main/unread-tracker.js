const { REPORT_UNREAD } = require('../renderer/shared/ipc-channels');

// Strategy: title-count — e.g. document.title becomes "Inbox (3) - Gmail".
// Only the count-bearing case updates the badge; a title with no count is
// ignored rather than treated as zero. Gmail (and presumably others using
// this strategy) only includes the count while showing the inbox/list view
// — opening a single message swaps the title for that message's subject
// instead, with no count at all, which was zeroing the badge just from
// opening an email rather than from it actually being read. The trade-off:
// since Gmail also drops the count entirely once truly back to zero
// unread (the same "no count" title as reading a message), the badge can
// stay stale-but-nonzero for a moment after the last unread item is
// cleared, until the next count-bearing title comes along.
function watchTitleCount(view, onChange) {
  view.webContents.on('page-title-updated', (event, title) => {
    const match = title.match(/\((\d+)\)/);
    if (match) onChange(parseInt(match[1], 10));
  });
}

// Some apps (Telegram Web among them) skip the document.title trick
// entirely and report unread counts through the Badging API
// (navigator.setAppBadge/clearAppBadge) instead — webview-preload.js
// intercepts those calls in the page's main world and forwards them here
// over REPORT_UNREAD, since Electron's own Badging API support just sets
// the OS dock/taskbar badge for the whole app, not a per-pinned-app count
// this sidebar can show. webContents.ipc scopes the listener to messages
// from this one view, so no appId bookkeeping is needed here. Wired
// unconditionally rather than as a selectable strategy — it's a no-op for
// apps that never call the Badging API, so there's nothing to configure.
function watchAppBadge(view, onChange) {
  view.webContents.ipc.on(REPORT_UNREAD, (event, count) => onChange(count));
}

module.exports = { watchTitleCount, watchAppBadge };
