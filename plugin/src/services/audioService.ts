import { Injectable } from '@angular/core'
import { ClaudeStatusConfigService } from './configService'
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

    constructor(private configService: ClaudeStatusConfigService) {}

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
     * Speak the phrase associated with `status`, dispatching to the configured
     * backend. Falls back to Web Speech if the selected backend throws, so a
     * misconfigured Edge/WinRT/Piper never silences the plugin.
     */
    speak(status: ClaudeStatusName): void {
        const config = this.configService.getAudioConfig()
        if (!config.enabled) return

        const text = config.statusTexts[status]
        if (!text) return

        this.speakText(text, config)

        if (config.systemBeep) {
            this.playBeep(config.volume)
        }
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
                    await this.webSpeech.speak(params)
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
