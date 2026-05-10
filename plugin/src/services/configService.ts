import { Injectable } from '@angular/core'
import type { ConfigService } from 'tabby-core'
import {
    type ClaudeSessionRestoreConfig,
    type ClaudeStatusAudioConfig,
    type ClaudeStatusConfig,
    type ClaudeStatusDisplayConfig,
    DEFAULT_AUDIO_CONFIG,
    DEFAULT_CONFIG,
    DEFAULT_DISPLAY_CONFIG,
    DEFAULT_EMOJI_MAP,
    DEFAULT_SESSION_RESTORE_CONFIG,
} from '../interfaces/types'

/**
 * Service for accessing Claude status plugin configuration
 */
@Injectable({ providedIn: 'root' })
export class ClaudeStatusConfigService {
    constructor(private config: ConfigService) {}

    /**
     * Get the current plugin configuration
     */
    get(): ClaudeStatusConfig {
        const stored = this.config.store.claudeStatus || {}
        return {
            ...DEFAULT_CONFIG,
            ...stored,
            colors: {
                ...DEFAULT_CONFIG.colors,
                ...(stored.colors || {}),
            },
            display: this.getDisplayConfig(),
        }
    }

    /**
     * Check if the plugin is enabled
     */
    get enabled(): boolean {
        return this.get().enabled
    }

    /**
     * Check if debug mode is enabled
     */
    get debugMode(): boolean {
        return this.get().debugMode
    }

    /**
     * Get the color for a specific status
     */
    getColor(status: 'working' | 'question' | 'done' | 'error'): string {
        return this.get().colors[status]
    }

    /**
     * Get the auto-reset delay for 'done' status
     */
    get doneAutoResetMs(): number {
        return this.get().doneAutoResetMs
    }

    /**
     * Check if tab color should be cleared on focus
     */
    get clearOnFocus(): boolean {
        return this.get().clearOnFocus
    }

    /**
     * Get audio configuration with deep-merge of defaults
     */
    getAudioConfig(): ClaudeStatusAudioConfig {
        const stored = this.config.store.claudeStatus?.audio || {}
        return {
            ...DEFAULT_AUDIO_CONFIG,
            ...stored,
            statusTexts: {
                ...DEFAULT_AUDIO_CONFIG.statusTexts,
                ...(stored.statusTexts || {}),
            },
            soundsByStatus: {
                ...DEFAULT_AUDIO_CONFIG.soundsByStatus,
                ...(stored.soundsByStatus || {}),
            },
            voicesByBackend: {
                ...(DEFAULT_AUDIO_CONFIG.voicesByBackend || {}),
                ...(stored.voicesByBackend || {}),
            },
        }
    }

    /**
     * Get session-restore configuration with deep-merge of defaults.
     */
    getSessionRestoreConfig(): ClaudeSessionRestoreConfig {
        const stored = this.config.store.claudeStatus?.sessionRestore || {}
        return {
            ...DEFAULT_SESSION_RESTORE_CONFIG,
            ...stored,
        }
    }

    /**
     * Get display-surface configuration with deep-merge of defaults.
     */
    getDisplayConfig(): ClaudeStatusDisplayConfig {
        const stored = this.config.store.claudeStatus?.display || {}
        return {
            ...DEFAULT_DISPLAY_CONFIG,
            ...stored,
            titleEmojiMap: {
                ...DEFAULT_EMOJI_MAP,
                ...(stored.titleEmojiMap || {}),
            },
        }
    }

    /**
     * Log a debug message if debug mode is enabled
     */
    debug(message: string, ...args: unknown[]): void {
        if (this.debugMode) {
            console.log(`[claude-status] ${message}`, ...args)
        }
    }
}
