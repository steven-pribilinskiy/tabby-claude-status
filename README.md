# tabby-claude-status

Works with: [![Tabby](https://img.shields.io/badge/Tabby-tabby.sh-3a3f58?style=for-the-badge)](https://tabby.sh) [![Torbie](https://img.shields.io/badge/Torbie-aylith--labs.github.io%2Ftorbie-2f6f5e?style=for-the-badge)](https://aylith-labs.github.io/torbie/)

Two halves of one system for running Claude Code inside [Tabby](https://tabby.sh) or [Torbie](https://aylith-labs.github.io/torbie/) (a Tabby fork that keeps Tabby's plugin API, so the same plugin loads in both):

- **[`plugin/`](plugin/README.md)** — the terminal plugin (`tabby-claude-status` on npm). Watches Claude Code hook events and drives per-tab visual state (color, emoji, progress bar, taskbar flash/overlay) plus optional TTS announcements (Web Speech, Edge Neural, Windows OneCore, or local Piper).
- **[`web/`](web/README.md)** — companion webapp that talks to [`tabby-mcp-server`](https://github.com/GentlemanHu/Tabby-MCP) (in whichever app runs it) over HTTP. Snapshot/restore of terminal tabs, an MCP tool explorer UI, and a sink for the plugin's hook fan-out (`POST /api/claude/hook`).

The two communicate via:
- A spool directory at `%TEMP%\tabby-claude-status.d` — `hook.js` drops one file per event, and the plugin reads and deletes them; the webapp doesn't touch it.
- HTTP `POST /api/claude/hook` — the plugin's `hook.js` fires this fire-and-forget on every Claude Code event so the webapp can resolve subsequent curl-only events to a tab. URL is configurable via `TABBY_CLAUDE_STATUS_WEBHOOK_URL`.

The webapp is optional. The plugin works standalone; the webapp adds the snapshot UI and persistent session-resume server-side.

## Quick start

**Plugin** — install from npm through the app's plugin manager (Tabby or Torbie → Settings → Plugins, search `tabby-claude-status`), or build from source:

```bash
cd plugin
npm install
npm run install-plugin                   # builds + copies into every installed app:
                                         #   %APPDATA%\tabby\plugins\node_modules\tabby-claude-status
                                         #   %APPDATA%\torbie\plugins\node_modules\tabby-claude-status
npm run install-plugin -- --app torbie   # just one app
npm run install-plugin -- --dir <data>   # a portable install's data folder
```

Restart the app, then go to Settings → Claude Status → Hooks to wire up Claude Code hooks. Do this once: the hooks point at a shared copy of `hook.js` in `%LOCALAPPDATA%\tabby-claude-status`, so one setup serves Tabby and Torbie alike. Each app keeps its own session history (`tabby-claude-status-sessions.json` in its own data folder).

**Webapp** — designed to run behind a local reverse proxy via container labels (no port mappings):

```bash
cd web
docker compose up --build
# → reachable at https://tabby-claude-status.lvh.me
```

This requires [`pintle`](https://github.com/aylith-labs/pintle) (or any compatible label-driven local proxy) on the `traefik` Docker network.

## Status

- Plugin: actively maintained, published to npm as `tabby-claude-status@1.x`.
- Webapp: tracks the same release cadence as the plugin since they share an IPC contract.

## License

MIT — see [LICENSE](LICENSE). Forked from upstream `tabby-claude-status-gse@1.0.1` by `graphix`.
