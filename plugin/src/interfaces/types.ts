/**
 * Claude status names that correspond to different states
 */
export type ClaudeStatusName = 'working' | 'question' | 'done' | 'error' | 'idle'

/**
 * Metadata that can be included with status updates
 */
export interface ClaudeStatusMetadata {
    tool?: string
    session?: string
    type?: string
    message?: string
    timestamp?: number
    action?: string
    source?: string
    reason?: string
    /**
     * Path to the JSONL session transcript Claude Code maintains. Forwarded
     * by hook.js when present. Used by the `dynamic` audio mode to read the
     * tail of the conversation for context-aware narration.
     */
    transcript_path?: string
    /** Working directory of the Claude Code session. */
    cwd?: string
}

/**
 * TTS backend identifiers
 */
export type TtsBackendId = 'webspeech' | 'edge' | 'winrt' | 'piper'

/**
 * Audio output mode.
 * - `tts` speaks the static `statusTexts` map.
 * - `sound` plays the file in `soundsByStatus`.
 * - `dynamic` asks Haiku 4.5 to write a short announcement based on the
 *   current hook context (last assistant message, tool name, etc.) and
 *   speaks that via the configured TTS backend. Falls back to `statusTexts`
 *   on API failure / timeout / disabled-for-status.
 *
 * The master `enabled` toggle (above) is the off switch — we don't need a
 * fourth "silent" mode.
 */
export type AudioMode = 'tts' | 'sound' | 'dynamic'

/**
 * Per-status configuration for the `dynamic` audio mode.
 */
export interface DynamicPhraseStatusConfig {
    /** When false, this status falls back to `statusTexts[status]`. */
    enabled: boolean
    /**
     * Full prompt template sent as the user message to Haiku. Supports
     * placeholder substitution: {status}, {eventName}, {tool}, {message},
     * {type}, {cwd}, {sessionId}, {lastAssistant}, {lastUserPrompt},
     * {lastToolName}.
     */
    promptTemplate: string
    /**
     * When true, skip the LLM call entirely — derive the announcement from
     * the last assistant message in the transcript via a local "first
     * sentence, ≤8 words" extractor. Zero token cost.
     */
    transcriptOnly: boolean
}

/**
 * Configuration for the `dynamic` audio mode.
 */
export interface ClaudeStatusDynamicConfig {
    /** Anthropic API key. Stored in tabby config; user pastes it. */
    apiKey: string
    /** Model id. Defaults to `claude-haiku-4-5` — pinned per claude-api skill. */
    model: string
    /** Output token cap for the announcement. 32 ≈ 8-12 short words. */
    maxOutputTokens: number
    /** Abort the call after this many ms; falls back to static phrase. */
    timeoutMs: number
    /** Per-status settings (only `done` and `question` are dynamically narrated). */
    perStatus: {
        done: DynamicPhraseStatusConfig
        question: DynamicPhraseStatusConfig
    }
}

/**
 * Audio configuration for TTS and beep notifications
 */
