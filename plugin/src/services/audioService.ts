import { Injectable } from '@angular/core'
import { ClaudeStatusConfigService } from './configService'
import { ClaudeStatusAudioConfig, ClaudeStatusName } from '../interfaces/types'

@Injectable({ providedIn: 'root' })
export class AudioService {
    constructor(private configService: ClaudeStatusConfigService) {}

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

    speakText(text: string, config?: Partial<ClaudeStatusAudioConfig>): void {
        if (typeof window === 'undefined') {
            console.warn('[claude-status] No window object')
            return
        }
        if (!window.speechSynthesis) {
            console.warn('[claude-status] speechSynthesis not available')
            return
        }

        const audioConfig = this.configService.getAudioConfig()
        const merged = config ? { ...audioConfig, ...config } : audioConfig

        window.speechSynthesis.cancel()

        const utterance = new SpeechSynthesisUtterance(text)
        utterance.volume = merged.volume
        utterance.rate = merged.rate
        utterance.pitch = merged.pitch

        if (merged.voiceName) {
            const voices = this.getVoices()
            const voice = voices.find(v => v.name === merged.voiceName)
            if (voice) {
                utterance.voice = voice
            }
        }

        utterance.onerror = (e) => {
            console.error('[claude-status] TTS error:', e.error, e)
        }

        console.log('[claude-status] Speaking:', text, 'voices available:', this.getVoices().length)
        window.speechSynthesis.speak(utterance)
    }

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
