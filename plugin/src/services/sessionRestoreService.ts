import { Injectable, Optional } from '@angular/core'
import { NotificationsService, ProfilesService } from 'tabby-core'
import { TerminalService } from 'tabby-local'
import { ClaudeStatusConfigService } from './configService'
import { ClaudeSessionRecord } from '../interfaces/types'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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
    private liveProfileResolver: (sessionId: string) => { id?: string; name?: string; type?: string } | undefined = () => undefined

    constructor(
        private configService: ClaudeStatusConfigService,
        @Optional() private terminalService: TerminalService | null,
        @Optional() private notifications: NotificationsService | null,
        @Optional() private profilesService: ProfilesService | null,
    ) {}

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
            return t && t.trim() ? t : undefined
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
        const existing = file.sessions.find(s => s.sessionId === sessionId)
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
        const existing = file.sessions.find(s => s.sessionId === sessionId)
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
        this.pruneInPlace(file, cfg.retentionDays)
        let dirty = false
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
        file.sessions = file.sessions.filter(s => s.sessionId !== sessionId)
        this.writeFile(file)
    }

    /**
     * Open a new Tabby tab at the session's `cwd` and type `claude --resume <id>`.
     * Returns true if a tab was opened.
     */
    async resumeSession(session: ClaudeSessionRecord): Promise<boolean> {
        if (!this.terminalService) {
            this.notifications?.error?.(
                'Session restore unavailable — the tabby-local plugin is not loaded.',
            )
            return false
        }

        const cfg = this.configService.getSessionRestoreConfig()
        const extra = cfg.extraArgs.trim()
        const resumeCmd = extra
            ? `claude --resume ${session.sessionId} ${extra}\r`
            : `claude --resume ${session.sessionId}\r`
        // Always send an explicit `cd "<cwd>"` first. Tabby's openTab(undefined,
        // cwd) does not reliably set cwd for WSL-backed profiles (the shell
        // ends up in the profile's default dir), and `claude --resume` reads
        // its session cache from the current cwd — wrong cwd → "No
        // conversation found with session ID …".
        const cdCmd = `cd ${this.shellQuote(session.cwd)}\r`

        // Clamp to a sane range. 0 is allowed (user opt-out) but step is 0.1s
        // in the UI so the smallest non-zero value is 100ms.
        const delaySec = Math.max(0, Math.min(cfg.resumeCdDelaySec ?? 1.2, 10))
        const cdDelayMs = Math.round(delaySec * 1000)

        const profile = await this.resolveProfile(session)

        try {
            const tab = await this.terminalService.openTab(profile, session.cwd)
            if (!tab) return false
            // First wait for the pty + shell to be ready for input. 800ms is
            // empirically generous but still faster than a click.
            setTimeout(() => {
                try { tab.sendInput(cdCmd) } catch (err) {
                    console.error('[claude-status] cd sendInput failed:', err)
                    return
                }
                setTimeout(() => {
                    try { tab.sendInput(resumeCmd) } catch (err) {
                        console.error('[claude-status] resume sendInput failed:', err)
                    }
                }, cdDelayMs)
            }, 800)
            return true
        } catch (err) {
            console.error('[claude-status] resumeSession failed:', err)
            this.notifications?.error?.(
                `Failed to resume Claude session: ${(err as Error).message}`,
            )
            return false
        }
    }

    /**
     * Quote a path for `cd` in the target shell. Both bash and PowerShell
     * accept double quotes around a path; the only character we have to escape
     * is the double-quote itself (rare in cwds, but cheap to handle).
     */
    private shellQuote(p: string): string {
        if (!p) return '""'
        return `"${p.replace(/"/g, '\\"')}"`
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
        if (!session.profileId && !session.profileType) return undefined
        try {
            const profiles = await this.profilesService.getProfiles()
            if (session.profileId) {
                const exact = profiles.find(p => p.id === session.profileId)
                if (exact) return exact
            }
            // Same id no longer exists — fall back to any profile of the same
            // type so a Windows session at least lands in a Windows-capable
            // shell rather than the WSL default.
            if (session.profileType) {
                const sameType = profiles.find(p => p.type === session.profileType)
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
            console.warn(
                '[claude-status] Could not resolve profile for session',
                session.sessionId,
                '(stored id:', session.profileId, ') — using default.',
            )
            return undefined
        } catch (err) {
            console.warn('[claude-status] resolveProfile failed:', err)
            return undefined
        }
    }

    /**
     * Sessions that were open at the time Tabby last ran — i.e. ones that
     * never received a `SessionEnd` hook and haven't been dismissed by the
     * user. This is what auto-resume should replay; `list()` returns the
     * whole history (including closed) for the settings table.
     */
    openSessions(): ClaudeSessionRecord[] {
        return this.list().filter(s => !s.closed)
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
            const ok = await this.resumeSession(s)
            if (ok) opened++
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
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(file, null, 2), 'utf-8')
        } catch (err) {
            console.warn('[claude-status] sessions file write failed:', err)
        }
    }

    private pruneInPlace(file: SessionsFile, retentionDays: number): void {
        if (!retentionDays || retentionDays <= 0) return
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
        file.sessions = file.sessions.filter(s => s.lastSeen >= cutoff)
    }
}
