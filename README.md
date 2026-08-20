# tabby-claude-status

Two halves of one system for running Claude Code inside [Tabby](https://tabby.sh):

- **[`plugin/`](plugin/README.md)** — the Tabby plugin (`tabby-claude-status` on npm). Watches Claude Code hook events and drives per-tab visual state (color, emoji, progress bar, taskbar flash/overlay) plus optional TTS announcements (Web Speech, Edge Neural, Windows OneCore, or local Piper).
- **[`web/`](web/README.md)** — companion webapp that talks to [`tabby-mcp-server`](https://github.com/GentlemanHu/Tabby-MCP) over HTTP. Snapshot/restore of Tabby tabs, an MCP tool explorer UI, and a sink for the plugin's hook fan-out (`POST /api/claude/hook`).

The two communicate via:
- A status JSON file at `%TEMP%\tabby-claude-status.json` — the plugin's own decorator reads it; the webapp doesn't.
- HTTP `POST /api/claude/hook` — the plugin's `hook.js` fires this fire-and-forget on every Claude Code event so the webapp can resolve subsequent curl-only events to a tab. URL is configurable via `TABBY_CLAUDE_STATUS_WEBHOOK_URL`.

The webapp is optional. The plugin works standalone; the webapp adds the snapshot UI and persistent session-resume server-side.

## Quick start

**Plugin** — install from npm into Tabby's plugin manager (search `tabby-claude-status`), or build from source:

```bash
cd plugin
npm install
npm run install-plugin   # builds + copies into %APPDATA%\tabby\plugins\node_modules\tabby-claude-status
```

Restart Tabby, then go to Settings → Claude Status to wire up Claude Code hooks.

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
