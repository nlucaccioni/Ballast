# Ballast

A Station/Wavebox-style desktop app: a sidebar of pinned web apps (Gmail, Slack,
Calendar, etc.), each isolated in its own session, with support for grouping
related apps together, live favicons, unread badges, and account sharing
across apps from the same provider.

Built with Electron. Currently an MVP — the sidebar UI is a functional
placeholder, not a final design.

## Running locally

```
npm install
npm start
```

No packaging/build step yet — this runs directly against the Electron
binary in `node_modules`.

## Adding an app

Click the `+` button at the bottom of the sidebar and either:

- Type a URL (e.g. `mail.google.com`) — `https://` is inferred if you leave
  it off.
- Type a search term (e.g. `telegram web`) — this opens a Google search
  inside the pinned slot; once you click through to the real site, Ballast
  automatically repoints the pinned app at wherever you land.

Apps on the same root domain (e.g. `mail.google.com` and
`calendar.google.com`) automatically share a login session. Drag one app
icon onto another to group them into a single sidebar slot; right-click an
icon to remove it from its group or from the sidebar entirely.

## Project layout

- `src/main/` — Electron main process: window/session/view management,
  persisted app config, IPC handlers.
- `src/preload/` — context-bridge preload scripts for the sidebar and for
  each pinned app's own view.
- `src/renderer/sidebar/` — the sidebar UI itself (placeholder, see above).
- `config/default-apps.json` — seed app list used the first time the app
  runs; after that, the user's own config (in the OS user-data directory)
  takes over.

## License

MIT — see [LICENSE](LICENSE).