export interface ClaudeStatusAudioConfig {
    enabled: boolean
    volume: number        // 0.0–1.0
    rate: number          // 0.5–2.0
    pitch: number         // 0.0–2.0
    /**
     * Backend-independent default voice (used by Web Speech API and as a legacy value).
     * Per-backend selections live in `voicesByBackend` below.
     */
    voiceName: string
    /** Which TTS backend to use. Falls back to webspeech if unavailable. */
    backend: TtsBackendId
    /**
     * Voice identifier selected for each backend (voice IDs are not comparable across backends).
     * Web Speech uses voice display names, Edge uses ShortName (e.g. "en-US-AriaNeural"),
     * WinRT uses Id strings, Piper uses the model file basename.
     */
    voicesByBackend: Partial<Record<TtsBackendId, string>>
    /** Absolute path to a piper.exe (or piper on *nix). Empty = disabled. */
    piperExePath: string
    /** Absolute path to a .onnx Piper model file. Empty = disabled. */
    piperModelPath: string
    systemBeep: boolean
    /**
     * When true, TTS stays silent while Zoom is actively recording a meeting
     * to the local disk. Detection is best-effort via the recording folder's
     * recent write activity.
     */
    muteDuringZoomRecording: boolean
    /**
     * When true, TTS stays silent while Zoom is in any meeting (recording or
     * not) — detected via active UDP media sockets owned by Zoom.exe.
     */
    muteDuringZoomMeeting: boolean
    /**
     * When true, TTS stays silent while ANY app is actively using the
     * microphone — covers Zoom, Teams, Discord, Windows Voice Access,
     * browser voice input, dictation tools, etc. Detected via the Windows
     * mic-access registry under CapabilityAccessManager.
     */
    muteTtsDuringMicActive: boolean
    /**
     * Same as above but for sound effects. Independent toggle so users can
     * keep short status chimes during a call while still suppressing the
     * more intrusive spoken phrases.
     */
    muteSoundDuringMicActive: boolean
    /**
     * Output mode. `tts` speaks `statusTexts`; `sound` plays the file paths
     * in `soundsByStatus`. Both maps are persisted independently so toggling
     * mode preserves the user's selections in the other mode.
     */
    mode: AudioMode
    /**
     * Per-status absolute file path of the sound to play when `mode === 'sound'`.
     * Empty string = skip (matches the existing convention for `statusTexts`).
     */
    soundsByStatus: {
        done: string
        question: string
        error: string
        working: string
        idle: string
    }
    statusTexts: {
        done: string
        question: string
        error: string
        working: string
        idle: string
    }
    /**
     * Settings for `mode === 'dynamic'`. Always present so the form binds even
     * when the user hasn't switched modes yet.
     */
    dynamic: ClaudeStatusDynamicConfig
}

/**
 * Per-status emoji/glyph prefix used by the `titleEmoji` display surface.
 */
export interface ClaudeStatusEmojiMap {
    working: string
    question: string
    done: string
    error: string
    idle: string
}

/**
 * Which visual surfaces the plugin should drive when status changes.
 * Every surface is individually toggleable; the historical default (just
 * `colorBorder`) is preserved.
 */
export interface ClaudeStatusDisplayConfig {
    colorBorder: boolean
    titleEmoji: boolean
    titleEmojiMap: ClaudeStatusEmojiMap
    progressBar: boolean
    activityMarker: boolean
    taskbarFlash: boolean
    taskbarOverlay: boolean
}

/**
 * Event→status mapping for v2 events from hook.js
 */
export const HOOK_EVENT_STATUS_MAP: Record<string, ClaudeStatusName | ((meta: any) => ClaudeStatusName)> = {
    'Stop': 'done',
    'PermissionRequest': 'question',
    'PostToolUseFailure': 'error',
    'UserPromptSubmit': 'working',
    'PreToolUse': 'working',
    'PostToolUse': 'working',
    'SessionStart': 'idle',
    'SessionEnd': 'idle',
    'Notification': (meta) =>
        ['permission_prompt', 'ask_user', 'confirmation', 'idle_prompt'].includes(meta?.type)
            ? 'question' : 'working',
}

/**
 * Default audio configuration
 */
