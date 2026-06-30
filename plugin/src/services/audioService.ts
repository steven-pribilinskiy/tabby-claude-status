import { Injectable } from '@angular/core'
import type { ClaudeStatusAudioConfig, ClaudeStatusName, TtsBackendId } from '../interfaces/types'
import { ClaudeApiService, type DynamicPhraseContext } from './claudeApiService'
import { ClaudeStatusConfigService } from './configService'
import { MicStateService } from './micStateService'
import { SoundService } from './soundService'
import { StatusActivityLogService } from './statusActivityLogService'
import { TranscriptReaderService, type TranscriptTail } from './transcriptReaderService'
import { EdgeTtsBackend } from './tts/edgeTtsBackend'
import { PiperBackend } from './tts/piperBackend'
import type { TtsBackend, TtsSpeakParams } from './tts/tts.interface'
import { WebSpeechBackend } from './tts/webSpeechBackend'
import { WinRtBackend } from './tts/winRtBackend'
import { ZoomStateService } from './zoomStateService'

@Injectable({ providedIn: 'root' })
export class AudioService {
    private readonly webSpeech = new WebSpeechBackend()
    private readonly edge = new EdgeTtsBackend()
    private readonly winrt = new WinRtBackend()
    private readonly piper = new PiperBackend()

    /**
     * Monotonic id bumped on every `speak()` call. The async pipeline (mute
     * probes + dynamic-phrase generation) can take seconds, during which a
     * newer status event may arrive. Each playback path captures the id at
     * dispatch time and bails if it's no longer current, so a slow dynamic
     * phrase for a now-stale status never plays over the newer one. Also used
     * to cancel any in-flight backend before starting a new utterance, so two
     * events on different backends don't overlap.
     */
    private playGeneration = 0

    /**
     * Last wall-clock ms a 'question'-status phrase was announced, keyed by
     * Claude session id. Used to coalesce the duplicate burst Claude Code
     * fires for a single permission/question prompt — see `speak()`.
     */
    private lastQuestionAnnounceBySession: Map<string, number> = new Map()
    /** Window within which a second 'question' event for the same session is
     *  treated as a duplicate of the first and suppressed. The observed gap
     *  between the PermissionRequest and its paired Notification is ~6–6.5s. */
    private static readonly QUESTION_COALESCE_MS = 9000

    constructor(
        private configService: ClaudeStatusConfigService,
        private zoomState: ZoomStateService,
        private micState: MicStateService,
        private soundService: SoundService,
        private activityLog: StatusActivityLogService,
        private claudeApi: ClaudeApiService,
        private transcriptReader: TranscriptReaderService,
    ) {}

    getBackend(id: TtsBackendId): TtsBackend {
        switch (id) {
            case 'edge':
                return this.edge
            case 'winrt':
                return this.winrt
            case 'piper':
                return this.piper
            default:
                return this.webSpeech
        }
    }

    listAllBackends(): TtsBackend[] {
        return [this.webSpeech, this.edge, this.winrt, this.piper]
    }

    /** Returns the Web Speech backend so the settings UI can still preload SAPI voices eagerly. */
    getWebSpeech(): WebSpeechBackend {
        return this.webSpeech
    }

    /**
     * Push the user's saved Piper paths into the backend instance. Without
     * this the backend's exePath/modelPath fields stay empty until the
     * first `speakText()` call, which makes `isAvailable()` lie to anyone
     * (e.g. the settings panel's backend dropdown) that probes earlier.
     */
    configurePiperFromConfig(): void {
        const cfg = this.configService.getAudioConfig()
        this.piper.configure(cfg.piperExePath, cfg.piperModelPath)
    }

    /**
     * Announce the given status. Dispatches to one of three pipelines based on
     * `mode`:
     * - `'tts'` — speak the static `statusTexts[status]` via the chosen backend
     * - `'sound'` — play the file in `soundsByStatus[status]`
     * - `'dynamic'` — ask Haiku 4.5 to generate a context-aware phrase using
     *   `ctx` (hook metadata + on-disk transcript), then speak it. Falls back
     *   to the static phrase on API failure / timeout / disabled-for-status.
     *
     * All three pipelines run after the same Zoom + mic mute gates. Web Speech
     * is the failure fallback for TTS so a misconfigured backend never silences
     * the plugin.
     */
    /**
     * True when a 'question'-status event is Claude *asking permission to
     * proceed* — a tool-permission grant, an ExitPlanMode plan approval, or a
     * `permission_prompt`/`confirmation` notification — as opposed to a
     * questionnaire (`AskUserQuestion` / `ask_user`) or an idle nudge
     * (`idle_prompt`). The authoritative signal is the `PermissionRequest`
     * event's `tool`: every tool except `AskUserQuestion` is a permission, and
     * `AskUserQuestion` is the questionnaire. Notification types map directly.
     */
    private isPermissionEvent(ctx?: {
        metadata?: Record<string, any> | unknown
        eventName?: string
    }): boolean {
        const meta = (ctx?.metadata ?? {}) as Record<string, any>
        const type = meta.type
        if (type === 'permission_prompt' || type === 'confirmation') return true
        if (type === 'ask_user' || type === 'idle_prompt') return false
        if (ctx?.eventName === 'PermissionRequest') return meta.tool !== 'AskUserQuestion'
        return false
    }

