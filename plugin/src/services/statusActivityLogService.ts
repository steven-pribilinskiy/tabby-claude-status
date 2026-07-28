import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Injectable } from '@angular/core'
import type { ClaudeStatusName } from '../interfaces/types'

/**
 * On-disk JSON log of every Claude-status event the plugin has consumed.
 *
 * The file is intentionally placed in `os.tmpdir()` next to the existing
 * `tabby-claude-status.json` IPC file so an external observer (a script,
 * an AI agent reading the user's machine) can inspect "why did Claude just
 * say 'Question' twice?" without poking at Tabby internals.
 *
 * One entry is written per consumed event. The audio outcome is patched in
 * after the gates resolve (zoom/mic mute, disabled, no-payload, played) so
 * the same record reflects both what triggered the status and what the user
 * actually heard.
 */
export const ACTIVITY_LOG_FILE = path.join(os.tmpdir(), 'tabby-claude-status-activity.json')

export type AudioOutcome =
    | 'announced'
    | 'suppressed-zoom'
    | 'suppressed-mic'
    | 'suppressed-disabled'
    | 'suppressed-no-payload'
    | 'suppressed-duplicate'
    | 'failed'

export interface ActivityLogEntry {
    /** Monotonic id within this Tabby run; survives across runs as a hex+counter pair. */
    id: string
    /** Unix ms when the event was first observed. */
    ts: number
    /** Mapped status the plugin acted on. */
    status: ClaudeStatusName
    /** Raw v2 hook event name, when available (e.g. 'Notification', 'PermissionRequest', 'Stop'). */
    eventName?: string
    /** Where the event came from. */
    source: 'hook-file' | 'escape-sequence'
    /** Whether a Tabby terminal was matched for this event (false → global-only emission). */
    terminalMatched: boolean
    /** Live tab title at the moment of dispatch, if a terminal matched. */
    terminalTitle?: string
    /** Claude session id from the hook payload, if present. */
    session?: string
    /** Audio mode at dispatch time. */
    audioMode?: 'tts' | 'sound' | 'dynamic'
    /** What was about to be spoken or played (TTS phrase or sound file path). */
    audioPayload?: string
    /** Resolved audio outcome (filled in asynchronously after mute gates run). */
    audioOutcome?: AudioOutcome
    /** Reason copy for suppressed/failed outcomes. */
    audioOutcomeDetail?: string
    /** Raw hook metadata, trimmed to the fields we display (kept small to avoid log bloat). */
    metadata?: Record<string, unknown>
}

const MAX_ENTRIES = 5000

/**
 * Logs every Claude-status event the plugin reacts to and persists the rolling
 * tail to `ACTIVITY_LOG_FILE` so it can be inspected from outside Tabby.
 *
 * The service is intentionally side-effect free during construction: no
 * polling, no watchers — flush is debounced (`scheduleFlush`) so a burst of
 * hook events writes the file once.
 */
@Injectable({ providedIn: 'root' })
export class StatusActivityLogService {
    private entries: ActivityLogEntry[] = []
    private listeners: Set<() => void> = new Set()
    private flushHandle: ReturnType<typeof setTimeout> | null = null
    /** True while an async flush is in flight — see `flushNow()`. */
    private flushing = false
    /** Set when state changed during an in-flight flush, so we write once more. */
    private flushAgain = false
    private nextSeq = 1
    private readonly runPrefix = Math.random().toString(36).slice(2, 8)

    constructor() {
        this.entries = this.loadFromDisk()
    }

    /** Latest entry first. Returns a copy so callers can sort/filter freely. */
    list(): ActivityLogEntry[] {
        return this.entries.slice().reverse()
    }

    /** Subscribe to entry-list changes. Returns an unsubscribe fn. */
    subscribe(fn: () => void): () => void {
        this.listeners.add(fn)
        return () => {
            this.listeners.delete(fn)
        }
    }

    clear(): void {
        this.entries = []
        this.notify()
        this.scheduleFlush()
    }

