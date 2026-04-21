import { Component, OnInit } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { AudioService } from '../services/audioService'
import {
    ClaudeSessionRecord,
    DEFAULT_AUDIO_CONFIG,
    DEFAULT_CONFIG,
    DEFAULT_DISPLAY_CONFIG,
    DEFAULT_EMOJI_MAP,
    DEFAULT_SESSION_RESTORE_CONFIG,
    TtsBackendId,
} from '../interfaces/types'
import { TtsBackend, TtsVoice } from '../services/tts/tts.interface'
import { SessionRestoreService } from '../services/sessionRestoreService'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PLUGIN_PACKAGE = require('../../package.json') as { version: string; homepage?: string }

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

interface BackendOption {
    id: TtsBackendId
    label: string
    available: boolean | null  // null = still probing
    voices: TtsVoice[]
}

@Component({
    template: `
        <div class="container-fluid">
            <div class="d-flex align-items-baseline gap-2 mb-2">
                <h3 class="mb-0">Claude Status</h3>
                <span class="badge text-bg-secondary">v{{pluginVersion}}</span>
                <a *ngIf="pluginHomepage"
                   class="small text-muted ms-2"
                   [attr.href]="pluginHomepage"
                   (click)="openHomepage($event)">
                    {{pluginHomepage}}
                </a>
            </div>

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

            <!-- Display surfaces -->
            <h5>Display surfaces</h5>
            <p class="text-muted small">
                Each surface updates independently when Claude status changes.
                Leave off the ones you don't want.
            </p>

            <div class="form-group mb-2">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.display.colorBorder"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Tab bottom border colour</label>
            </div>

            <div class="form-group mb-2">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.display.titleEmoji"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Tab title emoji prefix</label>
            </div>

            <div *ngIf="config.store.claudeStatus.display.titleEmoji" class="row mb-2 ms-3" style="max-width: 560px">
                <div class="col-4 mb-1" *ngFor="let status of emojiStatuses">
                    <label class="form-label text-capitalize small mb-1">{{status}}</label>
                    <input
                        type="text"
                        class="form-control form-control-sm"
                        [ngModel]="getEmoji(status)"
                        (ngModelChange)="setEmoji(status, $event)"
                        maxlength="4"
                    />
                </div>
            </div>

            <div class="form-group mb-2">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.display.progressBar"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Indeterminate progress bar while <em>working</em></label>
            </div>

            <div class="form-group mb-2">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.display.activityMarker"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Activity marker dot on <em>question</em> / <em>error</em></label>
            </div>

            <div class="form-group mb-2">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.display.taskbarFlash"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Flash taskbar when Tabby is unfocused</label>
            </div>

            <div class="form-group mb-3">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.display.taskbarOverlay"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Taskbar icon overlay per status</label>
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
                    <label class="form-label">TTS backend</label>
                    <select
                        class="form-control"
                        style="max-width: 360px"
                        [ngModel]="config.store.claudeStatus.audio.backend"
                        (ngModelChange)="onBackendChange($event)"
                    >
                        <option *ngFor="let b of backends" [value]="b.id">
                            {{b.label}}
                            <ng-container *ngIf="b.available === true">&nbsp;✓</ng-container>
                            <ng-container *ngIf="b.available === false">&nbsp;✗</ng-container>
                        </option>
                    </select>
                    <div class="form-text">
                        Web Speech is always available and is the fallback if the selected backend fails.
                    </div>
                </div>

                <div class="form-group mb-3">
                    <label class="form-label">Voice</label>
                    <select
                        class="form-control"
                        style="max-width: 500px"
                        [ngModel]="getSelectedVoiceId()"
                        (ngModelChange)="onVoiceChange($event)"
                    >
                        <option value="">(default for this backend)</option>
                        <option *ngFor="let v of currentVoices" [value]="v.id">{{v.label}}</option>
                    </select>
                    <div *ngIf="voicesLoading" class="form-text text-muted">Loading voices…</div>
                    <div *ngIf="!voicesLoading && currentVoices.length === 0" class="form-text text-warning">
                        No voices available for this backend. Check availability indicator above.
                    </div>
                </div>

                <div *ngIf="currentBackend?.id === 'piper'" class="row mb-3">
                    <div class="col-6">
                        <label class="form-label">Piper executable</label>
                        <input type="text" class="form-control"
                            [(ngModel)]="config.store.claudeStatus.audio.piperExePath"
                            (ngModelChange)="save()"
                            placeholder="C:\\tools\\piper\\piper.exe" />
                    </div>
                    <div class="col-6">
                        <label class="form-label">Piper model (.onnx)</label>
                        <input type="text" class="form-control"
                            [(ngModel)]="config.store.claudeStatus.audio.piperModelPath"
                            (ngModelChange)="save()"
                            placeholder="C:\\tools\\piper\\en_US-lessac-medium.onnx" />
                    </div>
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

            <!-- Session restore -->
            <h5>Session restore</h5>
            <p class="text-muted small">
                Persist each Claude Code session (cwd + session id) so you can
                reopen them after closing Tabby. Opt-in — nothing is written
                to disk until this is enabled.
            </p>

            <div class="form-group mb-2">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.sessionRestore.enabled"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="ms-2">Enable session tracking</label>
            </div>

            <div *ngIf="config.store.claudeStatus.sessionRestore.enabled">
                <div class="form-group mb-2 ms-3">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.sessionRestore.autoResumeOnLaunch"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="ms-2">
                        Auto-resume all saved sessions on Tabby launch
                    </label>
                </div>

                <div class="row mb-3 ms-3">
                    <div class="col-4">
                        <label class="form-label">Retention (days)</label>
                        <input
                            type="number"
                            class="form-control form-control-sm"
                            min="1" max="90" step="1"
                            [(ngModel)]="config.store.claudeStatus.sessionRestore.retentionDays"
                            (ngModelChange)="save()"
                        />
                    </div>
                    <div class="col-8">
                        <label class="form-label">Extra args (appended to <code>claude --resume &lt;id&gt;</code>)</label>
                        <input
                            type="text"
                            class="form-control form-control-sm"
                            placeholder="e.g. --model opus"
                            [(ngModel)]="config.store.claudeStatus.sessionRestore.extraArgs"
                            (ngModelChange)="save()"
                        />
                    </div>
                </div>

                <div class="d-flex align-items-center gap-2 mb-2 ms-3">
                    <button class="btn btn-sm btn-outline-primary" (click)="resumeAllSessions()">
                        Resume all now
                    </button>
                    <button class="btn btn-sm btn-outline-secondary" (click)="refreshSessions()">
                        Refresh list
                    </button>
                    <span class="text-muted small">{{sessions.length}} saved session(s)</span>
                </div>

                <table *ngIf="sessions.length > 0" class="table table-sm ms-3" style="max-width: 900px">
                    <thead>
                        <tr>
                            <th style="width: 42%">Working directory</th>
                            <th>Session id</th>
                            <th>Last seen</th>
                            <th style="width: 140px"></th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr *ngFor="let s of sessions">
                            <td>
                                <code class="small">{{s.cwd}}</code>
                                <div *ngIf="s.title" class="text-muted small">{{s.title}}</div>
                            </td>
                            <td><code class="small">{{s.sessionId}}</code></td>
                            <td class="small">{{formatTs(s.lastSeen)}}</td>
                            <td>
                                <button class="btn btn-sm btn-outline-success"
                                        (click)="resumeSession(s)">Resume</button>
                                <button class="btn btn-sm btn-outline-danger ms-1"
                                        (click)="forgetSession(s)">✕</button>
                            </td>
                        </tr>
                    </tbody>
                </table>

                <div *ngIf="sessions.length === 0" class="ms-3 text-muted small">
                    No sessions recorded yet. Run <code>claude</code> in any Tabby tab — this list populates as hook events fire.
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
                        <td class="text-muted" style="width: 120px">Plugin version</td>
                        <td><code>{{pluginVersion}}</code></td>
                    </tr>
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
    emojiStatuses = ['working', 'question', 'done', 'error', 'idle'] as const
    hooksStatus: 'ok' | 'missing' | 'error' | '' = ''

    backends: BackendOption[] = []
    voicesLoading = false
    pluginVersion = PLUGIN_PACKAGE.version
    pluginHomepage = PLUGIN_PACKAGE.homepage || ''
    sessions: ClaudeSessionRecord[] = []

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
        private sessionRestore: SessionRestoreService,
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
        if (!this.config.store.claudeStatus.audio.voicesByBackend) {
            this.config.store.claudeStatus.audio.voicesByBackend = {}
        }
        if (!this.config.store.claudeStatus.audio.backend) {
            this.config.store.claudeStatus.audio.backend = DEFAULT_AUDIO_CONFIG.backend
        }
        if (!this.config.store.claudeStatus.display) {
            this.config.store.claudeStatus.display = { ...DEFAULT_DISPLAY_CONFIG }
        }
        if (!this.config.store.claudeStatus.display.titleEmojiMap) {
            this.config.store.claudeStatus.display.titleEmojiMap = { ...DEFAULT_EMOJI_MAP }
        }
        if (!this.config.store.claudeStatus.sessionRestore) {
            this.config.store.claudeStatus.sessionRestore = { ...DEFAULT_SESSION_RESTORE_CONFIG }
        }
        this.refreshSessions()

        // Seed backend list (availability + voice probes are kicked off async)
        this.backends = this.audioService.listAllBackends().map(b => ({
            id: b.id,
            label: b.label,
            available: null,
            voices: [],
        }))
        for (const entry of this.backends) this.probeBackend(entry)

        // Handle Web Speech's late-loading voice list
        if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.onvoiceschanged = () => {
                const ws = this.backends.find(b => b.id === 'webspeech')
                if (ws) this.probeBackend(ws)
            }
        }

        // Detect environment
        this.hookJsPath = this.getHookJsPath()
        this.hookJsExists = fs.existsSync(this.hookJsPath)
        this.nodeInfo = this.detectNodePath()

        this.checkHooks()
    }

    private async probeBackend(entry: BackendOption): Promise<void> {
        const backend = this.audioService.getBackend(entry.id)
        try {
            entry.available = await backend.isAvailable()
        } catch {
            entry.available = false
        }
        if (entry.available) {
            try {
                entry.voices = await backend.listVoices()
            } catch {
                entry.voices = []
            }
        }
        if (this.currentBackend?.id === entry.id) {
            this.voicesLoading = false
        }
    }

    get currentBackend(): BackendOption | undefined {
        const id = this.config.store.claudeStatus?.audio?.backend as TtsBackendId
        return this.backends.find(b => b.id === id)
    }

    get currentVoices(): TtsVoice[] {
        return this.currentBackend?.voices || []
    }

    getColor(status: string): string {
        return this.config.store.claudeStatus.colors[status] || (DEFAULT_CONFIG.colors as any)[status]
    }

    setColor(status: string, color: string): void {
        this.config.store.claudeStatus.colors[status] = color
        this.save()
    }

    getEmoji(status: string): string {
        return this.config.store.claudeStatus.display.titleEmojiMap?.[status] ?? (DEFAULT_EMOJI_MAP as any)[status]
    }

    setEmoji(status: string, value: string): void {
        if (!this.config.store.claudeStatus.display.titleEmojiMap) {
            this.config.store.claudeStatus.display.titleEmojiMap = { ...DEFAULT_EMOJI_MAP }
        }
        this.config.store.claudeStatus.display.titleEmojiMap[status] = value
        this.save()
    }

    getSelectedVoiceId(): string {
        const backendId = this.config.store.claudeStatus?.audio?.backend as TtsBackendId
        return this.config.store.claudeStatus?.audio?.voicesByBackend?.[backendId] || ''
    }

    onVoiceChange(voiceId: string): void {
        const backendId = this.config.store.claudeStatus.audio.backend as TtsBackendId
        if (!this.config.store.claudeStatus.audio.voicesByBackend) {
            this.config.store.claudeStatus.audio.voicesByBackend = {}
        }
        this.config.store.claudeStatus.audio.voicesByBackend[backendId] = voiceId
        // Keep legacy field in sync for Web Speech so old code paths don't regress.
        if (backendId === 'webspeech') {
            this.config.store.claudeStatus.audio.voiceName = voiceId
        }
        this.save()
    }

    onBackendChange(backendId: TtsBackendId): void {
        this.config.store.claudeStatus.audio.backend = backendId
        this.save()
        this.voicesLoading = !this.currentBackend?.voices?.length
    }

    save(): void {
        this.config.save()
    }

    openHomepage(event: MouseEvent): void {
        event.preventDefault()
        if (!this.pluginHomepage) return
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { shell } = require('electron')
            shell.openExternal(this.pluginHomepage)
        } catch {
            // fall back to window.open if electron isn't reachable
            if (typeof window !== 'undefined') window.open(this.pluginHomepage, '_blank')
        }
    }

    testSpeak(status: string): void {
        const audio = this.config.store.claudeStatus.audio
        const text = audio.statusTexts[status]
        if (text) {
            this.audioService.speakText(text, audio)
        }
    }

    // ── Session restore ─────────────────────────────────────────────

    refreshSessions(): void {
        this.sessions = this.sessionRestore.list()
    }

    async resumeSession(session: ClaudeSessionRecord): Promise<void> {
        await this.sessionRestore.resumeSession(session)
    }

    async resumeAllSessions(): Promise<void> {
        await this.sessionRestore.resumeAll()
    }

    forgetSession(session: ClaudeSessionRecord): void {
        this.sessionRestore.forget(session.sessionId)
        this.refreshSessions()
    }

    formatTs(ts: number): string {
        if (!ts) return '—'
        const d = new Date(ts)
        return d.toLocaleString()
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
