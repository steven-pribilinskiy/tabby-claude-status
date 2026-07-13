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
import { MicStateService } from './services/micStateService'
import { PiperInstallerService } from './services/piperInstallerService'
import { SessionRestoreService } from './services/sessionRestoreService'
import { SoundService } from './services/soundService'
import { StatusActivityLogService } from './services/statusActivityLogService'
import { StatusParserService } from './services/statusParserService'
import { TranscriptReaderService } from './services/transcriptReaderService'
import { ZoomStateService } from './services/zoomStateService'

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
        { provide: ConfigProvider, useClass: ClaudeStatusConfigProvider, multi: true },
        { provide: TerminalDecorator, useClass: ClaudeStatusDecorator, multi: true },
        { provide: SettingsTabProvider, useClass: ClaudeStatusSettingsTabProvider, multi: true },
    ],
})
export default class ClaudeStatusModule {
    constructor() {
        console.log('[claude-status] Plugin loaded')
    }
}
