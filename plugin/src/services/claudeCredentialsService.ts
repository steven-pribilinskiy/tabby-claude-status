import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Injectable } from '@angular/core'

export interface ClaudeCredentials {
    accessToken: string
    /** Unix ms */
    expiresAt: number
    /** e.g. 'max', 'pro', 'free'. Display only — don't gate on this. */
    subscriptionType?: string
    /** e.g. 'default_claude_max_20x'. Display only. */
    rateLimitTier?: string
    scopes: string[]
}

export interface CredentialsStatus {
    /** What we found — guides UI copy. */
    state: 'ok' | 'expired' | 'missing-file' | 'no-oauth' | 'no-inference-scope' | 'read-error'
    /** Present when `state === 'ok'` (and only then is it safe to use). */
    creds?: ClaudeCredentials
    /** Display path of the file we tried to read. */
    filePath: string
    /** Free-text detail when state ≠ 'ok' — surfaced verbatim in the UI. */
    detail?: string
}

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json')
const CACHE_MS = 30_000
const REQUIRED_SCOPE = 'user:inference'

/**
 * Reads the OAuth credentials Claude Code maintains at
 * `~/.claude/.credentials.json`. The token (`claudeAiOauth.accessToken`) is
 * the same one the `claude` CLI uses; combined with the
 * `anthropic-beta: oauth-2025-04-20` header it authenticates `/v1/messages`
 * calls against the user's subscription rather than a paid API key.
 *
 * We deliberately don't try to refresh the token ourselves — the OAuth
 * client_id and refresh endpoint are an internal contract between Claude
 * Code and Anthropic that's outside this plugin's stable surface area. When
 * the user runs `claude` (or any tool that triggers Claude Code's own
 * refresh), the file gets rewritten and we pick up the new token on the
 * next read. If the token is genuinely expired and the user hasn't run
 * Claude Code recently, we surface a "run claude to refresh" message.
 *
 * Reads are cached for 30 s — bursts of hook events shouldn't pound the
 * filesystem, but the cache is short enough that a `claude` refresh during
 * a Tabby session becomes visible within half a minute.
 */
@Injectable({ providedIn: 'root' })
export class ClaudeCredentialsService {
    private cached: { status: CredentialsStatus; readAt: number } | null = null

    /** Path of the credentials file (for display in the settings UI). */
    get filePath(): string {
        return CREDENTIALS_PATH
    }

    /** Force the next `getStatus()` call to re-read from disk. */
    invalidate(): void {
        this.cached = null
    }

    getStatus(): CredentialsStatus {
        if (this.cached && Date.now() - this.cached.readAt < CACHE_MS) {
            const fresh = this.cached.status
            // If the cached token has expired since we read it, don't report a
            // stale "expired" — the file may already hold a refreshed token
            // (running `claude` rewrites it). Re-read from disk and re-cache so
            // a refresh becomes visible immediately rather than after the 30s
            // cache window elapses.
            //
            // The `> 0` matters: `read()` normalises a missing/non-numeric
            // `expiresAt` to 0 and treats only `> 0` as expiry-capable, so a
            // credentials file without that field yields state 'ok' with
            // expiresAt 0. Without the same guard here, `0 <= Date.now()` is
            // always true and every call would re-read and re-parse the file
            // synchronously — defeating the cache entirely on a code path that
            // runs once per hook event in dynamic audio mode.
            if (
                fresh.state === 'ok' &&
                fresh.creds &&
                fresh.creds.expiresAt > 0 &&
                fresh.creds.expiresAt <= Date.now()
            ) {
                const status = this.read()
                this.cached = { status, readAt: Date.now() }
                return status
            }
            return fresh
        }
        const status = this.read()
        this.cached = { status, readAt: Date.now() }
        return status
    }

    private read(): CredentialsStatus {
        if (!fs.existsSync(CREDENTIALS_PATH)) {
            return {
                state: 'missing-file',
                filePath: CREDENTIALS_PATH,
                detail: 'Run `claude login` (or just `claude`) once to sign in.',
            }
        }

        let parsed: any
        try {
            const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8')
            parsed = JSON.parse(raw)
        } catch (err: any) {
            return {
                state: 'read-error',
                filePath: CREDENTIALS_PATH,
                detail: err?.message || String(err),
            }
        }

        const oauth = parsed?.claudeAiOauth
        if (!oauth?.accessToken) {
            return {
                state: 'no-oauth',
                filePath: CREDENTIALS_PATH,
                detail: 'credentials.json exists but has no claudeAiOauth.accessToken. Run `claude login`.',
            }
        }

        const scopes: string[] = Array.isArray(oauth.scopes) ? oauth.scopes : []
        if (!scopes.includes(REQUIRED_SCOPE)) {
            return {
                state: 'no-inference-scope',
                filePath: CREDENTIALS_PATH,
                detail: `Token is missing the "${REQUIRED_SCOPE}" scope; can't call /v1/messages.`,
            }
        }

        const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0
        if (expiresAt > 0 && expiresAt <= Date.now()) {
            return {
                state: 'expired',
                filePath: CREDENTIALS_PATH,
                detail: 'OAuth token has expired. Run `claude` in any terminal — Claude Code refreshes the token on startup.',
            }
        }

        return {
            state: 'ok',
            filePath: CREDENTIALS_PATH,
            creds: {
                accessToken: oauth.accessToken,
                expiresAt,
                subscriptionType: oauth.subscriptionType,
                rateLimitTier: oauth.rateLimitTier,
                scopes,
            },
        }
    }
}
