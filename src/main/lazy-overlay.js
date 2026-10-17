const { WebContentsView } = require('electron');
const path = require('path');

// How long a closed overlay stays loaded before being torn down — long
// enough that reopening a menu right after closing it reuses the live page
// instead of reloading it, short enough that a menu used once doesn't keep a
// whole renderer process around for the rest of the session.
const IDLE_TEARDOWN_MS = 60 * 1000;

// An overlay WebContentsView (tab menu, group menu, ...) that only exists
// while it's in use: every one of them is its own renderer process, and
// these are opened rarely, so keeping them all loaded from launch cost ~5
// processes and a few hundred MB for menus most sessions never open.
//
// `view` creates it on first access (and cancels any pending teardown);
// `existing` is the view only if it already exists, for close/theme/z-order
// paths that must never create one just to tell it to close. Messages sent
// before the page finishes loading are held and delivered once it has —
// an open call's 'x:open' would otherwise arrive before the page's own
// listener exists and be silently dropped.
class LazyOverlay {
  // name is both the renderer folder (src/renderer/<name>/index.html) and
  // the preload's prefix (src/preload/<name>-preload.js), which all of
  // these overlays already follow. onCreate runs once per created view, for
  // its own listeners and initial theme.
  constructor(win, { name, onCreate }) {
    this.win = win;
    this.name = name;
    this.onCreate = onCreate;
    this.current = null;
    this.teardownTimer = null;
  }

  get existing() {
    return this.current;
  }

  get view() {
    clearTimeout(this.teardownTimer);
    this.teardownTimer = null;
    if (!this.current) this.current = this.create();
    return this.current;
  }

  create() {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', `${this.name}-preload.js`),
        contextIsolation: true,
        sandbox: true,
      },
    });
    view.setBackgroundColor('#00000000');

    const contents = view.webContents;
    const send = contents.send.bind(contents);
    let pending = [];
    contents.send = (...args) => {
      if (pending) pending.push(args);
      else send(...args);
    };
    contents.once('did-finish-load', () => {
      const queued = pending;
      pending = null;
      queued.forEach((args) => send(...args));
    });

    contents.loadFile(path.join(__dirname, '..', 'renderer', this.name, 'index.html'));
    this.win.contentView.addChildView(view);
    this.onCreate(view);
    return view;
  }

  // Called from each overlay's close path; reopening within the window
  // (any access to `view`) cancels it.
  scheduleTeardown() {
    if (!this.current) return;
    clearTimeout(this.teardownTimer);
    this.teardownTimer = setTimeout(() => {
      const view = this.current;
      this.current = null;
      this.teardownTimer = null;
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }, IDLE_TEARDOWN_MS);
  }
}

module.exports = { LazyOverlay };
