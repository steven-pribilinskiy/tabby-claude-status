import { Injectable, Optional } from '@angular/core'
import { NotificationsService } from 'tabby-core'
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
    constructor(
        private configService: ClaudeStatusConfigService,
        @Optional() private terminalService: TerminalService | null,
        @Optional() private notifications: NotificationsService | null,
    ) {}

    /**
     * Record (or update) a session observation. No-op when session restore
     * is disabled, so the sessions file stays empty for opted-out users.
     */
    record(sessionId: string, cwd: string, title?: string): void {
        if (!sessionId || !cwd) return
        const cfg = this.configService.getSessionRestoreConfig()
        if (!cfg.enabled) return

        const file = this.readFile()
        const now = Date.now()
        const existing = file.sessions.find(s => s.sessionId === sessionId)
        if (existing) {
            existing.cwd = cwd
            if (title) existing.title = title
            existing.lastSeen = now
        } else {
            file.sessions.push({
                sessionId,
                cwd,
                title,
                firstSeen: now,
                lastSeen: now,
            })
        }
        this.pruneInPlace(file, cfg.retentionDays)
        this.writeFile(file)
    }

    /**
     * Return sessions that are still within the retention window, newest first.
     */
    list(): ClaudeSessionRecord[] {
        const cfg = this.configService.getSessionRestoreConfig()
        const file = this.readFile()
        this.pruneInPlace(file, cfg.retentionDays)
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
        const command = extra
            ? `claude --resume ${session.sessionId} ${extra}\r`
            : `claude --resume ${session.sessionId}\r`

        try {
            const tab = await this.terminalService.openTab(undefined, session.cwd)
            if (!tab) return false
            // Wait for the pty to be ready for input. Empirically, shells
            // drop very-early input on the floor; 800ms is generous but
            // still snappier than the user could click.
            setTimeout(() => {
                try { tab.sendInput(command) } catch (err) {
                    console.error('[claude-status] sendInput failed:', err)
                }
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
     * Resume every persisted session that's still within retention. Used by
     * the launch hook when `autoResumeOnLaunch` is on.
     */
    async resumeAll(): Promise<number> {
        const sessions = this.list()
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
