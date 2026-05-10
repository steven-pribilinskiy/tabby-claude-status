# Security Policy

## Reporting a Vulnerability

If you find a security issue in `tabby-claude-status` (the plugin or the companion webapp), please **do not file a public issue**. Instead:

- **Preferred:** GitHub's [Private vulnerability reporting](https://github.com/steven-pribilinskiy/tabby-claude-status/security/advisories/new) — most reliable, integrates with GitHub Security Advisories.
- **Alternative:** email the maintainer at the address listed on the [GitHub profile](https://github.com/steven-pribilinskiy).

Please include:

- The version of the package (`npm view tabby-claude-status version` or your `package.json` snapshot)
- A minimal reproduction or proof-of-concept
- Your assessment of the impact and any workarounds you've identified

I'll acknowledge receipt within a few business days, and aim to publish a fix and advisory within two weeks for high-severity issues. Lower-severity issues may take longer.

## Scope

In scope:

- The published npm package `tabby-claude-status` (the plugin)
- The webapp under `web/` (`tabby-claude-status-web`)
- The hook script `plugin/hook.js` that's spawned by Claude Code

Out of scope:

- Vulnerabilities in upstream Tabby itself — report those at [Eugeny/tabby](https://github.com/Eugeny/tabby/security)
- Vulnerabilities in `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `tabby-mcp-server`, or other transitive dependencies — report to the relevant project; once a fixed version ships, this repo's Dependabot will surface a security update PR

## Supported Versions

Only the latest published version on npm receives security updates. Pin to specific versions if you need a long-tail support window.
