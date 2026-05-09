# Upstream

This fork tracks [`tabby-claude-status-gse`](https://www.npmjs.com/package/tabby-claude-status-gse) on npm. The original repo is on a private GitLab (`git.gsat.us/GSE/tabby-claude-status`) and isn't publicly browsable, so the npm tarball is the only diff surface we have.

To refresh this file, run the **`upstream-sync`** skill (`.claude/skills/upstream-sync/`).

## Last reviewed

- **Reviewed at:** 2026-05-09
- **Reviewed up to upstream version:** 1.1.0
- **Fork base version:** 1.0.1 (commit [`0b27862`](../../../commits/0b27862), "Fork tabby-claude-status, add overlay hotkey, fix monitor history scaling")

## Pending backports

Upstream changes identified as worth porting but not yet applied:

- **`safeRenderer: true` config (upstream 1.1.0)** — Default-on flag that fixes a blank-tab-until-resize bug caused by an xterm.js layout race during canvas/webgl reattach (Tabby issues [#11191](https://github.com/Eugeny/tabby/issues/11191), [#11009](https://github.com/Eugeny/tabby/issues/11009)). Skips reading `viewport.scrollTop` / `scrollHeight` / `clientHeight` and calling `terminal.frontend.scrollToBottom()` after applying tab color. Our fork still uses the legacy scroll-preservation path in `plugin/src/decorator/claudeStatusDecorator.ts:624-635`. Port if/when the bug bites; user-invisible until it does.

## Already-applied / superseded from upstream

(none yet)

## Notes on divergence

Areas where this fork has gone its own way; upstream changes in these areas usually WON'T apply cleanly:

- **Multi-backend TTS** (`webspeech` / `edge` / `winrt` / `piper`) vs upstream's web-speech-only `audioService`.
- **Display surfaces beyond color border** — emoji prefix, indeterminate progress bar, activity marker dot, taskbar flash, taskbar overlay (`ClaudeStatusDisplayConfig`).
- **Session restore** — persistent `tabby-claude-status-sessions.json`, auto-resume on Tabby launch, profile capture, run-id tracking (`sessionRestoreService.ts`, `ClaudeSessionRestoreConfig`).
- **Dynamic Haiku-narrated phrases** — Anthropic SDK integration, transcript reader, per-status prompt templates (`claudeApiService.ts`, `transcriptReaderService.ts`, `ClaudeStatusDynamicConfig`).
- **Mic / Zoom-aware muting** — best-effort detection of any active mic recording or Zoom meeting, with independent toggles for TTS vs sound effects (`micStateService.ts`, `zoomStateService.ts`).
- **Sound-effect mode** — per-status sound files (`soundService.ts`, `soundsByStatus`).
- **Activity log** — rolling JSON of every reacted-to event at `%TEMP%\tabby-claude-status-activity.json` (`statusActivityLogService.ts`).
- **Hook fan-out to companion webapp** — `hook.js` POSTs to `tabby-claude-status.lvh.me/api/claude/hook` (configurable via `TABBY_CLAUDE_STATUS_WEBHOOK_URL`).