export const DEFAULT_AUDIO_CONFIG: ClaudeStatusAudioConfig = {
    enabled: true,
    volume: 0.7,
    rate: 1.0,
    pitch: 1.0,
    voiceName: '',
    backend: 'webspeech',
    voicesByBackend: {},
    piperExePath: '',
    piperModelPath: '',
    systemBeep: false,
    muteDuringZoomRecording: true,
    muteDuringZoomMeeting: true,
    muteTtsDuringMicActive: true,
    muteSoundDuringMicActive: true,
    mode: 'tts',
    soundsByStatus: {
        done: '',
        question: '',
        error: '',
        working: '',
        idle: '',
    },
    statusTexts: {
        done: "I'm Done",
        question: 'Question',
        error: '',
        working: '',
        idle: 'Idle',
    },
    dynamic: {
        apiKey: '',
        model: 'claude-haiku-4-5',
        maxOutputTokens: 32,
        timeoutMs: 1500,
        perStatus: {
            done: {
                enabled: true,
                transcriptOnly: false,
                promptTemplate:
                    'Claude just finished a task. Tool last used: {lastToolName}. ' +
                    "Last assistant message: \"{lastAssistant}\". " +
                    'Write one short, casual announcement (≤7 words, no punctuation, no quotes) ' +
                    'that captures what was completed. Examples: "tests passing", "deploy finished", ' +
                    '"refactor done", "report ready". Output the phrase only.',
            },
            question: {
                enabled: true,
                transcriptOnly: false,
                promptTemplate:
                    'Claude is asking the user a question or requesting permission. ' +
                    'Notification type: {type}. Tool: {tool}. Message: "{message}". ' +
                    'Last assistant message: "{lastAssistant}". ' +
                    'Write one short, casual announcement (≤7 words, no punctuation, no quotes) ' +
                    'that hints at what is being asked without reading it verbatim. ' +
                    'Examples: "permission needed", "waiting on you", "confirm to continue". ' +
                    'Output the phrase only.',
            },
        },
    },
}

/**
 * Default emoji prefixes for the `titleEmoji` surface.
 */
export const DEFAULT_EMOJI_MAP: ClaudeStatusEmojiMap = {
    working: '⚡',
    question: '❓',
    done: '✅',
    error: '❌',
    idle: '',
}

/**
 * Default display-surface configuration. Only `colorBorder` is on by default
 * so the upgrade from <=1.1.x looks the same until users opt into the new
 * surfaces.
 */
export const DEFAULT_DISPLAY_CONFIG: ClaudeStatusDisplayConfig = {
    colorBorder: true,
    titleEmoji: false,
    titleEmojiMap: DEFAULT_EMOJI_MAP,
    progressBar: false,
    activityMarker: false,
    taskbarFlash: false,
    taskbarOverlay: false,
}

/**
 * A single persisted Claude session so it can be resumed on the next Tabby launch.
 */
export interface ClaudeSessionRecord {
    sessionId: string
    cwd: string
    title?: string
    /**
     * Tabby profile that owned the original tab — id is the persistent
     * profile identifier (looked up via ProfilesService.getProfiles()).
     * Without this we resumed every session through the default profile,
     * which sent Windows-cwd sessions into WSL.
     */
    profileId?: string
    /** Display name of the original profile, kept for the UI even if the profile is later deleted. */
    profileName?: string
    /** Profile family ('local', 'ssh', 'serial', …) — used as a fallback if the id lookup fails. */
    profileType?: string
    /** Unix ms at which we last saw a hook event for this session. */
    lastSeen: number
    /** Unix ms at which we first recorded this session. */
    firstSeen: number
    /**
     * True if this session has explicitly ended (Claude Code fired
     * `SessionEnd`) — or the user marked it closed from the UI. Auto-resume
     * skips closed sessions so only sessions that were still open when Tabby
     * last ran get resurrected.
     */
    closed?: boolean
    /**
     * Tabby run during which this record was last touched by a hook event.
     * Compared against `SessionsFile.currentRunId` and `previousRunId` to
     * decide whether the row belongs in Active / Previous run / History.
     * Optional for backwards compatibility with sessions written before this
     * field existed (those land in History on the next startup migration).
     */
    runId?: string
}

/**
 * Session restore (resume previous Claude Code sessions after a Tabby restart)
 * configuration. Opt-in by default — `enabled: false`.
 */
