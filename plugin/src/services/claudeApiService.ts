import { Injectable } from '@angular/core'
import Anthropic from '@anthropic-ai/sdk'
import { ClaudeStatusDynamicConfig, ClaudeStatusName } from '../interfaces/types'
import { TranscriptTail } from './transcriptReaderService'
import { ClaudeCredentialsService } from './claudeCredentialsService'

export interface DynamicPhraseContext {
    /** Mapped status the plugin acted on. */
    status: ClaudeStatusName
    /** Raw v2 hook event name (e.g. 'Notification', 'PermissionRequest', 'Stop'). */
    eventName?: string
    /** Trimmed hook payload — same fields the activity log keeps. */
    metadata?: Record<string, unknown>
    /** Read from the on-disk JSONL transcript if `transcript_path` was forwarded. */
    transcript?: TranscriptTail
}

const SYSTEM_PROMPT =
    'You announce the status of a Claude Code task to the user via TTS. ' +
    'Output exactly one short phrase, at most 8 words, no punctuation, no quotes, ' +
    'no preamble, no surrounding markdown. The phrase will be spoken aloud, so ' +
    'prefer plain words and avoid abbreviations or symbols. Match the requested style.'

/**
 * Generates a context-aware status announcement via Haiku 4.5.
 *
 * Why a fresh Anthropic client per call instead of a long-lived one: the SDK
 * client wraps an `apiKey` set at construction time. If the user pastes a new
 * key into settings, a cached client would keep using the old one. Construction
 * is cheap (no network), so we just rebuild it each call. `dangerouslyAllowBrowser`
 * is required because Tabby runs the plugin in an Electron renderer; the SDK
 * otherwise refuses to construct in any environment that exposes `window`.
 *
 * No prompt caching: Haiku 4.5's minimum cacheable prefix is 4096 tokens
 * (per shared/prompt-caching.md). Our system prompt is ~50 tokens — won't
 * cache no matter what we mark. Padding the system to 4096 tokens to force
 * caching would waste more tokens than it saves at our request volume.
 */
/**
 * One entry in the model dropdown shown by the settings UI. We surface only
 * the fields the dropdown needs — id (used as the API param) and a friendly
 * display name. Sorted server-side by created_at desc, so newest first.
 */
export interface ClaudeModelOption {
    id: string
    displayName: string
}

