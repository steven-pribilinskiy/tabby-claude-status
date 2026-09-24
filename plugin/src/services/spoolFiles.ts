import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    type AppIdentity,
    type OwnerRecord,
    type PeerWindow,
    toPeerWindow,
    type WindowHeartbeat,
} from './spoolArbitration'

/**
 * The files behind cross-window and cross-app coordination, all in
 * `tmpdir/tabby-claude-status.windows`:
 *
 *  - `<pid>-<rand>.json`, one heartbeat per window;
 *  - `owner.json`, the app Claude events were handed to.
 *
 * Every function takes the directory, so the tests point them at a scratch one
 * rather than the directory the running apps share.
 */
export const OWNER_FILE = 'owner.json'

/** How long a failed exe lookup stands before it is tried again. */
const RETRY_FAILED_LOOKUP_MS = 30000

export function heartbeatFile(dir: string, id: string): string {
    return path.join(dir, `${id}.json`)
}

/**
 * This window's heartbeat. A window that is not reading the spool claims no
 * sessions and no terminals: a 1.2.1 peer does not know `consuming`, and would
 * stay silent for an event whose tab is here while it, the app that read the
 * event, has no tab to decorate.
 */
export function buildHeartbeat(window: {
    id: string
    ts: number
    sessions: Iterable<string>
    pids: Iterable<number>
    app: AppIdentity
    consuming: boolean
    consumingSince: number
}): WindowHeartbeat {
    const heartbeat: WindowHeartbeat = {
        id: window.id,
        ts: window.ts,
        sessions: window.consuming ? [...window.sessions] : [],
        pids: window.consuming ? [...window.pids] : [],
        app: window.app,
        consuming: window.consuming,
    }
    if (window.consuming) heartbeat.consumingSince = window.consumingSince
    return heartbeat
}

export function writeHeartbeat(dir: string, heartbeat: WindowHeartbeat): void {
    const file = heartbeatFile(dir, heartbeat.id)
    // Atomic temp+rename: a peer must never read a half-written claim and
    // conclude we own nothing. Only this window writes this file, so a fixed
    // temp name is safe.
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(heartbeat))
    fs.renameSync(tmp, file)
}

/**
 * Live heartbeats of every window but `selfId`. A stale one belongs to a window
 * that crashed or was killed, and is deleted, as 1.2.1 does.
 */
export function readHeartbeats(
    dir: string,
    selfId: string,
    now: number,
    staleMs: number,
): WindowHeartbeat[] {
    const live: WindowHeartbeat[] = []
    let names: string[]
    try {
        names = fs.readdirSync(dir)
    } catch {
        return live
    }
    for (const name of names) {
        if (!name.endsWith('.json') || name === OWNER_FILE) continue
        const full = path.join(dir, name)
        try {
            const heartbeat = JSON.parse(fs.readFileSync(full, 'utf-8')) as WindowHeartbeat
            if (!heartbeat?.id || typeof heartbeat.ts !== 'number') continue
            if (heartbeat.id === selfId) continue
            if (now - heartbeat.ts > staleMs) {
                try {
                    fs.unlinkSync(full)
                } catch {
                    /* another window beat us to it */
                }
                continue
            }
            live.push(heartbeat)
        } catch {
            /* unreadable/partial — skip this pass */
        }
    }
    return live
}

/** Live peers of `selfId` as arbitration sees them, pre-1.2.2 ones identified
 *  through `exes`. */
export function readPeerWindows(
    dir: string,
    selfId: string,
    now: number,
    staleMs: number,
    platform: string,
    exes: LegacyExeCache,
): PeerWindow[] {
    return readHeartbeats(dir, selfId, now, staleMs).map((heartbeat) =>
        toPeerWindow(heartbeat, platform, (pid) => exes.get(pid, now)),
    )
}

export function readOwner(dir: string): OwnerRecord | null {
    try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf-8'))
        if (!record || typeof record.exe !== 'string' || typeof record.ts !== 'number') return null
        return record as OwnerRecord
    } catch {
        return null
    }
}

