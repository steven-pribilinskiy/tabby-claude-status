import { ConfigProvider } from 'tabby-core'
import { DEFAULT_CONFIG } from '../interfaces/types'

/**
 * Provides default configuration for the Claude status plugin
 */
export class ClaudeStatusConfigProvider extends ConfigProvider {
    defaults = {
        claudeStatus: DEFAULT_CONFIG,
    }
}