    speak(
        status: ClaudeStatusName,
        activityLogId?: string,
        ctx?: { metadata?: Record<string, any> | unknown; eventName?: string },
    ): void {
        const config = this.configService.getAudioConfig()
        if (!config.enabled) {
            if (activityLogId) {
                this.activityLog.setAudioOutcome(
                    activityLogId,
                    'suppressed-disabled',
                    'audio.enabled = false',
                )
            }
            return
        }

        // Collapse the duplicate burst Claude Code fires for a single
        // permission/question prompt. A permission prompt emits an immediate
        // `PermissionRequest` (which carries the tool) followed ~6s later by a
        // `Notification{permission_prompt}` for the same session; both map to
        // the 'question' status, so without this the user hears the phrase
        // twice, seconds apart. The `playGeneration` supersede below only
        // collapses announcements that overlap in time, which these don't.
        // Keyed per session so a genuine prompt in another tab still speaks;
        // also catches the occasional back-to-back idle_prompt double.
        if (status === 'question') {
            const session = String((ctx?.metadata as any)?.session || '')
            const now = Date.now()
            const last = session ? this.lastQuestionAnnounceBySession.get(session) : undefined
            if (last !== undefined && now - last < AudioService.QUESTION_COALESCE_MS) {
                if (activityLogId) {
                    this.activityLog.setAudioOutcome(
                        activityLogId,
                        'suppressed-duplicate',
                        'coalesced question/permission burst (same session, <9s)',
                    )
                }
                return
            }
            if (session) this.lastQuestionAnnounceBySession.set(session, now)
        }

        // Supersede any in-flight announcement. Captured here (synchronously)
        // so a newer event always wins the race through the async mute/dynamic
        // pipeline below.
        const gen = ++this.playGeneration

        const isSoundMode = config.mode === 'sound'
        const isDynamicMode = config.mode === 'dynamic'
        // Permission prompts (Claude stopping to ask you to proceed) speak a
        // distinct word from questionnaires (AskUserQuestion / ask_user) and
        // idle nudges, even though both share the 'question' visual status.
        // Only the spoken text differs; sound mode keeps the 'question' chime.
        const isPermission =
            !isSoundMode && status === 'question' && this.isPermissionEvent(ctx)
        // Static fallback payload — the dynamic path uses this if the LLM
        // call fails or is disabled for the status.
        const staticPayload = isSoundMode
            ? config.soundsByStatus[status]
            : isPermission && config.permissionText
              ? config.permissionText
              : config.statusTexts[status]

        if (activityLogId) {
            this.activityLog.patchEntry(activityLogId, {
                audioMode: config.mode,
                audioPayload: staticPayload,
            })
        }

        // Dynamic mode is only narrated for done + question; everything else
        // falls through to the static phrase.
        const dynamicCfg =
            isDynamicMode && (status === 'done' || status === 'question')
                ? config.dynamic.perStatus[status]
                : null

        if (!staticPayload && !dynamicCfg?.enabled) {
            if (activityLogId) {
                this.activityLog.setAudioOutcome(
                    activityLogId,
                    'suppressed-no-payload',
                    `${config.mode} mapping is empty for "${status}"`,
                )
            }
            return
        }

        Promise.all([
            this.zoomState.shouldMute(config),
            this.micState.shouldMute(config, config.mode),
        ]).then(
            async ([zoomMute, micMute]) => {
                if (zoomMute || micMute) {
                    const reason = zoomMute ? 'Zoom is active' : 'microphone is in use'
                    this.configService.debug(`Suppressing "${staticPayload}" — ${reason}`)
                    if (activityLogId) {
                        this.activityLog.setAudioOutcome(
                            activityLogId,
                            zoomMute ? 'suppressed-zoom' : 'suppressed-mic',
                            reason,
                        )
                    }
                    return
                }

                if (dynamicCfg?.enabled) {
                    const phrase = await this.tryDynamicPhrase(status, dynamicCfg, ctx, config)
                    if (phrase) {
                        // Generation may have advanced while the LLM call was in
                        // flight — drop this phrase rather than speak over the
                        // newer status.
                        if (!this.claimPlayback(gen)) return
                        this.speakText(phrase, config)
                        if (config.systemBeep) this.playBeep(config.volume)
                        if (activityLogId) {
                            this.activityLog.patchEntry(activityLogId, { audioPayload: phrase })
                            this.activityLog.setAudioOutcome(
                                activityLogId,
                                'announced',
                                dynamicCfg.transcriptOnly
                                    ? 'dynamic (transcript-only)'
                                    : 'dynamic (haiku)',
                            )
                        }
                        return
                    }
                    // Dynamic generation didn't yield a phrase — fall through to
                    // the static phrase if there is one. Note the fallback in the
                    // log so the user knows why they heard the boilerplate.
                    if (!staticPayload) {
                        if (activityLogId) {
                            this.activityLog.setAudioOutcome(
                                activityLogId,
                                'suppressed-no-payload',
                                'dynamic returned null and no static fallback configured',
                            )
                        }
                        return
                    }
                    if (activityLogId) {
                        this.activityLog.patchEntry(activityLogId, {
                            audioOutcomeDetail: 'dynamic-fallback',
                        })
                    }
                }

                if (!this.claimPlayback(gen)) return
                this.dispatchPlayback(isSoundMode, staticPayload!, config)
                if (activityLogId) {
                    this.activityLog.setAudioOutcome(activityLogId, 'announced')
                }
            },
            (err) => {
                console.warn('[claude-status] Mute probe failed, playing anyway:', err)
                if (staticPayload && this.claimPlayback(gen)) {
                    this.dispatchPlayback(isSoundMode, staticPayload, config)
                    if (activityLogId) {
                        this.activityLog.setAudioOutcome(
                            activityLogId,
                            'announced',
                            'mute-probe failed; played anyway',
                        )
                    }
                }
            },
        )
    }