export function writeOwner(dir: string, record: OwnerRecord): void {
    fs.mkdirSync(dir, { recursive: true })
    const { exe, name, pid, ts, window } = record
    // Spelled out so nothing else, an `id` above all, can ride along into a
    // file that 1.2.1 would then mistake for a window.
    writeJsonAtomic(path.join(dir, OWNER_FILE), { exe, name, pid, ts, window })
}

/** Remove `owner.json` if it names `window`. Any other hand-over is left alone. */
export function releaseOwner(dir: string, window: string): void {
    if (readOwner(dir)?.window !== window) return
    try {
        fs.unlinkSync(path.join(dir, OWNER_FILE))
    } catch {
        /* already gone */
    }
}

/**
 * Temp file then rename, so a reader never sees half a file. The temp name is
 * unique because two windows can write `owner.json` at the same moment, and it
 * does not end in `.json`, so no heartbeat reader, 1.2.1's included, lists it.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
    const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value))
    try {
        renameRetrying(tmp, file)
    } catch (err) {
        try {
            fs.unlinkSync(tmp)
        } catch {
            /* already gone */
        }
        throw err
    }
}

/** Windows refuses a rename over a file another process has open at that
 *  instant, a peer reading it, and the refusal clears at once. */
function renameRetrying(from: string, to: string): void {
    for (let attempt = 1; ; attempt++) {
        try {
            fs.renameSync(from, to)
            return
        } catch (err: any) {
            const transient =
                err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES'
            if (!transient || attempt >= 5) throw err
        }
    }
}

export type ExeLookup = (pid: number) => Promise<string | null>

/**
 * The executable a PID runs, for a heartbeat from before 1.2.2, which names no
 * app. One hidden PowerShell call on Windows, which is why LegacyExeCache asks
 * once per PID.
 */
export function lookupExeForPid(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null)
    if (process.platform === 'linux') {
        try {
            return Promise.resolve(fs.readlinkSync(`/proc/${pid}/exe`))
        } catch {
            return Promise.resolve(null)
        }
    }
    let command: string
    let args: string[]
    if (process.platform === 'win32') {
        command = 'powershell.exe'
        args = [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${pid} -ErrorAction Stop).Path`,
        ]
    } else {
        // macOS: `comm` is the full executable path there.
        command = 'ps'
        args = ['-o', 'comm=', '-p', String(pid)]
    }
    return new Promise((resolve) => {
        execFile(command, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
            resolve(err ? null : String(stdout).trim() || null)
        })
    })
}

/** PID to exe for pre-1.2.2 heartbeats, looked up once per PID. */
export class LegacyExeCache {
    private readonly answers = new Map<number, { exe: string | null; at: number }>()
    private readonly pending = new Set<number>()
    private readonly lookup: ExeLookup
    private readonly onSettled: () => void

    constructor(lookup: ExeLookup, onSettled: () => void) {
        this.lookup = lookup
        this.onSettled = onSettled
    }

    /** The exe; null when the lookup failed; undefined while the first one runs.
     *  A failure is retried after a while, still answering null meanwhile, so a
     *  peer does not flip between "unknown" and "still looking". */
    get(pid: number, now: number): string | null | undefined {
        const answer = this.answers.get(pid)
        if (answer?.exe) return answer.exe
        if (!answer || now - answer.at >= RETRY_FAILED_LOOKUP_MS) this.ask(pid, now)
        return answer ? null : undefined
    }

    private ask(pid: number, now: number): void {
        if (this.pending.has(pid)) return
        this.pending.add(pid)
        const settle = (exe: string | null): void => {
            this.pending.delete(pid)
            this.answers.set(pid, { exe, at: now })
            this.onSettled()
        }
        try {
            this.lookup(pid).then(settle, () => settle(null))
        } catch {
            settle(null)
        }
    }
}
