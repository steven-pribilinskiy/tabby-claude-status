import { Component, OnDestroy, OnInit } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { AudioService } from '../services/audioService'
import {
    AudioMode,
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
import { PiperInstallerService, PiperVoiceCatalogEntry } from '../services/piperInstallerService'
import { OnlineSoundEntry, SoundEntry, SoundService } from '../services/soundService'
import { ActivityLogEntry, StatusActivityLogService } from '../services/statusActivityLogService'
import { ClaudeApiService } from '../services/claudeApiService'
import { ClaudeCredentialsService, CredentialsStatus } from '../services/claudeCredentialsService'
import { TranscriptReaderService } from '../services/transcriptReaderService'
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
            color: var(--bs-body-color, #ddd);
            background: transparent;
            padding: 0;
        }

        .history-group {
            border-bottom: 1px solid var(--bs-border-color, rgba(128, 128, 128, 0.25));
        }
        .history-group:last-child {
            border-bottom: none;
        }
        .history-group-header {
            display: flex;
            align-items: center;
            gap: 0.25rem;
            width: 100%;
            padding: 0.5rem 0.75rem;
            background: transparent;
            border: 0;
            text-align: left;
            color: var(--bs-body-color, inherit);
            cursor: pointer;
        }
        .history-group-header:hover {
            background: rgba(128, 128, 128, 0.08);
        }
        .history-group-header code {
            background: transparent;
            color: var(--bs-secondary-color, #888);
            padding: 0;
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

        /* Hover-triggered help popover. The wrapper is the hover target so
           the popover stays visible while the cursor moves into it (only the
           wrapper's :hover state controls visibility). */
        .help-popover-wrap {
            position: relative;
            display: inline-flex;
            align-items: center;
        }
        .help-popover-wrap .help-trigger {
            background: transparent;
            border: 0;
            padding: 0;
            margin: 0;
            line-height: 1;
            color: var(--bs-secondary-color, #888);
            cursor: help;
            font-size: 0.95em;
        }
        .help-popover-wrap .help-trigger:hover,
        .help-popover-wrap .help-trigger:focus {
            color: var(--bs-info, #0dcaf0);
            outline: none;
        }
        .help-popover {
            position: absolute;
            top: calc(100% + 6px);
            left: 0;
            z-index: 1000;
            min-width: 360px;
            max-width: 480px;
            padding: 0.75rem 0.875rem;
            background: var(--bs-body-bg, #1f1f1f);
            color: var(--bs-body-color, #e6e6e6);
            border: 1px solid var(--bs-border-color, rgba(128, 128, 128, 0.45));
            border-radius: 0.375rem;
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
            font-size: 0.85em;
            line-height: 1.45;
            opacity: 0;
            visibility: hidden;
            transform: translateY(-2px);
            transition: opacity 0.12s ease-out, transform 0.12s ease-out, visibility 0s linear 0.12s;
            pointer-events: none;
        }
        .help-popover-wrap:hover .help-popover,
        .help-popover-wrap:focus-within .help-popover {
            opacity: 1;
            visibility: visible;
            transform: translateY(0);
            pointer-events: auto;
            transition-delay: 0s;
        }
        .help-popover h6 {
            margin: 0 0 0.5rem 0;
            font-size: 0.95em;
            font-weight: 600;
        }
        .help-popover p {
            margin: 0 0 0.5rem 0;
        }
        .help-popover p:last-child {
            margin-bottom: 0;
        }
        .help-popover code {
            background: rgba(128, 128, 128, 0.15);
            padding: 0.05rem 0.3rem;
            border-radius: 0.2rem;
            font-size: 0.92em;
        }
        .help-popover ul {
            margin: 0 0 0.5rem 0;
            padding-left: 1.1rem;
        }
        .help-popover li { margin-bottom: 0.2rem; }
        .help-popover li:last-child { margin-bottom: 0; }
        .help-popover.help-popover-right {
            left: auto;
            right: 0;
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
            /* Use the theme's body color at reduced opacity so inactive tabs
               stay legible on both Tabby's dark chrome (where
               --bs-secondary-color renders as near-black on near-black) and
               the lighter settings surface. currentColor + opacity adapts to
               whichever theme is in play without needing per-theme overrides. */
            color: inherit;
            opacity: 0.55;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            margin-bottom: -1px;
        }
        .settings-tabs .nav-link:hover {
            color: inherit;
            opacity: 0.85;
            background-color: rgba(128, 128, 128, 0.12);
        }
        .settings-tabs .nav-link.active {
            color: inherit;
            opacity: 1;
            background-color: var(--bs-body-bg, transparent);
            border-color: var(--bs-border-color, rgba(128, 128, 128, 0.35));
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
            <h5>Audio</h5>

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
                    <label class="form-label">Output mode</label>
                    <div class="d-flex gap-3">
                        <label class="form-check" style="cursor: pointer">
                            <input class="form-check-input" type="radio"
                                name="audio-mode" value="tts"
                                [checked]="config.store.claudeStatus.audio.mode === 'tts'"
                                (change)="onModeChange('tts')" />
                            <span class="form-check-label ms-1">Text-to-speech</span>
                        </label>
                        <label class="form-check" style="cursor: pointer">
                            <input class="form-check-input" type="radio"
                                name="audio-mode" value="sound"
                                [checked]="config.store.claudeStatus.audio.mode === 'sound'"
                                (change)="onModeChange('sound')" />
                            <span class="form-check-label ms-1">Sound effects</span>
                        </label>
                        <label class="form-check" style="cursor: pointer">
                            <input class="form-check-input" type="radio"
                                name="audio-mode" value="dynamic"
                                [checked]="config.store.claudeStatus.audio.mode === 'dynamic'"
                                (change)="onModeChange('dynamic')" />
                            <span class="form-check-label ms-1">Dynamic (Claude-generated)</span>
                        </label>
                    </div>
                    <div class="form-text">
                        Switching modes preserves your TTS phrases, sound mappings, and dynamic
                        prompts — nothing is lost when you flip back.
                    </div>
                </div>

                <!-- ===== DYNAMIC MODE ===== -->
                <div *ngIf="config.store.claudeStatus.audio.mode === 'dynamic'">
                    <div class="d-flex align-items-center gap-2 mb-1">
                        <h6 class="mb-0">Dynamic phrase generation</h6>
                        <span class="help-popover-wrap">
                            <button class="help-trigger" type="button"
                                    aria-label="How dynamic mode authenticates"
                                    tabindex="0"
                                    (click)="$event.preventDefault()">
                                <i class="fas fa-question-circle"></i>
                            </button>
                            <div class="help-popover" role="tooltip">
                                <h6>How dynamic mode authenticates</h6>
                                <p>
                                    The plugin reads your existing Claude Code login from
                                    <code>~/.claude/.credentials.json</code> and uses the OAuth
                                    access token Claude Code already manages — no API key setup
                                    required.
                                </p>
                                <p>Each request sends:</p>
                                <ul>
                                    <li><code>Authorization: Bearer &lt;oauth-token&gt;</code></li>
                                    <li><code>anthropic-beta: oauth-2025-04-20</code></li>
                                    <li><code>anthropic-version: 2023-06-01</code></li>
                                </ul>
                                <p>
                                    Calls bill against your Claude
                                    <strong>Max</strong>/<strong>Pro</strong> subscription, not a
                                    paid API key. The required scope is
                                    <code>user:inference</code>, which Claude Code grants by default.
                                </p>
                                <p>
                                    <strong>Token refresh:</strong> the plugin doesn't refresh the
                                    OAuth token itself — running <code>claude</code> in any
                                    terminal triggers Claude Code's own refresh, and the plugin
                                    re-reads the file (30 s read cache). If you see "Subscription
                                    token expired", run <code>claude</code> and click the
                                    <i class="fas fa-sync-alt"></i> refresh icon.
                                </p>
                                <p>
                                    <strong>Fallback:</strong> if the subscription isn't usable
                                    (not signed in, missing scope, can't read the file), an
                                    Anthropic API-key field appears below.
                                </p>
                            </div>
                        </span>
                    </div>
                    <p class="text-muted small mb-2">
                        Claude Haiku 4.5 writes a short, context-aware announcement based on the
                        actual hook event (last assistant message, tool name, etc.) — so you'll
                        hear "tests passing" instead of "I'm done". Calls run async and are
                        bounded by a per-status timeout; if the API is slow or fails, the static
                        phrases below are spoken instead.
                    </p>

                    <!-- Subscription status (primary auth path) -->
                    <div *ngIf="credStatus" class="claude-alert mb-2"
                         [class.claude-alert-success]="credStatus.state === 'ok'"
                         [class.claude-alert-warning]="credStatus.state === 'expired' || credStatus.state === 'no-inference-scope'"
                         [class.claude-alert-danger]="credStatus.state === 'missing-file' || credStatus.state === 'no-oauth' || credStatus.state === 'read-error'"
                         style="max-width: 700px">
                        <div class="d-flex align-items-center gap-2 flex-wrap">
                            <i class="fas"
                               [class.fa-check-circle]="credStatus.state === 'ok'"
                               [class.fa-exclamation-triangle]="credStatus.state !== 'ok'"></i>
                            <strong *ngIf="credStatus.state === 'ok'">
                                Using Claude Code subscription
                                <span *ngIf="credStatus.creds?.subscriptionType"
                                      class="badge text-bg-secondary text-uppercase ms-1">
                                    {{credStatus.creds!.subscriptionType}}
                                </span>
                            </strong>
                            <strong *ngIf="credStatus.state === 'expired'">Subscription token expired</strong>
                            <strong *ngIf="credStatus.state === 'missing-file'">Claude Code not signed in</strong>
                            <strong *ngIf="credStatus.state === 'no-oauth'">Claude Code credentials incomplete</strong>
                            <strong *ngIf="credStatus.state === 'no-inference-scope'">Subscription token can't call /v1/messages</strong>
                            <strong *ngIf="credStatus.state === 'read-error'">Couldn't read credentials.json</strong>
                            <button class="btn btn-sm btn-outline-secondary ms-auto"
                                    type="button"
                                    (click)="refreshCredStatus()"
                                    title="Re-read ~/.claude/.credentials.json">
                                <i class="fas fa-sync-alt"></i>
                            </button>
                        </div>
                        <div *ngIf="credStatus.state === 'ok' && credStatus.creds" class="small text-muted mt-1">
                            <span *ngIf="credStatus.creds.expiresAt > 0">
                                Token valid until {{formatExpiry(credStatus.creds.expiresAt)}}.
                            </span>
                            <span *ngIf="credStatus.creds.rateLimitTier" class="ms-1">
                                Rate-limit tier: <code>{{credStatus.creds.rateLimitTier}}</code>.
                            </span>
                            Calls bill against your subscription, not an API key.
                        </div>
                        <div *ngIf="credStatus.state !== 'ok'" class="small mt-1">
                            {{credStatus.detail}}
                            <span *ngIf="credStatus.state === 'expired'" class="d-block mt-1">
                                Run <code>claude</code> in any terminal — Claude Code refreshes the
                                token on startup. Then click the refresh icon above.
                            </span>
                            <span *ngIf="credStatus.state === 'missing-file'" class="d-block mt-1">
                                Or paste an API key below as a fallback.
                            </span>
                        </div>
                        <div class="small text-muted mt-1">
                            <code>{{credStatus.filePath}}</code>
                        </div>
                    </div>

                    <!-- API key fallback (only shown when subscription isn't usable) -->
                    <div *ngIf="!credStatus || credStatus.state !== 'ok'" class="form-group mb-3">
                        <label class="form-label">Anthropic API key (fallback)</label>
                        <input type="password" class="form-control" style="max-width: 480px"
                               [(ngModel)]="config.store.claudeStatus.audio.dynamic.apiKey"
                               (ngModelChange)="save()"
                               placeholder="sk-ant-..." autocomplete="off" />
                        <div class="form-text">
                            Used only when the Claude Code subscription above isn't available.
                            Get one at
                            <a href="#" (click)="openUrl('https://console.anthropic.com/settings/keys', $event)">
                                console.anthropic.com
                            </a>.
                        </div>
                    </div>

                    <div class="row mb-3" style="max-width: 700px">
                        <div class="col-4">
                            <label class="form-label">Model</label>
                            <input type="text" class="form-control"
                                   [(ngModel)]="config.store.claudeStatus.audio.dynamic.model"
                                   (ngModelChange)="save()"
                                   placeholder="claude-haiku-4-5" />
                        </div>
                        <div class="col-4">
                            <label class="form-label">Max output tokens</label>
                            <input type="number" class="form-control"
                                   [(ngModel)]="config.store.claudeStatus.audio.dynamic.maxOutputTokens"
                                   (ngModelChange)="save()"
                                   min="8" max="128" step="4" />
                        </div>
                        <div class="col-4">
                            <label class="form-label">Timeout (ms)</label>
                            <input type="number" class="form-control"
                                   [(ngModel)]="config.store.claudeStatus.audio.dynamic.timeoutMs"
                                   (ngModelChange)="save()"
                                   min="200" max="10000" step="100" />
                        </div>
                    </div>

                    <div *ngFor="let s of dynamicStatuses" class="card mb-2"
                         style="max-width: 900px">
                        <div class="card-body py-2 px-3">
                            <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
                                <toggle
                                    [(ngModel)]="config.store.claudeStatus.audio.dynamic.perStatus[s].enabled"
                                    (ngModelChange)="save()"
                                ></toggle>
                                <label class="toggle-label mb-0 text-capitalize"
                                       (click)="toggleField(config.store.claudeStatus.audio.dynamic.perStatus[s], 'enabled')">
                                    <strong>{{s}}</strong> — generate dynamically
                                </label>
                                <span class="text-muted small ms-2">
                                    Falls back to "{{config.store.claudeStatus.audio.statusTexts[s]}}" on miss
                                </span>
                                <button class="btn btn-sm btn-outline-secondary ms-auto"
                                        type="button"
                                        [disabled]="dynamicTesting === s"
                                        (click)="testDynamicPhrase(s)">
                                    <span *ngIf="dynamicTesting !== s">
                                        <i class="fas fa-flask me-1"></i>Test
                                    </span>
                                    <span *ngIf="dynamicTesting === s">Generating…</span>
                                </button>
                            </div>

                            <div *ngIf="config.store.claudeStatus.audio.dynamic.perStatus[s].enabled">
                                <div class="toggle-row mb-2 ms-4">
                                    <toggle
                                        [(ngModel)]="config.store.claudeStatus.audio.dynamic.perStatus[s].transcriptOnly"
                                        (ngModelChange)="save()"
                                    ></toggle>
                                    <label class="toggle-label small"
                                           (click)="toggleField(config.store.claudeStatus.audio.dynamic.perStatus[s], 'transcriptOnly')">
                                        Transcript-only (no API call, zero token cost)
                                    </label>
                                </div>

                                <div *ngIf="!config.store.claudeStatus.audio.dynamic.perStatus[s].transcriptOnly">
                                    <label class="form-label small mb-1">Prompt template</label>
                                    <textarea class="form-control form-control-sm font-monospace"
                                              rows="4"
                                              [(ngModel)]="config.store.claudeStatus.audio.dynamic.perStatus[s].promptTemplate"
                                              (ngModelChange)="save()"></textarea>
                                    <div class="form-text small">
                                        Placeholders:
                                        <code>{{ '{status}' }}</code>
                                        <code>{{ '{eventName}' }}</code>
                                        <code>{{ '{tool}' }}</code>
                                        <code>{{ '{message}' }}</code>
                                        <code>{{ '{type}' }}</code>
                                        <code>{{ '{lastAssistant}' }}</code>
                                        <code>{{ '{lastUserPrompt}' }}</code>
                                        <code>{{ '{lastToolName}' }}</code>
                                        <code>{{ '{cwd}' }}</code>
                                        <code>{{ '{sessionId}' }}</code>
                                    </div>
                                </div>

                                <div *ngIf="dynamicTestResult && dynamicTestResult.status === s"
                                     class="claude-alert mt-2 small"
                                     [class.claude-alert-success]="dynamicTestResult.kind === 'ok'"
                                     [class.claude-alert-danger]="dynamicTestResult.kind === 'error'">
                                    <strong>{{dynamicTestResult.kind === 'ok' ? 'Generated:' : 'Error:'}}</strong>
                                    {{dynamicTestResult.message}}
                                </div>
                            </div>
                        </div>
                    </div>

                    <p class="text-muted small mt-2">
                        Static fallback phrases live below — same UI as the TTS mode. They are
                        spoken when dynamic generation fails, times out, or is disabled for the
                        status.
                    </p>
                </div>

                <!-- ===== TTS / DYNAMIC MODE (shares the TTS backend + statusTexts) ===== -->
                <div *ngIf="config.store.claudeStatus.audio.mode === 'tts' || config.store.claudeStatus.audio.mode === 'dynamic'">
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
                    <div class="small mb-1">
                        <span class="text-muted me-2">Piper home:</span>
                        <a href="#" (click)="openUrl(piperInstaller.homepageUrl, $event)">
                            {{piperInstaller.homepageUrl}}
                        </a>
                    </div>
                    <div class="small mb-2">
                        <span class="text-muted me-2">Voices:</span>
                        <a href="#" (click)="openUrl(piperInstaller.voicesUrl, $event)">
                            huggingface.co/rhasspy/piper-voices
                        </a>
                        <span class="text-muted ms-2">
                            — download both <code>.onnx</code> and <code>.onnx.json</code> for a voice
                            and save them next to the configured Piper model below; restart Tabby
                            to pick up the new voice.
                        </span>
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

                    <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
                        <button class="btn btn-sm btn-primary"
                                [disabled]="piperInstalling"
                                (click)="installPiper()">
                            <span *ngIf="!piperInstalling && !piperInstalled">Install Piper + default voice</span>
                            <span *ngIf="!piperInstalling && piperInstalled">Reinstall</span>
                            <span *ngIf="piperInstalling">Installing…</span>
                        </button>
                        <button class="btn btn-sm btn-outline-primary"
                                [disabled]="piperInstalling || !piperInstalled"
                                (click)="openPiperVoiceCatalog()"
                                title="Browse the official rhasspy/piper-voices catalog and install voices into the Piper models folder.">
                            <i class="fas fa-cloud-download-alt me-1"></i>
                            Browse voices…
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

                <!-- Status Phrases (TTS mode only) -->
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
                </div><!-- /TTS mode -->

                <!-- ===== SOUND MODE ===== -->
                <div *ngIf="config.store.claudeStatus.audio.mode === 'sound'">
                    <div class="row mb-3">
                        <div class="col-4">
                            <label class="form-label">Volume ({{config.store.claudeStatus.audio.volume | number:'1.1-1'}})</label>
                            <input type="range" class="form-range" min="0" max="1" step="0.1"
                                [(ngModel)]="config.store.claudeStatus.audio.volume" (ngModelChange)="save()" />
                        </div>
                    </div>

                    <div class="d-flex gap-2 align-items-center mb-3 flex-wrap">
                        <button class="btn btn-sm btn-outline-primary"
                                (click)="openOnlineCatalog()">
                            <i class="fas fa-cloud-download-alt me-1"></i>
                            Browse online catalog…
                        </button>
                        <button class="btn btn-sm btn-outline-secondary"
                                (click)="refreshSoundLibrary()"
                                [disabled]="soundsLoading">
                            <i class="fas fa-sync me-1"></i>
                            {{soundsLoading ? 'Refreshing…' : 'Refresh library'}}
                        </button>
                        <button class="btn btn-sm btn-link"
                                (click)="openSoundCacheDir()"
                                [title]="soundCacheDir">
                            <i class="fas fa-folder me-1"></i>
                            Open downloaded-sounds folder
                        </button>
                    </div>

                    <div *ngIf="soundsLoading" class="form-text text-muted">Loading sound library…</div>
                    <div *ngIf="!soundsLoading && soundGroups.length === 0" class="claude-alert claude-alert-warning mb-3">
                        No sound files found yet. Use "Browse online catalog…" to download some,
                        or pick a custom file from the dropdowns below.
                    </div>

                    <h6>Status Sounds</h6>
                    <p class="text-muted small">Leave blank to skip the sound for that status.</p>
                    <div class="row mb-2 align-items-center" *ngFor="let status of phraseStatuses">
                        <div class="col-2">
                            <label class="form-label text-capitalize mb-0">{{status}}</label>
                        </div>
                        <div class="col-7">
                            <select class="form-control"
                                    [ngModel]="getSelectedSoundId(status)"
                                    (ngModelChange)="onSoundChange(status, $event)">
                                <option value="">(none)</option>
                                <optgroup *ngFor="let g of soundGroups" [label]="g.groupLabel">
                                    <option *ngFor="let s of g.sounds" [value]="s.id">{{s.label}}</option>
                                </optgroup>
                                <optgroup label="Custom">
                                    <option value="__custom__">Pick a file…</option>
                                </optgroup>
                            </select>
                            <div *ngIf="getSelectedSoundId(status) && !getSelectedSoundLabel(status)"
                                 class="form-text text-warning">
                                {{getSelectedSoundId(status)}}
                            </div>
                        </div>
                        <div class="col-3 d-flex gap-1">
                            <button class="btn btn-sm btn-outline-info"
                                    [disabled]="!getSelectedSoundId(status)"
                                    (click)="testSound(status)">Test</button>
                            <button class="btn btn-sm btn-outline-secondary"
                                    [disabled]="!getSelectedSoundId(status)"
                                    (click)="clearStatusSound(status)"
                                    title="Clear">✕</button>
                        </div>
                    </div>
                </div><!-- /sound mode -->

                <!-- ===== SHARED MUTE CONDITIONS ===== -->
                <h6 class="mt-4">Mute conditions</h6>
                <p class="text-muted small">Suppress audio in contexts where it would interrupt voice work.</p>

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
                        Detected via the Zoom.exe window title.
                    </div>
                </div>

                <div class="form-group mb-3">
                    <div class="toggle-row mb-1">
                        <toggle
                            [(ngModel)]="config.store.claudeStatus.audio.muteTtsDuringMicActive"
                            (ngModelChange)="save()"
                        ></toggle>
                        <label class="toggle-label"
                               (click)="toggleField(config.store.claudeStatus.audio, 'muteTtsDuringMicActive')">
                            Mute TTS while microphone is in use (any app)
                        </label>
                    </div>
                </div>

                <div class="form-group mb-3">
                    <div class="toggle-row mb-1">
                        <toggle
                            [(ngModel)]="config.store.claudeStatus.audio.muteSoundDuringMicActive"
                            (ngModelChange)="save()"
                        ></toggle>
                        <label class="toggle-label"
                               (click)="toggleField(config.store.claudeStatus.audio, 'muteSoundDuringMicActive')">
                            Mute sound effects while microphone is in use (any app)
                        </label>
                    </div>
                    <div class="form-text ms-4">
                        Mic detection covers Zoom, Teams, Discord, Windows Voice Access,
                        browser voice input, dictation tools, etc. — read from the same
                        registry that powers Settings → Privacy → Microphone.
                    </div>
                </div>
            </div><!-- /audio.enabled -->

            <!-- ===== ONLINE CATALOG MODAL ===== -->
            <div *ngIf="showOnlineCatalog"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9000;
                        display: flex; align-items: center; justify-content: center; padding: 2rem;"
                 (click)="closeOnlineCatalog()">
                <div style="background: var(--bs-body-bg, #1b1b1b); color: var(--bs-body-color, #ddd);
                            border-radius: 8px; max-width: 800px; width: 100%; max-height: 80vh;
                            overflow: hidden; display: flex; flex-direction: column;
                            box-shadow: 0 10px 40px rgba(0,0,0,0.6);"
                     (click)="$event.stopPropagation()">
                    <div class="d-flex align-items-center justify-content-between p-3 border-bottom">
                        <h5 class="m-0">Online sound catalog</h5>
                        <button class="btn btn-sm btn-link" (click)="closeOnlineCatalog()">✕</button>
                    </div>
                    <div class="p-3" style="overflow-y: auto; flex: 1;">
                        <div *ngIf="onlineCatalogLoading" class="text-muted">Loading catalog…</div>
                        <div *ngIf="onlineCatalogError" class="claude-alert claude-alert-warning mb-3">
                            {{onlineCatalogError}}
                        </div>
                        <div *ngIf="downloadAllResult" class="claude-alert claude-alert-success mb-3">
                            {{downloadAllResult}}
                        </div>

                        <div *ngIf="!onlineCatalogLoading && onlineCatalog.length > 0" class="mb-3">
                            <button class="btn btn-sm btn-primary"
                                    [disabled]="downloadingId === '__all__'"
                                    (click)="downloadAllCatalog()">
                                {{downloadingId === '__all__' ? 'Downloading all…' : 'Download all to library'}}
                            </button>
                        </div>

                        <table *ngIf="!onlineCatalogLoading && onlineCatalog.length > 0"
                               class="table table-sm" style="width: 100%;">
                            <thead>
                                <tr>
                                    <th>Sound</th>
                                    <th>Category</th>
                                    <th>License</th>
                                    <th class="text-end">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let entry of onlineCatalog">
                                    <td>
                                        <div>{{entry.label}}</div>
                                        <div *ngIf="entry.attribution" class="small text-muted">
                                            {{entry.attribution}}
                                        </div>
                                    </td>
                                    <td>{{entry.category || '—'}}</td>
                                    <td class="small">{{entry.license}}</td>
                                    <td class="text-end">
                                        <button class="btn btn-sm btn-link"
                                                (click)="previewCatalogEntry(entry)"
                                                title="Preview">▶</button>
                                        <button class="btn btn-sm btn-outline-primary"
                                                [disabled]="downloadingId === entry.id || isDownloaded(entry)"
                                                (click)="downloadCatalogEntry(entry)">
                                            <span *ngIf="downloadingId === entry.id">…</span>
                                            <span *ngIf="downloadingId !== entry.id && isDownloaded(entry)">In library</span>
                                            <span *ngIf="downloadingId !== entry.id && !isDownloaded(entry)">Download</span>
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- Piper voice catalog modal -->
            <div *ngIf="showPiperVoiceCatalog"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9000;
                        display: flex; align-items: center; justify-content: center; padding: 2rem;"
                 (click)="closePiperVoiceCatalog()">
                <div style="background: var(--bs-body-bg, #1b1b1b); color: var(--bs-body-color, #ddd);
                            border-radius: 8px; max-width: 900px; width: 100%; max-height: 80vh;
                            overflow: hidden; display: flex; flex-direction: column;
                            box-shadow: 0 10px 40px rgba(0,0,0,0.6);"
                     (click)="$event.stopPropagation()">
                    <div class="d-flex align-items-center justify-content-between p-3 border-bottom">
                        <h5 class="m-0">Piper voice catalog</h5>
                        <button class="btn btn-sm btn-link" (click)="closePiperVoiceCatalog()">✕</button>
                    </div>
                    <div class="px-3 pt-3">
                        <div class="d-flex gap-2 flex-wrap mb-2">
                            <select class="form-control form-control-sm"
                                    style="max-width: 240px"
                                    [(ngModel)]="piperCatalogLanguageFilter">
                                <option value="">All languages ({{piperCatalogTotalCount}})</option>
                                <option *ngFor="let lang of piperCatalogLanguageOptions" [value]="lang.code">
                                    {{lang.name}} ({{lang.count}})
                                </option>
                            </select>
                            <input type="text"
                                   class="form-control form-control-sm"
                                   style="flex: 1; min-width: 180px"
                                   placeholder="Filter by name…"
                                   [(ngModel)]="piperCatalogTextFilter" />
                            <button *ngIf="piperCatalogLanguageFilter || piperCatalogTextFilter"
                                    class="btn btn-sm btn-outline-secondary"
                                    type="button"
                                    title="Clear filters"
                                    (click)="clearPiperCatalogFilters()">
                                ✕
                            </button>
                        </div>
                        <div class="small text-muted mb-2">
                            Voices download into <code>{{piperModelsDir}}</code>. Tabby picks them up automatically — no restart required.
                        </div>
                    </div>
                    <div class="p-3 pt-0" style="overflow-y: auto; flex: 1;">
                        <div *ngIf="piperCatalogLoading" class="text-muted">Loading voice catalog from Hugging Face…</div>
                        <div *ngIf="piperCatalogError" class="claude-alert claude-alert-warning mb-3">
                            {{piperCatalogError}}
                        </div>

                        <table *ngIf="!piperCatalogLoading && filteredPiperCatalog.length > 0"
                               class="table table-sm" style="width: 100%;">
                            <thead>
                                <tr>
                                    <th>Voice</th>
                                    <th>Language</th>
                                    <th>Quality</th>
                                    <th class="text-end">Size</th>
                                    <th class="text-end">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let entry of filteredPiperCatalog">
                                    <td>
                                        <div><strong>{{entry.name}}</strong></div>
                                        <div class="small text-muted"><code>{{entry.key}}</code></div>
                                    </td>
                                    <td>{{entry.language}}</td>
                                    <td>{{entry.quality || '—'}}</td>
                                    <td class="text-end small">{{formatBytes(entry.sizeBytes)}}</td>
                                    <td class="text-end">
                                        <button class="btn btn-sm btn-outline-primary"
                                                [disabled]="piperDownloadingKey === entry.key || isPiperVoiceDownloaded(entry.key)"
                                                (click)="downloadPiperVoice(entry)">
                                            <span *ngIf="piperDownloadingKey === entry.key">{{piperDownloadStatus || '…'}}</span>
                                            <span *ngIf="piperDownloadingKey !== entry.key && isPiperVoiceDownloaded(entry.key)">Installed</span>
                                            <span *ngIf="piperDownloadingKey !== entry.key && !isPiperVoiceDownloaded(entry.key)">Download</span>
                                        </button>
                                        <button *ngIf="isPiperVoiceDownloaded(entry.key)"
                                                class="btn btn-sm btn-outline-success ms-1"
                                                (click)="usePiperVoice(entry.key)"
                                                title="Set as the active Piper voice.">
                                            Use
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <div *ngIf="!piperCatalogLoading && filteredPiperCatalog.length === 0 && piperCatalog.length > 0"
                             class="text-muted small">
                            No voices match the current filter.
                        </div>
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
                            [disabled]="previousRunSessions.length === 0"
                            (click)="resumeAllPreviousRun()"
                            title="Open a new tab for every previous-run session and run claude --resume on each.">
                        Resume previous run
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
                        {{activeSessions.length}} active ·
                        {{previousRunSessions.length}} previous run ·
                        {{closedSessions.length}} in history
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
                        {{filteredActiveSessions.length}} of {{activeSessions.length}} active ·
                        {{filteredPreviousRunSessions.length}} of {{previousRunSessions.length}} previous run ·
                        {{filteredClosedSessions.length}} of {{closedSessions.length}} in history match
                    </div>
                </div>

                <h6 class="ms-3 mt-3">Active sessions</h6>
                <table *ngIf="filteredActiveSessions.length > 0" class="table table-sm ms-3 session-table" style="max-width: 900px">
                    <thead>
                        <tr>
                            <th>Session</th>
                            <th class="actions-col"></th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr *ngFor="let s of filteredActiveSessions">
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
                                            title="Open a new tab and run claude --resume <id> --fork-session"
                                            (click)="forkSession(s)">Fork</button>
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
                <div *ngIf="activeSessions.length === 0" class="ms-3 text-muted small mb-3">
                    No active sessions in this Tabby run. Run <code>claude</code> in a Tabby
                    tab — a session appears here as soon as a hook event fires. Sessions
                    Tabby remembers from the previous run are listed below.
                </div>
                <div *ngIf="activeSessions.length > 0 && filteredActiveSessions.length === 0"
                     class="ms-3 text-muted small mb-3">
                    No active sessions match "{{sessionFilter}}".
                </div>

                <div class="ms-3 mt-3" style="max-width: 900px">
                    <button class="btn btn-sm btn-link ps-0 text-decoration-none"
                            (click)="previousRunExpanded = !previousRunExpanded">
                        <i class="fas" [class.fa-chevron-down]="previousRunExpanded"
                                        [class.fa-chevron-right]="!previousRunExpanded"></i>
                        Previous run ({{previousRunSessions.length}}<span *ngIf="sessionFilter">, {{filteredPreviousRunSessions.length}} match</span>)
                    </button>

                    <div *ngIf="previousRunExpanded" class="mt-2">
                        <div class="text-muted small mb-2">
                            Sessions Tabby remembers from the previous run. Click <strong>Fork</strong>
                            to pick up where you left off; otherwise they roll into History next
                            time Tabby restarts.
                        </div>
                        <table *ngIf="filteredPreviousRunSessions.length > 0"
                               class="table table-sm session-table" style="max-width: 900px">
                            <thead>
                                <tr>
                                    <th>Session</th>
                                    <th class="actions-col"></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let s of filteredPreviousRunSessions">
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
                                                    title="Open a new tab and run claude --resume <id>"
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
                        <div *ngIf="previousRunSessions.length === 0" class="text-muted small">
                            Nothing carried over from the previous run.
                        </div>
                        <div *ngIf="previousRunSessions.length > 0 && filteredPreviousRunSessions.length === 0"
                             class="text-muted small">
                            No previous-run sessions match "{{sessionFilter}}".
                        </div>
                    </div>
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
                             style="max-height: 720px; overflow-y: auto; border: 1px solid var(--bs-border-color, #333); border-radius: 4px;">
                            <div *ngFor="let group of groupedClosedSessions"
                                 class="history-group">
                                <button type="button"
                                        class="history-group-header"
                                        (click)="toggleClosedGroup(group.cwd)">
                                    <i class="fas me-1"
                                       [class.fa-chevron-down]="isClosedGroupExpanded(group.cwd)"
                                       [class.fa-chevron-right]="!isClosedGroupExpanded(group.cwd)"></i>
                                    <i class="fas fa-folder me-1 text-muted"></i>
                                    <strong>{{group.basename}}</strong>
                                    <code class="small text-muted ms-2">{{group.cwd}}</code>
                                    <span class="text-muted ms-2 small">
                                        ({{group.sessions.length}})
                                    </span>
                                    <span class="text-muted ms-2 small ms-auto"
                                          [attr.title]="formatTs(group.lastSeen)">
                                        {{timeAgo(group.lastSeen)}}
                                    </span>
                                </button>
                                <table *ngIf="isClosedGroupExpanded(group.cwd)"
                                       class="table table-sm mb-0 session-table">
                                    <tbody>
                                        <tr *ngFor="let s of group.sessions">
                                            <td>
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
                                                            title="Open a new tab and run claude --resume <id>"
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
                <button class="btn btn-sm btn-outline-danger"
                        [disabled]="setupRunning || hooksStatus === 'missing'"
                        (click)="removeHooks({ target: 'all' })"
                        title="Remove tabby-claude-status entries from every detected ~/.claude/settings.json (Windows + WSL).">
                    Uninstall hooks
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

            <!-- Recent activity ─────────────────────────────────────── -->
            <h5 class="mt-4 mb-2 d-flex align-items-center gap-2">
                Recent activity
                <span class="badge text-bg-secondary">{{activityEntries.length}}</span>
                <button class="btn btn-sm btn-outline-secondary ms-auto"
                        (click)="refreshActivityLog()"
                        title="Re-read the activity log from disk">
                    <i class="fas fa-sync-alt"></i>
                </button>
                <button class="btn btn-sm btn-outline-secondary"
                        (click)="copyActivityLogPath()"
                        [title]="activityLogPath">
                    <i class="fas fa-copy"></i>
                    <span class="ms-1">Copy log path</span>
                </button>
                <button class="btn btn-sm btn-outline-danger"
                        [disabled]="activityEntries.length === 0"
                        (click)="clearActivityLog()">
                    Clear
                </button>
            </h5>
            <p class="text-muted small mb-2">
                Every Claude-status event the plugin reacts to. The log persists to
                <code class="small">{{activityLogPath}}</code> so it can be inspected
                from outside Tabby.
                <span *ngIf="!activityFilter">Filter by status to narrow.</span>
            </p>

            <div class="d-flex gap-2 mb-2 flex-wrap" style="max-width: 1100px">
                <select class="form-control form-control-sm" style="max-width: 160px"
                        [(ngModel)]="activityFilter">
                    <option value="">All statuses</option>
                    <option *ngFor="let s of activityStatusFilters" [value]="s">{{s}}</option>
                </select>
                <input type="text" class="form-control form-control-sm"
                       style="flex: 1; min-width: 200px"
                       placeholder="Filter event name / session / payload…"
                       [(ngModel)]="activityTextFilter" />
                <button *ngIf="activityFilter || activityTextFilter"
                        class="btn btn-sm btn-outline-secondary"
                        (click)="activityFilter = ''; activityTextFilter = ''">
                    ✕ Clear filters
                </button>
            </div>

            <div *ngIf="filteredActivityEntries.length === 0" class="text-muted small mb-3">
                <span *ngIf="activityEntries.length === 0">
                    No events recorded yet. Trigger a Claude Code hook (start a session,
                    submit a prompt, finish a turn) and they'll show up here.
                </span>
                <span *ngIf="activityEntries.length > 0">
                    No entries match the current filter.
                </span>
            </div>

            <table *ngIf="filteredActivityEntries.length > 0"
                   class="table table-sm" style="max-width: 1100px">
                <thead>
                    <tr>
                        <th style="width: 80px">Time</th>
                        <th style="width: 90px">Status</th>
                        <th style="width: 150px">Event</th>
                        <th style="width: 130px">Audio outcome</th>
                        <th>Detail</th>
                    </tr>
                </thead>
                <tbody>
                    <tr *ngFor="let e of filteredActivityEntries"
                        [title]="formatActivityTooltip(e)">
                        <td><code class="small">{{formatActivityTime(e.ts)}}</code></td>
                        <td>
                            <span class="badge"
                                  [style.background-color]="activityStatusColor(e.status) + ' !important'"
                                  [style.color]="'#fff !important'">
                                {{e.status}}
                            </span>
                        </td>
                        <td>
                            <code class="small">{{e.eventName || '—'}}</code>
                            <span *ngIf="!e.terminalMatched"
                                  class="badge text-bg-secondary ms-1"
                                  title="Fired from a non-Tabby terminal — global audio only.">
                                global
                            </span>
                        </td>
                        <td>
                            <span class="badge"
                                  [class.text-bg-success]="e.audioOutcome === 'announced'"
                                  [class.text-bg-warning]="e.audioOutcome && e.audioOutcome !== 'announced' && e.audioOutcome !== 'failed'"
                                  [class.text-bg-danger]="e.audioOutcome === 'failed'"
                                  [class.text-bg-secondary]="!e.audioOutcome">
                                {{e.audioOutcome || 'pending'}}
                            </span>
                        </td>
                        <td class="small">
                            <div *ngIf="e.audioPayload">
                                <span class="text-muted">{{e.audioMode === 'sound' ? 'sound' : 'tts'}}:</span>
                                <code class="ms-1">{{e.audioPayload}}</code>
                            </div>
                            <div *ngIf="e.audioOutcomeDetail" class="text-muted">
                                {{e.audioOutcomeDetail}}
                            </div>
                            <div *ngIf="e.metadata?.type" class="text-muted">
                                type: <code>{{e.metadata.type}}</code>
                            </div>
                            <div *ngIf="e.metadata?.tool" class="text-muted">
                                tool: <code>{{e.metadata.tool}}</code>
                            </div>
                            <div *ngIf="e.terminalTitle" class="text-muted">
                                tab: {{e.terminalTitle}}
                            </div>
                            <div *ngIf="e.session" class="text-muted">
                                session: <code>{{e.session.substring(0, 8)}}…</code>
                            </div>
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

    // Sound-mode state. The grouped list is recomputed each time the user
    // opens the audio tab, after a download from the catalog completes, and
    // when "Refresh" is pressed; it isn't tied to change-detection so we
    // populate it eagerly from ngOnInit.
    soundsLoading = false
    soundGroups: { groupLabel: string; sounds: SoundEntry[] }[] = []
    onlineCatalog: OnlineSoundEntry[] = []
    onlineCatalogLoading = false
    onlineCatalogError = ''
    showOnlineCatalog = false
    downloadingId = ''
    downloadAllResult = ''
    soundCacheDir = ''

    // Piper voice catalog modal state. The catalog is fetched once per
    // open (no aggressive caching beyond the in-memory list), and
    // `installedKeys` is recomputed every modal open so the "Installed"
    // badge always reflects what's on disk.
    showPiperVoiceCatalog = false
    piperCatalog: PiperVoiceCatalogEntry[] = []
    piperCatalogLoading = false
    piperCatalogError = ''
    piperCatalogLanguageFilter = ''
    piperCatalogTextFilter = ''
    piperDownloadingKey = ''
    piperDownloadStatus = ''
    piperInstalledKeys: Set<string> = new Set()
    piperModelsDir = ''
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

    readonly dynamicStatuses = ['done', 'question'] as const
    dynamicTesting: 'done' | 'question' | '' = ''
    dynamicTestResult: { status: 'done' | 'question'; kind: 'ok' | 'error'; message: string } | null = null
    credStatus: CredentialsStatus | null = null

    activityEntries: ActivityLogEntry[] = []
    activityFilter: '' | 'working' | 'question' | 'done' | 'error' | 'idle' = ''
    activityTextFilter = ''
    readonly activityStatusFilters = ['working', 'question', 'done', 'error', 'idle'] as const
    activityLogPath = ''
    private activityUnsubscribe: (() => void) | null = null

    historyExpanded = false
    previousRunExpanded = true
    sessionFilter = ''
    /** cwds whose history group is expanded; collapsed by default to keep the list scannable. */
    expandedClosedGroups: Set<string> = new Set()
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
        private soundService: SoundService,
        private activityLog: StatusActivityLogService,
        private claudeApi: ClaudeApiService,
        private transcriptReader: TranscriptReaderService,
        private credentialsService: ClaudeCredentialsService,
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
        if (!this.config.store.claudeStatus.audio.soundsByStatus) {
            this.config.store.claudeStatus.audio.soundsByStatus = { ...DEFAULT_AUDIO_CONFIG.soundsByStatus }
        }
        if (!this.config.store.claudeStatus.audio.voicesByBackend) {
            this.config.store.claudeStatus.audio.voicesByBackend = {}
        }
        if (!this.config.store.claudeStatus.audio.backend) {
            this.config.store.claudeStatus.audio.backend = DEFAULT_AUDIO_CONFIG.backend
        }
        if (!this.config.store.claudeStatus.audio.mode) {
            this.config.store.claudeStatus.audio.mode = DEFAULT_AUDIO_CONFIG.mode
        }
        // Backfill dynamic-phrase config for users upgrading from <=1.2.x.
        // Deep-merge so newly-added per-status entries appear without
        // clobbering user customizations.
        if (!this.config.store.claudeStatus.audio.dynamic) {
            this.config.store.claudeStatus.audio.dynamic = JSON.parse(JSON.stringify(DEFAULT_AUDIO_CONFIG.dynamic))
        } else {
            const dyn = this.config.store.claudeStatus.audio.dynamic
            const def = DEFAULT_AUDIO_CONFIG.dynamic
            if (dyn.apiKey == null) dyn.apiKey = def.apiKey
            if (!dyn.model) dyn.model = def.model
            if (!dyn.maxOutputTokens) dyn.maxOutputTokens = def.maxOutputTokens
            if (!dyn.timeoutMs) dyn.timeoutMs = def.timeoutMs
            if (!dyn.perStatus) dyn.perStatus = JSON.parse(JSON.stringify(def.perStatus))
            for (const s of ['done', 'question'] as const) {
                if (!dyn.perStatus[s]) {
                    dyn.perStatus[s] = JSON.parse(JSON.stringify(def.perStatus[s]))
                }
            }
        }
        if (this.config.store.claudeStatus.audio.muteTtsDuringMicActive == null) {
            this.config.store.claudeStatus.audio.muteTtsDuringMicActive =
                DEFAULT_AUDIO_CONFIG.muteTtsDuringMicActive
        }
        if (this.config.store.claudeStatus.audio.muteSoundDuringMicActive == null) {
            this.config.store.claudeStatus.audio.muteSoundDuringMicActive =
                DEFAULT_AUDIO_CONFIG.muteSoundDuringMicActive
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

        // Pre-populate the sound library so the per-status dropdowns are
        // ready as soon as the user lands on the audio tab in sound mode.
        // Cheap: bundled is in-memory, cached + Windows are one readdir each.
        if (this.config.store.claudeStatus.audio?.mode === 'sound') {
            this.refreshSoundLibrary()
        }

        // Activity log: live-refresh while the settings tab is open so new
        // events appear without a manual reload. Subscription is cheap (the
        // service notifies in-process; no IO).
        this.activityLogPath = this.activityLog.filePath
        this.refreshActivityLog()
        this.activityUnsubscribe = this.activityLog.subscribe(() => this.refreshActivityLog())

        this.refreshCredStatus()
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
        const audio = this.config.store.claudeStatus?.audio
        const backendId = audio?.backend as TtsBackendId
        const stored = audio?.voicesByBackend?.[backendId] || ''
        // Piper has no separate "voice" concept — the model path IS the
        // voice. If the dropdown is empty but the user has a model path
        // configured (typically via the path field below or the installer),
        // surface it so the trigger label matches reality. Without this, the
        // dropdown reads "(default for this backend)" even though Piper is
        // actively using en_US-lessac-medium.
        if (backendId === 'piper' && !stored && audio?.piperModelPath) {
            return audio.piperModelPath
        }
        return stored
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
        // For Piper, the dropdown is the canonical control — push the
        // selection into piperModelPath so the path field below mirrors it
        // and the backend (which reads piperModelPath) actually uses the
        // newly-selected voice.
        if (backendId === 'piper' && voiceId) {
            this.config.store.claudeStatus.audio.piperModelPath = voiceId
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

    // ── Sound mode ──────────────────────────────────────────────────

    onModeChange(mode: AudioMode): void {
        this.config.store.claudeStatus.audio.mode = mode
        this.save()
        if (mode === 'sound' && this.soundGroups.length === 0) {
            this.refreshSoundLibrary()
        }
    }

    async refreshSoundLibrary(): Promise<void> {
        this.soundsLoading = true
        try {
            this.soundService.invalidateCacheList()
            const [bundled, cached, windows] = await Promise.all([
                Promise.resolve(this.soundService.listBundledSounds()),
                this.soundService.listCachedDownloads(),
                this.soundService.listWindowsSounds(),
            ])
            const groups: { groupLabel: string; sounds: SoundEntry[] }[] = []
            if (bundled.length) groups.push({ groupLabel: `Bundled (${bundled.length})`, sounds: bundled })
            if (cached.length) groups.push({ groupLabel: `Downloaded (${cached.length})`, sounds: cached })
            if (windows.length) groups.push({ groupLabel: `Windows (${windows.length})`, sounds: windows })
            this.soundGroups = groups
            this.soundCacheDir = this.soundService.getCacheDir()
        } finally {
            this.soundsLoading = false
        }
    }

    onSoundChange(status: string, soundId: string): void {
        if (soundId === '__custom__') {
            this.pickCustomSound(status)
            return
        }
        this.config.store.claudeStatus.audio.soundsByStatus[status] = soundId || ''
        this.save()
    }

    /** Resolves the value bound in the per-status <select> back to a real path. */
    getSelectedSoundId(status: string): string {
        return this.config.store.claudeStatus.audio.soundsByStatus?.[status] || ''
    }

    /** Label rendered next to the per-status row when a sound is selected. */
    getSelectedSoundLabel(status: string): string {
        const id = this.getSelectedSoundId(status)
        if (!id) return ''
        for (const group of this.soundGroups) {
            const hit = group.sounds.find(s => s.id === id)
            if (hit) return hit.label
        }
        // Custom path that's not in any group — show the file name.
        return path.basename(id)
    }

    async pickCustomSound(status: string): Promise<void> {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { dialog, getCurrentWindow } = require('@electron/remote')
            const win = getCurrentWindow()
            const result = await dialog.showOpenDialog(win, {
                title: `Pick sound for ${status}`,
                properties: ['openFile'],
                filters: [
                    { name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'm4a', 'aac'] },
                    { name: 'All', extensions: ['*'] },
                ],
            })
            if (result.canceled || !result.filePaths?.[0]) return
            this.config.store.claudeStatus.audio.soundsByStatus[status] = result.filePaths[0]
            this.save()
        } catch (err) {
            console.warn('[claude-status] Custom sound picker failed:', err)
        }
    }

    clearStatusSound(status: string): void {
        this.config.store.claudeStatus.audio.soundsByStatus[status] = ''
        this.save()
    }

    testSound(status: string): void {
        const audio = this.config.store.claudeStatus.audio
        const filePath = audio.soundsByStatus?.[status]
        if (filePath) {
            this.audioService.testPlaySound(filePath, audio.volume)
        }
    }

    // ── Online catalog modal ────────────────────────────────────────

    async openOnlineCatalog(): Promise<void> {
        this.showOnlineCatalog = true
        this.onlineCatalogError = ''
        this.downloadAllResult = ''
        if (this.onlineCatalog.length) return
        this.onlineCatalogLoading = true
        try {
            this.onlineCatalog = await this.soundService.listOnlineCatalog()
            if (this.onlineCatalog.length === 0) {
                this.onlineCatalogError =
                    'No online sounds curated yet. Add entries to online-sounds/catalog.json (see the _schema field there) and reload Tabby.'
            }
        } catch (err) {
            this.onlineCatalogError = err instanceof Error ? err.message : String(err)
        } finally {
            this.onlineCatalogLoading = false
        }
    }

    closeOnlineCatalog(): void {
        this.showOnlineCatalog = false
    }

    // ── Piper voice catalog modal ──────────────────────────────────

    async openPiperVoiceCatalog(): Promise<void> {
        this.showPiperVoiceCatalog = true
        this.piperCatalogError = ''
        this.refreshPiperInstalledKeys()
        const installPaths = this.piperInstaller.getInstallPaths()
        this.piperModelsDir = path.dirname(installPaths.modelPath)
        if (this.piperCatalog.length) return
        this.piperCatalogLoading = true
        try {
            this.piperCatalog = await this.piperInstaller.fetchVoiceCatalog()
            if (this.piperCatalog.length === 0) {
                this.piperCatalogError = 'Voice catalog returned no entries — Hugging Face may be unreachable.'
            }
        } catch (err) {
            this.piperCatalogError = err instanceof Error ? err.message : String(err)
        } finally {
            this.piperCatalogLoading = false
        }
    }

    closePiperVoiceCatalog(): void {
        this.showPiperVoiceCatalog = false
    }

    clearPiperCatalogFilters(): void {
        this.piperCatalogLanguageFilter = ''
        this.piperCatalogTextFilter = ''
    }

    /** Total catalog count (used by the "All languages (N)" select option). */
    get piperCatalogTotalCount(): number {
        return this.piperCatalog.length
    }

    get piperCatalogLanguageOptions(): { code: string; name: string; count: number }[] {
        const counts = new Map<string, { name: string; count: number }>()
        for (const v of this.piperCatalog) {
            const code = v.languageFamily || v.languageCode || 'unknown'
            const name = v.language || code
            const cur = counts.get(code)
            if (cur) cur.count++
            else counts.set(code, { name, count: 1 })
        }
        return [...counts]
            .map(([code, { name, count }]) => ({ code, name, count }))
            .sort((a, b) => {
                if (a.code === 'en' && b.code !== 'en') return -1
                if (b.code === 'en' && a.code !== 'en') return 1
                return a.name.localeCompare(b.name)
            })
    }

    get filteredPiperCatalog(): PiperVoiceCatalogEntry[] {
        const text = this.piperCatalogTextFilter.trim().toLowerCase()
        const lang = this.piperCatalogLanguageFilter
        return this.piperCatalog.filter(v => {
            if (lang && v.languageFamily !== lang && v.languageCode !== lang) return false
            if (text) {
                const hay = `${v.key} ${v.name} ${v.language}`.toLowerCase()
                if (!hay.includes(text)) return false
            }
            return true
        })
    }

    isPiperVoiceDownloaded(key: string): boolean {
        return this.piperInstalledKeys.has(key)
    }

    formatBytes(n: number): string {
        if (!n) return '—'
        if (n < 1024) return `${n} B`
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
        return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    /**
     * Download a voice from the catalog. After the download finishes:
     *  - the on-disk index is refreshed so the "Installed" badge appears,
     *  - the TTS voice list for Piper is reloaded so the dropdown picks up
     *    the new file without a Tabby restart,
     *  - the per-voice progress text is reset.
     */
    async downloadPiperVoice(
        entry: PiperVoiceCatalogEntry,
    ): Promise<void> {
        this.piperDownloadingKey = entry.key
        this.piperDownloadStatus = ''
        this.piperCatalogError = ''
        try {
            await this.piperInstaller.downloadVoice(entry, p => {
                if (p.bytesTotal) {
                    const pct = Math.floor((p.bytesReceived || 0) / p.bytesTotal * 100)
                    this.piperDownloadStatus = `${pct}%`
                } else {
                    this.piperDownloadStatus = '…'
                }
            })
            this.refreshPiperInstalledKeys()
            await this.reloadPiperVoices()
        } catch (err) {
            this.piperCatalogError = `Download failed: ${err instanceof Error ? err.message : String(err)}`
        } finally {
            this.piperDownloadingKey = ''
            this.piperDownloadStatus = ''
        }
    }

    /**
     * Set the chosen voice as the active Piper model. Updates piperModelPath
     * (the canonical setting the backend reads) and clears voicesByBackend
     * so getSelectedVoiceId()'s Piper-fallback to piperModelPath kicks in.
     */
    usePiperVoice(key: string): void {
        const installed = this.piperInstaller.listInstalledVoices().find(v => v.key === key)
        if (!installed) return
        this.config.store.claudeStatus.audio.piperModelPath = installed.modelPath
        this.config.store.claudeStatus.audio.voicesByBackend = {
            ...(this.config.store.claudeStatus.audio.voicesByBackend || {}),
            piper: installed.modelPath,
        }
        this.save()
        this.reloadPiperVoices()
        this.closePiperVoiceCatalog()
    }

    private refreshPiperInstalledKeys(): void {
        const next = new Set<string>()
        for (const v of this.piperInstaller.listInstalledVoices()) next.add(v.key)
        this.piperInstalledKeys = next
    }

    /**
     * Re-query the Piper backend's voice list and shove it into the
     * voicesByBackend bookkeeping so the existing voice dropdown rerenders
     * with the freshly-downloaded entries. Mirrors the loadVoicesForBackend
     * pattern used elsewhere in this component.
     */
    private async reloadPiperVoices(): Promise<void> {
        const piper = this.audioService.getBackend('piper')
        const audio = this.config.store.claudeStatus.audio
        ;(piper as any).configure?.(audio.piperExePath, audio.piperModelPath)
        try {
            const voices = await piper.listVoices()
            const target = this.backends.find(b => b.id === 'piper')
            if (target) target.voices = voices
        } catch (err) {
            console.warn('[claude-status] reloadPiperVoices failed:', err)
        }
    }

    async downloadCatalogEntry(entry: OnlineSoundEntry): Promise<void> {
        this.downloadingId = entry.id
        this.onlineCatalogError = ''
        try {
            await this.soundService.downloadOnlineSound(entry)
            await this.refreshSoundLibrary()
        } catch (err) {
            this.onlineCatalogError = `Download failed: ${err instanceof Error ? err.message : String(err)}`
        } finally {
            this.downloadingId = ''
        }
    }

    async downloadAllCatalog(): Promise<void> {
        this.downloadingId = '__all__'
        this.onlineCatalogError = ''
        this.downloadAllResult = ''
        try {
            const result = await this.soundService.downloadAllMissing()
            await this.refreshSoundLibrary()
            const failedCount = result.failed.length
            this.downloadAllResult =
                failedCount === 0
                    ? `Downloaded ${result.downloaded} new sound${result.downloaded === 1 ? '' : 's'}.`
                    : `Downloaded ${result.downloaded}, ${failedCount} failed (${result.failed.map(f => f.entry.label).join(', ')}).`
        } catch (err) {
            this.onlineCatalogError = err instanceof Error ? err.message : String(err)
        } finally {
            this.downloadingId = ''
        }
    }

    isDownloaded(entry: OnlineSoundEntry): boolean {
        // Heuristic: catalog entries are downloaded into a deterministic
        // filename (id + extension), so we can check for that file in the
        // cached list.
        const safeId = entry.id.replace(/[^a-zA-Z0-9._-]/g, '_')
        for (const group of this.soundGroups) {
            if (!group.groupLabel.startsWith('Downloaded')) continue
            if (group.sounds.some(s => path.basename(s.id, path.extname(s.id)) === safeId)) {
                return true
            }
        }
        return false
    }

    previewCatalogEntry(entry: OnlineSoundEntry): void {
        // Preview by streaming the URL directly; if a download already
        // exists locally, prefer that to avoid re-fetching.
        const safeId = entry.id.replace(/[^a-zA-Z0-9._-]/g, '_')
        for (const group of this.soundGroups) {
            if (!group.groupLabel.startsWith('Downloaded')) continue
            const hit = group.sounds.find(s => path.basename(s.id, path.extname(s.id)) === safeId)
            if (hit) {
                this.audioService.testPlaySound(hit.path)
                return
            }
        }
        const url = entry.previewUrl || entry.url
        try {
            const audio = new Audio(url)
            audio.volume = this.config.store.claudeStatus.audio.volume
            audio.play().catch(err => {
                this.onlineCatalogError = `Preview failed: ${err.message || err}`
            })
        } catch (err) {
            this.onlineCatalogError = err instanceof Error ? err.message : String(err)
        }
    }

    openSoundCacheDir(): void {
        this.soundService.openCacheDir()
    }

    // ── Session restore ─────────────────────────────────────────────

    refreshSessions(): void {
        this.sessions = this.sessionRestore.list()
    }

    get activeSessions(): ClaudeSessionRecord[] {
        return this.sessionRestore.activeSessions()
    }

    get previousRunSessions(): ClaudeSessionRecord[] {
        return this.sessionRestore.previousRunSessions()
    }

    get closedSessions(): ClaudeSessionRecord[] {
        return this.sessions.filter(s => !!s.closed)
    }

    /** Active + previous-run combined — used by the bulk "Mark all as closed" action. */
    get openSessions(): ClaudeSessionRecord[] {
        return this.sessions.filter(s => !s.closed)
    }

    get filteredActiveSessions(): ClaudeSessionRecord[] {
        return this.applySessionFilter(this.activeSessions)
    }

    get filteredPreviousRunSessions(): ClaudeSessionRecord[] {
        return this.applySessionFilter(this.previousRunSessions)
    }

    get filteredClosedSessions(): ClaudeSessionRecord[] {
        return this.applySessionFilter(this.closedSessions)
    }

    /**
     * History sessions grouped by `cwd`, newest group first. Within each
     * group, sessions are sorted newest-first. Used by the Sessions tab to
     * render history collapsibly per folder so dozens of sessions in the
     * same project don't dominate the list.
     */
    get groupedClosedSessions(): { cwd: string; basename: string; lastSeen: number; sessions: ClaudeSessionRecord[] }[] {
        const byCwd = new Map<string, ClaudeSessionRecord[]>()
        for (const s of this.filteredClosedSessions) {
            const key = s.cwd || '(unknown)'
            if (!byCwd.has(key)) byCwd.set(key, [])
            byCwd.get(key)!.push(s)
        }
        const groups: { cwd: string; basename: string; lastSeen: number; sessions: ClaudeSessionRecord[] }[] = []
        for (const [cwd, sessions] of byCwd) {
            sessions.sort((a, b) => b.lastSeen - a.lastSeen)
            groups.push({
                cwd,
                basename: this.cwdBasename(cwd),
                lastSeen: sessions[0].lastSeen,
                sessions,
            })
        }
        groups.sort((a, b) => b.lastSeen - a.lastSeen)
        return groups
    }

    /** Return the last path segment (handles both Windows and POSIX separators). */
    private cwdBasename(cwd: string): string {
        if (!cwd) return '(unknown)'
        const trimmed = cwd.replace(/[/\\]+$/, '')
        const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
        return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
    }

    isClosedGroupExpanded(cwd: string): boolean {
        return this.expandedClosedGroups.has(cwd)
    }

    toggleClosedGroup(cwd: string): void {
        if (this.expandedClosedGroups.has(cwd)) this.expandedClosedGroups.delete(cwd)
        else this.expandedClosedGroups.add(cwd)
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
        // Auto-expand collapsed buckets when typing so matches become visible.
        if (!this.sessionFilter.trim()) return
        if (this.filteredClosedSessions.length > 0) this.historyExpanded = true
        if (this.filteredPreviousRunSessions.length > 0) this.previousRunExpanded = true
        // Also expand any history group with at least one match so the user
        // sees the matched session without an extra click.
        for (const group of this.groupedClosedSessions) {
            this.expandedClosedGroups.add(group.cwd)
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
        if (this.activityUnsubscribe) {
            this.activityUnsubscribe()
            this.activityUnsubscribe = null
        }
        document.removeEventListener('click', this.docClickListener, true)
    }

    // ── Subscription credentials (Audio tab → Dynamic mode) ─────────

    /** Re-read ~/.claude/.credentials.json and refresh the displayed status. */
    refreshCredStatus(): void {
        this.credentialsService.invalidate()
        this.credStatus = this.credentialsService.getStatus()
    }

    formatExpiry(expiresAt: number): string {
        if (!expiresAt) return 'unknown'
        try {
            return new Date(expiresAt).toLocaleString()
        } catch {
            return new Date(expiresAt).toISOString()
        }
    }

    // ── Dynamic phrase test (Audio tab) ──────────────────────────────

    /**
     * Generate a test phrase for the given status using whatever the user
     * just typed into the prompt template. Doesn't go through the audio
     * pipeline's mute gates — preview only. Speaks the result if TTS is
     * configured, and prints it to the result row regardless.
     */
    async testDynamicPhrase(status: 'done' | 'question'): Promise<void> {
        if (this.dynamicTesting) return
        this.dynamicTesting = status
        this.dynamicTestResult = null
        try {
            const audio = this.config.store.claudeStatus.audio
            const cfg = audio.dynamic
            const statusCfg = cfg.perStatus[status]

            // Try to find the most recent matching entry in the activity log
            // for realistic context; fall back to a synthesized payload.
            const recent = this.activityLog.list().find(e =>
                e.status === status && e.metadata,
            )
            const ctx = {
                status,
                eventName: recent?.eventName ?? (status === 'done' ? 'Stop' : 'PermissionRequest'),
                metadata: recent?.metadata as Record<string, unknown> | undefined,
                transcript: undefined as any,
            }

            let phrase: string | null = null
            if (statusCfg.transcriptOnly) {
                this.dynamicTestResult = {
                    status,
                    kind: 'error',
                    message: 'Transcript-only mode requires a live hook event — trigger Claude and watch the activity log instead.',
                }
                return
            }
            phrase = await this.claudeApi.generatePhrase(ctx, cfg, statusCfg.promptTemplate)
            if (phrase) {
                this.dynamicTestResult = { status, kind: 'ok', message: phrase }
                this.audioService.speakText(phrase, audio).catch(() => { /* preview is best-effort */ })
            } else {
                this.dynamicTestResult = {
                    status,
                    kind: 'error',
                    message: 'API call failed or timed out. Check your API key, model id, and timeout setting.',
                }
            }
        } catch (err: any) {
            this.dynamicTestResult = {
                status,
                kind: 'error',
                message: err?.message || String(err),
            }
        } finally {
            this.dynamicTesting = ''
        }
    }

    // ── Activity log (Hooks tab) ────────────────────────────────────

    refreshActivityLog(): void {
        this.activityEntries = this.activityLog.list()
    }

    clearActivityLog(): void {
        this.activityLog.clear()
        this.activityEntries = []
    }

    copyActivityLogPath(): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { clipboard } = require('electron')
            clipboard.writeText(this.activityLogPath)
        } catch {
            try { (navigator as any).clipboard?.writeText(this.activityLogPath) } catch { /* noop */ }
        }
    }

    get filteredActivityEntries(): ActivityLogEntry[] {
        const text = this.activityTextFilter.trim().toLowerCase()
        return this.activityEntries.filter(e => {
            if (this.activityFilter && e.status !== this.activityFilter) return false
            if (!text) return true
            const haystack = [
                e.eventName, e.session, e.audioPayload,
                e.audioOutcome, e.audioOutcomeDetail, e.terminalTitle,
                JSON.stringify(e.metadata || {}),
            ].filter(Boolean).join(' ').toLowerCase()
            return haystack.includes(text)
        })
    }

    formatActivityTime(ts: number): string {
        const d = new Date(ts)
        const pad = (n: number) => n.toString().padStart(2, '0')
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    formatActivityTooltip(entry: ActivityLogEntry): string {
        const lines: string[] = []
        lines.push(`${new Date(entry.ts).toLocaleString()} — ${entry.status}`)
        if (entry.eventName) lines.push(`event: ${entry.eventName}`)
        if (entry.source) lines.push(`source: ${entry.source}`)
        if (entry.audioOutcome) lines.push(`audio: ${entry.audioOutcome}${entry.audioOutcomeDetail ? ' — ' + entry.audioOutcomeDetail : ''}`)
        if (entry.session) lines.push(`session: ${entry.session}`)
        if (entry.metadata) lines.push(`meta: ${JSON.stringify(entry.metadata)}`)
        return lines.join('\n')
    }

    activityStatusColor(status: string): string {
        const colors: Record<string, string> = {
            working: '#0d6efd',
            question: '#3b82f6',
            done: '#198754',
            error: '#dc3545',
            idle: '#6c757d',
        }
        return colors[status] || '#6c757d'
    }

    async resumeSession(session: ClaudeSessionRecord): Promise<void> {
        await this.sessionRestore.resumeSession(session, 'resume')
    }

    /** Open a new tab forked off an active session (claude --resume <id> --fork-session). */
    async forkSession(session: ClaudeSessionRecord): Promise<void> {
        await this.sessionRestore.resumeSession(session, 'fork')
    }

    async resumeAllSessions(): Promise<void> {
        await this.sessionRestore.resumeAll()
    }

    /**
     * Bulk-resume all sessions that were active in the previous Tabby run.
     * Active-this-run sessions are excluded — those are already running, so
     * "resume" wouldn't make sense for them.
     */
    async resumeAllPreviousRun(): Promise<void> {
        for (const s of this.sessionRestore.previousRunSessions()) {
            await this.sessionRestore.resumeSession(s, 'resume')
        }
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

    /**
     * Strip every tabby-claude-status hook from each target's settings.json.
     * Symmetric to `setupHooks()` — preserves any non-tabby hooks the user
     * has configured (other extensions like Claude-Code-Agent-Monitor).
     */
    removeHooks(choice: SetupChoice): void {
        if (this.setupRunning) return
        this.setupRunning = true
        this.setupResult = null

        const targets: SetupTarget[] = []
        if (choice.target === 'windows' || choice.target === 'all') {
            targets.push({ kind: 'windows', label: 'Windows' })
        }
        if (choice.target === 'wsl' && choice.distro) {
            const settingsPath = this.findWslSettingsPath(choice.distro)
            if (settingsPath) {
                targets.push({
                    kind: 'wsl',
                    label: `WSL ${choice.distro}`,
                    distro: choice.distro,
                    settingsPath,
                })
            }
        }
        if (choice.target === 'all') {
            for (const distro of this.wslDistros) {
                const settingsPath = this.findWslSettingsPath(distro)
                if (settingsPath) {
                    targets.push({
                        kind: 'wsl',
                        label: `WSL ${distro}`,
                        distro,
                        settingsPath,
                    })
                }
            }
        }

        const successes: string[] = []
        const failures: string[] = []
        let totalRemoved = 0
        for (const target of targets) {
            try {
                const removed = this.removeHooksFromTarget(target)
                totalRemoved += removed
                if (removed > 0) successes.push(`${target.label} (${removed})`)
            } catch (e: any) {
                console.error(`[claude-status] Failed to remove hooks for ${target.label}:`, e)
                failures.push(`${target.label}: ${e?.message || e}`)
            }
        }

        this.setupRunning = false
        if (failures.length === 0) {
            this.setupResult = {
                kind: 'ok',
                message: totalRemoved === 0
                    ? 'No tabby-claude-status hooks were configured anywhere.'
                    : `Removed ${totalRemoved} hook entr${totalRemoved === 1 ? 'y' : 'ies'} from ${successes.join(', ')}`,
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

    /**
     * Remove every tabby-claude-status command from `target`'s settings.json
     * and return the number of entries removed. Empty matcher groups and
     * empty hook-event arrays are pruned. The `hooks` key itself is left in
     * place even if empty, since the user may want to add hooks back later.
     */
    private removeHooksFromTarget(target: SetupTarget): number {
        const settingsPath = target.kind === 'windows'
            ? path.join(os.homedir(), '.claude', 'settings.json')
            : target.settingsPath
        if (!settingsPath || !fs.existsSync(settingsPath)) return 0

        const settings: any = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        if (!settings || typeof settings !== 'object' || !settings.hooks) return 0

        let removed = 0
        for (const event of Object.keys(settings.hooks)) {
            const matcherGroups: any[] = settings.hooks[event]
            if (!Array.isArray(matcherGroups)) continue
            for (const group of matcherGroups) {
                if (!Array.isArray(group?.hooks)) continue
                const before = group.hooks.length
                group.hooks = group.hooks.filter(
                    (h: any) => !(h?.type === 'command' && this.isTabbyHookCommand(h.command)),
                )
                removed += before - group.hooks.length
            }
            settings.hooks[event] = matcherGroups.filter(g => Array.isArray(g?.hooks) && g.hooks.length > 0)
            if (settings.hooks[event].length === 0) delete settings.hooks[event]
        }

        if (removed > 0) {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
        }
        return removed
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