    /**
     * Cancel every backend's in-flight utterance and any playing sound effect.
     * Used to stop an older announcement before a newer one starts so the two
     * don't overlap (each backend only self-cancels its own utterances; nothing
     * else coordinates across backends).
     */
    private cancelAll(): void {
        for (const b of [this.webSpeech, this.edge, this.winrt, this.piper]) {
            try {
                b.cancel()
            } catch {
                /* noop */
            }
        }
        try {
            this.soundService.stop()
        } catch {
            /* noop */
        }
    }

    /**
     * Returns true if `gen` is still the latest `speak()` generation — i.e. no
     * newer status event has arrived. When current, cancels any in-flight audio
     * first so the new utterance plays cleanly. Returns false (doing nothing)
     * when superseded, so the caller drops the stale playback.
     */
    private claimPlayback(gen: number): boolean {
        if (gen !== this.playGeneration) return false
        this.cancelAll()
        return true
    }

    /**
     * Generate a dynamic announcement for `status`. Returns null when the
     * caller should fall back to the static phrase.
     *
     * Three branches:
     * 1. `transcriptOnly`: read the JSONL transcript and synthesize a phrase
     *    locally. No API call, no token cost.
     * 2. API call with transcript context: read the JSONL, send it as part
     *    of the user prompt to Haiku.
     * 3. API call without transcript: hook payload had no `transcript_path`
     *    (e.g. an old hook.js, or an event that fires before SessionStart).
     *    Send what metadata we have.
     */
    private async tryDynamicPhrase(
        status: ClaudeStatusName,
        statusCfg: { promptTemplate: string; transcriptOnly: boolean },
        ctx: { metadata?: Record<string, any> | unknown; eventName?: string } | undefined,
        config: ClaudeStatusAudioConfig,
    ): Promise<string | null> {
        const meta = ctx?.metadata as Record<string, any> | undefined
        const transcriptPath = meta?.transcript_path as string | undefined
        const transcript: TranscriptTail | undefined = transcriptPath
            ? this.transcriptReader.readTail(transcriptPath)
            : undefined

        if (statusCfg.transcriptOnly) {
            if (!transcript?.lastAssistant) return null
            return this.transcriptReader.extractAnnouncement(transcript.lastAssistant)
        }

        // No explicit auth gate here: claudeApi.resolveAuth() is subscription-
        // first and works with the OAuth token from ~/.claude/.credentials.json
        // when no API key is set (the common Max/Pro case). It returns null on
        // its own when neither OAuth nor an API key is available, and
        // generatePhrase() then returns null so we fall back to the static
        // phrase. Gating on config.dynamic.apiKey here wrongly disabled dynamic
        // mode for every subscription user who never pasted a key.
        const phraseCtx: DynamicPhraseContext = {
            status,
            eventName: ctx?.eventName,
            metadata: meta,
            transcript,
        }
        return this.claudeApi.generatePhrase(phraseCtx, config.dynamic, statusCfg.promptTemplate)
    }

