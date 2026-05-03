import { Injectable } from '@angular/core'
import { ClaudeStatusConfigService } from './configService'
import { ZoomStateService } from './zoomStateService'
import { MicStateService } from './micStateService'
import { SoundService } from './soundService'
import { StatusActivityLogService } from './statusActivityLogService'
import { ClaudeApiService, DynamicPhraseContext } from './claudeApiService'
import { TranscriptReaderService, TranscriptTail } from './transcriptReaderService'
import { ClaudeStatusAudioConfig, ClaudeStatusName, TtsBackendId } from '../interfaces/types'
import { TtsBackend, TtsSpeakParams } from './tts/tts.interface'
import { WebSpeechBackend } from './tts/webSpeechBackend'
import { EdgeTtsBackend } from './tts/edgeTtsBackend'
import { WinRtBackend } from './tts/winRtBackend'
import { PiperBackend } from './tts/piperBackend'

@Injectable({ providedIn: 'root' })
export class AudioService {
    private readonly webSpeech = new WebSpeechBackend()
    private readonly edge = new EdgeTtsBackend()
    private readonly winrt = new WinRtBackend()
    private readonly piper = new PiperBackend()

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
            case 'edge': return this.edge
            case 'winrt': return this.winrt
            case 'piper': return this.piper
            case 'webspeech':
            default: return this.webSpeech
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
    speak(status: ClaudeStatusName, activityLogId?: string, ctx?: { metadata?: Record<string, any> | unknown; eventName?: string }): void {
        const config = this.configService.getAudioConfig()
        if (!config.enabled) {
            if (activityLogId) {
                this.activityLog.setAudioOutcome(activityLogId, 'suppressed-disabled', 'audio.enabled = false')
            }
            return
        }

        const isSoundMode = config.mode === 'sound'
        const isDynamicMode = config.mode === 'dynamic'
        // Static fallback payload — the dynamic path uses this if the LLM
        // call fails or is disabled for the status.
        const staticPayload = isSoundMode
            ? config.soundsByStatus[status]
            : config.statusTexts[status]

        if (activityLogId) {
            this.activityLog.patchEntry(activityLogId, {
                audioMode: config.mode,
                audioPayload: staticPayload,
            })
        }

        // Dynamic mode is only narrated for done + question; everything else
        // falls through to the static phrase.
        const dynamicCfg = isDynamicMode && (status === 'done' || status === 'question')
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
        ]).then(async ([zoomMute, micMute]) => {
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
                    this.speakText(phrase, config)
                    if (config.systemBeep) this.playBeep(config.volume)
                    if (activityLogId) {
                        this.activityLog.patchEntry(activityLogId, { audioPayload: phrase })
                        this.activityLog.setAudioOutcome(
                            activityLogId,
                            'announced',
                            dynamicCfg.transcriptOnly ? 'dynamic (transcript-only)' : 'dynamic (haiku)',
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

            this.dispatchPlayback(isSoundMode, staticPayload!, config)
            if (activityLogId) {
                this.activityLog.setAudioOutcome(activityLogId, 'announced')
            }
        }, err => {
            console.warn('[claude-status] Mute probe failed, playing anyway:', err)
            if (staticPayload) {
                this.dispatchPlayback(isSoundMode, staticPayload, config)
                if (activityLogId) {
                    this.activityLog.setAudioOutcome(activityLogId, 'announced', 'mute-probe failed; played anyway')
                }
            }
        })
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
        const transcriptPath = meta?.['transcript_path'] as string | undefined
        const transcript: TranscriptTail | undefined = transcriptPath
            ? this.transcriptReader.readTail(transcriptPath)
            : undefined

        if (statusCfg.transcriptOnly) {
            if (!transcript?.lastAssistant) return null
            return this.transcriptReader.extractAnnouncement(transcript.lastAssistant)
        }

        if (!config.dynamic.apiKey) return null

        const phraseCtx: DynamicPhraseContext = {
            status,
            eventName: ctx?.eventName,
            metadata: meta,
            transcript,
        }
        return this.claudeApi.generatePhrase(phraseCtx, config.dynamic, statusCfg.promptTemplate)
    }

    private dispatchPlayback(isSoundMode: boolean, payload: string, config: ClaudeStatusAudioConfig): void {
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
        const voiceId = merged.voicesByBackend[merged.backend] || (merged.backend === 'webspeech' ? merged.voiceName : '')

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
            console.warn(`[claude-status] Backend "${merged.backend}" failed, falling back to Web Speech:`, err)
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
        try {
            const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
            if (!AudioCtx) return

            const ctx = new AudioCtx()
            const oscillator = ctx.createOscillator()
            const gain = ctx.createGain()

            oscillator.connect(gain)
            gain.connect(ctx.destination)

            oscillator.frequency.value = 800
            gain.gain.value = volume

            oscillator.start()
            oscillator.stop(ctx.currentTime + 0.2)

            oscillator.onended = () => ctx.close()
        } catch (_) {
            // AudioContext not available
        }
    }
}
