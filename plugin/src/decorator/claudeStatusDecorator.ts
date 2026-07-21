import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Injectable } from '@angular/core'
import { AppService } from 'tabby-core'
import { type BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'
import {
    type ClaudeStatusDisplayConfig,
    type ClaudeStatusEvent,
    type ClaudeStatusName,
    HOOK_EVENT_STATUS_MAP,
} from '../interfaces/types'
import { AudioService } from '../services/audioService'
import { ClaudeStatusConfigService } from '../services/configService'
import { ClaudeCrashLogService } from '../services/crashLogService'
import { SessionRestoreService } from '../services/sessionRestoreService'
import { StatusActivityLogService } from '../services/statusActivityLogService'
import { StatusParserService } from '../services/statusParserService'
import { WindowCoordinatorService } from '../services/windowCoordinatorService'

/**
 * Spool directory for status events. hook.js drops one file per event here
 * (atomic temp+rename, unique filename), and the decorator processes then
 * deletes each. A spool dir — rather than the old single overwrite-in-place
 * file — means concurrent hooks from multiple Claude sessions can't clobber
 * each other's event before the watcher reads it: every event survives as its
 * own file until consumed.
 */
const STATUS_DIR = path.join(os.tmpdir(), 'tabby-claude-status.d')
/** Legacy single-file path from before the spool dir. Cleaned up on startup. */
const LEGACY_STATUS_FILE = path.join(os.tmpdir(), 'tabby-claude-status.json')

/** Lazy handle to the current Electron BrowserWindow via @electron/remote. */
let cachedBrowserWindow: any | null = null
function getBrowserWindow(): any | null {
    if (cachedBrowserWindow) return cachedBrowserWindow
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const remote = require('@electron/remote')
        cachedBrowserWindow = remote.getCurrentWindow()
        return cachedBrowserWindow
    } catch {
        return null
    }
}

