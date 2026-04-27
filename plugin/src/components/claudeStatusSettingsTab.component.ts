import { Component, OnDestroy, OnInit } from '@angular/core'
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
import { PiperInstallerService } from '../services/piperInstallerService'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PLUGIN_PACKAGE = require('../../package.json') as { version: string; homepage?: string }

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync, execSync } from 'child_process'

export interface HookLocationStatus {
    label: string
    path: string
    state: 'ok' | 'partial' | 'missing' | 'no-file' | 'error'
    totalEvents: number
    configuredEvents: number
    missingEvents: string[]
    error?: string
}

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
    styles: [`
        .session-table th.actions-col,
        .session-table td.actions-col {
            width: 1px;
            white-space: nowrap;
        }
        .copyable-row {
            display: inline-flex;
            align-items: baseline;
            gap: 0.25rem;
            max-width: 100%;
        }
        .copyable-row code {
            word-break: break-all;
        }
        .copyable-row .copy-btn {
            opacity: 0;
            transition: opacity 0.1s ease-in;
            border: 0;
            line-height: 1;
            color: var(--bs-secondary-color, #888);
        }
        .copyable-row:hover .copy-btn,
        .copy-btn:focus {
            opacity: 1;
        }
        .copy-btn:hover {
            color: var(--bs-body-color, #ddd);
        }
        .copy-btn .fa-check {
            color: var(--bs-success, #28a745);
            opacity: 1;
        }

        /* Toggle + label rows: vertically centred, label click toggles. */
        .toggle-row {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 0.75rem;
        }
        .toggle-row .toggle-label {
            cursor: pointer;
            user-select: none;
            margin: 0;
        }
        .toggle-row.indented {
            margin-left: 1.5rem;
        }

        /* Theme-agnostic status alerts. Semi-transparent backgrounds work
           on both Tabby's dark chrome and the light-themed settings page;
           Bootstrap's default alert-* classes inherit dark CSS variables
           even on light surfaces, which made green text on a near-black
           bg unreadable in light mode. */
        .claude-alert {
            border-radius: 0.375rem;
            padding: 0.5rem 0.875rem;
            border: 1px solid transparent;
            color: var(--bs-body-color, inherit);
        }
        .claude-alert-success {
            background-color: rgba(25, 135, 84, 0.15);
            border-color: rgba(25, 135, 84, 0.45);
        }
        .claude-alert-warning {
            background-color: rgba(255, 193, 7, 0.15);
            border-color: rgba(255, 193, 7, 0.5);
        }
        .claude-alert-danger {
            background-color: rgba(220, 53, 69, 0.15);
            border-color: rgba(220, 53, 69, 0.5);
        }
        .claude-alert-info {
            background-color: rgba(13, 110, 253, 0.15);
            border-color: rgba(13, 110, 253, 0.45);
        }

        /* Tabs nav across the top of the settings panel. */
        .settings-tabs {
            border-bottom: 1px solid var(--bs-border-color, rgba(128, 128, 128, 0.25));
            display: flex;
            flex-wrap: wrap;
            gap: 0.25rem;
            margin-bottom: 1rem;
            padding: 0;
            list-style: none;
        }
        .settings-tabs .nav-link {
            cursor: pointer;
            padding: 0.5rem 0.875rem;
            border: 1px solid transparent;
            border-bottom: none;
            border-top-left-radius: 0.375rem;
            border-top-right-radius: 0.375rem;
            color: var(--bs-secondary-color, #888);
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            margin-bottom: -1px;
        }
        .settings-tabs .nav-link:hover {
            color: var(--bs-body-color, inherit);
            background-color: rgba(128, 128, 128, 0.08);
        }
        .settings-tabs .nav-link.active {
            color: var(--bs-body-color, inherit);
            background-color: var(--bs-body-bg, transparent);
            border-color: var(--bs-border-color, rgba(128, 128, 128, 0.25));
            border-bottom-color: var(--bs-body-bg, transparent);
        }
        .settings-tabs .tab-badge {
            background: rgba(128, 128, 128, 0.2);
            color: inherit;
            border-radius: 999px;
            font-size: 0.7rem;
            padding: 0 0.45rem;
            line-height: 1.4;
        }
    `],
    template: `
        <div class="container-fluid">
            <div class="d-flex align-items-center gap-2 mb-2">
                <h3 class="mb-0">Claude Status</h3>
                <span class="badge text-bg-secondary">v{{pluginVersion}}</span>
                <a *ngIf="pluginHomepage"
                   class="small text-muted ms-auto d-inline-flex align-items-center gap-1"
                   [attr.href]="pluginHomepage"
                   [attr.title]="pluginHomepage"
                   (click)="openHomepage($event)">
                    <i class="fab fa-github"></i>
                    <span>{{pluginRepoLabel}}</span>
                </a>
            </div>

            <!-- Tab navigation -->
            <ul class="settings-tabs">
                <li *ngFor="let t of tabs">
                    <a class="nav-link"
                       [class.active]="activeTab === t.id"
                       (click)="activeTab = t.id">
                        <i class="fas {{t.icon}}"></i>
                        <span>{{t.label}}</span>
                    </a>
                </li>
            </ul>

            <!-- ============== GENERAL TAB ============== -->
            <div *ngIf="activeTab === 'general'">

                <!-- Enable plugin -->
                <div class="toggle-row">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.enabled"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus, 'enabled')">
                        Enable plugin
                    </label>
                </div>

                <hr />

                <!-- Display surfaces -->
                <h5>Display surfaces</h5>
                <p class="text-muted small">
                    Each surface updates independently when Claude status changes.
                    Leave off the ones you don't want.
                </p>

                <div class="toggle-row">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.display.colorBorder"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus.display, 'colorBorder')">
                        Tab bottom border colour
                    </label>
                </div>

                <!-- Tab Colors palette is only meaningful when colorBorder is on,
                     so co-locate it under the toggle that consumes it. -->
                <div *ngIf="config.store.claudeStatus.display.colorBorder"
                     class="row mb-3 ms-4" style="max-width: 640px">
                    <div class="col-3" *ngFor="let status of colorStatuses">
                        <label class="form-label text-capitalize small mb-1">{{status}}</label>
                        <input
                            type="color"
                            class="form-control form-control-color"
                            [ngModel]="getColor(status)"
                            (ngModelChange)="setColor(status, $event)"
                        />
                    </div>
                    <div class="col-12 mt-1">
                        <div class="toggle-row">
                            <toggle
                                [(ngModel)]="config.store.claudeStatus.clearOnFocus"
                                (ngModelChange)="save()"
                            ></toggle>
                            <label class="toggle-label"
                                   (click)="toggleField(config.store.claudeStatus, 'clearOnFocus')">
                                Clear tab color when tab is focused
                            </label>
                        </div>
                    </div>
                </div>

                <div class="toggle-row">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.display.titleEmoji"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus.display, 'titleEmoji')">
                        Tab title emoji prefix
                    </label>
                </div>

                <div *ngIf="config.store.claudeStatus.display.titleEmoji"
                     class="row mb-2 ms-4" style="max-width: 560px">
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

                <div class="toggle-row">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.display.progressBar"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus.display, 'progressBar')">
                        Indeterminate progress bar while <em>working</em>
                    </label>
                </div>

                <div class="toggle-row">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.display.activityMarker"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus.display, 'activityMarker')">
                        Activity marker dot on <em>question</em> / <em>error</em>
                    </label>
                </div>

                <div class="toggle-row">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.display.taskbarFlash"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus.display, 'taskbarFlash')">
                        Flash taskbar when Tabby is unfocused
                    </label>
                </div>

                <div class="toggle-row">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.display.taskbarOverlay"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus.display, 'taskbarOverlay')">
                        Taskbar icon overlay per status
                    </label>
                </div>

                <hr />

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

                <div class="toggle-row">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.debugMode"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus, 'debugMode')">
                        Debug mode (logs to DevTools console)
                    </label>
                </div>
            </div>

            <!-- ============== AUDIO / TTS TAB ============== -->
            <div *ngIf="activeTab === 'audio'">

            <!-- Audio / TTS -->
            <h5>Audio / TTS</h5>

            <div class="toggle-row">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.audio.enabled"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="toggle-label"
                       (click)="toggleField(config.store.claudeStatus.audio, 'enabled')">
                    Enable audio notifications
                </label>
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
                    <div *ngIf="currentVoices.length > 1"
                         class="d-flex gap-2 mb-2 flex-wrap"
                         style="max-width: 700px">
                        <select class="form-control form-control-sm"
                                style="max-width: 240px"
                                [(ngModel)]="voiceLanguageFilter">
                            <option value="">All languages ({{currentVoices.length}})</option>
                            <option *ngFor="let lang of voiceLanguageOptions" [value]="lang.code">
                                {{lang.name}} ({{lang.count}})
                            </option>
                        </select>
                        <input type="text"
                               class="form-control form-control-sm"
                               style="flex: 1; min-width: 180px"
                               placeholder="Filter by name…"
                               [(ngModel)]="voiceTextFilter" />
                        <button *ngIf="voiceLanguageFilter || voiceTextFilter"
                                class="btn btn-sm btn-outline-secondary"
                                type="button"
                                title="Clear filters"
                                (click)="clearVoiceFilters()">
                            ✕
                        </button>
                    </div>
                    <select
                        class="form-control"
                        style="max-width: 700px"
                        [ngModel]="getSelectedVoiceId()"
                        (ngModelChange)="onVoiceChange($event)"
                    >
                        <option value="">(default for this backend)</option>
                        <optgroup *ngFor="let g of filteredAndGroupedVoices" [label]="g.groupLabel">
                            <option *ngFor="let v of g.voices" [value]="v.id">{{v.label}}</option>
                        </optgroup>
                    </select>
                    <div *ngIf="voicesLoading" class="form-text text-muted">Loading voices…</div>
                    <div *ngIf="!voicesLoading && currentVoices.length === 0" class="form-text text-warning">
                        No voices available for this backend. Check availability indicator above.
                    </div>
                    <div *ngIf="!voicesLoading && currentVoices.length > 0 && filteredVoiceCount === 0"
                         class="form-text text-warning">
                        No voices match the current filter.
                    </div>
                </div>

                <div *ngIf="currentBackend?.id === 'piper'" class="mb-3">
                    <div class="d-flex align-items-center gap-2 mb-2">
                        <span class="small text-muted">Piper home:</span>
                        <a href="#" (click)="openUrl(piperInstaller.homepageUrl, $event)">
                            {{piperInstaller.homepageUrl}}
                        </a>
                        <span class="small text-muted ms-3">Voices:</span>
                        <a href="#" (click)="openUrl(piperInstaller.voicesUrl, $event)">
                            huggingface.co/rhasspy/piper-voices
                        </a>
                    </div>

                    <div *ngIf="piperInstalled" class="claude-alert claude-alert-success mb-2">
                        Piper is installed. Click "Reinstall" to re-download the latest <code>piper-tts</code> from PyPI.
                    </div>
                    <div *ngIf="!piperInstalled && !piperInstalling" class="claude-alert claude-alert-warning mb-2">
                        Piper isn't installed yet. The original C++ binary repo was archived in 2025;
                        the supported successor is
                        <a href="#" (click)="openUrl(piperInstaller.homepageUrl, $event)">OHF-Voice/piper1-gpl</a>,
                        distributed as the
                        <code>piper-tts</code> PyPI package. We'll create a private Python venv
                        under <code>%LOCALAPPDATA%\\tabby-claude-status\\piper</code>, pip-install the latest
                        version into it, and download the default <code>en_US-lessac-medium</code> voice
                        (~25 MB total). Requires Python 3.9+ on PATH.
                    </div>
                    <div *ngIf="piperInstalling" class="claude-alert claude-alert-info mb-2">
                        {{piperInstallStatus || 'Installing…'}}
                    </div>
                    <div *ngIf="piperInstallError" class="claude-alert claude-alert-danger mb-2">
                        Install failed: {{piperInstallError}}
                    </div>

                    <div class="d-flex align-items-center gap-2 mb-3">
                        <button class="btn btn-sm btn-primary"
                                [disabled]="piperInstalling"
                                (click)="installPiper()">
                            <span *ngIf="!piperInstalling && !piperInstalled">Install Piper + default voice</span>
                            <span *ngIf="!piperInstalling && piperInstalled">Reinstall</span>
                            <span *ngIf="piperInstalling">Installing…</span>
                        </button>
                        <span *ngIf="piperDetectedInstallers.length" class="text-muted small">
                            Also detected: {{piperDetectedInstallers.join(', ')}} (Piper isn't in these repositories)
                        </span>
                    </div>

                    <div class="row mb-2">
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

                <div class="toggle-row">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.audio.systemBeep"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus.audio, 'systemBeep')">
                        Play system beep alongside TTS
                    </label>
                </div>

                <div class="form-group mb-3">
                    <div class="toggle-row mb-1">
                        <toggle
                            [(ngModel)]="config.store.claudeStatus.audio.muteDuringZoomRecording"
                            (ngModelChange)="save()"
                        ></toggle>
                        <label class="toggle-label"
                               (click)="toggleField(config.store.claudeStatus.audio, 'muteDuringZoomRecording')">
                            Mute while Zoom is recording
                        </label>
                    </div>
                    <div class="form-text ms-4">
                        Detected via recent writes in the Zoom recording folder.
                    </div>
                </div>

                <div class="form-group mb-3">
                    <div class="toggle-row mb-1">
                        <toggle
                            [(ngModel)]="config.store.claudeStatus.audio.muteDuringZoomMeeting"
                            (ngModelChange)="save()"
                        ></toggle>
                        <label class="toggle-label"
                               (click)="toggleField(config.store.claudeStatus.audio, 'muteDuringZoomMeeting')">
                            Mute while in any Zoom meeting
                        </label>
                    </div>
                    <div class="form-text ms-4">
                        Detected via active UDP media sockets owned by Zoom.exe.
                    </div>
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
            </div><!-- /audio tab -->

            <!-- ============== SESSIONS TAB ============== -->
            <div *ngIf="activeTab === 'sessions'">

            <!-- Session restore -->
            <h5>Session restore</h5>
            <p class="text-muted small">
                Persist each Claude Code session (cwd + session id) so you can
                reopen them after closing Tabby. Opt-in — nothing is written
                to disk until this is enabled.
            </p>

            <div class="toggle-row">
                <toggle
                    [(ngModel)]="config.store.claudeStatus.sessionRestore.enabled"
                    (ngModelChange)="save()"
                ></toggle>
                <label class="toggle-label"
                       (click)="toggleField(config.store.claudeStatus.sessionRestore, 'enabled')">
                    Enable session tracking
                </label>
            </div>

            <div *ngIf="config.store.claudeStatus.sessionRestore.enabled">
                <div class="toggle-row indented">
                    <toggle
                        [(ngModel)]="config.store.claudeStatus.sessionRestore.autoResumeOnLaunch"
                        (ngModelChange)="save()"
                    ></toggle>
                    <label class="toggle-label"
                           (click)="toggleField(config.store.claudeStatus.sessionRestore, 'autoResumeOnLaunch')">
                        Auto-resume open sessions on Tabby launch
                    </label>
                </div>

                <div class="row mb-3 ms-3">
                    <div class="col-12 col-md-8">
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

                <div class="row mb-3 ms-3">
                    <div class="col-12 col-md-8">
                        <label class="form-label">
                            Delay between <code>cd</code> and <code>claude --resume</code> (seconds)
                        </label>
                        <input
                            type="number"
                            class="form-control form-control-sm"
                            style="max-width: 160px"
                            min="0" max="10" step="0.1"
                            [(ngModel)]="config.store.claudeStatus.sessionRestore.resumeCdDelaySec"
                            (ngModelChange)="save()"
                        />
                        <div class="form-text small">
                            Resume runs <code>cd "&lt;cwd&gt;"</code> first; if Claude says
                            "No conversation found with session ID …" it usually means the
                            shell hadn't finished cd-ing yet — bump this up.
                        </div>
                    </div>
                </div>

                <div class="d-flex align-items-center gap-2 mb-2 ms-3 flex-wrap">
                    <button class="btn btn-sm btn-outline-primary"
                            [disabled]="openSessions.length === 0"
                            (click)="resumeAllSessions()">
                        Resume all now
                    </button>
                    <button class="btn btn-sm btn-outline-secondary" (click)="refreshSessions()">
                        Refresh list
                    </button>
                    <button class="btn btn-sm btn-outline-warning"
                            [disabled]="openSessions.length === 0"
                            (click)="markAllClosed()">
                        Move all to history
                    </button>
                    <span class="text-muted small">
                        {{openSessions.length}} open · {{closedSessions.length}} in history
                    </span>
                </div>

                <div class="ms-3 mb-2" style="max-width: 900px">
                    <div class="input-group input-group-sm">
                        <span class="input-group-text"><i class="fas fa-search"></i></span>
                        <input type="text"
                               class="form-control"
                               placeholder="Filter by path, session id, or title…"
                               [(ngModel)]="sessionFilter"
                               (ngModelChange)="onFilterChange()" />
                        <button *ngIf="sessionFilter"
                                class="btn btn-outline-secondary"
                                type="button"
                                title="Clear filter"
                                (click)="clearFilter()">
                            ✕
                        </button>
                    </div>
                    <div *ngIf="sessionFilter" class="form-text small">
                        {{filteredOpenSessions.length}} of {{openSessions.length}} open ·
                        {{filteredClosedSessions.length}} of {{closedSessions.length}} in history match
                    </div>
                </div>

                <h6 class="ms-3 mt-3">Open sessions</h6>
                <table *ngIf="filteredOpenSessions.length > 0" class="table table-sm ms-3 session-table" style="max-width: 900px">
                    <thead>
                        <tr>
                            <th>Session</th>
                            <th class="actions-col"></th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr *ngFor="let s of filteredOpenSessions">
                            <td>
                                <div class="copyable-row">
                                    <code class="small">{{s.cwd}}</code>
                                    <button class="btn btn-sm btn-link copy-btn p-0 ms-1"
                                            type="button"
                                            title="Copy path"
                                            (click)="copyToClipboard(s.cwd, 'cwd-' + s.sessionId)">
                                        <i class="fas"
                                           [class.fa-copy]="copiedKey !== 'cwd-' + s.sessionId"
                                           [class.fa-check]="copiedKey === 'cwd-' + s.sessionId"></i>
                                    </button>
                                </div>
                                <div class="copyable-row small text-muted">
                                    <code>{{s.sessionId}}</code>
                                    <button class="btn btn-sm btn-link copy-btn p-0 ms-1"
                                            type="button"
                                            title="Copy session id"
                                            (click)="copyToClipboard(s.sessionId, 'sid-' + s.sessionId)">
                                        <i class="fas"
                                           [class.fa-copy]="copiedKey !== 'sid-' + s.sessionId"
                                           [class.fa-check]="copiedKey === 'sid-' + s.sessionId"></i>
                                    </button>
                                </div>
                                <div *ngIf="displayTitle(s)" class="small text-muted fst-italic">{{displayTitle(s)}}</div>
                                <div *ngIf="displayProfileName(s)" class="small text-muted">
                                    <i class="fas fa-terminal me-1"></i>{{displayProfileName(s)}}
                                </div>
                            </td>
                            <td class="actions-col text-end">
                                <div class="d-flex gap-1 justify-content-end">
                                    <button class="btn btn-sm btn-outline-success"
                                            (click)="resumeSession(s)">Resume</button>
                                    <button class="btn btn-sm btn-outline-danger"
                                            (click)="forgetSession(s)">✕</button>
                                </div>
                                <div class="small text-muted mt-1"
                                     [attr.title]="formatTs(s.lastSeen)">
                                    {{timeAgo(s.lastSeen)}}
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
                <div *ngIf="openSessions.length === 0" class="ms-3 text-muted small mb-3">
                    No open sessions. Run <code>claude</code> in a Tabby tab — a session
                    appears here as soon as a hook event fires, and moves to history
                    automatically when you close the tab or Claude ends the session.
                </div>
                <div *ngIf="openSessions.length > 0 && filteredOpenSessions.length === 0"
                     class="ms-3 text-muted small mb-3">
                    No open sessions match "{{sessionFilter}}".
                </div>

                <div class="ms-3 mt-3" style="max-width: 900px">
                    <button class="btn btn-sm btn-link ps-0 text-decoration-none"
                            (click)="historyExpanded = !historyExpanded">
                        <i class="fas" [class.fa-chevron-down]="historyExpanded"
                                        [class.fa-chevron-right]="!historyExpanded"></i>
                        History ({{closedSessions.length}}<span *ngIf="sessionFilter">, {{filteredClosedSessions.length}} match</span>)
                    </button>

                    <div *ngIf="historyExpanded" class="mt-2">
                        <div class="row mb-2">
                            <div class="col-6 col-md-4">
                                <label class="form-label small">Retention (days)</label>
                                <input
                                    type="number"
                                    class="form-control form-control-sm"
                                    min="1" max="90" step="1"
                                    [(ngModel)]="config.store.claudeStatus.sessionRestore.retentionDays"
                                    (ngModelChange)="save()"
                                />
                                <div class="form-text small">
                                    Historical (closed) sessions older than this are pruned.
                                </div>
                            </div>
                        </div>

                        <div *ngIf="filteredClosedSessions.length > 0"
                             style="max-height: 360px; overflow-y: auto; border: 1px solid var(--bs-border-color, #333); border-radius: 4px;">
                            <table class="table table-sm mb-0 session-table">
                                <thead class="sticky-top"
                                       style="background: var(--bs-body-bg, #1b1b1b); z-index: 1;">
                                    <tr>
                                        <th>Session</th>
                                        <th class="actions-col"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr *ngFor="let s of filteredClosedSessions">
                                        <td>
                                            <div class="copyable-row">
                                                <code class="small">{{s.cwd}}</code>
                                                <button class="btn btn-sm btn-link copy-btn p-0 ms-1"
                                                        type="button"
                                                        title="Copy path"
                                                        (click)="copyToClipboard(s.cwd, 'cwd-' + s.sessionId)">
                                                    <i class="fas"
                                                       [class.fa-copy]="copiedKey !== 'cwd-' + s.sessionId"
                                                       [class.fa-check]="copiedKey === 'cwd-' + s.sessionId"></i>
                                                </button>
                                            </div>
                                            <div class="copyable-row small text-muted">
                                                <code>{{s.sessionId}}</code>
                                                <button class="btn btn-sm btn-link copy-btn p-0 ms-1"
                                                        type="button"
                                                        title="Copy session id"
                                                        (click)="copyToClipboard(s.sessionId, 'sid-' + s.sessionId)">
                                                    <i class="fas"
                                                       [class.fa-copy]="copiedKey !== 'sid-' + s.sessionId"
                                                       [class.fa-check]="copiedKey === 'sid-' + s.sessionId"></i>
                                                </button>
                                            </div>
                                            <div *ngIf="displayTitle(s)" class="small text-muted fst-italic">{{displayTitle(s)}}</div>
                                <div *ngIf="displayProfileName(s)" class="small text-muted">
                                    <i class="fas fa-terminal me-1"></i>{{displayProfileName(s)}}
                                </div>
                                        </td>
                                        <td class="actions-col text-end">
                                            <div class="d-flex gap-1 justify-content-end">
                                                <button class="btn btn-sm btn-outline-success"
                                                        (click)="resumeSession(s)">Resume</button>
                                                <button class="btn btn-sm btn-outline-danger"
                                                        (click)="forgetSession(s)">✕</button>
                                            </div>
                                            <div class="small text-muted mt-1"
                                                 [attr.title]="formatTs(s.lastSeen)">
                                                {{timeAgo(s.lastSeen)}}
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div *ngIf="closedSessions.length === 0" class="text-muted small">
                            No sessions in history yet.
                        </div>
                        <div *ngIf="closedSessions.length > 0 && filteredClosedSessions.length === 0"
                             class="text-muted small">
                            No history sessions match "{{sessionFilter}}".
                        </div>
                    </div>
                </div>
            </div>
            </div><!-- /sessions tab -->

            <!-- ============== HOOKS TAB ============== -->
            <div *ngIf="activeTab === 'hooks'">

            <!-- Hook Setup -->
            <div class="d-flex align-items-center gap-2 mb-1">
                <h5 class="mb-0">Claude Code Hook Setup</h5>
                <button class="btn btn-sm btn-link p-0 text-decoration-none"
                        type="button"
                        title="What do these hooks do?"
                        (click)="hooksHelpOpen = !hooksHelpOpen">
                    <i class="fas"
                       [class.fa-question-circle]="!hooksHelpOpen"
                       [class.fa-times-circle]="hooksHelpOpen"></i>
                    <span class="ms-1 small">{{hooksHelpOpen ? 'Hide' : 'What are these?'}}</span>
                </button>
            </div>
            <p class="text-muted small">
                Claude Code sends status events to this plugin via hooks. We check
                <code>~/.claude/settings.json</code> in Windows and in every detected WSL
                distro (they have separate config files). The "Setup" button writes to
                Windows; click the caret to pick a specific WSL distro or all locations.
                WSL hooks invoke the Windows <code>node.exe</code> via <code>/mnt/c/…</code>
                so you don't have to install Node inside the distro.
            </p>

            <div *ngIf="hooksHelpOpen" class="card mb-3" style="max-width: 900px">
                <div class="card-body py-3">
                    <div class="d-flex justify-content-between align-items-baseline mb-2">
                        <h6 class="mb-0">Hook events used by this plugin</h6>
                        <span class="small text-muted">{{hookEventDescriptions.length}} events</span>
                    </div>
                    <p class="small text-muted mb-2">
                        Each event triggers a small <code>hook.js</code> launcher that writes a
                        JSON payload to a temp file the plugin watches. The launcher is the
                        same in every location — only the <code>node</code> path differs
                        (Windows <code>node.exe</code> vs WSL <code>/mnt/c/…/node.exe</code>).
                    </p>
                    <table class="table table-sm mb-2">
                        <thead>
                            <tr>
                                <th style="width: 26px"></th>
                                <th style="width: 170px">Event</th>
                                <th>What this plugin does with it</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let h of hookEventDescriptions">
                                <td class="text-center">
                                    <i *ngIf="isHookEventConfigured(h.event)"
                                       class="fas fa-check-circle text-success"
                                       title="Wired up in at least one settings.json"></i>
                                    <i *ngIf="!isHookEventConfigured(h.event)"
                                       class="far fa-circle text-muted"
                                       title="Not configured in any settings.json"></i>
                                </td>
                                <td><code class="small">{{h.event}}</code></td>
                                <td class="small">
                                    <span class="badge text-bg-secondary me-1"
                                          [style.background-color]="h.statusColor + ' !important'"
                                          *ngIf="h.statusLabel">
                                        → {{h.statusLabel}}
                                    </span>
                                    {{h.purpose}}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <div class="small text-muted">
                        Reference:
                        <a href="#"
                           (click)="openUrl('https://docs.claude.com/en/docs/claude-code/hooks', $event)">
                            Claude Code hook events docs
                        </a>
                    </div>
                </div>
            </div>

            <div class="d-flex align-items-center gap-3 mb-2 flex-wrap">
                <div class="btn-group" (click)="$event.stopPropagation()">
                    <button class="btn btn-primary"
                            [disabled]="setupRunning"
                            (click)="setupHooks({ target: 'windows' })">
                        Setup Claude Hooks (Windows)
                    </button>
                    <button class="btn btn-primary"
                            type="button"
                            style="padding-left: 0.6rem; padding-right: 0.6rem;"
                            [disabled]="setupRunning"
                            (click)="setupDropdownOpen = !setupDropdownOpen">
                        <span class="caret">▾</span>
                    </button>
                    <ul class="dropdown-menu show" *ngIf="setupDropdownOpen"
                        style="position: absolute; top: 100%; left: 0; z-index: 100;">
                        <li>
                            <a class="dropdown-item" href="#"
                               (click)="onSetupChoice($event, { target: 'windows' })">
                                Windows <code class="small">~/.claude/settings.json</code>
                            </a>
                        </li>
                        <li *ngIf="wslDistros.length === 0" class="px-3 py-1 small text-muted">
                            No WSL distros detected
                        </li>
                        <li *ngFor="let distro of wslDistros">
                            <a class="dropdown-item" href="#"
                               (click)="onSetupChoice($event, { target: 'wsl', distro: distro })">
                                WSL {{distro}}
                            </a>
                        </li>
                        <li *ngIf="wslDistros.length > 0"><hr class="dropdown-divider" /></li>
                        <li *ngIf="wslDistros.length > 0">
                            <a class="dropdown-item" href="#"
                               (click)="onSetupChoice($event, { target: 'all' })">
                                <strong>All locations (Windows + every WSL distro)</strong>
                            </a>
                        </li>
                    </ul>
                </div>
                <button class="btn btn-sm btn-outline-secondary" (click)="checkHooks()">
                    Re-check
                </button>
                <span *ngIf="hooksStatus === 'ok'" class="text-success">All locations configured</span>
                <span *ngIf="hooksStatus === 'partial'" class="text-warning">Partially configured</span>
                <span *ngIf="hooksStatus === 'missing'" class="text-danger">Hooks not configured</span>
                <span *ngIf="hooksStatus === 'error'" class="text-warning">Could not check hooks</span>
                <span *ngIf="setupResult" class="small"
                      [class.text-success]="setupResult.kind === 'ok'"
                      [class.text-danger]="setupResult.kind === 'error'">
                    {{setupResult.message}}
                </span>
            </div>

            <table *ngIf="hookLocations.length > 0"
                   class="table table-sm mb-3" style="max-width: 900px">
                <thead>
                    <tr>
                        <th style="width: 160px">Location</th>
                        <th style="width: 90px">Status</th>
                        <th>settings.json</th>
                    </tr>
                </thead>
                <tbody>
                    <tr *ngFor="let loc of hookLocations"
                        [attr.title]="loc.state === 'partial' ? ('Missing events: ' + loc.missingEvents.join(', ')) : null">
                        <td>{{loc.label}}</td>
                        <td>
                            <span *ngIf="loc.state === 'ok'" class="badge text-bg-success">
                                {{loc.configuredEvents}}/{{loc.totalEvents}} ok
                            </span>
                            <span *ngIf="loc.state === 'partial'" class="badge text-bg-warning">
                                {{loc.configuredEvents}}/{{loc.totalEvents}}
                            </span>
                            <span *ngIf="loc.state === 'missing'" class="badge text-bg-danger">
                                0/{{loc.totalEvents}}
                            </span>
                            <span *ngIf="loc.state === 'no-file'" class="badge text-bg-secondary">
                                no file
                            </span>
                            <span *ngIf="loc.state === 'error'" class="badge text-bg-warning">
                                error
                            </span>
                        </td>
                        <td>
                            <code class="small">{{loc.path}}</code>
                            <div *ngIf="loc.error" class="small text-muted">{{loc.error}}</div>
                        </td>
                    </tr>
                </tbody>
            </table>

            </div><!-- /hooks tab -->

            <!-- ============== DIAGNOSTICS TAB ============== -->
            <div *ngIf="activeTab === 'diagnostics'">

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

            <div *ngIf="!nodeInfo.path" class="claude-alert claude-alert-warning mt-2" style="max-width: 600px">
                <strong>Node.js not detected on Tabby's PATH.</strong>
                If you use nvm or fnm, Tabby launched from a desktop shortcut may not
                inherit your shell's PATH. Hooks will still work because Claude Code
                provides its own Node.js runtime.
            </div>
            </div><!-- /diagnostics tab -->
        </div>
    `,
})
export class ClaudeStatusSettingsTabComponent implements OnInit, OnDestroy {
    colorStatuses = ['working', 'question', 'done', 'error'] as const
    phraseStatuses = ['done', 'question', 'error', 'working', 'idle'] as const
    emojiStatuses = ['working', 'question', 'done', 'error', 'idle'] as const
    hooksStatus: 'ok' | 'partial' | 'missing' | 'error' | '' = ''
    hookLocations: HookLocationStatus[] = []

