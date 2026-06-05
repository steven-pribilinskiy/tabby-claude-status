import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Inject, Injectable, Optional } from '@angular/core'
import { NotificationsService, ProfilesService } from 'tabby-core'
import { TerminalService } from 'tabby-local'
import type { ClaudeSessionRecord } from '../interfaces/types'
import { ClaudeStatusConfigService } from './configService'

/**
 * On-disk location for persisted Claude sessions. Kept under Tabby's AppData
 * dir rather than %TEMP% so it survives reboots and Windows tmp cleanup.
 */
const SESSIONS_FILE = path.join(
    process.env.APPDATA || os.homedir(),
    'tabby',
    'tabby-claude-status-sessions.json',
)

interface SessionsFile {
    version: 1
    sessions: ClaudeSessionRecord[]
    /** Run id of the currently-active Tabby instance (rotated on every start). */
    currentRunId?: string
    /** Run id of the immediately preceding Tabby instance, captured at startup. */
    previousRunId?: string | null
}

/**
 * Persists Claude Code sessions (sessionId + cwd + title) and knows how to
 * resurrect them in new Tabby tabs after a restart.
 *
 * Every action is gated on `sessionRestore.enabled` so users who haven't
 * opted into the feature pay nothing.
 *
 * `TerminalService` is injected as `@Optional()` — if the user somehow
 * runs without `tabby-local` loaded, the service is still constructable
 * and simply fails the restore gracefully.
 */
@Injectable({ providedIn: 'root' })
export class SessionRestoreService {
    /**
     * Pluggable lookup that returns the live tab title for a sessionId, if any.
     * Registered by `ClaudeStatusDecorator` once it has a terminal mapped to a
     * session. The settings tab uses this so the displayed title reflects the
     * tab's current title (which Claude Code rewrites mid-session via OSC
     * sequences) rather than the snapshot taken when the SessionStart hook
     * fired — that snapshot is usually still "✷ Claude Code".
     */
    private liveTitleResolver: (sessionId: string) => string | undefined = () => undefined
    /**
     * Like `liveTitleResolver`, but returns the profile metadata for the live
     * tab. We use this in `list()` to backfill profile fields onto records
     * created before the profile-capture upgrade, and to capture the profile
     * on every tick even if hooks aren't wired beyond SessionStart.
     */
    private liveProfileResolver: (
        sessionId: string,
    ) => { id?: string; name?: string; type?: string } | undefined = () => undefined

    /** Run id rotated every Tabby start. Records observed in the current run carry this id. */
    private currentRunId: string = SessionRestoreService.makeRunId()
    /** Run id from the previous Tabby instance — captured on first file read. */
    private previousRunId: string | null = null
    private migrated = false

    constructor(
        private configService: ClaudeStatusConfigService,
        @Optional() @Inject(TerminalService) private terminalService: TerminalService | null,
        @Optional()
        @Inject(NotificationsService)
        private notifications: NotificationsService | null,
        @Optional() @Inject(ProfilesService) private profilesService: ProfilesService | null,
    ) {
        this.migrateIfNeeded()
    }

