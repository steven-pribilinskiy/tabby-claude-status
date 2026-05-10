# tabby-claude-status web

Companion webapp for the [`tabby-claude-status`](../plugin) Tabby plugin. Two pages plus a hook sink:

- **`/tabby`** — snapshot/restore Tabby tabs. Lists live sessions (driven over MCP from `tabby-mcp-server`), saves named snapshots, restores tabs into the matching profile with the original cwd + an automatic `claude --resume <sessionId>` for Claude Code sessions.
- **`/tabby/mcp`** — interactive form-driven explorer for every `tabby-mcp` tool (tabs, sessions, profiles, SFTP).
- **`POST /api/claude/hook`** — sink for the plugin's `hook.js` fire-and-forget. Caches `session_id → ancestors[], ppid` in memory so curl-only Claude Code hooks can still resolve a tab.

The plugin and the webapp share an IPC contract (`%TEMP%\tabby-claude-status.json` file format + the hook payload), which is why they live in the same repo.

## Run with Docker (recommended)

The container is meant to live behind a label-driven local proxy on a shared `traefik` network — no port mapping, no host bind. Designed for [`local-proxy`](https://github.com/steven-pribilinskiy/local-proxy) but any compatible label scheme works.

```bash
docker compose up --build
```

Then browse `https://tabby-claude-status.lvh.me/tabby`.

Persistent state (snapshots, profile settings) lives in `./data/` and is bind-mounted into the container at `/app/data`. The plugin still writes to `%TEMP%\tabby-claude-status.json` on the host — that file is unrelated to the webapp's `/app/data`.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Server listens on this port. local-proxy `local-proxy.port` label must match. |
| `DATA_DIR` | `/app/data` | Where `tabby-sessions.json` and `tabby-profile-settings.json` live. |
| `TABBY_MCP_URL` | `http://host.docker.internal:3001/mcp` | Where `tabby-mcp-server` is reachable. From a container, the host-bridge alias is required. |

### `host.docker.internal` on Linux Docker

Without Docker Desktop you also need the `extra_hosts: ["host.docker.internal:host-gateway"]` line that's already in `docker-compose.yml`. With Docker Desktop it's a no-op.

## Run locally without Docker

```bash
npm install
npm run dev
```

Vite serves the SPA on `:5173` and proxies `/api/*` to the Hono server on `:3000`. Set `TABBY_MCP_URL` if `tabby-mcp-server` isn't on the default `http://127.0.0.1:3001/mcp`.

## Architecture

- **Server**: Hono on `@hono/node-server`. Routes mounted under `/api/tabby` (40+ endpoints from `routes/tabby.ts`) and `/api/claude` (hook sink). The MCP transport is `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` — wrapped in a small auto-reconnecting client (`lib/tabby-mcp-client.ts`).
- **Client**: Vite + React 19 + Tailwind 4 + Zustand. The two pages copy verbatim from windows-settings; the `useCachedEndpoint` hook + Zustand store give every endpoint a stale-while-revalidate cache backed by localStorage. No SSR.
- **Hook ingestion**: `routes/claude-hook.ts` is sink-only — it caches session ancestry in memory but does NOT write `%TEMP%\tabby-claude-status.json`. That file belongs to the plugin's own `hook.js`; double-writing it caused 3x activity-log dedup misses in the past.

## Pointing the plugin at this server

The plugin's `hook.js` posts to `https://tabby-claude-status.lvh.me/api/claude/hook` by default. Override per-machine with `TABBY_CLAUDE_STATUS_WEBHOOK_URL` in the user's environment (Tabby inherits the launching shell's env, so `setx TABBY_CLAUDE_STATUS_WEBHOOK_URL https://something.local/api/claude/hook` on Windows works).