    backends: BackendOption[] = []
    voicesLoading = false
    voiceLanguageFilter = 'en'
    voiceTextFilter = ''
    filteredVoiceCount = 0
    private languageDisplayNames: Intl.DisplayNames | null = (() => {
        try { return new Intl.DisplayNames(['en'], { type: 'language' }) } catch { return null }
    })()
    private regionDisplayNames: Intl.DisplayNames | null = (() => {
        try { return new Intl.DisplayNames(['en'], { type: 'region' }) } catch { return null }
    })()
    pluginVersion = PLUGIN_PACKAGE.version
    pluginHomepage = PLUGIN_PACKAGE.homepage || ''
    pluginRepoLabel = (() => {
        const url = PLUGIN_PACKAGE.homepage || ''
        const m = url.match(/github\.com\/([^/]+)\/([^/#?]+)/)
        return m ? `${m[1]}/${m[2]}` : url
    })()
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

    piperInstalled = false
    piperInstalling = false
    piperInstallStatus = ''
    piperInstallError = ''
    piperDetectedInstallers: string[] = []

    historyExpanded = false
    sessionFilter = ''
    copiedKey = ''
    setupDropdownOpen = false
    setupRunning = false
    hooksHelpOpen = false
    activeTab: 'general' | 'audio' | 'sessions' | 'hooks' | 'diagnostics' = 'general'
    readonly tabs: ReadonlyArray<{
        id: 'general' | 'audio' | 'sessions' | 'hooks' | 'diagnostics'
        label: string
        icon: string
    }> = [
        { id: 'general', label: 'General', icon: 'fa-sliders-h' },
        { id: 'audio', label: 'Audio / TTS', icon: 'fa-volume-up' },
        { id: 'sessions', label: 'Sessions', icon: 'fa-history' },
        { id: 'hooks', label: 'Hooks', icon: 'fa-link' },
        { id: 'diagnostics', label: 'Diagnostics', icon: 'fa-stethoscope' },
    ]
    readonly hookEventDescriptions: ReadonlyArray<{
        event: string
        purpose: string
        statusLabel?: string
        statusColor?: string
    }> = [
        {
            event: 'SessionStart',
            statusLabel: 'working',
            statusColor: '#0d6efd',
            purpose: 'Captures session id, cwd, and Tabby profile when a Claude Code session begins. Drives the "Open sessions" list above and seeds the tab as working.',
        },
        {
            event: 'UserPromptSubmit',
            statusLabel: 'working',
            statusColor: '#0d6efd',
            purpose: 'Fires when you press Enter on a prompt. Re-marks the tab as working in case you started a new turn.',
        },
        {
            event: 'PreToolUse',
            statusLabel: 'working',
            statusColor: '#0d6efd',
            purpose: 'Fires before every tool call (Read, Edit, Bash, …). Keeps the tab indicator alive while Claude is mid-task.',
        },
        {
            event: 'PostToolUse',
            statusLabel: 'working',
            statusColor: '#0d6efd',
            purpose: 'Fires after a tool call succeeds. Refreshes the working indicator with the latest tool name (shown in the tab title prefix when enabled).',
        },
        {
            event: 'PostToolUseFailure',
            statusLabel: 'error',
            statusColor: '#dc3545',
            purpose: 'Fires when a tool call errors out. Marks the tab as error and (if enabled) speaks the error phrase.',
        },
        {
            event: 'Notification',
            statusLabel: 'question',
            statusColor: '#fd7e14',
            purpose: 'Fires when Claude wants your attention without a permission prompt (e.g. permission timeout warning). Marks the tab as question and flashes the taskbar.',
        },
        {
            event: 'PermissionRequest',
            statusLabel: 'question',
            statusColor: '#fd7e14',
            purpose: 'Fires when Claude needs you to approve a tool. Marks the tab as question and triggers the question phrase.',
        },
        {
            event: 'Stop',
            statusLabel: 'done',
            statusColor: '#198754',
            purpose: 'Fires when Claude finishes its turn. Marks the tab done and triggers the done phrase. Auto-resets to idle after the configured timeout.',
        },
        {
            event: 'SessionEnd',
            statusLabel: 'idle',
            statusColor: '#6c757d',
            purpose: 'Fires when the Claude Code session ends (Ctrl+C, /quit, etc.). Moves the row from "Open sessions" to history.',
        },
    ]
    setupResult: { kind: 'ok' | 'error'; message: string } | null = null
    wslDistros: string[] = []
    private copiedTimer: ReturnType<typeof setTimeout> | null = null
    private setupResultTimer: ReturnType<typeof setTimeout> | null = null
    private refreshTicker: ReturnType<typeof setInterval> | null = null
    private docClickListener = (ev: MouseEvent) => {
        if (!this.setupDropdownOpen) return
        const target = ev.target as HTMLElement | null
        if (!target?.closest?.('.btn-group')) {
            this.setupDropdownOpen = false
        }
    }

    constructor(
        public config: ConfigService,
        private audioService: AudioService,
        private sessionRestore: SessionRestoreService,
        public piperInstaller: PiperInstallerService,
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
        // Backfill new fields for users upgrading from <=1.2.0
        if (this.config.store.claudeStatus.sessionRestore.resumeCdDelaySec == null) {
            this.config.store.claudeStatus.sessionRestore.resumeCdDelaySec =
                DEFAULT_SESSION_RESTORE_CONFIG.resumeCdDelaySec
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

        this.wslDistros = process.platform === 'win32' ? this.getWslDistros() : []
        this.checkHooks()
        this.refreshPiperState()
        document.addEventListener('click', this.docClickListener, true)

        // Keep the sessions table fresh while the settings tab is open so
        // sessions that get closed elsewhere (tab-close in another Tabby
        // window, SessionEnd hook, etc.) move to history without needing a
        // manual refresh. 5s is plenty — this is cheap (single JSON read).
        this.refreshTicker = setInterval(() => {
            this.refreshSessions()
        }, 5000)
    }

    refreshPiperState(): void {
        this.piperInstalled = this.piperInstaller.isInstalled()
        this.piperInstaller
            .detectInstallers()
            .then(list => {
                this.piperDetectedInstallers = list
            })
            .catch(() => {
                this.piperDetectedInstallers = []
            })
    }

    async installPiper(): Promise<void> {
        this.piperInstalling = true
        this.piperInstallError = ''
        this.piperInstallStatus = 'Starting install…'
        try {
            const paths = await this.piperInstaller.install(p => {
                this.piperInstallStatus = p.message
            })
            // Auto-fill the plugin config with the paths we just installed.
            this.config.store.claudeStatus.audio.piperExePath = paths.exePath
            this.config.store.claudeStatus.audio.piperModelPath = paths.modelPath
            this.save()
            this.piperInstalled = true
            this.piperInstallStatus = `Installed at ${paths.installDir}`
        } catch (e: any) {
            this.piperInstallError = e?.message || String(e)
            this.piperInstallStatus = ''
        } finally {
            this.piperInstalling = false
        }
    }

    openUrl(url: string, event?: MouseEvent): void {
        if (event) event.preventDefault()
        if (!url) return
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { shell } = require('electron')
            shell.openExternal(url)
        } catch {
            if (typeof window !== 'undefined') window.open(url, '_blank')
        }
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
            this.syncFilterToSelection()
        }
    }

    /**
     * Default the language filter to the family of whatever voice is already
     * configured for the current backend. Falls back to 'en' if nothing is
     * selected yet but English voices exist; otherwise clears the filter so
     * the user can see everything.
     */
    private syncFilterToSelection(): void {
        if (this.voiceTextFilter) return // user is actively filtering by text
        const selectedId = this.getSelectedVoiceId()
        if (selectedId) {
            const current = this.currentVoices.find(v => v.id === selectedId)
            if (current) {
                this.voiceLanguageFilter = this.languageFamilyOf(current.locale)
                return
            }
        }
        const hasEnglish = this.currentVoices.some(v => this.languageFamilyOf(v.locale) === 'en')
        this.voiceLanguageFilter = hasEnglish ? 'en' : ''
    }

    get currentBackend(): BackendOption | undefined {
        const id = this.config.store.claudeStatus?.audio?.backend as TtsBackendId
        return this.backends.find(b => b.id === id)
    }

    get currentVoices(): TtsVoice[] {
        return this.currentBackend?.voices || []
    }

    /**
     * Unique language families present in the current backend's voices, with
     * English first and the rest alphabetised by display name. Each entry
     * carries a count so the filter dropdown can show "English (47)" etc.
     */
    get voiceLanguageOptions(): { code: string; name: string; count: number }[] {
        const counts = new Map<string, number>()
        for (const v of this.currentVoices) {
            const code = this.languageFamilyOf(v.locale)
            counts.set(code, (counts.get(code) || 0) + 1)
        }
        const list: { code: string; name: string; count: number }[] = []
        for (const [code, count] of counts) {
            list.push({ code, name: this.displayLanguage(code), count })
        }
        list.sort((a, b) => {
            if (a.code === 'en' && b.code !== 'en') return -1
            if (b.code === 'en' && a.code !== 'en') return 1
            return a.name.localeCompare(b.name)
        })
        return list
    }

    /**
     * Voices grouped by full locale (e.g. "English (United States) — en-US"),
     * filtered by the language + text inputs, with English locales sorted to
     * the top. The currently-selected voice is always included so the
     * <select> caption stays correct even if the filter would otherwise hide
     * it.
     */
    get filteredAndGroupedVoices(): { groupLabel: string; voices: TtsVoice[] }[] {
        const text = this.voiceTextFilter.trim().toLowerCase()
        const lang = this.voiceLanguageFilter
        const selectedId = this.getSelectedVoiceId()
        const passesFilter = (v: TtsVoice): boolean => {
            if (lang && this.languageFamilyOf(v.locale) !== lang) return false
            if (text && !v.label.toLowerCase().includes(text)
                && !(v.locale || '').toLowerCase().includes(text)) return false
            return true
        }
        let filtered = this.currentVoices.filter(passesFilter)
        this.filteredVoiceCount = filtered.length

        // Always keep the current selection visible so the caption renders.
        if (selectedId && !filtered.some(v => v.id === selectedId)) {
            const current = this.currentVoices.find(v => v.id === selectedId)
            if (current) filtered = [current, ...filtered]
        }

        filtered = filtered.slice().sort((a, b) => {
            const aFamily = this.languageFamilyOf(a.locale)
            const bFamily = this.languageFamilyOf(b.locale)
            if (aFamily === 'en' && bFamily !== 'en') return -1
            if (bFamily === 'en' && aFamily !== 'en') return 1
            const al = (a.locale || '').toLowerCase()
            const bl = (b.locale || '').toLowerCase()
            if (al !== bl) return al.localeCompare(bl)
            return a.label.localeCompare(b.label)
        })

        const groups = new Map<string, TtsVoice[]>()
        for (const v of filtered) {
            const key = v.locale || 'unknown'
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key)!.push(v)
        }
        const result: { groupLabel: string; voices: TtsVoice[] }[] = []
        for (const [locale, vs] of groups) {
            result.push({ groupLabel: this.displayLocale(locale), voices: vs })
        }
        return result
    }

    clearVoiceFilters(): void {
        this.voiceLanguageFilter = ''
        this.voiceTextFilter = ''
    }

    private languageFamilyOf(locale: string | undefined): string {
        if (!locale) return 'unknown'
        return locale.split(/[-_]/)[0].toLowerCase()
    }

    private displayLanguage(code: string): string {
        if (code === 'unknown') return 'Unknown'
        try {
            const name = this.languageDisplayNames?.of(code)
            if (name && name !== code) return name
        } catch { /* fall through */ }
        return code
    }

    private displayLocale(locale: string): string {
        if (locale === 'unknown') return 'Unknown'
        const [lang, region] = locale.split(/[-_]/)
        const langName = this.displayLanguage(lang.toLowerCase())
        if (region) {
            let regionName = region.toUpperCase()
            try {
                const r = this.regionDisplayNames?.of(region.toUpperCase())
                if (r) regionName = r
            } catch { /* fall through */ }
            return `${langName} (${regionName}) — ${locale}`
        }
        return `${langName} — ${locale}`
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
        // Replace the whole voicesByBackend object so Tabby's config-save sees
        // a reference change — some save paths miss deep mutations.
        this.config.store.claudeStatus.audio.voicesByBackend = {
            ...(this.config.store.claudeStatus.audio.voicesByBackend || {}),
            [backendId]: voiceId,
        }
        // Keep legacy field in sync for Web Speech so old code paths don't regress.
        if (backendId === 'webspeech') {
            this.config.store.claudeStatus.audio.voiceName = voiceId
        }
        console.info(
            '[claude-status] Voice saved for backend',
            backendId,
            '→',
            voiceId || '(default)',
        )
        this.save()
    }

    onBackendChange(backendId: TtsBackendId): void {
        this.config.store.claudeStatus.audio.backend = backendId
        this.save()
        this.voicesLoading = !this.currentBackend?.voices?.length
        if (!this.voicesLoading) this.syncFilterToSelection()
    }

    save(): void {
        this.config.save()
    }

    /**
     * Flip a boolean field on a config object and persist. Used by the
     * <label> next to each <toggle> so clicking the label toggles the
     * switch — Tabby's <toggle> isn't a native checkbox, so the standard
     * `<label for="...">` pattern doesn't work on it.
     */
    toggleField(obj: any, key: string): void {
        if (!obj) return
        obj[key] = !obj[key]
        this.save()
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

    get openSessions(): ClaudeSessionRecord[] {
        return this.sessions.filter(s => !s.closed)
    }

    get closedSessions(): ClaudeSessionRecord[] {
        return this.sessions.filter(s => !!s.closed)
    }

    get filteredOpenSessions(): ClaudeSessionRecord[] {
        return this.applySessionFilter(this.openSessions)
    }

    get filteredClosedSessions(): ClaudeSessionRecord[] {
        return this.applySessionFilter(this.closedSessions)
    }

    private applySessionFilter(list: ClaudeSessionRecord[]): ClaudeSessionRecord[] {
        const q = this.sessionFilter.trim().toLowerCase()
        if (!q) return list
        return list.filter(s => {
            const title = this.displayTitle(s)
            return (
                (s.cwd && s.cwd.toLowerCase().includes(q)) ||
                (s.sessionId && s.sessionId.toLowerCase().includes(q)) ||
                (!!title && title.toLowerCase().includes(q))
            )
        })
    }

    /**
     * Title to render for a session row. For open sessions we ask the
     * decorator for the live tab title (Claude rewrites it during the
     * session); for closed sessions we just use the persisted snapshot.
     */
    displayTitle(s: ClaudeSessionRecord): string | undefined {
        if (!s.closed) {
            const live = this.sessionRestore.getLiveTitle(s.sessionId)
            if (live) return live
        }
        return s.title
    }

    /**
     * Tabby profile that will own the resumed tab. Live for open sessions
     * (so renames/profile-edits propagate immediately), persisted snapshot
     * for history rows. Returns undefined for legacy records that pre-date
     * the profile-capture upgrade — the row just hides the row's profile
     * line in that case.
     */
    displayProfileName(s: ClaudeSessionRecord): string | undefined {
        if (!s.closed) {
            const live = this.sessionRestore.getLiveProfile(s.sessionId)
            if (live?.name) return live.name
        }
        return s.profileName
    }

    onFilterChange(): void {
        // Auto-expand history when typing so matches there become visible.
        if (this.sessionFilter.trim() && this.filteredClosedSessions.length > 0) {
            this.historyExpanded = true
        }
    }

    clearFilter(): void {
        this.sessionFilter = ''
    }

    copyToClipboard(text: string, key: string): void {
        if (!text) return
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { clipboard } = require('electron')
            clipboard.writeText(text)
        } catch {
            try {
                navigator.clipboard?.writeText(text)
            } catch {
                /* nothing else to try */
            }
        }
        this.copiedKey = key
        if (this.copiedTimer) clearTimeout(this.copiedTimer)
        this.copiedTimer = setTimeout(() => {
            this.copiedKey = ''
            this.copiedTimer = null
        }, 1200)
    }

    markAllClosed(): void {
        const n = this.sessionRestore.markAllClosed()
        console.info(`[claude-status] Moved ${n} session(s) to history`)
        this.refreshSessions()
    }

    /**
     * Human-friendly relative timestamp ("3m ago", "2h ago"). The full
     * datetime is surfaced via the `title` tooltip on the same element so
     * the user can hover to see the exact time.
     */
    timeAgo(ts: number): string {
        if (!ts) return '—'
        const delta = Date.now() - ts
        if (delta < 0) return 'just now'
        const s = Math.floor(delta / 1000)
        if (s < 45) return `${s}s ago`
        const m = Math.floor(s / 60)
        if (m < 60) return `${m}m ago`
        const h = Math.floor(m / 60)
        if (h < 24) return `${h}h ago`
        const d = Math.floor(h / 24)
        if (d < 30) return `${d}d ago`
        const mo = Math.floor(d / 30)
        if (mo < 12) return `${mo}mo ago`
        const y = Math.floor(d / 365)
        return `${y}y ago`
    }

    ngOnDestroy(): void {
        if (this.refreshTicker) {
            clearInterval(this.refreshTicker)
            this.refreshTicker = null
        }
        if (this.copiedTimer) {
            clearTimeout(this.copiedTimer)
            this.copiedTimer = null
        }
        if (this.setupResultTimer) {
            clearTimeout(this.setupResultTimer)
            this.setupResultTimer = null
        }
        document.removeEventListener('click', this.docClickListener, true)
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

    /**
     * Scan every settings.json we can get to — Windows home dir plus one per
     * active WSL distro — and report how many of `HOOK_EVENTS` are wired up
     * in each. Matching is done by substring (`tabby-claude-status` +
     * `hook.js`) rather than exact absolute path, so a command like
     * `"/mnt/c/Program Files/nodejs/node.exe" "C:\\...\\tabby-claude-status\\hook.js"`
     * inside a WSL settings file is correctly recognised as "our hook".
     */
    checkHooks(): void {
        const locations: HookLocationStatus[] = []

        // Windows ~/.claude/settings.json
        locations.push(
            this.analyseSettingsFile('Windows', path.join(os.homedir(), '.claude', 'settings.json')),
        )

        // Each WSL distro has its own ~/.claude/settings.json. Enumerate via
        // `wsl.exe -l -q` and read via the \\wsl.localhost UNC mount.
        if (process.platform === 'win32') {
            for (const distro of this.getWslDistros()) {
                const settingsPath = this.findWslSettingsPath(distro)
                if (settingsPath) {
                    locations.push(this.analyseSettingsFile(`WSL ${distro}`, settingsPath))
                } else {
                    locations.push({
                        label: `WSL ${distro}`,
                        path: `\\\\wsl.localhost\\${distro}\\home\\<user>\\.claude\\settings.json`,
                        state: 'no-file',
                        totalEvents: HOOK_EVENTS.length,
                        configuredEvents: 0,
                        missingEvents: [...HOOK_EVENTS],
                    })
                }
            }
        }

        this.hookLocations = locations

        // Aggregate: ok if every location is ok; partial if any location has
        // ≥1 event configured; missing otherwise.
        const anyOk = locations.some(l => l.state === 'ok')
        const anyPartial = locations.some(l => l.configuredEvents > 0)
        const allOk = locations.length > 0 && locations.every(l => l.state === 'ok')
        if (allOk) {
            this.hooksStatus = 'ok'
        } else if (anyOk || anyPartial) {
            this.hooksStatus = 'partial'
        } else if (locations.some(l => l.state === 'error')) {
            this.hooksStatus = 'error'
        } else {
            this.hooksStatus = 'missing'
        }
    }

    /**
     * True if the event is wired up to our hook.js in at least one of the
     * scanned settings.json files. Drives the green tick in the help popover
     * so users can see at a glance which events they have coverage for.
     */
    isHookEventConfigured(event: string): boolean {
        return this.hookLocations.some(
            loc => loc.state !== 'no-file'
                && loc.state !== 'error'
                && !loc.missingEvents.includes(event),
        )
    }

    private analyseSettingsFile(label: string, settingsPath: string): HookLocationStatus {
        const base: HookLocationStatus = {
            label,
            path: settingsPath,
            state: 'no-file',
            totalEvents: HOOK_EVENTS.length,
            configuredEvents: 0,
            missingEvents: [...HOOK_EVENTS],
        }
        try {
            if (!fs.existsSync(settingsPath)) return base
            const raw = fs.readFileSync(settingsPath, 'utf-8')
            const settings = JSON.parse(raw)
            const hooks = (settings && settings.hooks) || {}
            const missing: string[] = []
            let configured = 0
            for (const event of HOOK_EVENTS) {
                const groups: any[] = hooks[event] || []
                const hit = groups.some((group: any) => {
                    const inner: any[] = (group && group.hooks) || []
                    return inner.some(h => this.isTabbyHookCommand(h && h.command))
                })
                if (hit) configured++
                else missing.push(event)
            }
            return {
                ...base,
                state:
                    configured === HOOK_EVENTS.length
                        ? 'ok'
                        : configured > 0
                          ? 'partial'
                          : 'missing',
                configuredEvents: configured,
                missingEvents: missing,
            }
        } catch (e: any) {
            return { ...base, state: 'error', error: e?.message || String(e) }
        }
    }

    /**
     * Recognise a hook command that invokes this plugin's hook.js, no matter
     * which node binary (win32 node, WSL node, /mnt/c/... passthrough) or
     * path style (forward/backward slashes, escaped backslashes) it uses.
     */
    private isTabbyHookCommand(command: unknown): boolean {
        if (typeof command !== 'string' || !command) return false
        const lower = command.toLowerCase().replace(/\\\\/g, '\\')
        return lower.includes('tabby-claude-status') && lower.includes('hook.js')
    }

    private getWslDistros(): string[] {
        try {
            const out = execFileSync('wsl.exe', ['-l', '-q'], {
                encoding: 'utf16le',
                timeout: 5000,
                windowsHide: true,
            })
            return out
                .split(/\r?\n/)
                .map(s => s.replace(/\0/g, '').trim())
                .filter(Boolean)
                .filter(d => !/^(rancher-desktop|docker-desktop)/i.test(d))
        } catch {
            return []
        }
    }

    /**
     * WSL distros expose their filesystem at `\\wsl.localhost\<distro>\`.
     * We don't know the Linux username up-front (it differs from the Windows
     * USERPROFILE), so we enumerate /home and look for the first entry that
     * has a `.claude/settings.json` — matches the way Claude Code discovers
     * its own config.
     */
    private findWslSettingsPath(distro: string): string | null {
        const homeRoot = `\\\\wsl.localhost\\${distro}\\home`
        let users: string[] = []
        try {
            users = fs.readdirSync(homeRoot)
        } catch {
            return null
        }
        for (const user of users) {
            const candidate = path.join(homeRoot, user, '.claude', 'settings.json')
            try {
                if (fs.existsSync(candidate)) return candidate
            } catch {
                /* permission hiccup — try next */
            }
        }
        // Root-only distros (rare) keep their settings at /root/.claude/.
        const rootCandidate = `\\\\wsl.localhost\\${distro}\\root\\.claude\\settings.json`
        try {
            if (fs.existsSync(rootCandidate)) return rootCandidate
        } catch {
            /* ignore */
        }
        return null
    }

    onSetupChoice(event: MouseEvent, choice: SetupChoice): void {
        event.preventDefault()
        this.setupDropdownOpen = false
        this.setupHooks(choice)
    }

    setupHooks(choice: SetupChoice): void {
        if (this.setupRunning) return
        this.setupRunning = true
        this.setupResult = null

        const targets: SetupTarget[] = []
        if (choice.target === 'windows' || choice.target === 'all') {
            targets.push({ kind: 'windows', label: 'Windows' })
        }
        if (choice.target === 'wsl' && choice.distro) {
            const settingsPath = this.findWslSettingsPath(choice.distro)
            targets.push({
                kind: 'wsl',
                label: `WSL ${choice.distro}`,
                distro: choice.distro,
                settingsPath: settingsPath ?? this.guessWslSettingsPath(choice.distro),
            })
        }
        if (choice.target === 'all') {
            for (const distro of this.wslDistros) {
                const settingsPath = this.findWslSettingsPath(distro)
                targets.push({
                    kind: 'wsl',
                    label: `WSL ${distro}`,
                    distro,
                    settingsPath: settingsPath ?? this.guessWslSettingsPath(distro),
                })
            }
        }

        const successes: string[] = []
        const failures: string[] = []
        for (const target of targets) {
            try {
                this.writeHooksToTarget(target)
                successes.push(target.label)
            } catch (e: any) {
                console.error(`[claude-status] Failed to setup hooks for ${target.label}:`, e)
                failures.push(`${target.label}: ${e?.message || e}`)
            }
        }

        this.setupRunning = false
        if (failures.length === 0) {
            this.setupResult = {
                kind: 'ok',
                message: `Configured ${successes.join(', ')}`,
            }
        } else {
            this.setupResult = {
                kind: 'error',
                message: `Failed: ${failures.join(' · ')}`,
            }
        }
        if (this.setupResultTimer) clearTimeout(this.setupResultTimer)
        this.setupResultTimer = setTimeout(() => {
            this.setupResult = null
            this.setupResultTimer = null
        }, 6000)
        this.checkHooks()
    }

    private writeHooksToTarget(target: SetupTarget): void {
        const settingsPath = target.kind === 'windows'
            ? path.join(os.homedir(), '.claude', 'settings.json')
            : target.settingsPath
        if (!settingsPath) {
            throw new Error('Could not resolve settings.json path')
        }

        const dir = path.dirname(settingsPath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }

        let settings: any = {}
        if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        }
        if (!settings.hooks) settings.hooks = {}

        const hookCmd = this.buildHookCmd(target.kind)

        for (const event of HOOK_EVENTS) {
            if (!settings.hooks[event]) settings.hooks[event] = []
            const matcherGroups: any[] = settings.hooks[event]

            // Replace any existing tabby-claude-status hook in place. Match by
            // our `isTabbyHookCommand` so we don't accidentally clobber the
            // user's other hook.js entries (e.g. agent-flow/hook.js,
            // Claude-Code-Agent-Monitor/hook-handler.js) — that was the bug
            // before, where any command containing "hook.js" got overwritten.
            let found = false
            for (const group of matcherGroups) {
                if (!group.hooks) continue
                const idx = group.hooks.findIndex(
                    (h: any) => h?.type === 'command' && this.isTabbyHookCommand(h.command),
                )
                if (idx >= 0) {
                    group.hooks[idx] = hookCmd
                    found = true
                    break
                }
            }
            if (!found) {
                matcherGroups.push({ hooks: [hookCmd] })
            }
        }

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    }

    /**
     * Build the hook command string for the requested target.
     *
     * Windows: native `"<node.exe>" "<hook.js>"` — both args are JS strings
     * with single backslashes; JSON.stringify escapes them on write.
     *
     * WSL: bash invokes the Windows `node.exe` via the `/mnt/<drive>/…`
     * passthrough, then passes the Windows `hook.js` path as its argv. Inside
     * bash double quotes, `\\` collapses to `\` — so we need to write `\\`
     * pairs to the JSON file, which means our JS string holds doubled
     * backslashes (`\\\\` source → `\\` in memory → `\\\\` on disk).
     */
    private buildHookCmd(kind: 'windows' | 'wsl'): { type: 'command'; command: string } {
        const hookJs = this.hookJsPath || this.getHookJsPath()
        if (kind === 'windows') {
            const node = this.nodeInfo.path ? `"${this.nodeInfo.path}"` : 'node'
            return { type: 'command', command: `${node} "${hookJs}"` }
        }
        const nodeWindowsPath = this.nodeInfo.path || 'C:\\Program Files\\nodejs\\node.exe'
        const nodeWslPath = this.toWslMountPath(nodeWindowsPath)
        // Double the backslashes so bash's `"…"` quote-unescaping yields a
        // single backslash per separator when calling node.exe.
        const hookJsForBash = hookJs.replace(/\\/g, '\\\\')
        return { type: 'command', command: `"${nodeWslPath}" "${hookJsForBash}"` }
    }

    private toWslMountPath(winPath: string): string {
        const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/)
        if (!m) return winPath
        return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
    }

    /**
     * Path to use when `findWslSettingsPath` returns null (no settings.json
     * exists yet) — we want to create one in the canonical location for the
     * distro's primary user.
     */
    private guessWslSettingsPath(distro: string): string {
        const homeRoot = `\\\\wsl.localhost\\${distro}\\home`
        try {
            const users = fs.readdirSync(homeRoot)
            if (users.length > 0) {
                return path.join(homeRoot, users[0], '.claude', 'settings.json')
            }
        } catch {
            /* fall through */
        }
        return `\\\\wsl.localhost\\${distro}\\root\\.claude\\settings.json`
    }
}

interface SetupChoice {
    target: 'windows' | 'wsl' | 'all'
    distro?: string
}

interface SetupTarget {
    kind: 'windows' | 'wsl'
    label: string
    distro?: string
    settingsPath?: string
}
