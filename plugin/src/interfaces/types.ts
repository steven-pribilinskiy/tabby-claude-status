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
 * Audio configuration for TTS and beep notifications
 */
export interface ClaudeStatusAudioConfig {
    enabled: boolean
    volume: number        // 0.0–1.0
    rate: number          // 0.5–2.0
    pitch: number         // 0.0–2.0
    voiceName: string     // '' = system default
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
}