@Injectable()
export class ClaudeStatusDecorator extends TerminalDecorator {
    private resetTimers: Map<BaseTerminalTabComponent, ReturnType<typeof setTimeout>> = new Map()
    private currentStatus: Map<BaseTerminalTabComponent, ClaudeStatusName> = new Map()
    private terminals: Set<BaseTerminalTabComponent> = new Set()
    private terminalPids: Map<BaseTerminalTabComponent, number> = new Map()
    /** Latest working directory reported by each terminal via OSC 7 / OSC 1337,
     *  normalised. Used to match WSL sessions to their tab by cwd when PID
     *  matching can't (Linux hook PIDs never equal Windows conpty PIDs). */
    private terminalCwds: Map<BaseTerminalTabComponent, string> = new Map()
    private sessionTerminals: Map<string, BaseTerminalTabComponent> = new Map()
    /** OSC 7: `ESC ] 7 ; file://<host><path> (BEL|ST)`. Captures `<path>`. */
    private static readonly OSC7_RE = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g
    /** OSC 1337 CurrentDir variant: `ESC ] 1337 ; CurrentDir=<path> (BEL|ST)`. */
    private static readonly OSC1337_CWD_RE = /\x1b\]1337;CurrentDir=([^\x07\x1b]*)(?:\x07|\x1b\\)/g
    private fileWatcher: fs.FSWatcher | null = null
    private pollInterval: ReturnType<typeof setInterval> | null = null
    /**
     * Recently-processed event signatures, used to dedupe the duplicate
     * change events `fs.watch` fires for a single write (common on Windows).
     * Keyed on the full event identity (ts + event + session + tool) rather
     * than a single monotonic `lastFileTs` threshold — the old threshold
     * dropped genuinely-distinct events that happened to share a millisecond,
     * and permanently blocked ALL events after any backward wall-clock change
     * (NTP correction, VM resume) since every new ts then compared `<=` the
     * stuck high-water mark. `recentEventOrder` bounds the set to the last N.
     */
    private recentEventSigs: Set<string> = new Set()
    private recentEventOrder: string[] = []
    private static readonly MAX_RECENT_SIGS = 50
    /** How long a window waits before announcing an event it couldn't match,
     *  giving the window that *can* match it time to publish its claim. Long
     *  enough to cover a synchronous claim write plus FS latency, short enough
     *  that a genuinely ownerless announcement still feels immediate. */
    private static readonly PEER_CLAIM_GRACE_MS = 350
    /** Spool filenames currently being read, so overlapping watch fires don't
     *  double-process the same event before it's deleted. */
    private processingFiles: Set<string> = new Set()
    /**
     * Flipped to true when the renderer fires `beforeunload` — i.e. the
     * user is closing the Tabby window. Tabby then mass-detaches every
     * tab on its way out, and our `detach()` callback would otherwise
     * call `sessionRestore.markClosed()` for every active Claude
     * session, sending them all to History instead of preserving them
     * as the next run's "Previous run" bucket. Skipping the markClosed
     * during shutdown keeps `closed=false` on those records, which is
     * what `migrateIfNeeded()` looks for to populate "Previous run".
     */
    private isShuttingDown = false

    // Display-surface bookkeeping per terminal
    private baseTitles: Map<BaseTerminalTabComponent, string> = new Map()
    private progressIntervals: Map<BaseTerminalTabComponent, ReturnType<typeof setInterval>> =
        new Map()

    constructor(
        private parser: StatusParserService,
        private configService: ClaudeStatusConfigService,
        private audioService: AudioService,
        private sessionRestore: SessionRestoreService,
        private activityLog: StatusActivityLogService,
        private app: AppService,
        private crashLog: ClaudeCrashLogService,
        private windowCoordinator: WindowCoordinatorService,
    ) {
        super()
        this.configService.debug('ClaudeStatusDecorator initialized')

        // Announce this window to its siblings. Every Tabby window watches the
        // same hook spool dir, so without this each one announces every event
        // and the user hears N copies with N windows open.
        this.windowCoordinator.start()

        // Capture renderer errors/rejections to a persistent log so a future
        // Tabby crash is diagnosable (Tabby's own log.txt is main-process only,
        // and a renderer error leaves no Crashpad dump). Idempotent.
        this.crashLog.install()

        // Resolve live tab titles for the settings tab. We own the
        // session→terminal mapping, so we plug a getter into SessionRestore
        // rather than leaking the map out. Reads `terminal.title` at call
        // time, so what the settings tab renders matches what's on the
        // tab right now — not what the title happened to be when the
        // SessionStart hook fired.
        this.sessionRestore.setLiveTitleResolver((sessionId) => {
            const terminal = this.sessionTerminals.get(sessionId)
            if (!terminal) return undefined
            const baseTitle = this.baseTitles.get(terminal)
            return baseTitle ?? (terminal as any).title
        })
        this.sessionRestore.setLiveProfileResolver((sessionId) => {
            const terminal = this.sessionTerminals.get(sessionId)
            const profile = terminal ? (terminal as any).profile : undefined
            if (!profile) return undefined
            return { id: profile.id, name: profile.name, type: profile.type }
        })

        // Auto-resume on launch. Deferred so Tabby has time to finish its own
        // tab restoration (if any) before we pile on more tabs.
        const restoreCfg = this.configService.getSessionRestoreConfig()
        if (restoreCfg.enabled && restoreCfg.autoResumeOnLaunch) {
            setTimeout(() => {
                this.sessionRestore.resumeAll().then((n) => {
                    if (n > 0) this.configService.debug(`Auto-resumed ${n} Claude sessions`)
                })
            }, 1500)
        }

        if (this.configService.clearOnFocus) {
            this.app.activeTabChange$.subscribe((tab) => {
                for (const terminal of this.terminals) {
                    if (terminal === tab || (terminal as any).parent === tab) {
                        this.clearStatus(terminal)
                    }
                }
            })
        }

        // Detect Tabby shutdown so the mass-detach that follows doesn't
        // dump every active Claude session into History. `beforeunload`
        // fires synchronously before the renderer is destroyed, and
        // every `detach(terminal)` Tabby fires afterwards reads this
        // flag and skips the `markClosed` call. The `capture: true` is
        // important — without it Tabby's own beforeunload handler may
        // run first and we miss the signal.
        if (typeof window !== 'undefined') {
            window.addEventListener(
                'beforeunload',
                () => {
                    this.isShuttingDown = true
                    // Persist any debounced session-file write synchronously
                    // before the renderer is torn down, so a clean quit never
                    // loses the last few observations sitting in the coalescing
                    // buffer. (A crash is covered separately: migrateIfNeeded
                    // keeps still-open sessions under "Previous run".)
                    try {
                        this.sessionRestore.flush()
                    } catch {
                        /* shutdown best-effort */
                    }
                    // Drop our claim file immediately so a sibling window
                    // doesn't wait out the staleness window before taking
                    // over the ownerless-event announcements.
                    try {
                        this.windowCoordinator.stop()
                    } catch {
                        /* shutdown best-effort */
                    }
                },
                { capture: true },
            )
        }
    }

    attach(terminal: BaseTerminalTabComponent): void {
        if (!this.configService.enabled) return

        this.terminals.add(terminal)
        this.cacheTerminalPid(terminal)

        // Start file watcher on first terminal
        if (!this.fileWatcher && !this.pollInterval) {
            this.startFileWatcher()
        }

        // Also listen for escape sequences (e.g. manual printf testing) and
        // track the terminal's reported cwd (OSC 7 / OSC 1337) for WSL matching.
        this.subscribeUntilDetached(
            terminal,
            terminal.output$.subscribe((data: string) => {
                this.handleOutput(terminal, data)
                this.trackTerminalCwd(terminal, data)
            }),
        )
    }

    detach(terminal: BaseTerminalTabComponent): void {
        this.clearResetTimer(terminal)
        this.stopProgressAnimation(terminal)
        this.restoreTitle(terminal)
        this.currentStatus.delete(terminal)
        this.terminalPids.delete(terminal)
        this.terminalCwds.delete(terminal)
        this.terminals.delete(terminal)
        this.publishOwnedPids()

        // Push any Claude sessions that were running in this tab into the
        // closed/history bucket — UNLESS Tabby itself is shutting down
        // (beforeunload fired). On Tabby quit, every tab's `detach()`
        // fires, and marking those sessions closed would empty the
        // "Previous run" bucket on next launch. The previous-run flow
        // depends on `closed=false` records carrying the prior run's
        // runId, which `migrateIfNeeded()` then surfaces on relaunch.
        // For mid-session tab closes (the user clicking ×), we still
        // want to mark the session closed so it goes to History.
        for (const [session, t] of this.sessionTerminals) {
            if (t === terminal) {
                this.sessionTerminals.delete(session)
                this.windowCoordinator.releaseSession(session)
                if (this.isShuttingDown) continue
                try {
                    this.sessionRestore.markClosed(session)
                } catch (err) {
                    console.error('[claude-status] markClosed on detach failed:', err)
                }
            }
        }

        if (this.terminals.size === 0) {
            this.stopFileWatcher()
        }

        super.detach(terminal)
    }

    // ── Terminal PID caching ───────────────────────────────────────

    private async cacheTerminalPid(terminal: BaseTerminalTabComponent): Promise<void> {
        for (let i = 0; i < 5; i++) {
            try {
                const pid = await (terminal as any).session?.pty?.getPID?.()
                if (pid) {
                    this.terminalPids.set(terminal, pid)
                    this.publishOwnedPids()
                    this.configService.debug('Cached terminal PID:', pid)
                    return
                }
            } catch (_) {
                /* retry */
            }
            await new Promise((r) => setTimeout(r, 1000))
        }
    }

    // ── File watcher (primary mechanism) ───────────────────────────

    private startFileWatcher(): void {
        try {
            fs.mkdirSync(STATUS_DIR, { recursive: true })
            this.cleanupSpoolDir()
            // Drain anything already waiting (events that fired during startup,
            // before the watcher attached).
            this.processSpoolDir()

            this.fileWatcher = fs.watch(STATUS_DIR, { persistent: false }, () => {
                this.processSpoolDir()
            })

            this.fileWatcher.on('error', () => {
                this.fileWatcher = null
                this.startPolling()
            })

            this.configService.debug('File watcher started:', STATUS_DIR)
        } catch (_) {
            this.startPolling()
        }
    }

    private startPolling(): void {
        this.pollInterval = setInterval(() => this.processSpoolDir(), 500)
    }

    private stopFileWatcher(): void {
        if (this.fileWatcher) {
            this.fileWatcher.close()
            this.fileWatcher = null
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval)
            this.pollInterval = null
        }
    }

    /** One-time cleanup on startup: remove the legacy single status file and
     *  any stale `.tmp` leftovers from a hook that crashed mid-write. */
    private cleanupSpoolDir(): void {
        try {
            fs.unlinkSync(LEGACY_STATUS_FILE)
        } catch {
            /* not present — fine */
        }
        try {
            for (const name of fs.readdirSync(STATUS_DIR)) {
                if (name.endsWith('.tmp')) {
                    try {
                        fs.unlinkSync(path.join(STATUS_DIR, name))
                    } catch {
                        /* racing a live write — leave it */
                    }
                }
            }
        } catch {
            /* dir vanished — fine */
        }
    }

    /**
     * Read every pending event file in the spool dir, in chronological order
     * (filenames are `<ts>-<pid>-<rand>.json`), process it, and delete it.
     * Each file is consumed exactly once even if the watcher fires multiple
     * times for the same batch.
     */
    private processSpoolDir(): void {
        let names: string[]
        try {
            names = fs.readdirSync(STATUS_DIR)
        } catch {
            return
        }
        names = names.filter((n) => n.endsWith('.json')).sort()
        for (const name of names) {
            if (this.processingFiles.has(name)) continue
            this.processingFiles.add(name)
            const full = path.join(STATUS_DIR, name)
            let data: any
            try {
                const raw = fs.readFileSync(full, 'utf-8')
                data = JSON.parse(raw)
            } catch {
                // Couldn't read/parse. Atomic rename means a present file is
                // complete, so this is a transient FS hiccup — leave it for the
                // next pass rather than deleting an event we never saw.
                this.processingFiles.delete(name)
                continue
            }
            // Consume the file regardless of how we handle the data, so stale
            // or duplicate events don't accumulate.
            try {
                fs.unlinkSync(full)
            } catch {
                /* already gone */
            }
            this.processingFiles.delete(name)
            try {
                this.handleEventData(data)
            } catch (_) {
                /* a bad event shouldn't stall the rest of the batch */
            }
        }
    }

    private handleEventData(data: any): void {
        try {
            if (!data || !data.ts || !data.event) return

            // Staleness gate first: ignore events older than 10s (e.g. a stale
            // file left over from a previous run, read on startup). Uses a time
            // delta, not a stored high-water mark, so a backward clock change
            // can't wedge it permanently.
            if (Date.now() - data.ts > 10000) return

            // Dedupe in case the same event is somehow seen twice. A distinct
            // event sharing a millisecond with a prior one has a different
            // signature and is still processed.
            const sig = `${data.ts}|${data.event}|${data.session || ''}|${data.tool || ''}`
            if (this.recentEventSigs.has(sig)) return
            this.recentEventSigs.add(sig)
            this.recentEventOrder.push(sig)
            if (this.recentEventOrder.length > ClaudeStatusDecorator.MAX_RECENT_SIGS) {
                const evicted = this.recentEventOrder.shift()
                if (evicted) this.recentEventSigs.delete(evicted)
            }

            // Map event name → status
            const mapper = HOOK_EVENT_STATUS_MAP[data.event]
            let status: ClaudeStatusName
            if (typeof mapper === 'function') {
                status = mapper(data)
            } else if (mapper) {
                status = mapper
            } else {
                return
            }

            const event: ClaudeStatusEvent = {
                version: 2,
                status,
                eventName: data.event,
                metadata: data,
            }

            // Feed the session-restore service. SessionEnd flips the record
            // to closed so auto-resume skips it; every other event reopens
            // and refreshes lastSeen.
            if (data.session) {
                if (data.event === 'SessionEnd') {
                    this.sessionRestore.markClosed(data.session)
                } else if (data.cwd) {
                    const terminal = this.findTerminalForEvent(data)
                    const title = terminal ? (terminal as any).title : undefined
                    const profile = terminal ? (terminal as any).profile : undefined
                    this.sessionRestore.record(data.session, data.cwd, title, profile)
                }
            }

            // Find the right terminal for this event
            const terminal = this.findTerminalForEvent(data)
            if (terminal) {
                this.handleStatusEvent(terminal, event, 'hook-file')
            } else {
                // Claude fired from a non-Tabby terminal (VS Code, Windows
                // Terminal, plain pwsh…) — OR from a tab in a *different*
                // Tabby window. Don't fan per-tab decorations out to unrelated
                // Tabby tabs — that just lights up every tab in red/green for a
                // session that has nothing to do with them. Still emit the
                // global effects (audio + taskbar) so the user hears "I'm Done"
                // etc. regardless of host terminal — but only from one window,
                // see `runGlobalEffects`.
                this.runGlobalEffects(event, data)
            }
        } catch (_) {
            // Defensive: a malformed payload shouldn't break the watcher.
        }
    }

    // ── Cross-window arbitration ──────────────────────────────────

    /** Map a session to one of our tabs and tell sibling windows we own it, so
     *  they skip the ownerless-event path for it instead of announcing too. */
    private claimSessionForTerminal(session: string, terminal: BaseTerminalTabComponent): void {
        this.sessionTerminals.set(session, terminal)
        this.windowCoordinator.claimSession(session)
    }

    private publishOwnedPids(): void {
        this.windowCoordinator.setPids(Array.from(this.terminalPids.values()))
    }

    /**
     * Global (non-tab-scoped) effects for an event we couldn't match to a tab
     * in this window: taskbar flash + the spoken announcement.
     *
     * Every open Tabby window watches the same hook spool dir and reaches this
     * point for the same event, so running it unconditionally means N windows
     * → N utterances. Two gates fix that:
     *
     *  - If a sibling window owns the session (or hosts a terminal in the
     *    event's process ancestry), it is announcing this event from its own
     *    matched-terminal path. Stay silent.
     *  - Otherwise nobody owns it (Claude running outside Tabby entirely).
     *    Exactly one window — the coordinator's leader — announces.
     *
     * The ownership check runs twice: once immediately (cheap, catches the
     * steady state via published PIDs) and once after a short grace period.
     * The grace matters for the *first* event of a session, where the owning
     * window only learns the session→tab mapping while processing that very
     * event; its claim lands within a few ms, well inside the window below.
     * WSL sessions match by cwd rather than PID and depend on this entirely.
     */
    private runGlobalEffects(event: ClaudeStatusEvent, data: any): void {
        if (this.isClaimedByPeerWindow(data)) return
        setTimeout(() => {
            if (this.isClaimedByPeerWindow(data)) {
                this.configService.debug('Global event claimed by another window — skipping')
                return
            }
            if (!this.windowCoordinator.isLeader()) {
                this.configService.debug('Global event: not the leader window — skipping')
                return
            }
            this.applyTaskbar(event.status, this.configService.getDisplayConfig())
            const logId = this.activityLog.record({
                status: event.status,
                eventName: event.eventName,
                source: 'hook-file',
                terminalMatched: false,
                session: data.session,
                metadata: this.summarizeMetadata(data),
            })
            // Pass the full payload (not the trimmed summary) as ctx so the
            // dynamic-phrase pipeline can read transcript_path. The call is
            // fire-and-forget — speak() returns void.
            this.audioService.speak(event.status, logId, {
                metadata: data,
                eventName: event.eventName,
            })
        }, ClaudeStatusDecorator.PEER_CLAIM_GRACE_MS)
    }

    private isClaimedByPeerWindow(data: any): boolean {
        try {
            return this.windowCoordinator.isClaimedByPeer(data?.session, data?.ancestors)
        } catch {
            // Coordination is best-effort: if the temp dir is unreadable, fall
            // back to the old behaviour (announce) rather than going silent.
            return false
        }
    }

    private findTerminalForEvent(data: any): BaseTerminalTabComponent | null {
        const session = data.session

        // Check cached session→terminal mapping first
        if (session && this.sessionTerminals.has(session)) {
            this.configService.debug('PID match: using cached session mapping for', session)
            return this.sessionTerminals.get(session)!
        }

        // Use ancestor PIDs from hook.js (resolved while processes were still alive)
        const ancestors: number[] = data.ancestors || []
        if (ancestors.length > 0 && this.terminalPids.size > 0) {
            const cachedPids = Array.from(this.terminalPids.values())
            this.configService.debug(
                'PID match: ancestors=',
                ancestors.join(','),
                '| cached terminal PIDs=',
                cachedPids.join(','),
            )
            for (const [terminal, cachedPid] of this.terminalPids) {
                if (ancestors.includes(cachedPid)) {
                    if (session) this.claimSessionForTerminal(session, terminal)
                    this.configService.debug('PID match: MATCHED terminal PID', cachedPid)
                    return terminal
                }
            }
            this.configService.debug('PID match: no match found, falling back to cwd match')
        } else {
            this.configService.debug(
                'PID match: skipped — ancestors=',
                ancestors.length,
                'cached count=',
                this.terminalPids.size,
            )
        }

        // cwd fallback — this is what makes WSL sessions match. The hook runs
        // inside the WSL VM and reports Linux ancestor PIDs that can never
        // equal Tabby's Windows conpty PIDs, so PID matching always misses for
        // WSL. But the shell reports its working directory via OSC 7 (and some
        // via OSC 1337 CurrentDir), which we track per-terminal from the output
        // stream. Match the event's cwd to the terminal sitting in that dir.
        const eventCwd = this.normalizeCwd(data.cwd)
        if (eventCwd && this.terminalCwds.size > 0) {
            const matches: BaseTerminalTabComponent[] = []
            for (const [terminal, cwd] of this.terminalCwds) {
                if (cwd === eventCwd && this.terminals.has(terminal)) matches.push(terminal)
            }
            // Only trust an unambiguous match — if two tabs sit in the same
            // directory we can't tell which fired the event, so fall through to
            // the global path rather than decorate the wrong tab.
            if (matches.length === 1) {
                const terminal = matches[0]
                if (session) this.claimSessionForTerminal(session, terminal)
                this.configService.debug('cwd match: MATCHED terminal for cwd', eventCwd)
                return terminal
            }
            this.configService.debug(
                'cwd match: ambiguous/none for cwd',
                eventCwd,
                '— candidates:',
                matches.length,
            )
        }

        return null
    }

    /**
     * Track a terminal's current working directory from OSC escape sequences
     * in its output stream. OSC 7 (`file://host/path`) is the de-facto standard
     * and is emitted by most modern shell setups (incl. default WSL bash/zsh);
     * OSC 1337 `CurrentDir=` is iTerm's variant. Used as the WSL-friendly
     * fallback in `findTerminalForEvent`.
     */
    private trackTerminalCwd(terminal: BaseTerminalTabComponent, data: string): void {
        if (!data || data.indexOf('\x1b]') === -1) return
        let raw: string | undefined
        let m: RegExpExecArray | null
        ClaudeStatusDecorator.OSC7_RE.lastIndex = 0
        // Take the last match in the chunk — that's the most recent cd.
        while ((m = ClaudeStatusDecorator.OSC7_RE.exec(data)) !== null) raw = m[1]
        if (raw === undefined) {
            ClaudeStatusDecorator.OSC1337_CWD_RE.lastIndex = 0
            while ((m = ClaudeStatusDecorator.OSC1337_CWD_RE.exec(data)) !== null) raw = m[1]
        }
        if (raw === undefined) return
        const norm = this.normalizeCwd(raw)
        if (norm) this.terminalCwds.set(terminal, norm)
    }

    /** Normalise a path for cwd comparison: percent-decode, unify separators,
     *  drop any trailing separator. Returns '' for empty input. */
    private normalizeCwd(p: string | undefined): string {
        if (!p) return ''
        let out = p
        try {
            out = decodeURIComponent(out)
        } catch {
            /* malformed %-escape — compare raw */
        }
        return out.replace(/\\/g, '/').replace(/\/+$/, '')
    }

    // ── Escape sequence parsing (secondary / testing) ──────────────

    private handleOutput(terminal: BaseTerminalTabComponent, data: string): void {
        const result = this.parser.parse(data)
        for (const event of result.events) {
            if (event.version >= 2 && event.eventName) {
                const mapper = HOOK_EVENT_STATUS_MAP[event.eventName]
                if (typeof mapper === 'function') {
                    event.status = mapper(event.metadata)
                } else if (mapper) {
                    event.status = mapper
                } else {
                    continue
                }
            }
            this.handleStatusEvent(terminal, event, 'escape-sequence')
        }
    }

    // ── Status handling ────────────────────────────────────────────

    private handleStatusEvent(
        terminal: BaseTerminalTabComponent,
        event: ClaudeStatusEvent,
        source: 'hook-file' | 'escape-sequence',
    ): void {
        const current = this.currentStatus.get(terminal)
        const logBase = {
            status: event.status,
            eventName: event.eventName,
            source,
            terminalMatched: true as const,
            terminalTitle: (terminal as any).title as string | undefined,
            session: (event.metadata as any)?.session as string | undefined,
            metadata: this.summarizeMetadata(event.metadata),
        }

        if (event.status === 'working' && current === 'question') {
            // Suppressed: don't downgrade an open question to "working" mid-turn.
            // Still record so the activity log shows why the user did NOT hear
            // anything for this event.
            const id = this.activityLog.record(logBase)
            this.activityLog.setAudioOutcome(
                id,
                'suppressed-duplicate',
                'working while still in question',
            )
            return
        }

        this.clearResetTimer(terminal)
        this.currentStatus.set(terminal, event.status)

        const display = this.configService.getDisplayConfig()

        this.applyColorBorder(terminal, event.status, display)
        this.applyTitleEmoji(terminal, event.status, display)
        this.applyProgressBar(terminal, event.status, display)
        this.applyActivityMarker(terminal, event.status, display)
        this.applyTaskbar(event.status, display)

        if (event.status === 'done') {
            this.scheduleAutoReset(terminal)
        }

        const logId = this.activityLog.record(logBase)
        // Fire-and-forget. speak() returns void; the dynamic-phrase pipeline
        // runs entirely async inside speak(). Decorator never awaits — that
        // would delay terminal decoration on slow networks.
        this.audioService.speak(event.status, logId, {
            metadata: event.metadata,
            eventName: event.eventName,
        })
    }

    /**
     * Trim the hook payload to fields we actually display in the activity
     * log. Keeps the on-disk JSON small and avoids leaking arbitrary tool
     * arguments (some `tool_input` blobs are huge).
     */
    private summarizeMetadata(meta: any): Record<string, unknown> | undefined {
        if (!meta || typeof meta !== 'object') return undefined
        const keep = ['type', 'tool', 'reason', 'message', 'action', 'source']
        const out: Record<string, unknown> = {}
        for (const key of keep) {
            if (meta[key] !== undefined) out[key] = meta[key]
        }
        if (Array.isArray(meta.ancestors) && meta.ancestors.length) {
            out.ancestors = meta.ancestors.slice(0, 4)
        }
        return Object.keys(out).length ? out : undefined
    }

    // ── Display surfaces ──────────────────────────────────────────

    private applyColorBorder(
        terminal: BaseTerminalTabComponent,
        status: ClaudeStatusName,
        display: ClaudeStatusDisplayConfig,
    ): void {
        if (!display.colorBorder) {
            if (terminal.color !== null) this.setColorWithScrollGuard(terminal, null)
            return
        }

        let newColor: string | null = null
        switch (status) {
            case 'working':
                newColor = this.configService.getColor('working')
                break
            case 'question':
                newColor = this.configService.getColor('question')
                break
            case 'done':
                newColor = this.configService.getColor('done')
                break
            case 'error':
                newColor = this.configService.getColor('error')
                break
            case 'idle':
                newColor = null
                break
        }

        if (terminal.color !== newColor) {
            this.setColorWithScrollGuard(terminal, newColor)
        }
    }

    private applyTitleEmoji(
        terminal: BaseTerminalTabComponent,
        status: ClaudeStatusName,
        display: ClaudeStatusDisplayConfig,
    ): void {
        if (!display.titleEmoji) {
            this.restoreTitle(terminal)
            return
        }

        const currentTitle = (terminal as any).title as string
        if (!this.baseTitles.has(terminal)) {
            this.baseTitles.set(terminal, this.stripEmojiPrefix(currentTitle, display))
        }
        const base = this.baseTitles.get(terminal) || ''
        const emoji = display.titleEmojiMap[status] || ''
        const next = emoji ? `${emoji} ${base}` : base

        if (currentTitle !== next) {
            try {
                terminal.setTitle(next)
            } catch {
                /* older Tabby may not expose setTitle */
            }
        }
    }

    private stripEmojiPrefix(title: string, display: ClaudeStatusDisplayConfig): string {
        for (const emoji of Object.values(display.titleEmojiMap)) {
            if (emoji && title.startsWith(`${emoji} `)) {
                return title.slice(emoji.length + 1)
            }
        }
        return title
    }

    private restoreTitle(terminal: BaseTerminalTabComponent): void {
        const base = this.baseTitles.get(terminal)
        if (base !== undefined) {
            try {
                terminal.setTitle(base)
            } catch {
                /* noop */
            }
            this.baseTitles.delete(terminal)
        }
    }

    private applyProgressBar(
        terminal: BaseTerminalTabComponent,
        status: ClaudeStatusName,
        display: ClaudeStatusDisplayConfig,
    ): void {
        this.stopProgressAnimation(terminal)

        if (!display.progressBar) {
            try {
                terminal.setProgress(null)
            } catch {
                /* noop */
            }
            return
        }

        if (status === 'working') {
            // Pulse an indeterminate bar: sweep 0 → 1 every ~1.5s
            let tick = 0
            const iv = setInterval(() => {
                tick = (tick + 1) % 30
                const value = tick / 30
                try {
                    terminal.setProgress(value)
                } catch {
                    /* noop */
                }
            }, 50)
            this.progressIntervals.set(terminal, iv)
        } else {
            try {
                terminal.setProgress(null)
            } catch {
                /* noop */
            }
        }
    }

    private stopProgressAnimation(terminal: BaseTerminalTabComponent): void {
        const iv = this.progressIntervals.get(terminal)
        if (iv) {
            clearInterval(iv)
            this.progressIntervals.delete(terminal)
            try {
                terminal.setProgress(null)
            } catch {
                /* noop */
            }
        }
    }

    private applyActivityMarker(
        terminal: BaseTerminalTabComponent,
        status: ClaudeStatusName,
        display: ClaudeStatusDisplayConfig,
    ): void {
        if (!display.activityMarker) {
            try {
                terminal.clearActivity()
            } catch {
                /* noop */
            }
            return
        }

        try {
            if (status === 'question' || status === 'error') {
                terminal.displayActivity()
            } else {
                terminal.clearActivity()
            }
        } catch {
            /* older Tabby */
        }
    }

    private applyTaskbar(status: ClaudeStatusName, display: ClaudeStatusDisplayConfig): void {
        if (!display.taskbarFlash && !display.taskbarOverlay) return
        const win = getBrowserWindow()
        if (!win) return

        // Only act when the Tabby window is not focused — otherwise flashing the
        // currently-focused window is just noise.
        const focused = typeof win.isFocused === 'function' ? win.isFocused() : true

        if (display.taskbarFlash && !focused) {
            try {
                win.flashFrame?.(status === 'question' || status === 'error')
            } catch {
                /* noop */
            }
        }

        if (display.taskbarOverlay) {
            try {
                if (status === 'idle') {
                    win.setOverlayIcon?.(null, '')
                } else {
                    const iconPath = this.getOverlayIconPath(status)
                    if (iconPath && fs.existsSync(iconPath)) {
                        win.setOverlayIcon?.(iconPath, status)
                    }
                }
            } catch {
                /* noop */
            }
        }
    }

    private getOverlayIconPath(status: ClaudeStatusName): string | null {
        try {
            // dist/index.js lives one level up from the built overlay assets.
            const assetsDir = path.resolve(__dirname, '..', 'assets')
            const candidate = path.join(assetsDir, `overlay-${status}.png`)
            return candidate
        } catch {
            return null
        }
    }

    private setColorWithScrollGuard(
        terminal: BaseTerminalTabComponent,
        color: string | null,
    ): void {
        const frontend = terminal.frontend as any
        const xterm = frontend?.xterm

        if (!xterm?.element) {
            terminal.color = color
            return
        }

        const viewport = xterm.element.querySelector('.xterm-viewport') as HTMLElement | null
        if (!viewport) {
            terminal.color = color
            return
        }

        // Save scroll state
        const savedScrollTop = viewport.scrollTop
        const wasAtBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1

        terminal.color = color

        // Restore scroll position on next animation frame (after Angular change detection)
        requestAnimationFrame(() => {
            if (wasAtBottom) {
                terminal.frontend?.scrollToBottom()
            } else {
                viewport.scrollTop = savedScrollTop
            }
        })
    }

    private scheduleAutoReset(terminal: BaseTerminalTabComponent): void {
        const delay = this.configService.doneAutoResetMs
        if (delay <= 0) return

        const timer = setTimeout(() => {
            if (this.currentStatus.get(terminal) === 'done') {
                this.clearStatus(terminal)
            }
        }, delay)

        this.resetTimers.set(terminal, timer)
    }

    private clearResetTimer(terminal: BaseTerminalTabComponent): void {
        const timer = this.resetTimers.get(terminal)
        if (timer) {
            clearTimeout(timer)
            this.resetTimers.delete(terminal)
        }
    }

    private clearStatus(terminal: BaseTerminalTabComponent): void {
        this.currentStatus.set(terminal, 'idle')
        const display = this.configService.getDisplayConfig()

        if (terminal.color !== null) {
            this.setColorWithScrollGuard(terminal, null)
        }
        this.stopProgressAnimation(terminal)
        if (display.titleEmoji) this.restoreTitle(terminal)
        if (display.activityMarker) {
            try {
                terminal.clearActivity()
            } catch {
                /* noop */
            }
        }
        if (display.taskbarOverlay) {
            const win = getBrowserWindow()
            try {
                win?.setOverlayIcon?.(null, '')
            } catch {
                /* noop */
            }
        }
    }
}
