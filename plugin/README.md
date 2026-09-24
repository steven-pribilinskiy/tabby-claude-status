# tabby-claude-status

Works with: [![Tabby](https://img.shields.io/badge/Tabby-tabby.sh-3a3f58?style=for-the-badge)](https://tabby.sh) [![Torbie](https://img.shields.io/badge/Torbie-aylith--labs.github.io%2Ftorbie-2f6f5e?style=for-the-badge)](https://aylith-labs.github.io/torbie/)

Visual status indicators and TTS announcements for [Claude Code](https://claude.ai/code) activity inside the [Tabby](https://tabby.sh) and [Torbie](https://aylith-labs.github.io/torbie/) terminals. Torbie is a Tabby fork that keeps Tabby's plugin API, so the same package loads in both.

Claude Code fires hook events → a tiny `hook.js` script drops one file per event into `%TEMP%\tabby-claude-status.d` → this plugin reads that spool and updates one or more visual surfaces on the matching terminal tab, plus (optionally) speaks a short phrase.

## Install

In either app: **Settings → Plugins**, search `tabby-claude-status`, install, restart. Then **Settings → Claude Status → Hooks → Setup hooks** to wire Claude Code to it. With the plugin in both apps, set up hooks once from either; see [Claude Code hook wiring](#claude-code-hook-wiring).

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
| Taskbar flash | off | Only when the app is unfocused |
| Taskbar icon overlay | off | 16×16 coloured PNGs from `assets/overlay-*.png` |

## Session restore (opt-in)

Enable **Settings → Claude Status → Session restore → Enable session tracking** to persist each Claude Code session's `{ sessionId, cwd, title, lastSeen }` to `tabby-claude-status-sessions.json` in the app's own data folder: `%APPDATA%\tabby` for Tabby, `%APPDATA%\torbie` for Torbie, `data\` beside the executable for a portable install. Each app keeps its own history and resumes only its own sessions. The first time Torbie (or a portable install) runs this version, it copies the history older versions wrote to `%APPDATA%\tabby`, leaving the original untouched. Nothing is written until the toggle is on.

Once enabled:
- Every hook event updates the matching session entry (cwd follows `cd`s inside the Claude session).
- Sessions older than **Retention (days)** are pruned automatically.
- The settings tab lists saved sessions with per-row **Resume** / **✕ Forget** buttons.
- **Resume all now** opens a new local tab per session at the recorded cwd and types `claude --resume <sessionId>` once the pty is ready.
- Turn on **Auto-resume open sessions on launch** to have the plugin do that automatically ~1.5s after the app boots.
- **Extra args** are appended to every resume command (e.g. `--model opus`).

Under the hood this uses `tabby-local`'s `TerminalService.openTab(undefined, cwd)` + `BaseTerminalTabComponent.sendInput()`.

## Running in two apps at once

The hook spool is consume-and-delete: whichever app reads an event first is the only one that sees it. So when two different apps carry this plugin, Tabby and Torbie say, only one of them reads Claude events. Apps are told apart by executable path, and every window of one app reads them as before.

- An app that finds another app already reading stays out of the spool. It says so in a notification and under **Settings → Claude Status → General → Claude events**, where **Handle Claude events in this app** moves them over. The other app stops, and says where they went.
- An app that finds another app reading alongside it offers **Leave Claude events to …**, both in the notification (click it) and in Settings.
- When the app holding the events closes, an app that was leaving them to it starts reading, and says so once.

Versions before 1.2.2 cannot hand the events over. Taking them from such an app asks first, because both apps then read them, each missing some, until it reloads with the update.

The coordination lives in `%TEMP%\tabby-claude-status.windows`: a heartbeat file per window, plus `owner.json` for a hand-over made from Settings.

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
npm run install-plugin # build + copy into every installed app's plugins\node_modules\tabby-claude-status
                       #   (%APPDATA%\tabby and/or %APPDATA%\torbie)
npm run install-plugin -- --app tabby   # or --app torbie: just one
npm run install-plugin -- --dir <data>  # a portable install's data folder
npm test               # node --test over test/*.test.mjs
```

After `install-plugin`, restart the app. The plugin loads via its module entry (`dist/index.js`).

## Installing via the plugin manager

Tabby and Torbie both list npm packages tagged `tabby-plugin`, so users install this plugin by name from Settings → Plugins → search `tabby-claude-status`, in either app.

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
rspack.config.js                          Build (UMD, node target, tabby externals); SWC handles TS via builtin:swc-loader
tsconfig.json
scripts/install-plugin.js                 Copies build output into Tabby's and/or Torbie's plugin dir
```

## Claude Code hook wiring

The hook script is invoked by Claude Code for each event. `~/.claude/settings.json` is per user, not per app, so one set of hooks serves every app that has the plugin: they all read the same spool. **Settings → Claude Status → Hooks → Setup hooks** (in either app) copies `hook.js` to an app-neutral per-user folder, `%LOCALAPPDATA%\tabby-claude-status\hook.js`, and points all 9 events at it in `%USERPROFILE%\.claude\settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse":         [{ "hooks": [{ "type": "command", "command": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\<you>\\AppData\\Local\\tabby-claude-status\\hook.js\"" }] }]
    // ... same for PostToolUse, PostToolUseFailure, Notification, Stop,
    //     UserPromptSubmit, PermissionRequest, SessionStart, SessionEnd
  }
}
```

Running Setup again from the other app replaces the entries in place rather than adding a second set, and older entries that point into an app's `plugins` folder are repointed the same way. Each app refreshes the shared `hook.js` on load when its plugin is newer, never older, so removing the plugin from one app doesn't break hooks for the other. The Hooks tab flags a location whose hooks name a `hook.js` that no longer exists.

`UserPromptSubmit` is what marks a tab "working" as soon as you send a prompt; without it a tab stays idle until the first tool call.

### WSL

From inside WSL, invoke Windows `node.exe` via interop so PIDs and `%TEMP%` resolve to the Windows side (the plugin can't match Linux PIDs). Setup hooks writes this to each distro's `~/.claude/settings.json`, for all 9 events, `UserPromptSubmit` included:

```bash
"/mnt/c/Program Files/nodejs/node.exe" "C:\\Users\\<you>\\AppData\\Local\\tabby-claude-status\\hook.js"
```

## Upstream

Forked from `tabby-claude-status-gse@1.0.1` (MIT, author `graphix`). The original repo is on a private GitLab (`git.gsat.us/GSE/tabby-claude-status`) and isn't publicly browsable — the only public artifact of the upstream is the npm tarball under `tabby-claude-status-gse`. This fork is published as `tabby-claude-status` on npm and developed openly in [this repo](https://github.com/steven-pribilinskiy/tabby-claude-status). Significant divergence from upstream: multi-backend TTS (Edge / Windows OneCore / Piper), display-surface toggles (emoji prefix, progress bar, taskbar flash & overlay), Haiku-narrated dynamic phrases, session restore, mic/Zoom-aware muting, sound-effect mode, activity log.
