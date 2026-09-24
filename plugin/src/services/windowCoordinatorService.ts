import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Injectable } from '@angular/core'
import {
    type AppIdentity,
    appNameForExe,
    claimedByPeer,
    HEARTBEAT_MS,
    leads,
    normalizeExe,
    type PeerWindow,
    STALE_MS,
} from './spoolArbitration'
import {
    buildHeartbeat,
    heartbeatFile,
    LegacyExeCache,
    lookupExeForPid,
    readPeerWindows,
    writeHeartbeat,
} from './spoolFiles'

/**
 * Cross-window coordination for the shared hook spool directory.
 *
 * Every Tabby window runs its own renderer, its own copy of this plugin, and
 * therefore its own watcher over `tmpdir/tabby-claude-status.d`. That is fine
 * for events we can match to a tab in *this* window — only one window owns any
 * given terminal, so only that window decorates and announces it. It is NOT
 * fine for the unmatched/global path: a window with no tab for the event still
 * falls through to the "Claude ran outside Tabby" branch and speaks. With N
 * windows open the user hears every announcement N times.
 *
 * This service publishes what each window owns (Claude session ids + terminal
 * PIDs) to a heartbeat file in the temp dir, so a window can ask two questions
 * before doing anything global:
 *
 *  1. `isClaimedByPeer()` — does another *live* window own this event? If so,
 *     that window is already handling it; stay quiet.
 *  2. `isLeader()` — for an event genuinely owned by nobody (Claude running in
 *     VS Code, Windows Terminal, a bare pwsh…), exactly one window should
 *     announce it. Leader is the lowest instance id among live windows, which
 *     every window computes identically from the same files.
 *
 * Heartbeat files are tiny, written synchronously on every ownership change
 * (so a peer's check sees fresh data immediately) plus on a slow timer to keep
 * liveness fresh and reap crashed windows.
 *
 * Since 1.2.2 a heartbeat also names its app and says whether its window is
 * reading the spool, which is what SpoolOwnershipService uses to keep two
 * different apps from both reading it. Both questions above consider only
 * windows of this app that are reading: a window that is not reading acts on no
 * event, and another app's windows see other events. With one app, whose
 * windows all read, that is every live window, as before.
 */
const WINDOWS_DIR = path.join(os.tmpdir(), 'tabby-claude-status.windows')

@Injectable({ providedIn: 'root' })
export class WindowCoordinatorService {
    /** The app this window belongs to. Windows sharing an executable are one app. */
    readonly app: AppIdentity = {
        exe: process.execPath,
        name: appNameForExe(process.execPath),
        pid: process.pid,
    }
    private readonly selfExe = normalizeExe(process.execPath, process.platform)
    /** Unique per renderer. PID alone would be enough on a live system, but the
     *  random suffix keeps a recycled PID from colliding with a stale file. */
    private readonly id = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    private readonly file = heartbeatFile(WINDOWS_DIR, this.id)
    private sessions: Set<string> = new Set()
    private pids: Set<number> = new Set()
    private consuming = false
    private consumingSince = 0
    private timer: ReturnType<typeof setInterval> | null = null
    private started = false
    private readonly listeners = new Set<() => void>()

    /** Cache of the last peer scan. Re-reading a handful of small files per
     *  hook event is cheap, but events can arrive in bursts, so hold the
     *  result briefly. Short enough that a fresh ownership claim published by
     *  a peer is picked up well within the decorator's regrace window. */
    private peerCache: { ts: number; peers: PeerWindow[] } | null = null
    private static readonly PEER_CACHE_MS = 100

    /** A heartbeat from before 1.2.2 names no app, so its PID is looked up. */
    private readonly legacyExes = new LegacyExeCache(lookupExeForPid, () => {
        this.peerCache = null
        this.emit()
    })

    get instanceId(): string {
        return this.id
    }

    /** Where heartbeats live, and `owner.json` beside them. */
    get heartbeatDir(): string {
        return WINDOWS_DIR
    }

