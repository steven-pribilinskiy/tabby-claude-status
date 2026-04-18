import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { ClaudeStatusAudioConfig, ClaudeStatusConfig, DEFAULT_AUDIO_CONFIG, DEFAULT_CONFIG } from '../interfaces/types'

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