    /** Path of the on-disk log; exposed so the settings tab can show it. */
    get filePath(): string {
        return ACTIVITY_LOG_FILE
    }

    /**
     * Record an incoming hook event. Returns the entry id so the audio
     * pipeline can patch the outcome in after its async mute gates resolve.
     */
    record(entry: Omit<ActivityLogEntry, 'id' | 'ts'> & { ts?: number }): string {
        const id = `${this.runPrefix}-${this.nextSeq++}`
        const full: ActivityLogEntry = {
            id,
            ts: entry.ts ?? Date.now(),
            ...entry,
        }
        this.entries.push(full)
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_ENTRIES)
        }
        this.notify()
        this.scheduleFlush()
        return id
    }

    setAudioOutcome(id: string, outcome: AudioOutcome, detail?: string): void {
        const entry = this.entries.find((e) => e.id === id)
        if (!entry) return
        entry.audioOutcome = outcome
        if (detail) entry.audioOutcomeDetail = detail
        this.notify()
        this.scheduleFlush()
    }

    /**
     * Patch arbitrary fields onto an existing entry. Used by the audio
     * service to fill in `audioMode` / `audioPayload` once it's resolved
     * the active config — those aren't known when the decorator first
     * records the event.
     */
    patchEntry(id: string, fields: Partial<ActivityLogEntry>): void {
        const entry = this.entries.find((e) => e.id === id)
        if (!entry) return
        Object.assign(entry, fields)
        this.notify()
        this.scheduleFlush()
    }

    private notify(): void {
        for (const fn of this.listeners) {
            try {
                fn()
            } catch {
                /* listener errors don't break the log */
            }
        }
    }

    private scheduleFlush(): void {
        if (this.flushHandle) return
        this.flushHandle = setTimeout(() => {
            this.flushHandle = null
            void this.flushNow()
        }, 250)
    }

    /**
     * Write the rolling tail to disk.
     *
     * Serialise + write asynchronously. At the MAX_ENTRIES ceiling the payload
     * is ~3.3 MB, and doing this with `writeFileSync` blocked the *renderer*
     * thread for ~12 ms — a whole frame — every 250 ms for as long as hook
     * events kept arriving, which is exactly when the terminal is busy
     * painting. `writeFile` hands the work to the libuv threadpool instead.
     *
     * `flushing` serialises overlapping writes: without it two in-flight
     * flushes race on the same temp path and the later rename can land the
     * older snapshot. A flush requested while one is running sets
     * `flushAgain`, so the newest state is always written exactly once more.
     */
    private async flushNow(): Promise<void> {
        if (this.flushing) {
            this.flushAgain = true
            return
        }
        this.flushing = true
        try {
            // Atomic write so a concurrent reader (e.g. the settings tab's
            // loadFromDisk on open) never parses a half-written log and
            // throws it all away as corrupt.
            const payload = JSON.stringify(
                {
                    version: 1,
                    updated: Date.now(),
                    entries: this.entries,
                },
                null,
                2,
            )
            const tmp = `${ACTIVITY_LOG_FILE}.tmp-${process.pid}`
            await fsp.writeFile(tmp, payload)
            await fsp.rename(tmp, ACTIVITY_LOG_FILE)
        } catch (err) {
            console.warn('[claude-status] Failed to flush activity log:', err)
        } finally {
            this.flushing = false
            if (this.flushAgain) {
                this.flushAgain = false
                void this.flushNow()
            }
        }
    }

    private loadFromDisk(): ActivityLogEntry[] {
        try {
            if (!fs.existsSync(ACTIVITY_LOG_FILE)) return []
            const raw = fs.readFileSync(ACTIVITY_LOG_FILE, 'utf-8')
            const data = JSON.parse(raw) as { entries?: ActivityLogEntry[] }
            return Array.isArray(data?.entries) ? data.entries : []
        } catch {
            return []
        }
    }
}
