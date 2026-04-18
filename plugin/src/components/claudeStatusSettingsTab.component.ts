import { Component, OnInit } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { AudioService } from '../services/audioService'
import { DEFAULT_AUDIO_CONFIG, DEFAULT_CONFIG } from '../interfaces/types'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync } from 'child_process'

const HOOK_EVENTS = [
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'Notification', 'Stop',
    'UserPromptSubmit', 'PermissionRequest',
    'SessionStart', 'SessionEnd',
]

@Component({
    template: `
        <div class="container-fluid">
            <h3>Claude Status</h3>

            <!-- Enable plugin -->
            <div class="form-group mb-3">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.enabled"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Enable plugin</label>
            </div>

            <hr />

            <!-- Tab Colors -->
            <h5>Tab Colors</h5>
            <div class="row mb-3">
                <div class="col-3" *ngFor="let status of colorStatuses">
                    <label class="form-label text-capitalize">{{status}}</label>
                    <input
                        type="color"
                        class="form-control form-control-color"
                        [ngModel]="getColor(status)"
                        (ngModelChange)="setColor(status, $event)"
                    />
                </div>
            </div>

            <div class="form-group mb-3">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.clearOnFocus"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Clear tab color when tab is focused</label>
            </div>

            <div class="form-group mb-3">
                <label class="form-label">Auto-reset "done" after (ms, 0 = disabled)</label>
                <input
                    type="number"
                    class="form-control"
                    style="max-width: 200px"
                    [(ngModel)]="config.store.claudeStatus.doneAutoResetMs"
                    (ngModelChange)="save()"
                    min="0"
                    step="1000"
                />
            </div>

            <hr />

            <!-- Audio / TTS -->
            <h5>Audio / TTS</h5>

            <div class="form-group mb-3">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.audio.enabled"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Enable audio notifications</label>
            </div>

            <div *ngIf="config.store.claudeStatus.audio.enabled">
                <div class="form-group mb-3">
                    <label class="form-label">Voice</label>
                    <select
                        class="form-control"
                        style="max-width: 300px"
                        [(ngModel)]="config.store.claudeStatus.audio.voiceName"
                        (ngModelChange)="save()"
                    >
                        <option value="">System Default</option>
                        <option *ngFor="let v of voices" [value]="v.name">{{v.name}} ({{v.lang}})</option>
                    </select>
                </div>

                <div class="row mb-3">
                    <div class="col-4">
                        <label class="form-label">Volume ({{config.store.claudeStatus.audio.volume | number:'1.1-1'}})</label>
                        <input type="range" class="form-range" min="0" max="1" step="0.1"
                            [(ngModel)]="config.store.claudeStatus.audio.volume" (ngModelChange)="save()" />
                    </div>
                    <div class="col-4">
                        <label class="form-label">Rate ({{config.store.claudeStatus.audio.rate | number:'1.1-1'}})</label>
                        <input type="range" class="form-range" min="0.5" max="2" step="0.1"
                            [(ngModel)]="config.store.claudeStatus.audio.rate" (ngModelChange)="save()" />
                    </div>
                    <div class="col-4">
                        <label class="form-label">Pitch ({{config.store.claudeStatus.audio.pitch | number:'1.1-1'}})</label>
                        <input type="range" class="form-range" min="0" max="2" step="0.1"
                            [(ngModel)]="config.store.claudeStatus.audio.pitch" (ngModelChange)="save()" />
                    </div>
                </div>

                <div class="form-group mb-3">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.audio.systemBeep"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="ms-2">Play system beep alongside TTS</label>
                </div>

                <!-- Status Phrases -->
                <h6>Status Phrases</h6>
                <p class="text-muted small">Leave blank to skip TTS for that status.</p>
                <div class="row mb-3" *ngFor="let status of phraseStatuses">
                    <div class="col-2">
                        <label class="form-label text-capitalize">{{status}}</label>
                    </div>
                    <div class="col-6">
                        <input
                            type="text"
                            class="form-control"
                            [(ngModel)]="config.store.claudeStatus.audio.statusTexts[status]"
                            (ngModelChange)="save()"
                        />
                    </div>
                    <div class="col-2">
                        <button class="btn btn-sm btn-outline-info" (click)="testSpeak(status)">Test</button>
                    </div>
                </div>
            </div>

            <hr />

            <!-- Hook Setup -->
            <h5>Claude Code Hook Setup</h5>
            <p class="text-muted small">
                Configures Claude Code to send status events to this plugin via hooks.
                This writes to <code>~/.claude/settings.json</code>.
            </p>

            <div class="d-flex align-items-center gap-3 mb-3">
                <button class="btn btn-primary" (click)="setupHooks()">
                    Setup Claude Hooks
                </button>
                <span *ngIf="hooksStatus === 'ok'" class="text-success">Hooks configured</span>
                <span *ngIf="hooksStatus === 'missing'" class="text-danger">Hooks not configured</span>
                <span *ngIf="hooksStatus === 'error'" class="text-warning">Could not check hooks</span>
            </div>

            <hr />

            <!-- Diagnostics -->
            <h5>Diagnostics</h5>
            <table class="table table-sm table-borderless" style="max-width: 600px">
                <tbody>
                    <tr>
                        <td class="text-muted" style="width: 120px">Platform</td>
                        <td><code>{{osInfo.platform}} {{osInfo.arch}}</code></td>
                    </tr>
                    <tr>
                        <td class="text-muted">OS Version</td>
                        <td><code>{{osInfo.release}}</code></td>
                    </tr>
                    <tr>
                        <td class="text-muted">Node.js</td>
                        <td>
                            <span *ngIf="nodeInfo.path" class="text-success">
                                {{nodeInfo.version}} &mdash; <code>{{nodeInfo.path}}</code>
                            </span>
                            <span *ngIf="!nodeInfo.path" class="text-danger">
                                Not found on PATH
                            </span>
                        </td>
                    </tr>
                    <tr>
                        <td class="text-muted">Hook script</td>
                        <td>
                            <span *ngIf="hookJsExists" class="text-success">
                                <code>{{hookJsPath}}</code>
                            </span>
                            <span *ngIf="!hookJsExists" class="text-danger">
                                <code>{{hookJsPath}}</code> (NOT FOUND)
                            </span>
                        </td>
                    </tr>
                    <tr>
                        <td class="text-muted">Temp file</td>
                        <td><code>{{tempFilePath}}</code></td>
                    </tr>
                </tbody>
            </table>

            <div *ngIf="!nodeInfo.path" class="alert alert-warning mt-2" style="max-width: 600px">
                <strong>Node.js not detected on Tabby's PATH.</strong>
                If you use nvm or fnm, Tabby launched from a desktop shortcut may not
                inherit your shell's PATH. Hooks will still work because Claude Code
                provides its own Node.js runtime.
            </div>

            <hr />

            <!-- Debug -->
            <div class="form-group mb-3">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.debugMode"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Debug mode (logs to DevTools console)</label>
            </div>
        </div>
    `,
})
export class ClaudeStatusSettingsTabComponent implements OnInit {
    colorStatuses = ['working', 'question', 'done', 'error'] as const
    phraseStatuses = ['done', 'question', 'error', 'working', 'idle'] as const
    voices: SpeechSynthesisVoice[] = []
    hooksStatus: 'ok' | 'missing' | 'error' | '' = ''

