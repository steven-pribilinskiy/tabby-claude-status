# Contributing

Thanks for the interest in `tabby-claude-status`. This repo is a monorepo with two halves:

- **`plugin/`** — the npm-published Tabby plugin (`tabby-claude-status`)
- **`web/`** — the optional companion webapp (Hono + Vite + React, runs in Docker)

## Local setup

You'll need Node 22+ (Node 24 recommended — that's what CI uses, and it ships with npm 11+ which is required for the publish flow).

```bash
git clone https://github.com/steven-pribilinskiy/tabby-claude-status.git
cd tabby-claude-status

# Repo-root tooling (Biome)
npm install

# Plugin
cd plugin && npm install
cd ..

# Webapp (only if you're working on the webapp half)
cd web && npm install
cd ..
```

The plugin's `npm install` may emit Tabby ecosystem peer-dep warnings — that's expected; `plugin/.npmrc` has `legacy-peer-deps=true` so the install proceeds with the lockfile's resolution.

## Common tasks

From the repo root:

```bash
npm run check        # Biome lint + format check across plugin/ and web/
npm run check:fix    # Auto-fix what Biome can
npm run format       # Format only
```

Per package:

```bash
# Plugin
cd plugin
npm run typecheck    # tsgo (TypeScript 7 beta) — type-only check
npm run build        # rspack production build → dist/
npm run watch        # rspack watch mode for plugin development
npm run install-plugin   # build + copy into %APPDATA%\tabby\plugins\node_modules\tabby-claude-status

# Webapp
cd web
npm run dev          # Vite + Hono concurrently
npm run typecheck    # tsgo
npm run build:client # Vite production build → public/
```

After running `install-plugin`, restart Tabby (full quit from system tray, not just window-close) to load the new bundle.

## Submitting a change

1. Fork the repo on GitHub
2. Branch from `main` for your change
3. Make sure `npm run check` and `npm run typecheck` (in both `plugin/` and `web/` if you touched both) are clean before opening a PR
4. Open a PR against `main` describing what changed and why
5. CI will run the same checks; once green and reviewed, the PR is merged via squash

If your change touches the plugin's behavior, mention any relevant Tabby version you tested against — Tabby's plugin API has shifted occasionally.

## Code style

Biome enforces formatting + lint rules. The two halves use different conventions:

- `plugin/` — 4-space indent, single quotes, no semicolons (matches the upstream tabby-claude-status convention)
- `web/` — tab indent, double quotes, semicolons (matches the broader monorepo Hono/React style this code came from)

Don't fight Biome — run `npm run check:fix` and let it normalize.

## Releases

Maintainer-only — see commits + release notes for the cadence. Releases are tagged `vMAJOR.MINOR.PATCH` and trigger an automated npm publish via Trusted Publishing (no token in CI).

## License

MIT — see [LICENSE](LICENSE). Contributions are accepted under the same license.
