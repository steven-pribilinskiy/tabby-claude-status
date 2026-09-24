import * as path from 'node:path'
import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { TerminalDecorator } from 'tabby-terminal'
import { ClaudeStatusSettingsTabComponent } from './components/claudeStatusSettingsTab.component'
import { ClaudeStatusDecorator } from './decorator/claudeStatusDecorator'
import { ClaudeStatusConfigProvider } from './providers/configProvider'
import { ClaudeStatusSettingsTabProvider } from './providers/settingsTabProvider'
import { AudioService } from './services/audioService'
import { ClaudeApiService } from './services/claudeApiService'
import { ClaudeCredentialsService } from './services/claudeCredentialsService'
import { ClaudeStatusConfigService } from './services/configService'
import { ClaudeCrashLogService } from './services/crashLogService'
import { hostApp } from './services/hostApp'
import { MicStateService } from './services/micStateService'
import { PiperInstallerService } from './services/piperInstallerService'
import { SessionRestoreService } from './services/sessionRestoreService'
import { syncSharedHook } from './services/sharedHook'
import { SoundService } from './services/soundService'
import { SpoolOwnershipService } from './services/spoolOwnershipService'
import { StatusActivityLogService } from './services/statusActivityLogService'
import { StatusParserService } from './services/statusParserService'
import { TranscriptReaderService } from './services/transcriptReaderService'
import { WindowCoordinatorService } from './services/windowCoordinatorService'
import { ZoomStateService } from './services/zoomStateService'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PLUGIN_PACKAGE = require('../package.json') as { version: string }

@NgModule({
    imports: [CommonModule, FormsModule, TabbyCoreModule],
    declarations: [ClaudeStatusSettingsTabComponent],
    providers: [
        StatusParserService,
        ClaudeStatusConfigService,
        AudioService,
        ZoomStateService,
        MicStateService,
        SoundService,
        StatusActivityLogService,
        ClaudeCrashLogService,
        ClaudeApiService,
        ClaudeCredentialsService,
        TranscriptReaderService,
        PiperInstallerService,
        SessionRestoreService,
        WindowCoordinatorService,
        SpoolOwnershipService,
        { provide: ConfigProvider, useClass: ClaudeStatusConfigProvider, multi: true },
        { provide: TerminalDecorator, useClass: ClaudeStatusDecorator, multi: true },
        { provide: SettingsTabProvider, useClass: ClaudeStatusSettingsTabProvider, multi: true },
    ],
})
export default class ClaudeStatusModule {
    constructor() {
        const host = hostApp()
        console.log(`[claude-status] Plugin loaded in ${host.name} (data: ${host.dataDir})`)
        // Keep the shared hook.js (the one Claude Code actually runs, shared by
        // every app with this plugin) in step with a plugin update. Refresh
        // only: installing it is Setup hooks' job. Off the load path.
        setTimeout(() => {
            const r = syncSharedHook({
                bundledHookPath: path.join(__dirname, '..', 'hook.js'),
                version: PLUGIN_PACKAGE.version,
                installedBy: host.name,
                install: false,
            })
            if (r.action === 'updated')
                console.log(`[claude-status] refreshed shared hook ${r.hookPath}`)
            if (r.action === 'failed')
                console.warn('[claude-status] shared hook refresh failed:', r.error)
        }, 0)
    }
}