    nodeInfo: { path: string | null; version: string | null; error: string | null } = {
        path: null, version: null, error: null,
    }
    osInfo = {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
    }
    hookJsPath = ''
    hookJsExists = false
    tempFilePath = path.join(os.tmpdir(), 'tabby-claude-status.json')

    constructor(
        public config: ConfigService,
        private audioService: AudioService,
    ) {}

    ngOnInit(): void {
        // Ensure config defaults exist in store
        if (!this.config.store.claudeStatus) {
            this.config.store.claudeStatus = { ...DEFAULT_CONFIG }
        }
        if (!this.config.store.claudeStatus.colors) {
            this.config.store.claudeStatus.colors = { ...DEFAULT_CONFIG.colors }
        }
        if (!this.config.store.claudeStatus.audio) {
            this.config.store.claudeStatus.audio = { ...DEFAULT_AUDIO_CONFIG }
        }
        if (!this.config.store.claudeStatus.audio.statusTexts) {
            this.config.store.claudeStatus.audio.statusTexts = { ...DEFAULT_AUDIO_CONFIG.statusTexts }
        }

        // Load voices (may need a small delay for browser to populate)
        this.voices = this.audioService.getVoices()
        if (this.voices.length === 0 && typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.onvoiceschanged = () => {
                this.voices = this.audioService.getVoices()
            }
        }

        // Detect environment
        this.hookJsPath = this.getHookJsPath()
        this.hookJsExists = fs.existsSync(this.hookJsPath)
        this.nodeInfo = this.detectNodePath()

        this.checkHooks()
    }

