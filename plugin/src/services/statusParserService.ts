import { Injectable } from '@angular/core'
import type {
    ClaudeStatusEvent,
    ClaudeStatusMetadata,
    ClaudeStatusName,
    ParseResult,
} from '../interfaces/types'

/**
 * Service for parsing Claude status escape sequences from terminal output
 *
 * Escape sequence format: \x1b]777;claude-status;VERSION;STATUS;METADATA\x07
 */
@Injectable({ providedIn: 'root' })
export class StatusParserService {
    /**
     * Regex pattern to match Claude status escape sequences
     * - \x1b\] - OSC introducer
     * - 777 - Private-use OSC code
     * - claude-status - Protocol identifier
     * - (\d+) - Version number (captured)
     * - ([^;]+) - Status name (captured)
     * - ([^\x07]*) - Metadata JSON (captured)
     * - \x07 - String terminator (BEL)
     */
    private readonly ESCAPE_SEQUENCE_REGEX = /\x1b\]777;claude-status;(\d+);([^;]+);([^\x07]*)\x07/g

    private readonly VALID_STATUSES: Set<ClaudeStatusName> = new Set([
        'working',
        'question',
        'done',
        'error',
        'idle',
    ])

    /**
     * Parse terminal output for Claude status escape sequences
     * @param output Raw terminal output
     * @returns Parsed result with cleaned output and status events
     */
    parse(output: string): ParseResult {
        const events: ClaudeStatusEvent[] = []
        let cleanedOutput = output

        // Find all matches
        let match: RegExpExecArray | null
        const regex = new RegExp(this.ESCAPE_SEQUENCE_REGEX.source, 'g')

        while ((match = regex.exec(output)) !== null) {
            const [, versionStr, statusStr, metadataStr] = match

            const version = parseInt(versionStr, 10)
            const metadata = this.parseMetadata(metadataStr)

            if (version >= 2) {
                // v2: statusStr is a raw event name, not a mapped status
                events.push({
                    version,
                    status: 'idle', // placeholder; decorator maps via HOOK_EVENT_STATUS_MAP
                    eventName: statusStr,
                    metadata,
                })
            } else {
                const status = this.parseStatus(statusStr)
                if (status) {
                    events.push({ version, status, metadata })
                }
            }
        }

        // Strip all escape sequences from output
        cleanedOutput = output.replace(this.ESCAPE_SEQUENCE_REGEX, '')

        return {
            cleanedOutput,
            events,
        }
    }

    /**
     * Validate and normalize status name
     */
    private parseStatus(status: string): ClaudeStatusName | null {
        const normalized = status.toLowerCase().trim() as ClaudeStatusName
        if (this.VALID_STATUSES.has(normalized)) {
            return normalized
        }
        console.warn(`[claude-status] Unknown status: ${status}`)
        return null
    }

    /**
     * Parse metadata JSON string
     */
    private parseMetadata(metadataStr: string): ClaudeStatusMetadata {
        if (!metadataStr || metadataStr === '{}') {
            return {}
        }

        try {
            return JSON.parse(metadataStr) as ClaudeStatusMetadata
        } catch (e) {
            console.warn(`[claude-status] Failed to parse metadata: ${metadataStr}`, e)
            return {}
        }
    }

    /**
     * Check if a string contains any Claude status escape sequences
     */
    hasStatusSequence(output: string): boolean {
        return this.ESCAPE_SEQUENCE_REGEX.test(output)
    }

    /**
     * Create an escape sequence for a given status (useful for testing)
     */
    createEscapeSequence(
        status: ClaudeStatusName,
        metadata: ClaudeStatusMetadata = {},
        version = 1,
    ): string {
        const metadataStr = JSON.stringify(metadata)
        return `\x1b]777;claude-status;${version};${status};${metadataStr}\x07`
    }
}