export interface ClaudeSessionRestoreConfig {
    /** Master switch. When false, no sessions are persisted and no auto-resume runs. */
    enabled: boolean
    /** Auto-open saved sessions when the plugin first loads (i.e. Tabby launch). */
    autoResumeOnLaunch: boolean
    /** Sessions older than this are pruned and excluded from auto-resume. */
    retentionDays: number
    /** Extra flags appended after `claude --resume <id>` (e.g. `--model opus`). */
    extraArgs: string
    /**
     * Seconds to wait between sending `cd "<cwd>"\n` and `claude --resume\n`
     * into the new pty. Empirically Tabby's openTab(profile, cwd) does not
     * always honor cwd for WSL-backed profiles (the shell ends up in the
     * profile's default working dir), so we always send an explicit cd and
     * give it a beat to land before typing the resume command. Without the
     * gap, claude runs from the wrong cwd and reports
     * "No conversation found with session ID …" because the on-disk session
     * cache is per-cwd.
     */
    resumeCdDelaySec: number
    /**
     * Seconds to wait between `terminalService.openTab(...)` returning and
     * the FIRST `cd "<cwd>"\r` keystroke being sent. Originally this was
     * hard-coded at 800 ms, which is fine for an already-warm WSL distro
     * but loses input on a cold-boot WSL or a slow shell init (oh-my-zsh
     * sourcing, nvm.lazy, fnm, starship pre-prompt) — the pty isn't
     * accepting input yet, the cd line vanishes into a buffer that gets
     * cleared by the prompt redraw, and the user's tab opens at the
     * profile's default cwd (~/projects) with no cd, no resume, just a
     * fresh prompt. Bumping this past your shell's startup time makes
     * Resume reliable; default is 1.5 s.
     */
    resumeOpenDelaySec: number
}

/**
 * Configuration for the Claude status plugin
 */
export interface ClaudeStatusConfig {
    /** Whether the plugin is enabled */
    enabled: boolean
    /** Color mappings for each status */
    colors: {
        working: string
        question: string
        done: string
        error: string
    }
    /** Whether to clear the tab color when the tab is focused */
    clearOnFocus: boolean
    /** Milliseconds after which 'done' status auto-resets to idle (0 to disable) */
    doneAutoResetMs: number
    /** Enable debug logging */
    debugMode: boolean
    /** Audio/TTS configuration */
    audio: ClaudeStatusAudioConfig
    /** Visual display-surface configuration */
    display: ClaudeStatusDisplayConfig
    /** Session-restore configuration (opt-in) */
    sessionRestore: ClaudeSessionRestoreConfig
}

/**
 * Default session-restore configuration. Opt-in: `enabled` defaults to false,
 * matching the user's explicit requirement that this feature never activates
 * without being turned on.
 */
export const DEFAULT_SESSION_RESTORE_CONFIG: ClaudeSessionRestoreConfig = {
    enabled: false,
    autoResumeOnLaunch: false,
    retentionDays: 7,
    // Skip the permission prompts when resuming — the user already trusted
    // Claude in the previous session, and a resume into an interactive prompt
    // defeats the whole point of auto-resume.
    extraArgs: '--dangerously-skip-permissions',
    resumeCdDelaySec: 1.2,
    resumeOpenDelaySec: 1.5,
}

/**
 * Parsed status event from escape sequence
 */
export interface ClaudeStatusEvent {
    version: number
    status: ClaudeStatusName
    metadata: ClaudeStatusMetadata
    /** For v2 events, stores the raw hook event name before mapping to status */
    eventName?: string
}

/**
 * Result from parsing terminal output
 */
export interface ParseResult {
    /** Output with escape sequences stripped */
    cleanedOutput: string
    /** Parsed status events */
    events: ClaudeStatusEvent[]
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: ClaudeStatusConfig = {
    enabled: true,
    colors: {
        working: '#f59e0b',  // Amber
        question: '#3b82f6', // Blue
        done: '#22c55e',     // Green
        error: '#ef4444',    // Red
    },
    clearOnFocus: true,
    doneAutoResetMs: 0,
    debugMode: false,
    audio: DEFAULT_AUDIO_CONFIG,
    display: DEFAULT_DISPLAY_CONFIG,
    sessionRestore: DEFAULT_SESSION_RESTORE_CONFIG,
}
