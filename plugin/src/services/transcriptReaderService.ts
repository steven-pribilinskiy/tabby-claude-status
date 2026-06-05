import * as fs from 'node:fs'
import { Injectable } from '@angular/core'

export interface TranscriptTail {
    /** Plain-text last assistant message, or '' if not found. */
    lastAssistant: string
    /** Plain-text last user prompt (excluding tool_result wrappers), or ''. */
    lastUserPrompt: string
    /** Name of the most recent tool the assistant called, or undefined. */
    lastToolName?: string
}

const DEFAULT_MAX_BYTES = 32 * 1024

/**
 * Reads the tail of a Claude Code JSONL session transcript and extracts the
 * fields the dynamic-phrase audio mode needs for context.
 *
 * The JSONL format is one JSON message per line; each message has
 * `type: 'user' | 'assistant'` and `message.content` which is either a string
 * or an array of typed content blocks (text / tool_use / tool_result). We
 * walk the parsed lines from newest to oldest and pick out the first
 * assistant text, the first non-tool-result user text, and the first
 * assistant tool_use we see.
 *
 * Pure local file IO — no network. Used by both:
 * - the transcript-only path (zero token cost), and
 * - the Haiku call (sent as context).
 */
@Injectable({ providedIn: 'root' })
export class TranscriptReaderService {
    /**
     * Read the tail of a JSONL transcript. If the file is shorter than
     * `maxBytes`, the whole file is read; otherwise we skip the first
     * (potentially partial) line.
     */
    readTail(transcriptPath: string, maxBytes = DEFAULT_MAX_BYTES): TranscriptTail {
        const empty: TranscriptTail = { lastAssistant: '', lastUserPrompt: '' }
        if (!transcriptPath) return empty

        let buffer: string
        try {
            const stat = fs.statSync(transcriptPath)
            if (stat.size <= maxBytes) {
                buffer = fs.readFileSync(transcriptPath, 'utf-8')
            } else {
                const fd = fs.openSync(transcriptPath, 'r')
                try {
                    const chunk = Buffer.alloc(maxBytes)
                    const bytesRead = fs.readSync(fd, chunk, 0, maxBytes, stat.size - maxBytes)
                    const slice = chunk.subarray(0, bytesRead)
                    // Find the first newline at the BYTE level and decode only
                    // from after it. This drops the (partial) first line and,
                    // crucially, avoids decoding a window that starts mid-way
                    // through a multi-byte UTF-8 char — which `toString('utf-8')`
                    // would otherwise turn into a leading replacement char.
                    const nlByte = slice.indexOf(0x0a)
                    const from = nlByte >= 0 ? nlByte + 1 : 0
                    buffer = slice.subarray(from).toString('utf-8')
                } finally {
                    fs.closeSync(fd)
                }
            }
        } catch {
            return empty
        }

        const lines = buffer.split('\n').filter((l) => l.length > 0)
        const result: TranscriptTail = { lastAssistant: '', lastUserPrompt: '' }

        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i])
                const role = entry?.type ?? entry?.role ?? entry?.message?.role
                const content = entry?.message?.content ?? entry?.content

                if (role === 'assistant') {
                    if (!result.lastAssistant) {
                        const text = this.extractText(content)
                        if (text) result.lastAssistant = text
                    }
                    if (!result.lastToolName) {
                        const tool = this.extractToolName(content)
                        if (tool) result.lastToolName = tool
                    }
                } else if (role === 'user' && !result.lastUserPrompt) {
                    const text = this.extractText(content, /* skipToolResults */ true)
                    if (text) result.lastUserPrompt = text
                }

                if (result.lastAssistant && result.lastUserPrompt && result.lastToolName) break
            } catch {
                // Bad line — keep walking.
            }
        }

        return result
    }

    /**
     * Local fallback when the user has set `transcriptOnly: true`. Takes the
     * last assistant message and reduces it to a short announcement-shaped
     * phrase: first sentence, lowercased, capped at 8 words. Returns null if
     * we can't make anything useful out of it.
     */
    extractAnnouncement(text: string, maxWords = 8): string | null {
        if (!text) return null
        // First sentence (or the whole thing if there's no terminator).
        const m = text.match(/^[^.!?\n]+/)
        const first = (m ? m[0] : text).trim()
        if (!first) return null
        const words = first.split(/\s+/).filter(Boolean)
        if (words.length === 0) return null
        const trimmed = words.slice(0, maxWords).join(' ')
        // Strip surrounding quotes / leading filler words that don't read well aloud.
        return (
            trimmed
                .replace(/^["'`*_]+|["'`*_]+$/g, '')
                .replace(/^(okay|ok|sure|alright|so|well),?\s+/i, '')
                .trim() || null
        )
    }

    private extractText(content: unknown, skipToolResults = false): string {
        if (typeof content === 'string') return content
        if (!Array.isArray(content)) return ''
        const parts: string[] = []
        for (const block of content) {
            if (!block || typeof block !== 'object') continue
            const b = block as { type?: string; text?: string; content?: unknown }
            if (b.type === 'text' && typeof b.text === 'string') {
                parts.push(b.text)
            } else if (!skipToolResults && b.type === 'tool_result') {
                // tool_result blocks carry their payload under `content` (a
                // string, or an array of {type:'text', text} blocks) — not a
                // top-level `text` field. Reading `b.text` here extracted
                // nothing.
                const c = b.content
                if (typeof c === 'string') {
                    parts.push(c)
                } else if (Array.isArray(c)) {
                    for (const inner of c) {
                        if (
                            inner &&
                            typeof inner === 'object' &&
                            (inner as any).type === 'text' &&
                            typeof (inner as any).text === 'string'
                        ) {
                            parts.push((inner as any).text)
                        }
                    }
                }
            }
        }
        return parts.join(' ').trim()
    }

    private extractToolName(content: unknown): string | undefined {
        if (!Array.isArray(content)) return undefined
        for (const block of content) {
            if (!block || typeof block !== 'object') continue
            const b = block as { type?: string; name?: string }
            if (b.type === 'tool_use' && typeof b.name === 'string') return b.name
        }
        return undefined
    }
}