    private static makeRunId(): string {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    /**
     * On the first file touch after this Tabby instance starts:
     *
     * - Capture `currentRunId` from the file as our `previousRunId`, then
     *   stamp a fresh `currentRunId` and persist both.
     * - Tag any legacy `!closed` records (no `runId`) with a synthetic
     *   previous-run id so they show up under "Previous run" rather than
     *   getting dumped straight into History.
     * - Roll any record whose `runId` predates the previous run into History
     *   (`closed = true`). The "Previous run" bucket only shows the most
     *   recent prior run, never older ones.
     * - Dedupe `sessions` by `sessionId`, keeping the most recent `lastSeen`.
     *   Guards against any duplicates left over from older versions.
     */
    private migrateIfNeeded(): void {
        if (this.migrated) return
        this.migrated = true

        const file = this.readFile()
        const priorRunIdFromFile = file.currentRunId ?? null
        this.previousRunId = priorRunIdFromFile

        // Tag legacy open records (no runId, written by a pre-runId version)
        // with the previous-run id so they surface under "Previous run" rather
        // than being force-closed into History by the validRunIds sweep below.
        // This must run whether or not previousRunId already came from the file
        // — the old `&& !this.previousRunId` guard skipped tagging on any normal
        // restart (where the file already had a currentRunId), silently dumping
        // legacy sessions straight into History.
        const hasLegacy = file.sessions.some((s) => !s.closed && !s.runId)
        if (hasLegacy) {
            if (!this.previousRunId) {
                this.previousRunId = `legacy-${Date.now().toString(36)}`
            }
            for (const s of file.sessions) {
                if (!s.closed && !s.runId) s.runId = this.previousRunId
            }
        }

        file.previousRunId = this.previousRunId
        file.currentRunId = this.currentRunId

        const validRunIds = new Set<string>([this.currentRunId])
        if (this.previousRunId) validRunIds.add(this.previousRunId)

        for (const s of file.sessions) {
            if (s.closed) continue
            if (!s.runId || !validRunIds.has(s.runId)) {
                s.closed = true
                s.lastSeen = Date.now()
            }
        }

        const byId = new Map<string, ClaudeSessionRecord>()
        for (const s of file.sessions) {
            const cur = byId.get(s.sessionId)
            if (!cur || (s.lastSeen ?? 0) > (cur.lastSeen ?? 0)) byId.set(s.sessionId, s)
        }
        file.sessions = [...byId.values()]

        this.writeFile(file)
    }

    /** Run id of the current Tabby instance. Exposed so the settings tab can
     *  bucket its locally-cached session list (active vs previous run) without
     *  calling back into `list()` — which reads the sessions file from disk —
     *  on every Angular change-detection cycle. */
    getCurrentRunId(): string {
        return this.currentRunId
    }

    /** Run id of the immediately-preceding Tabby instance, or null if this is
     *  the first run / no prior run was recorded. See `getCurrentRunId()`. */
    getPreviousRunId(): string | null {
        return this.previousRunId
    }

    setLiveTitleResolver(resolver: (sessionId: string) => string | undefined): void {
        this.liveTitleResolver = resolver
    }

    setLiveProfileResolver(
        resolver: (sessionId: string) => { id?: string; name?: string; type?: string } | undefined,
    ): void {
        this.liveProfileResolver = resolver
    }

    getLiveTitle(sessionId: string): string | undefined {
        try {
            const t = this.liveTitleResolver(sessionId)
            return t?.trim() ? t : undefined
        } catch {
            return undefined
        }
    }

    getLiveProfile(sessionId: string): { id?: string; name?: string; type?: string } | undefined {
        try {
            return this.liveProfileResolver(sessionId)
        } catch {
            return undefined
        }
    }

    /**
     * Record (or update) a session observation. No-op when session restore
     * is disabled, so the sessions file stays empty for opted-out users.
     *
     * Any observation other than `SessionEnd` reopens the session (clears
     * `closed`) — Claude Code reuses session ids across `--resume` so the
     * same id can cycle between open and closed.
     */
    record(sessionId: string, cwd: string, title?: string, profile?: any): void {
        if (!sessionId || !cwd) return
        const cfg = this.configService.getSessionRestoreConfig()
        if (!cfg.enabled) return

        const file = this.readFile()
        const now = Date.now()
        const existing = file.sessions.find((s) => s.sessionId === sessionId)
        if (existing) {
            existing.cwd = cwd
            if (title) existing.title = title
            if (profile?.id) {
                existing.profileId = profile.id
                existing.profileName = profile.name
                existing.profileType = profile.type
            }
            existing.lastSeen = now
            existing.closed = false
            existing.runId = this.currentRunId
        } else {
            file.sessions.push({
                sessionId,
                cwd,
                title,
                profileId: profile?.id,
                profileName: profile?.name,
                profileType: profile?.type,
                firstSeen: now,
                lastSeen: now,
                closed: false,
                runId: this.currentRunId,
            })
        }
        this.pruneInPlace(file, cfg.retentionDays)
        this.writeFile(file)
    }

    /**
     * Mark a session as closed. Called when Claude Code fires `SessionEnd`
     * and from the settings UI's "Mark all as closed" bulk action.
     *
     * Runs even if session restore is disabled so we capture the end-state
     * correctly if the user toggles the feature back on later.
     */
    markClosed(sessionId: string): void {
        if (!sessionId) return
        const file = this.readFile()
        const existing = file.sessions.find((s) => s.sessionId === sessionId)
        if (!existing) return
        if (existing.closed === true) return
        existing.closed = true
        existing.lastSeen = Date.now()
        this.writeFile(file)
    }

    /**
     * Bulk-close everything currently in the sessions file. The UI uses this
     * to clear out the backlog of pre-existing sessions that were never
     * explicitly ended — so on the next launch, auto-resume starts from a
     * clean slate.
     */
    markAllClosed(): number {
        const file = this.readFile()
        let n = 0
        for (const s of file.sessions) {
            if (!s.closed) {
                s.closed = true
                n++
            }
        }
        if (n > 0) this.writeFile(file)
        return n
    }

    /**
     * Return sessions that are still within the retention window, newest first.
     *
     * If a session has a live tab whose title differs from the persisted one,
     * update the record in place and write back. This keeps the title fresh
     * for users whose only-tabby-on-SessionStart hook setup never re-fires
     * after the SessionStart snapshot — Claude rewrites the tab title later
     * (recap, /rename-session, etc.) and we want to capture the latest.
     */
    list(): ClaudeSessionRecord[] {
        const cfg = this.configService.getSessionRestoreConfig()
        const file = this.readFile()
        // Persist the prune too — otherwise a list() that only removed expired
        // records (no title/profile change) returned the pruned array but left
        // the stale records on disk, so they reappeared on the next read and
        // got re-pruned every call.
        let dirty = this.pruneInPlace(file, cfg.retentionDays)
        for (const s of file.sessions) {
            if (s.closed) continue
            const live = this.getLiveTitle(s.sessionId)
            if (live && live !== s.title) {
                s.title = live
                dirty = true
            }
            const liveProfile = this.getLiveProfile(s.sessionId)
            if (liveProfile?.id && liveProfile.id !== s.profileId) {
                s.profileId = liveProfile.id
                s.profileName = liveProfile.name
                s.profileType = liveProfile.type
                dirty = true
            }
        }
        if (dirty) this.writeFile(file)
        return [...file.sessions].sort((a, b) => b.lastSeen - a.lastSeen)
    }

    /**
     * Delete a session from the sidecar file (e.g. user dismissed it from the UI).
     */
    forget(sessionId: string): void {
        const file = this.readFile()
        file.sessions = file.sessions.filter((s) => s.sessionId !== sessionId)
        this.writeFile(file)
    }

    /**
     * Open a new Tabby tab at the session's `cwd` and type either
     * `claude --resume <id>` (mode 'resume', the default) or
     * `claude --resume <id> --fork-session` (mode 'fork', for active sessions
     * where resuming in-place would just open a duplicate of an already-running
     * conversation — the user actually wants a divergent branch).
     *
     * Returns true if a tab was opened.
     */
    async resumeSession(
        session: ClaudeSessionRecord,
        mode: 'resume' | 'fork' = 'resume',
    ): Promise<{ ok: boolean; error?: string }> {
        if (!this.terminalService) {
            const msg = 'Session restore unavailable — the tabby-local plugin is not loaded.'
            this.notifications?.error?.(msg)
            console.error('[claude-status]', msg)
            return { ok: false, error: msg }
        }

        const cfg = this.configService.getSessionRestoreConfig()
        const extra = cfg.extraArgs.trim()
        const forkFlag = mode === 'fork' ? ' --fork-session' : ''
        const resumeCmd = extra
            ? `claude --resume ${session.sessionId}${forkFlag} ${extra}\r`
            : `claude --resume ${session.sessionId}${forkFlag}\r`
        // Always send an explicit `cd "<cwd>"` first. Tabby's openTab(undefined,
        // cwd) does not reliably set cwd for WSL-backed profiles (the shell
        // ends up in the profile's default dir), and `claude --resume` reads
        // its session cache from the current cwd — wrong cwd → "No
        // conversation found with session ID …".
        const cdCmd = `cd ${this.shellQuote(session.cwd)}\r`

        // Clamp to a sane range. 0 is allowed (user opt-out) but step is 0.1s
        // in the UI so the smallest non-zero value is 100ms.
        const cdDelayMs = Math.round(Math.max(0, Math.min(cfg.resumeCdDelaySec ?? 1.2, 10)) * 1000)
        const openDelayMs = Math.round(
            Math.max(0, Math.min(cfg.resumeOpenDelaySec ?? 1.5, 30)) * 1000,
        )

        const profile = await this.resolveProfile(session)

        // Pass cwd to openTab ONLY when it's a path Tabby's host (Windows)
        // can stat — otherwise Tabby's tabby-local logs "Ignoring
        // non-existent CWD: …" and silently opens the tab at the
        // profile's default dir. For WSL/SSH/non-Windows profiles the
        // cwd lives on the *guest* filesystem; rely entirely on the
        // explicit `cd "<cwd>"` we send below.
        const openCwd = this.cwdSafeForOpenTab(profile, session.cwd)

        try {
            const tab = await this.terminalService.openTab(profile, openCwd)
            if (!tab) {
                const msg = profile
                    ? `Tabby returned no tab for profile ${profile.name || profile.id}. Check the profile's command and cwd.`
                    : 'Tabby returned no tab. The Claude session was recorded before profile capture shipped, and no profile could be inferred from the cwd. Open a tab manually with the right shell and try again.'
                console.error('[claude-status] resumeSession:', msg, { session, profile })
                this.notifications?.error?.(msg)
                return { ok: false, error: msg }
            }
            // Wait for the pty + shell to be ready for input. The
            // duration is `cfg.resumeOpenDelaySec` — needs to exceed the
            // shell's first-prompt readiness time (cold WSL: 1-2s; with
            // oh-my-zsh + plugins: longer). If too short, the cd line
            // is sent into the still-initialising shell and dropped, and
            // the user's tab ends up at the profile's default cwd
            // instead of the session cwd.
            // The tab may be closed by the user during either delay below.
            // sendInput on a destroyed tab can silently go nowhere (or throw);
            // skip it if the tab's session is gone so we don't fire a resume
            // command into a dead pty.
            const tabAlive = () => {
                const t = tab as any
                if (t?.destroyed === true) return false
                // A live local terminal tab has a `session`/`frontend`; once
                // closed Tabby tears these down. Treat absence as "not alive".
                return !!(t?.session || t?.frontend)
            }
            setTimeout(() => {
                if (!tabAlive()) return
                try {
                    tab.sendInput(cdCmd)
                } catch (err) {
                    console.error('[claude-status] cd sendInput failed:', err)
                    return
                }
                setTimeout(() => {
                    if (!tabAlive()) return
                    try {
                        tab.sendInput(resumeCmd)
                    } catch (err) {
                        console.error('[claude-status] resume sendInput failed:', err)
                    }
                }, cdDelayMs)
            }, openDelayMs)
            return { ok: true }
        } catch (err) {
            const msg = (err as Error)?.message || String(err)
            console.error('[claude-status] resumeSession failed:', err, { session, profile })
            this.notifications?.error?.(`Failed to resume Claude session: ${msg}`)
            return { ok: false, error: msg }
        }
    }

    /**
     * Decide whether `cwd` can be passed to `terminalService.openTab(profile, cwd)`.
     * Tabby's tabby-local does `fs.lstatSync(cwd)` on the *host* (always
     * Windows on this build) and logs "Ignoring non-existent CWD: …"
     * when the path is missing. WSL/SSH cwds (`/home/...`, `~/...`)
     * always fail that check even though they're valid inside the
     * guest. Drop the cwd in those cases; the `cd "<cwd>"` we send via
     * sendInput already places the shell in the right directory once
     * the pty is alive.
     */
    private cwdSafeForOpenTab(profile: any, cwd: string): string | undefined {
        if (!cwd) return undefined
        // Non-local profile types (ssh, telnet, serial, …) — cwd lives
        // remotely, not on the host filesystem.
        const profType = profile?.type
        if (profType && profType !== 'local') return undefined
        // WSL profiles run wsl.exe — their cwd is inside the WSL distro,
        // not on Windows. We detect WSL via the profile's command.
        const cmd = String(profile?.options?.command ?? '').toLowerCase()
        if (cmd.includes('wsl.exe') || cmd.endsWith('\\wsl')) return undefined
        // Heuristic: Unix-style absolute path on a Windows host means
        // the session was inside WSL or SSH — host can't stat it.
        if (process.platform === 'win32' && (cwd.startsWith('/') || cwd.startsWith('~'))) {
            return undefined
        }
        return cwd
    }

    /**
     * Quote a path for `cd` in the target shell. Both bash and PowerShell
     * accept double quotes around a path; the only character we have to escape
     * is the double-quote itself (rare in cwds, but cheap to handle).
     */
    private shellQuote(p: string): string {
        if (!p) return '""'
        // Strip a trailing path separator before quoting. `cd "C:\foo\"` (or
        // the bash equivalent) mis-parses because the trailing `\` escapes the
        // closing quote, breaking the command and landing the resume in the
        // wrong directory. `cd "C:\foo"` is equivalent. Keep the original if
        // stripping would empty the string (e.g. a bare "/").
        const trimmed = p.replace(/[\\/]+$/, '') || p
        return `"${trimmed.replace(/"/g, '\\"')}"`
    }

    /**
     * Look up the Tabby profile to launch this session under. Without an exact
     * id match a Windows-cwd session would otherwise resume in the user's
     * default profile (typically WSL), which then can't `cd` to a Windows
     * path. Falls back to a same-`type` profile if the original id is gone
     * (profile deleted/renamed), and to `undefined` only as a last resort —
     * undefined means TerminalService picks the default, matching pre-fix
     * behaviour.
     */
    private async resolveProfile(session: ClaudeSessionRecord): Promise<any | undefined> {
        if (!this.profilesService) return undefined
        try {
            const profiles = await this.profilesService.getProfiles()
            // Path 1 — exact profile id captured at SessionStart.
            if (session.profileId) {
                const exact = profiles.find((p) => p.id === session.profileId)
                if (exact) return exact
            }
            // Path 2 — same profile type (Windows session falls back to a
            // Windows shell, WSL session to a WSL shell).
            if (session.profileType) {
                const sameType = profiles.find((p) => p.type === session.profileType)
                if (sameType) {
                    console.warn(
                        '[claude-status] Original profile not found for session',
                        session.sessionId,
                        '— falling back to same-type profile:',
                        sameType.name,
                    )
                    return sameType
                }
            }
            // Path 3 — legacy records that pre-date the profile capture
            // upgrade have neither profileId nor profileType. Without
            // them, openTab(undefined, '/home/<user>/...') falls through
            // to Tabby's default profile, which on Windows is typically
            // PowerShell — and PowerShell can't start in a /home/...
            // cwd, so the openTab call rejects and Resume silently does
            // nothing. Pick a profile based on the cwd shape instead.
            const inferred = this.inferProfileFromCwd(profiles, session.cwd)
            if (inferred) {
                console.warn(
                    '[claude-status] Legacy session record has no profile metadata; inferred',
                    inferred.name,
                    `(${inferred.type})`,
                    'from cwd',
                    session.cwd,
                )
                return inferred
            }
            console.warn(
                '[claude-status] Could not resolve profile for session',
                session.sessionId,
                '— using Tabby default.',
            )
            return undefined
        } catch (err) {
            console.warn('[claude-status] resolveProfile failed:', err)
            return undefined
        }
    }

    /**
     * Pick the first profile whose `type` is plausible for the given
     * cwd. Linux-style absolute paths (`/home/...`, `/root/...`,
     * `/tmp/...`, `/mnt/...`) → a WSL profile. Windows-style drive paths
     * (`C:\...`) → a Windows local profile. Used only for legacy
     * sessions where SessionStart didn't capture profile metadata.
     */
    private inferProfileFromCwd(profiles: any[], cwd: string | undefined): any | undefined {
        if (!cwd) return undefined
        const isLinuxPath = /^\/(home|root|tmp|mnt|usr|var|opt|srv)(\/|$)/i.test(cwd)
        const isWindowsPath = /^[a-z]:[\\/]/i.test(cwd)
        if (isLinuxPath) {
            // Tabby's WSL profiles are typed `local` with a wsl.exe
            // command; the dedicated `wsl` type is what newer Tabby
            // versions assign. Try both, then anything whose command
            // looks like wsl.exe.
            return (
                profiles.find((p) => p.type === 'wsl') ||
                profiles.find(
                    (p) => p.type === 'local' && /wsl(\.exe)?\b/i.test(p.options?.command || ''),
                )
            )
        }
        if (isWindowsPath) {
            return profiles.find(
                (p) => p.type === 'local' && !/wsl(\.exe)?\b/i.test(p.options?.command || ''),
            )
        }
        return undefined
    }

    /**
     * Sessions that have received a hook event during the *current* Tabby
     * run. Drives the "Active sessions" bucket in the settings UI.
     */
    activeSessions(): ClaudeSessionRecord[] {
        return this.list().filter((s) => !s.closed && s.runId === this.currentRunId)
    }

    /**
     * Sessions that were active in the immediately-preceding Tabby run but
     * haven't been forked back into the current one. Drives the "Previous
     * run" bucket. Older runs are rolled into History by `migrateIfNeeded()`.
     */
    previousRunSessions(): ClaudeSessionRecord[] {
        if (!this.previousRunId) return []
        const prev = this.previousRunId
        return this.list().filter((s) => !s.closed && s.runId === prev)
    }

    /**
     * All non-closed sessions across both Active and Previous run. Used by
     * `resumeAll()` so auto-resume on launch keeps its pre-three-buckets
     * behaviour: pick up everything that wasn't explicitly closed.
     */
    openSessions(): ClaudeSessionRecord[] {
        return this.list().filter((s) => !s.closed)
    }

    /**
     * Resume only sessions that were still open when Tabby last ran. Used by
     * the launch hook when `autoResumeOnLaunch` is on — we deliberately do
     * not replay the full history, which for heavy Claude Code users can be
     * dozens of sessions.
     */
    async resumeAll(): Promise<number> {
        const sessions = this.openSessions()
        let opened = 0
        for (const s of sessions) {
            const result = await this.resumeSession(s)
            if (result.ok) opened++
        }
        return opened
    }

    // ── File I/O helpers ───────────────────────────────────────────────

    private readFile(): SessionsFile {
        try {
            if (!fs.existsSync(SESSIONS_FILE)) {
                return { version: 1, sessions: [] }
            }
            const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8')
            const parsed = JSON.parse(raw)
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
                return { version: 1, sessions: [] }
            }
            return parsed as SessionsFile
        } catch (err) {
            console.warn('[claude-status] sessions file unreadable, resetting:', err)
            return { version: 1, sessions: [] }
        }
    }

