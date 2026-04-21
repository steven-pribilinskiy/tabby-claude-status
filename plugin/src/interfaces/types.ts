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
}

/**
 * TTS backend identifiers
 */
export type TtsBackendId = 'webspeech' | 'edge' | 'winrt' | 'piper'

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
    statusTexts: {
        done: string
        question: string
        error: string
        working: string
        idle: string
    }
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
    statusTexts: {
        done: "I'm Done",
        question: 'Question',
        error: '',
        working: '',
        idle: 'Idle',
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
    /** Unix ms at which we last saw a hook event for this session. */
    lastSeen: number
    /** Unix ms at which we first recorded this session. */
    firstSeen: number
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
    extraArgs: '',
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
