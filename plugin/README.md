# tabby-claude-status

Visual status indicators and TTS announcements for [Claude Code](https://claude.ai/code) activity inside the [Tabby](https://tabby.sh) terminal.

Claude Code fires hook events → a tiny `hook.js` script writes the current event to `%TEMP%\tabby-claude-status.json` → this plugin watches the file and updates one or more visual surfaces on the matching terminal tab, plus (optionally) speaks a short phrase.

## Status mapping

| State | Fired on |
|---|---|
| working | PreToolUse / PostToolUse / UserPromptSubmit |
| question | Notification / PermissionRequest |
| done | Stop |
| error | PostToolUseFailure |
| idle | SessionStart / SessionEnd |

Tab matching is done by Windows PID ancestry: the hook walks up to 6 levels of parents; the plugin intersects those PIDs with its `terminalPids` map.

## Display surfaces

Every surface is individually toggleable in **Settings → Claude Status → Display surfaces**. Defaults preserve the classic behaviour (bottom colour border only).

| Surface | Default | Notes |
|---|---|---|
| Tab bottom border colour | **on** | Uses the colours defined in the Tab Colors section |
| Tab title emoji prefix | off | Per-status emoji configurable; defaults `⚡ ❓ ✅ ❌` |
| Indeterminate progress bar | off | Pulses during `working` |
| Activity marker dot | off | The same dot Tabby uses for background activity; shown on `question` / `error` |
| Taskbar flash | off | Only when Tabby is unfocused |
| Taskbar icon overlay | off | 16×16 coloured PNGs from `assets/overlay-*.png` |

## Session restore (opt-in)

Enable **Settings → Claude Status → Session restore → Enable session tracking** to persist each Claude Code session's `{ sessionId, cwd, title, lastSeen }` to `%APPDATA%\tabby\tabby-claude-status-sessions.json`. Nothing is written until the toggle is on.

Once enabled:
- Every hook event updates the matching session entry (cwd follows `cd`s inside the Claude session).
- Sessions older than **Retention (days)** are pruned automatically.
- The settings tab lists saved sessions with per-row **Resume** / **✕ Forget** buttons.
- **Resume all now** opens a new local tab per session at the recorded cwd and types `claude --resume <sessionId>` once the pty is ready.
- Turn on **Auto-resume all saved sessions on Tabby launch** to have the plugin do that automatically ~1.5s after Tabby boots.
- **Extra args** are appended to every resume command (e.g. `--model opus`).

Under the hood this uses `tabby-local`'s `TerminalService.openTab(undefined, cwd)` + `BaseTerminalTabComponent.sendInput()`.

## TTS backends

The voice dropdown previously exposed only SAPI 5 voices (David/Mark/Zira) because that's all Chromium's Web Speech API surfaces on Windows. v1.2 introduces a backend picker with four options; Web Speech remains the always-available fallback when the chosen backend fails.

| Backend | Quality | Offline | Notes |
|---|---|---|---|
| Web Speech (SAPI) | low | ✓ | default; SAPI 5 only |
| Edge TTS (`msedge-tts`) | neural | ✗ | uses the free Azure Read Aloud endpoint; no API key |
| Windows OneCore | good | ✓ | shells out to PowerShell `Windows.Media.SpeechSynthesis`; surfaces Natural Voices installed via Settings → Time & Language → Speech |
| Piper | neural | ✓ | set `piperExePath` and `piperModelPath` to use a local [Piper](https://github.com/rhasspy/piper) install |

Each backend remembers its own voice selection (`voicesByBackend`), so switching backends doesn't wipe your Edge voice when you flip back to Web Speech.

## Develop

```bash
npm install
npm run watch          # rebuild on change
npm run build          # one-shot production build
npm run install-plugin # build + copy into %APPDATA%\tabby\plugins\node_modules\tabby-claude-status
```

After `install-plugin`, restart Tabby. The plugin loads via its module entry (`dist/index.js`).

## Installing via Tabby's plugin manager

Once published to npm, users can install this plugin by name from Tabby → Settings → Plugins → search `tabby-claude-status`.

## Layout

```
src/
  claudeStatusModule.ts                  NgModule wiring
  index.ts                               public exports
  components/
    claudeStatusSettingsTab.component.ts Settings UI
  decorator/
    claudeStatusDecorator.ts             Watches status file, drives display surfaces
  interfaces/
    types.ts                             Config interfaces + defaults
  providers/
    configProvider.ts                    Default config provider
    settingsTabProvider.ts               Registers settings page
  services/
    audioService.ts                      Dispatches to selected TTS backend
    configService.ts                     Plugin config accessor
    statusParserService.ts               OSC escape-sequence parser
    tts/
      tts.interface.ts                   TtsBackend interface
      webSpeechBackend.ts                Web Speech / SAPI 5
      edgeTtsBackend.ts                  Microsoft Edge Read Aloud
      winRtBackend.ts                    Windows OneCore via PowerShell
      piperBackend.ts                    Local Piper TTS
assets/
  overlay-working.png  overlay-question.png  overlay-done.png  overlay-error.png
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

The Settings tab has a **Setup Claude Hooks** button that writes this for you.

### WSL

From inside WSL, invoke Windows `node.exe` via interop so PIDs and `%TEMP%` resolve to the Windows side (the plugin can't match Linux PIDs):

```bash
"/mnt/c/Program Files/nodejs/node.exe" "C:\Users\<you>\AppData\Roaming\tabby\plugins\node_modules\tabby-claude-status\hook.js"
```

See [`tabby-claude-status-plugin-2026.md`](https://notes.lvh.me/#/tabby-claude-status-plugin-2026.md) in the personal notes repo for a full new-machine setup walkthrough and troubleshooting.

## Upstream

Source material: `tabby-claude-status-gse@1.0.1` (MIT, author `graphix`, hosted at `git.gsat.us/GSE/tabby-claude-status`). Local fork exists so divergent changes (multi-backend TTS, display-surface toggles) have a home.