@Injectable({ providedIn: 'root' })
export class ClaudeApiService {
    /**
     * Fallback list shown when /v1/models is unreachable (no auth, offline,
     * subscription token without `models:read` scope, etc.). Keep small —
     * just enough to let the user pick something sensible. The user can
     * always type in the SDK any model id, but the dropdown needs *some*
     * options for `<select>` to be useful.
     */
    private static readonly STATIC_FALLBACK_MODELS: ClaudeModelOption[] = [
        { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
        { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' },
        { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5' },
    ]

    private modelsCache: ClaudeModelOption[] | null = null
    private modelsCacheError: string | null = null

    constructor(private credentials: ClaudeCredentialsService) {}

    /**
     * Returns the list of models the current auth (subscription token or
     * API key) can use. Memoised per service lifetime — settings UI calls
     * this each time the audio tab opens, but we only hit /v1/models once.
     *
     * On error, returns the static fallback list and caches the error so
     * the settings UI can show "Couldn't reach Anthropic API — showing a
     * curated list" instead of failing silently.
     */
    async listModels(opts: { force?: boolean; cfg: ClaudeStatusDynamicConfig }):
        Promise<{ models: ClaudeModelOption[]; error: string | null; fromCache: boolean }> {
        if (!opts.force && this.modelsCache) {
            return { models: this.modelsCache, error: this.modelsCacheError, fromCache: true }
        }
        const auth = this.resolveAuth(opts.cfg)
        if (!auth) {
            this.modelsCache = ClaudeApiService.STATIC_FALLBACK_MODELS
            this.modelsCacheError = 'Sign in to Claude Code or paste an API key to fetch the live list.'
            return { models: this.modelsCache, error: this.modelsCacheError, fromCache: false }
        }
        try {
            const clientOptions: any = {
                dangerouslyAllowBrowser: true,
                ...(auth.kind === 'oauth'
                    ? { authToken: auth.token, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } }
                    : { apiKey: auth.token }),
            }
            const client = new Anthropic(clientOptions)
            // The SDK exposes models.list with auto-pagination; we cap at a
            // single page (default 20) — the catalog is small and the
            // dropdown doesn't need every legacy variant.
            const page = await client.models.list({ limit: 100 })
            const data = (page as any).data as Array<{ id: string; display_name?: string }>
            const models = data
                .map(m => ({ id: m.id, displayName: m.display_name || m.id }))
                .sort((a, b) => a.displayName.localeCompare(b.displayName))
            this.modelsCache = models
            this.modelsCacheError = null
            return { models, error: null, fromCache: false }
        } catch (err: any) {
            console.warn('[claude-status] /v1/models failed:', err?.message || err)
            this.modelsCache = ClaudeApiService.STATIC_FALLBACK_MODELS
            this.modelsCacheError = err?.message || String(err)
            return { models: this.modelsCache, error: this.modelsCacheError, fromCache: false }
        }
    }

    /** Drop the cached models list — caller wants a fresh fetch. */
    invalidateModels(): void {
        this.modelsCache = null
        this.modelsCacheError = null
    }

    /**
     * Returns the generated phrase, or `null` on timeout / API error / empty
     * response. Callers fall back to the static phrase on `null`.
     *
     * Auth resolution: subscription-first.
     * 1. Read `claudeAiOauth.accessToken` from `~/.claude/.credentials.json`.
     *    If it's present and not expired, send `Authorization: Bearer …`
     *    plus `anthropic-beta: oauth-2025-04-20`. The user's Max/Pro
     *    subscription pays for the call — no API-key billing.
     * 2. Otherwise, if the user pasted an API key into settings, use that.
     * 3. Otherwise, return null with a recorded reason.
     */
    async generatePhrase(
        ctx: DynamicPhraseContext,
        cfg: ClaudeStatusDynamicConfig,
        promptTemplate: string,
    ): Promise<string | null> {
        const auth = this.resolveAuth(cfg)
        if (!auth) return null

        const userPrompt = this.fillTemplate(promptTemplate, ctx)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)

        try {
            const clientOptions: any = {
                dangerouslyAllowBrowser: true,
                ...(auth.kind === 'oauth'
                    ? { authToken: auth.token, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } }
                    : { apiKey: auth.token }),
            }
            const client = new Anthropic(clientOptions)

            const response = await client.messages.create(
                {
                    model: cfg.model || 'claude-haiku-4-5',
                    max_tokens: cfg.maxOutputTokens || 32,
                    system: SYSTEM_PROMPT,
                    messages: [{ role: 'user', content: userPrompt }],
                },
                { signal: controller.signal },
            )

            const text = response.content
                .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                .map(b => b.text)
                .join(' ')
                .trim()

            return this.cleanPhrase(text)
        } catch (err: any) {
            if (err?.name === 'AbortError' || controller.signal.aborted) {
                return null
            }
            // 401 on a subscription token usually means the file was rewritten
            // mid-flight (Claude Code refreshed). Drop the cache so the next
            // call reads the new token.
            if (err?.status === 401 && auth.kind === 'oauth') {
                this.credentials.invalidate()
            }
            console.warn('[claude-status] Dynamic phrase API call failed:', err?.message || err)
            return null
        } finally {
            clearTimeout(timer)
        }
    }

    private resolveAuth(cfg: ClaudeStatusDynamicConfig):
        | { kind: 'oauth'; token: string }
        | { kind: 'api-key'; token: string }
        | null {
        const status = this.credentials.getStatus()
        if (status.state === 'ok' && status.creds) {
            return { kind: 'oauth', token: status.creds.accessToken }
        }
        if (cfg.apiKey) {
            return { kind: 'api-key', token: cfg.apiKey }
        }
        return null
    }

    /**
     * Substitute {placeholder} tokens. Missing fields collapse to empty
     * strings rather than leaving the literal `{tool}` in the prompt — Haiku
     * handles "Tool: " gracefully but echoes literal placeholders sometimes.
     */
    private fillTemplate(template: string, ctx: DynamicPhraseContext): string {
        const meta = (ctx.metadata || {}) as Record<string, any>
        const t = ctx.transcript
        const map: Record<string, string> = {
            status: ctx.status,
            eventName: ctx.eventName ?? '',
            tool: meta.tool ?? '',
            message: meta.message ?? '',
            type: meta.type ?? '',
            cwd: meta.cwd ?? '',
            sessionId: meta.session ?? '',
            lastAssistant: t?.lastAssistant ?? '',
            lastUserPrompt: t?.lastUserPrompt ?? '',
            lastToolName: t?.lastToolName ?? meta.tool ?? '',
        }
        return template.replace(/\{(\w+)\}/g, (_, key) => map[key] ?? '')
    }

    /**
     * Strip punctuation, surrounding quotes, and trailing markdown that
     * Haiku occasionally emits despite the system prompt. Length cap at 60
     * chars is a defensive backstop against runaway responses.
     */
    private cleanPhrase(text: string): string | null {
        if (!text) return null
        let out = text
            .replace(/^["'`*_]+|["'`*_]+$/g, '')
            .replace(/[.!?,;:]+$/g, '')
            .trim()
        if (!out) return null
        if (out.length > 60) out = out.slice(0, 60).trim()
        return out
    }
}