    getColor(status: string): string {
        return this.config.store.claudeStatus.colors[status] || (DEFAULT_CONFIG.colors as any)[status]
    }

    setColor(status: string, color: string): void {
        this.config.store.claudeStatus.colors[status] = color
        this.save()
    }

    save(): void {
        this.config.save()
    }

    testSpeak(status: string): void {
        const audio = this.config.store.claudeStatus.audio
        const text = audio.statusTexts[status]
        if (text) {
            this.audioService.speakText(text, audio)
        }
    }

    // ── Node.js detection ────────────────────────────────────────────

    private detectNodePath(): { path: string | null; version: string | null; error: string | null } {
        try {
            const version = execSync('node --version', {
                encoding: 'utf8',
                timeout: 5000,
                windowsHide: true,
            }).trim()

            let nodePath: string | null = null
            try {
                const whichCmd = process.platform === 'win32' ? 'where node' : 'which node'
                nodePath = execSync(whichCmd, {
                    encoding: 'utf8',
                    timeout: 5000,
                    windowsHide: true,
                }).trim().split(/\r?\n/)[0] // `where` on Windows may return multiple lines
            } catch (_) {
                // `which`/`where` failed but `node --version` worked — node is available but path unknown
            }

            return { path: nodePath, version, error: null }
        } catch (e: any) {
            return { path: null, version: null, error: e.message || 'node not found' }
        }
    }

    // ── Hook setup ──────────────────────────────────────────────────

    private getHookJsPath(): string {
        try {
            const pluginRoot = path.resolve(__dirname, '..')
            const hookPath = path.join(pluginRoot, 'hook.js')
            if (fs.existsSync(hookPath)) {
                return hookPath
            }
        } catch (_) {
            // ignore
        }
        return path.resolve(__dirname, 'hook.js')
    }

    checkHooks(): void {
        try {
            const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
            if (!fs.existsSync(settingsPath)) {
                this.hooksStatus = 'missing'
                return
            }
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
            const hooks = settings.hooks || {}
            const hookJsPath = this.hookJsPath || this.getHookJsPath()

            // Match on hook.js path presence in command, not exact string.
            // This handles both old `node "path"` and new `"/abs/node" "path"` formats.
            const allConfigured = HOOK_EVENTS.every(event => {
                const matcherGroups: any[] = hooks[event] || []
                return matcherGroups.some((group: any) => {
                    const innerHooks: any[] = group.hooks || []
                    return innerHooks.some((h: any) => h.type === 'command' && h.command.includes(hookJsPath))
                })
            })

            this.hooksStatus = allConfigured ? 'ok' : 'missing'
        } catch (_) {
            this.hooksStatus = 'error'
        }
    }

    setupHooks(): void {
        try {
            const claudeDir = path.join(os.homedir(), '.claude')
            if (!fs.existsSync(claudeDir)) {
                fs.mkdirSync(claudeDir, { recursive: true })
            }

            const settingsPath = path.join(claudeDir, 'settings.json')
            let settings: any = {}
            if (fs.existsSync(settingsPath)) {
                settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
            }

            if (!settings.hooks) {
                settings.hooks = {}
            }

            const hookJsPath = this.hookJsPath || this.getHookJsPath()

            // Use absolute Node.js path when available, fall back to bare `node`
            const nodeCmd = this.nodeInfo.path ? `"${this.nodeInfo.path}"` : 'node'
            const hookCmd = { type: 'command', command: `${nodeCmd} "${hookJsPath}"` }

            // New format: hooks[event] = [ { hooks: [ { type, command } ] } ]
            for (const event of HOOK_EVENTS) {
                if (!settings.hooks[event]) {
                    settings.hooks[event] = []
                }
                const matcherGroups: any[] = settings.hooks[event]

                // Find existing matcher group that contains our hook.js command
                let found = false
                for (const group of matcherGroups) {
                    if (!group.hooks) continue
                    const idx = group.hooks.findIndex(
                        (h: any) => h.type === 'command' && h.command.includes('hook.js'),
                    )
                    if (idx >= 0) {
                        group.hooks[idx] = hookCmd
                        found = true
                        break
                    }
                }

                if (!found) {
                    // Add a new matcher group (no matcher = match all)
                    matcherGroups.push({ hooks: [hookCmd] })
                }
            }

            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
            this.hooksStatus = 'ok'
        } catch (e) {
            console.error('[claude-status] Failed to setup hooks:', e)
            this.hooksStatus = 'error'
        }
    }
}
