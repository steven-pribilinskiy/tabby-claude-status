# tabby-claude-status

Visual tab color indicator for Claude Code activity inside the [Tabby](https://tabby.sh) terminal. Source extracted from upstream `tabby-claude-status-gse` v1.0.1 (self-hosted GitLab at `git.gsat.us/GSE`) so changes can live here.

## What it does

Claude Code fires hook events. A lightweight hook script (`hook.js`) writes the current event to `%TEMP%\tabby-claude-status.json`. This Tabby plugin watches the file and colors the tab:

| State | Color | Fired on |
|---|---|---|
| Working | Amber `#f59e0b` | PreToolUse / PostToolUse |
| Question | Blue `#3b82f6` | Notification / PermissionRequest |
| Done | Green `#22c55e` | Stop |
| Error | Red `#ef4444` | PostToolUseFailure |
| Idle | — | default |

Matching is done by Windows PID ancestry: the hook walks up to 6 levels of parents; the plugin intersects those PIDs with its known `terminalPids` map.

## Develop

```bash
npm install
npm run watch          # rebuild on change
npm run build          # one-shot production build
npm run install-plugin # build + copy into %APPDATA%\tabby\plugins\node_modules\tabby-claude-status
```

After `install-plugin`, restart Tabby. The plugin loads via its module entry (`dist/index.js`).

## Layout

```
src/
  claudeStatusModule.ts                  NgModule wiring
  index.ts                               public exports
  components/
    claudeStatusSettingsTab.component.ts Settings UI
  decorator/
    claudeStatusDecorator.ts             Watches status file, sets tab colors
  interfaces/
    types.ts                             ClaudeStatusConfig, HOOK_EVENT_STATUS_MAP
  providers/
    configProvider.ts                    Default config provider
    settingsTabProvider.ts               Registers settings page
  services/
    audioService.ts                      TTS + beep on status change
    configService.ts                     Plugin config accessor
    statusParserService.ts               OSC escape-sequence parser
hook.js                                   Cross-platform Claude Code hook script
webpack.config.js                         Build (UMD, node target, tabby externals)
tsconfig.json
scripts/install-plugin.js                 Copies build output into Tabby's plugin dir
```

## Claude Code hook wiring

The hook script is invoked by Claude Code for each event. Point all 9 events at the same command in `%USERPROFILE%\.claude\settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse":         [{ "hooks": [{ "type": "command", "command": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\<you>\\AppData\\Roaming\\tabby\\plugins\\node_modules\\tabby-claude-status\\hook.js\"" }] }]
    // ... same for PostToolUse, PostToolUseFailure, Notification, Stop,
    //     UserPromptSubmit, PermissionRequest, SessionStart, SessionEnd
  }
}
```

### WSL

From inside WSL, invoke Windows `node.exe` via interop so PIDs and `%TEMP%` resolve to the Windows side (the plugin can't match Linux PIDs):

```bash
"/mnt/c/Program Files/nodejs/node.exe" "C:\Users\<you>\AppData\Roaming\tabby\plugins\node_modules\tabby-claude-status\hook.js"
```

See [`tabby-claude-status-plugin-2026.md`](https://notes.lvh.me/#/tabby-claude-status-plugin-2026.md) in the personal notes repo for a full new-machine setup walkthrough and troubleshooting.

## Upstream

Source material: `tabby-claude-status-gse@1.0.1` (MIT, author `graphix`, hosted at `git.gsat.us/GSE/tabby-claude-status`). Local fork exists so divergent changes have a home.
