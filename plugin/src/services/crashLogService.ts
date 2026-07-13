import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Injectable } from '@angular/core'

/**
 * Persistent, bounded crash/error log for the Tabby renderer.
 *
 * Tabby's own `log.txt` only captures the *main* process; a plugin's
 * renderer-side `console.error`/uncaught exceptions never reach it, and Electron
 * writes no Crashpad dump for a plain renderer error. So when Tabby "crashes"
 * there is nothing to diagnose after the fact. This service wires the renderer's
 * global `error` / `unhandledrejection` handlers to an append-only file next to
 * the plugin's other sidecar files, so the *next* crash leaves a trail.
 *
 * Writes are synchronous by design — an uncaught error may immediately precede a
 * fatal crash, so a debounced write could be lost before the process dies. The
 * events are rare, so the cost is negligible. The file is rotated (oldest half
 * dropped) once it exceeds `MAX_BYTES` so it can never grow without bound.
 */
const TABBY_DATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'tabby')
export const CRASH_LOG_FILE = path.join(TABBY_DATA_DIR, 'tabby-claude-status-crash.log')
const MAX_BYTES = 256 * 1024

@Injectable({ providedIn: 'root' })
export class ClaudeCrashLogService {
    private installed = false

    /** On-disk path; exposed so the settings/diagnostics tab can surface it. */
    get filePath(): string {
        return CRASH_LOG_FILE
    }

    /**
     * Register the global renderer error handlers. Idempotent — safe to call
     * from every decorator instance; only the first call installs listeners.
     */
    install(): void {
        if (this.installed) return
        this.installed = true
        if (typeof window === 'undefined') return
        window.addEventListener('error', (e: ErrorEvent) => {
            const err: any = e?.error
            this.record('error', e?.message || String(err), err?.stack, {
                source: e?.filename,
                line: e?.lineno,
                col: e?.colno,
            })
        })
        window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
            const r: any = e?.reason
            this.record('unhandledrejection', r?.message || String(r), r?.stack)
        })
        this.record('info', 'crash logger installed')
    }

    /**
     * Append one entry. Never throws — logging must not be able to break the
     * thing it's logging.
     */
    record(kind: string, message: string, stack?: string, extra?: Record<string, unknown>): void {
        try {
            const entry = `${JSON.stringify({
                ts: new Date().toISOString(),
                kind,
                message: String(message ?? '').slice(0, 2000),
                stack: stack ? String(stack).slice(0, 8000) : undefined,
                ...extra,
            })}\n`
            fs.mkdirSync(TABBY_DATA_DIR, { recursive: true })
            this.rotateIfNeeded(entry.length)
            fs.appendFileSync(CRASH_LOG_FILE, entry)
        } catch {
            /* swallow — a failed write must not surface as another error */
        }
    }

    /** Drop the oldest half of the log (aligned to a line boundary) once it
     *  would exceed the size cap, so recent context is always retained. */
    private rotateIfNeeded(incoming: number): void {
        try {
            const st = fs.statSync(CRASH_LOG_FILE)
            if (st.size + incoming <= MAX_BYTES) return
            const raw = fs.readFileSync(CRASH_LOG_FILE, 'utf-8')
            const half = raw.slice(Math.floor(raw.length / 2))
            const nl = half.indexOf('\n')
            fs.writeFileSync(CRASH_LOG_FILE, nl >= 0 ? half.slice(nl + 1) : half)
        } catch {
            /* file doesn't exist yet or is unreadable — nothing to rotate */
        }
    }
}