    private dispatchPlayback(
        isSoundMode: boolean,
        payload: string,
        config: ClaudeStatusAudioConfig,
    ): void {
        if (isSoundMode) {
            this.soundService.play(payload, config.volume)
        } else {
            this.speakText(payload, config)
        }
        if (config.systemBeep) {
            this.playBeep(config.volume)
        }
    }

    /**
     * Plays a sound from the settings UI's per-status Test buttons, bypassing
     * the mic/Zoom mute gates so previewing during dictation still works.
     */
    async testPlaySound(filePath: string, volume?: number): Promise<void> {
        const config = this.configService.getAudioConfig()
        return this.soundService.play(filePath, volume ?? config.volume)
    }

    async speakText(text: string, config?: Partial<ClaudeStatusAudioConfig>): Promise<void> {
        const merged = {
            ...this.configService.getAudioConfig(),
            ...(config || {}),
        } as ClaudeStatusAudioConfig

        // Keep Piper's configured paths in sync on every call — cheap enough, and
        // the user may change them from the settings tab without re-loading.
        this.piper.configure(merged.piperExePath, merged.piperModelPath)

        const backend = this.getBackend(merged.backend)
        const voiceId =
            merged.voicesByBackend[merged.backend] ||
            (merged.backend === 'webspeech' ? merged.voiceName : '')

        const params: TtsSpeakParams = {
            text,
            voiceId: voiceId || undefined,
            volume: merged.volume,
            rate: merged.rate,
            pitch: merged.pitch,
        }

        try {
            await backend.speak(params)
        } catch (err) {
            console.warn(
                `[claude-status] Backend "${merged.backend}" failed, falling back to Web Speech:`,
                err,
            )
            if (backend.id !== 'webspeech') {
                try {
                    // Voice ids are not comparable across backends (Edge uses
                    // Azure ShortNames like "en-US-AriaNeural", Web Speech uses
                    // SAPI display names). Use the Web Speech voice saved in
                    // voicesByBackend/voiceName, not whatever id the original
                    // backend was trying to use.
                    const webSpeechVoice =
                        merged.voicesByBackend?.webspeech || merged.voiceName || undefined
                    await this.webSpeech.speak({ ...params, voiceId: webSpeechVoice })
                } catch (fallbackErr) {
                    console.error('[claude-status] Web Speech fallback also failed:', fallbackErr)
                }
            }
        }
    }

    /** Legacy passthrough kept for the settings "Test" buttons. */
    getVoices(): SpeechSynthesisVoice[] {
        if (typeof window === 'undefined' || !window.speechSynthesis) return []
        return window.speechSynthesis.getVoices()
    }

    playBeep(volume = 0.7): void {
        const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
        if (!AudioCtx) return

        let ctx: AudioContext | null = null
        try {
            ctx = new AudioCtx()
            const oscillator = ctx.createOscillator()
            const gain = ctx.createGain()

            oscillator.connect(gain)
            gain.connect(ctx.destination)

            oscillator.frequency.value = 800
            gain.gain.value = Math.max(0, Math.min(1, volume))

            // Close the context when the tone ends. Without this we leak one
            // AudioContext per beep, and browsers hard-cap concurrent contexts
            // (~6) — after which `new AudioContext()` throws and beeps silently
            // stop working.
            const localCtx = ctx
            oscillator.onended = () => {
                try {
                    localCtx.close()
                } catch {
                    /* noop */
                }
            }

            oscillator.start()
            oscillator.stop(ctx.currentTime + 0.2)
        } catch (_) {
            // Creation/start failed — close the context if we managed to make one
            // so a throw after construction doesn't leak it.
            if (ctx) {
                try {
                    ctx.close()
                } catch {
                    /* noop */
                }
            }
        }
    }
}
