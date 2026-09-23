const { REPORT_UNREAD } = require('../renderer/shared/ipc-channels');

// A count-bearing Gmail title (e.g. "Inbox (3) - Gmail") only appears on a
// list view (inbox/label/search/etc.) — opening a single thread swaps the
// title for that message's subject instead, with no count at all. That
// makes a bare "no count" title ambiguous on its own: it means either
// "genuinely zero unread" or "a thread is open right now", and those need
// opposite handling (the former should zero the badge, the latter should
// leave it alone). The hash disambiguates them, since only list views use
// one of these forms — anything else (a thread's own hash, settings, etc.)
// is assumed to be a non-list view and ignored.
const GMAIL_LIST_HASH = /^#(?:inbox|starred|snoozed|sent|drafts|all|spam|trash|important|chats)(?:\/p\d+)?$|^#label\/[^/]+$|^#search\/[^/]*$/;

// Strategy: title-count — e.g. document.title becomes "Inbox (3) - Gmail".
// The count-bearing case always updates the badge. A title with no count is
// otherwise ignored (stays stale) rather than treated as zero, since for
// most apps using this strategy there's no way to tell "zero unread" apart
// from "not currently showing a count for some other reason" — except
// Gmail specifically, where the hash resolves that ambiguity (see
// GMAIL_LIST_HASH above), so a bare title there can confidently mean zero.
function watchTitleCount(view, onChange) {
  view.webContents.on('page-title-updated', (event, title) => {
    const match = title.match(/\((\d+)\)/);
    if (match) {
      onChange(parseInt(match[1], 10));
      return;
    }
    let url;
    try {
      url = new URL(view.webContents.getURL());
    } catch {
      return;
    }
    if (url.hostname === 'mail.google.com' && GMAIL_LIST_HASH.test(url.hash)) onChange(0);
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
