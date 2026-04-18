import { Injectable } from '@angular/core'
import { AppService } from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'
import { StatusParserService } from '../services/statusParserService'
import { ClaudeStatusConfigService } from '../services/configService'
import { AudioService } from '../services/audioService'
import { ClaudeStatusName, ClaudeStatusEvent, HOOK_EVENT_STATUS_MAP } from '../interfaces/types'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const STATUS_FILE = path.join(os.tmpdir(), 'tabby-claude-status.json')

@Injectable()
export class ClaudeStatusDecorator extends TerminalDecorator {
    private resetTimers: Map<BaseTerminalTabComponent, ReturnType<typeof setTimeout>> = new Map()
    private currentStatus: Map<BaseTerminalTabComponent, ClaudeStatusName> = new Map()
    private terminals: Set<BaseTerminalTabComponent> = new Set()
    private terminalPids: Map<BaseTerminalTabComponent, number> = new Map()
    private sessionTerminals: Map<string, BaseTerminalTabComponent> = new Map()
    private fileWatcher: fs.FSWatcher | null = null
    private pollInterval: ReturnType<typeof setInterval> | null = null
    private lastFileTs = 0

    constructor(
        private parser: StatusParserService,
        private configService: ClaudeStatusConfigService,
        private audioService: AudioService,
        private app: AppService,
    ) {
        super()
        this.configService.debug('ClaudeStatusDecorator initialized')

        if (this.configService.clearOnFocus) {
            this.app.activeTabChange$.subscribe(tab => {
                for (const terminal of this.terminals) {
                    if (terminal === tab || (terminal as any).parent === tab) {
                        this.clearStatus(terminal)
                    }
                }
            })
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

        // Also listen for escape sequences (e.g. manual printf testing)
        this.subscribeUntilDetached(
            terminal,
            terminal.output$.subscribe((data: string) => {
                this.handleOutput(terminal, data)
            }),
        )
    }

    detach(terminal: BaseTerminalTabComponent): void {
        this.clearResetTimer(terminal)
        this.currentStatus.delete(terminal)
        this.terminalPids.delete(terminal)
        this.terminals.delete(terminal)

        // Clean up session mappings pointing to this terminal
        for (const [session, t] of this.sessionTerminals) {
            if (t === terminal) this.sessionTerminals.delete(session)
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
                    this.configService.debug('Cached terminal PID:', pid)
                    return
                }
            } catch (_) { /* retry */ }
            await new Promise(r => setTimeout(r, 1000))
        }
    }

    // ── File watcher (primary mechanism) ───────────────────────────

    private startFileWatcher(): void {
        try {
            if (!fs.existsSync(STATUS_FILE)) {
                fs.writeFileSync(STATUS_FILE, '{}')
            }

            this.fileWatcher = fs.watch(STATUS_FILE, { persistent: false }, () => {
                this.handleFileChange()
            })

            this.fileWatcher.on('error', () => {
                this.fileWatcher = null
                this.startPolling()
            })

            this.configService.debug('File watcher started:', STATUS_FILE)
        } catch (_) {
            this.startPolling()
        }
    }

    private startPolling(): void {
        this.pollInterval = setInterval(() => this.handleFileChange(), 500)
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

    private handleFileChange(): void {
        try {
            const raw = fs.readFileSync(STATUS_FILE, 'utf-8')
            if (!raw || raw === '{}') return

            const data = JSON.parse(raw)
            if (!data.ts || !data.event) return

            if (data.ts <= this.lastFileTs) return
            this.lastFileTs = data.ts

            if (Date.now() - data.ts > 10000) return

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

            // Find the right terminal for this event
            const terminal = this.findTerminalForEvent(data)
            if (terminal) {
                this.handleStatusEvent(terminal, event)
            } else {
                // Fallback: update all terminals
                for (const t of this.terminals) {
                    this.handleStatusEvent(t, event)
                }
            }
        } catch (_) {
            // File might be mid-write
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
                'PID match: ancestors=', ancestors.join(','),
                '| cached terminal PIDs=', cachedPids.join(','),
            )
            for (const [terminal, cachedPid] of this.terminalPids) {
                if (ancestors.includes(cachedPid)) {
                    if (session) this.sessionTerminals.set(session, terminal)
                    this.configService.debug('PID match: MATCHED terminal PID', cachedPid)
                    return terminal
                }
            }
            this.configService.debug('PID match: no match found, falling back to all terminals')
        } else {
            this.configService.debug(
                'PID match: skipped — ancestors=', ancestors.length,
                'cached count=', this.terminalPids.size,
            )
        }

        return null
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
            this.handleStatusEvent(terminal, event)
        }
    }

    // ── Status handling ────────────────────────────────────────────

    private handleStatusEvent(terminal: BaseTerminalTabComponent, event: ClaudeStatusEvent): void {
        const current = this.currentStatus.get(terminal)
        if (event.status === 'working' && current === 'question') {
            return
        }

        this.clearResetTimer(terminal)
        this.currentStatus.set(terminal, event.status)

        let newColor: string | null = null
        switch (event.status) {
            case 'working':
                newColor = this.configService.getColor('working')
                break
            case 'question':
                newColor = this.configService.getColor('question')
                break
            case 'done':
                newColor = this.configService.getColor('done')
                this.scheduleAutoReset(terminal)
                break
            case 'error':
                newColor = this.configService.getColor('error')
                break
            case 'idle':
                newColor = null
                break
        }

        // Only update color if it actually changed — avoids triggering
        // Angular change detection and potential scroll-to-top from xterm resize
        if (terminal.color !== newColor) {
            this.setColorWithScrollGuard(terminal, newColor)
        }

        this.audioService.speak(event.status)
    }

    private setColorWithScrollGuard(terminal: BaseTerminalTabComponent, color: string | null): void {
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
        if (terminal.color !== null) {
            this.setColorWithScrollGuard(terminal, null)
        }
    }
}
