/**
 * Tabby Claude Status Plugin
 *
 * Integrates with Claude Code's hooks system to provide visual tab color
 * indicators based on Claude's state (working, waiting for input, done, error).
 *
 * @module tabby-claude-status
 */
export { default } from './claudeStatusModule'
export * from './interfaces/types'
export { StatusParserService } from './services/statusParserService'
export { ClaudeStatusConfigService } from './services/configService'
export { AudioService } from './services/audioService'