    start(): void {
        if (this.started) return
        this.started = true
        try {
            fs.mkdirSync(WINDOWS_DIR, { recursive: true })
        } catch {
            /* temp dir unwritable — every check then degrades to "no peers",
             * i.e. exactly the old single-window behaviour. */
        }
        this.reapStale()
        this.publish()
        this.timer = setInterval(() => {
            this.publish()
            this.emit()
        }, HEARTBEAT_MS)
        // `unref` where available so the heartbeat never holds the process open.
        ;(this.timer as any)?.unref?.()
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
        this.started = false
        try {
            fs.unlinkSync(this.file)
        } catch {
            /* already gone */
        }
    }

    /** Called after every heartbeat, and when a pre-1.2.2 peer is identified. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    // ── Ownership publishing ───────────────────────────────────────

    claimSession(session: string): void {
        if (!session || this.sessions.has(session)) return
        this.sessions.add(session)
        this.publish()
    }

    releaseSession(session: string): void {
        if (!session || !this.sessions.delete(session)) return
        this.publish()
    }

    /** Replace the set of terminal PIDs this window hosts. No-op when
     *  unchanged, so the caller can fire it on every attach/detach. */
    setPids(pids: number[]): void {
        const next = new Set(pids.filter((p) => typeof p === 'number' && p > 0))
        if (next.size === this.pids.size && [...next].every((p) => this.pids.has(p))) return
        this.pids = next
        this.publish()
    }

    /** Whether this window's watcher reads the spool. Published at once, so a
     *  peer deciding right now already sees it. */
    setConsuming(consuming: boolean, since: number): void {
        const nextSince = consuming ? since : 0
        if (this.consuming === consuming && this.consumingSince === nextSince) return
        this.consuming = consuming
        this.consumingSince = nextSince
        this.publish()
    }

    private publish(): void {
        if (!this.started) return
        try {
            writeHeartbeat(
                WINDOWS_DIR,
                buildHeartbeat({
                    id: this.id,
                    ts: Date.now(),
                    sessions: this.sessions,
                    pids: this.pids,
                    app: this.app,
                    consuming: this.consuming,
                    consumingSince: this.consumingSince,
                }),
            )
        } catch {
            /* best effort */
        }
    }

    private emit(): void {
        for (const listener of this.listeners) {
            try {
                listener()
            } catch (err) {
                console.error('[claude-status] window coordinator listener failed:', err)
            }
        }
    }

    // ── Peer queries ───────────────────────────────────────────────

    /** Live windows other than this one. Stale files are ignored and reaped. */
    peers(): PeerWindow[] {
        const now = Date.now()
        if (this.peerCache && now - this.peerCache.ts < WindowCoordinatorService.PEER_CACHE_MS) {
            return this.peerCache.peers
        }
        const peers = readPeerWindows(
            WINDOWS_DIR,
            this.id,
            now,
            STALE_MS,
            process.platform,
            this.legacyExes,
        )
        this.peerCache = { ts: now, peers }
        return peers
    }

    /** Drop heartbeat files left behind by windows that crashed or were killed. */
    private reapStale(): void {
        this.peerCache = null
        this.peers()
    }

    /**
     * True when another live, reading window of this app already owns this
     * event — either it has the Claude session mapped to one of its tabs, or
     * one of its terminal PIDs is in the event's process ancestry. Either way
     * that window handles the announcement and this one must stay silent.
     */
    isClaimedByPeer(session: string | undefined, ancestors: number[] | undefined): boolean {
        return claimedByPeer(this.peers(), this.selfExe, session, ancestors)
    }

    /**
     * True when this window is the one responsible for events no window owns.
     * Deterministic across windows: lowest instance id among this window and
     * the reading windows of its app wins, so exactly one window answers.
     */
    isLeader(): boolean {
        return leads(this.id, this.peers(), this.selfExe)
    }
}
