import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { ClaudeStatusSettingsTabComponent } from '../components/claudeStatusSettingsTab.component'

@Injectable()
export class ClaudeStatusSettingsTabProvider extends SettingsTabProvider {
    id = 'claude-status'
    icon = 'bell'
    title = 'Claude Status'

    getComponentType(): any {
        return ClaudeStatusSettingsTabComponent
    }
}
