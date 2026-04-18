import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ConfigProvider } from 'tabby-core'
import TabbyCoreModule from 'tabby-core'
import { TerminalDecorator } from 'tabby-terminal'
import { SettingsTabProvider } from 'tabby-settings'

import { ClaudeStatusDecorator } from './decorator/claudeStatusDecorator'
import { ClaudeStatusConfigProvider } from './providers/configProvider'
import { ClaudeStatusSettingsTabProvider } from './providers/settingsTabProvider'
import { StatusParserService } from './services/statusParserService'
import { ClaudeStatusConfigService } from './services/configService'
import { AudioService } from './services/audioService'
import { ClaudeStatusSettingsTabComponent } from './components/claudeStatusSettingsTab.component'

@NgModule({
    imports: [CommonModule, FormsModule, TabbyCoreModule],
    declarations: [ClaudeStatusSettingsTabComponent],
    providers: [
        StatusParserService,
        ClaudeStatusConfigService,
        AudioService,
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
