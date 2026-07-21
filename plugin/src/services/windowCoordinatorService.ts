import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Injectable } from '@angular/core'

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
 */
const WINDOWS_DIR = path.join(os.tmpdir(), 'tabby-claude-status.windows')
/** How often we refresh our own heartbeat even when nothing changed. */
const HEARTBEAT_MS = 2000
/** A peer file older than this is treated as a dead window and ignored.
 *  Generous relative to HEARTBEAT_MS so a briefly-janked renderer (GC pause,
 *  heavy paint) is never mistaken for a crashed one and double-announced. */
const STALE_MS = 8000

interface WindowClaim {
    id: string
    ts: number
    sessions: string[]
    pids: number[]
}

@Injectable({ providedIn: 'root' })
export class WindowCoordinatorService {
    /** Unique per renderer. PID alone would be enough on a live system, but the
     *  random suffix keeps a recycled PID from colliding with a stale file. */
    private readonly id = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    private readonly file = path.join(WINDOWS_DIR, `${this.id}.json`)
    private sessions: Set<string> = new Set()
    private pids: Set<number> = new Set()
    private timer: ReturnType<typeof setInterval> | null = null
    private started = false

    /** Cache of the last peer scan. Re-reading a handful of small files per
     *  hook event is cheap, but events can arrive in bursts, so hold the
     *  result briefly. Short enough that a fresh ownership claim published by
     *  a peer is picked up well within the decorator's regrace window. */
    private peerCache: { ts: number; claims: WindowClaim[] } | null = null
    private static readonly PEER_CACHE_MS = 100

    get instanceId(): string {
        return this.id
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
        this.timer = setInterval(() => this.publish(), HEARTBEAT_MS)
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

    private publish(): void {
        if (!this.started) return
        const claim: WindowClaim = {
            id: this.id,
            ts: Date.now(),
            sessions: [...this.sessions],
            pids: [...this.pids],
        }
        try {
            // Atomic temp+rename: a peer must never read a half-written claim
            // and conclude we own nothing.
            const tmp = `${this.file}.tmp`
            fs.writeFileSync(tmp, JSON.stringify(claim))
            fs.renameSync(tmp, this.file)
        } catch {
            /* best effort */
        }
    }

    // ── Peer queries ───────────────────────────────────────────────

    /** Live claims from OTHER windows. Stale files are ignored and reaped. */
    private readPeers(): WindowClaim[] {
        const now = Date.now()
        if (this.peerCache && now - this.peerCache.ts < WindowCoordinatorService.PEER_CACHE_MS) {
            return this.peerCache.claims
        }
        const claims: WindowClaim[] = []
        let names: string[] = []
        try {
            names = fs.readdirSync(WINDOWS_DIR)
        } catch {
            this.peerCache = { ts: now, claims }
            return claims
        }
        for (const name of names) {
            if (!name.endsWith('.json')) continue
            const full = path.join(WINDOWS_DIR, name)
            try {
                const claim = JSON.parse(fs.readFileSync(full, 'utf-8')) as WindowClaim
                if (!claim?.id || typeof claim.ts !== 'number') continue
                if (claim.id === this.id) continue
                if (now - claim.ts > STALE_MS) {
                    try {
                        fs.unlinkSync(full)
                    } catch {
                        /* another window beat us to it */
                    }
                    continue
                }
                claims.push(claim)
            } catch {
                /* unreadable/partial — skip this pass */
            }
        }
        this.peerCache = { ts: now, claims }
        return claims
    }

    /** Drop heartbeat files left behind by windows that crashed or were killed. */
    private reapStale(): void {
        this.peerCache = null
        this.readPeers()
    }

    /**
     * True when another live window already owns this event — either it has the
     * Claude session mapped to one of its tabs, or one of its terminal PIDs is
     * in the event's process ancestry. Either way that window handles the
     * announcement and this one must stay silent.
     */
    isClaimedByPeer(session: string | undefined, ancestors: number[] | undefined): boolean {
        const peers = this.readPeers()
        if (peers.length === 0) return false
        if (session) {
            for (const peer of peers) {
                if (peer.sessions?.includes(session)) return true
            }
        }
        if (ancestors?.length) {
            for (const peer of peers) {
                if (peer.pids?.some((pid) => ancestors.includes(pid))) return true
            }
        }
        return false
    }

    /**
     * True when this window is the one responsible for events no window owns.
     * Deterministic across windows: lowest instance id among all live claims
     * (peers + ourselves) wins, so exactly one window answers.
     */
    isLeader(): boolean {
        const ids = this.readPeers().map((p) => p.id)
        ids.push(this.id)
        ids.sort()
        return ids[0] === this.id
    }
}