    private writeFile(file: SessionsFile): void {
        try {
            fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true })
            // Atomic write: serialise to a temp file then rename over the
            // target. A reader (another window, or the settings tab's 5s
            // refresh) therefore always sees either the complete old file or
            // the complete new one — never a half-written, unparseable file
            // that JSON.parse would reject and treat as an empty session list.
            // The `.tmp-<pid>` suffix keeps concurrent writers from colliding
            // on the same temp path.
            const tmp = `${SESSIONS_FILE}.tmp-${process.pid}`
            fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
            fs.renameSync(tmp, SESSIONS_FILE)
        } catch (err) {
            console.warn('[claude-status] sessions file write failed:', err)
        }
    }

    /** Drop records older than the retention window. Returns true if anything
     *  was removed so callers can persist the change. */
    private pruneInPlace(file: SessionsFile, retentionDays: number): boolean {
        if (!retentionDays || retentionDays <= 0) return false
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
        const before = file.sessions.length
        file.sessions = file.sessions.filter((s) => {
            // Treat a missing/NaN lastSeen as "recently seen" rather than
            // pruning it: `undefined >= cutoff` is false, which would silently
            // delete a record (possibly an active session) whose lastSeen got
            // corrupted or was never set. Fall back to firstSeen, then now.
            const seen =
                typeof s.lastSeen === 'number' && Number.isFinite(s.lastSeen)
                    ? s.lastSeen
                    : (s.firstSeen ?? Date.now())
            return seen >= cutoff
        })
        return file.sessions.length !== before
    }
}
