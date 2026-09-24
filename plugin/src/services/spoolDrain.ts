import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Drains the hook spool (`tmpdir/tabby-claude-status.d`) without blocking the
 * renderer.
 *
 * The first reader drained it synchronously: `readdirSync`, then
 * `readFileSync` + `unlinkSync` per file, all on the renderer thread. Files
 * pile up whenever Claude runs while no app is reading (no terminal open, the
 * app closed, another app holding the spool), and a startup profile of Torbie
 * caught the renderer frozen for 24 s draining ~3,460 of them — every one of
 * which was then thrown away as stale.
 *
 * Now:
 * - All I/O is async (libuv's thread pool), so the renderer only runs the
 *   JSON parse and the event handler.
 * - Staleness is read from the file NAME (`<ts>-<pid>-<rand>.json`, written by
 *   hook.js), so stale events are deleted without being read, in parallel
 *   batches, and never reach the handler: an old event's status is
 *   meaningless and it must not be spoken.
 * - Work is chunked with a yield between chunks, so even a huge backlog of
 *   fresh events can't hold the thread.
 * - Passes never overlap. A request during a pass schedules exactly one more.
 */

/** Events older than this are discarded unread. Matches the handler's own gate. */
export const STALE_EVENT_MS = 10_000

/** Timestamp hook.js put in the file name, or null for an unrecognised name. */
export function eventTsFromName(name: string): number | null {
    const m = /^(\d{12,})-/.exec(name)
    if (!m) return null
    const ts = Number(m[1])
    return Number.isFinite(ts) ? ts : null
}

export interface SpoolDrainResult {
    /** Fresh events handed to the handler. */
    delivered: number
    /** Stale events deleted unread. */
    discarded: number
    /** Files left for the next pass (unreadable, or racing a write). */
    skipped: number
}

export interface SpoolFs {
    readdir(dir: string): Promise<string[]>
    readFile(file: string, enc: 'utf-8'): Promise<string>
    unlink(file: string): Promise<void>
}

export interface SpoolDrainerOptions {
    staleMs?: number
    /** Files per chunk between yields (and per parallel delete batch). */
    chunk?: number
    now?: () => number
    /** Hand the thread back to the event loop. */
    yieldFn?: () => Promise<void>
    fs?: SpoolFs
    onError?: (err: unknown) => void
}

const defaultYield = (): Promise<void> =>
    new Promise((resolve) =>
        typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0),
    )

export class SpoolDrainer {
    private readonly staleMs: number
    private readonly chunk: number
    private readonly now: () => number
    private readonly yieldFn: () => Promise<void>
    private readonly fs: SpoolFs
    private readonly onError: (err: unknown) => void
    private running: Promise<void> | null = null
    private rerun = false
    private stopped = false

    private readonly dir: string
    private readonly onEvent: (data: any) => void

    constructor(dir: string, onEvent: (data: any) => void, opts: SpoolDrainerOptions = {}) {
        this.dir = dir
        this.onEvent = onEvent
        this.staleMs = opts.staleMs ?? STALE_EVENT_MS
        this.chunk = Math.max(1, opts.chunk ?? 50)
        this.now = opts.now ?? Date.now
        this.yieldFn = opts.yieldFn ?? defaultYield
        this.fs = opts.fs ?? (fsp as unknown as SpoolFs)
        this.onError = opts.onError ?? (() => {})
    }

    /**
     * Ask for a pass. Cheap and safe to call from every watcher callback: while
     * a pass runs, any number of requests collapse into one follow-up pass.
     * Resolves when the dir has been drained up to (at least) this request.
     */
    request(): Promise<void> {
        this.stopped = false
        if (this.running) {
            this.rerun = true
            return this.running
        }
        this.running = (async () => {
            try {
                do {
                    this.rerun = false
                    await this.drainOnce()
                } while (this.rerun && !this.stopped)
            } catch (err) {
                this.onError(err)
            } finally {
                this.running = null
            }
        })()
        return this.running
    }

    /** Stop after the current chunk; a later `request()` resumes. */
    stop(): void {
        this.stopped = true
        this.rerun = false
    }

    /** One pass over the directory. */
    async drainOnce(): Promise<SpoolDrainResult> {
        const result: SpoolDrainResult = { delivered: 0, discarded: 0, skipped: 0 }
        let names: string[]
        try {
            names = await this.fs.readdir(this.dir)
        } catch {
            return result
        }
        names.sort()
        const cutoff = this.now() - this.staleMs
        const stale: string[] = []
        const fresh: string[] = []
        for (const n of names) {
            const ts = eventTsFromName(n)
            const isTmp = n.endsWith('.tmp')
            if (!isTmp && !n.endsWith('.json')) continue
            // A stale `.tmp` is a hook that died mid-write; a fresh one may be
            // being written right now, so it is left alone.
            if (ts !== null && ts < cutoff) stale.push(n)
            else if (!isTmp) fresh.push(n)
        }

        // Stale: delete unread, a batch at a time in parallel.
        for (let i = 0; i < stale.length && !this.stopped; i += this.chunk) {
            const batch = stale.slice(i, i + this.chunk)
            const outcomes = await Promise.allSettled(
                batch.map((n) => this.fs.unlink(path.join(this.dir, n))),
            )
            for (const o of outcomes) {
                if (o.status === 'fulfilled') result.discarded++
                // ENOENT: another reader got it first. Anything else: a later pass.
            }
            await this.yieldFn()
        }

        // Fresh: in order, since status follows the event sequence.
        let sinceYield = 0
        for (const n of fresh) {
            if (this.stopped) break
            const full = path.join(this.dir, n)
            let data: any
            try {
                data = JSON.parse(await this.fs.readFile(full, 'utf-8'))
            } catch {
                // hook.js renames a complete file into place, so a present
                // file that won't read is a transient FS hiccup (or it was
                // consumed under us). Leave it for the next pass.
                result.skipped++
                continue
            }
            try {
                await this.fs.unlink(full)
            } catch (err: any) {
                // Gone: another reader consumed it, so it's theirs. Any other
                // failure (a scanner holding it) still delivers; the handler
                // dedupes if a later pass sees it again.
                if (err?.code === 'ENOENT') continue
            }
            try {
                this.onEvent(data)
                result.delivered++
            } catch (err) {
                this.onError(err)
            }
            if (++sinceYield >= this.chunk) {
                sinceYield = 0
                await this.yieldFn()
            }
        }
        return result
    }
}
