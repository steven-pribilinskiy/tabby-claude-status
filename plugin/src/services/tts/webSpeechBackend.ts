import { TtsBackend, TtsSpeakParams, TtsVoice } from './tts.interface'

/**
 * Uses the browser-provided Web Speech API. In Electron on Windows this
 * enumerates only SAPI 5 voices (David/Mark/Zira), but it is the one
 * backend that is always available with no install, so we keep it as the
 * fallback.
 */
export class WebSpeechBackend implements TtsBackend {
    readonly id = 'webspeech' as const
    readonly label = 'Web Speech (SAPI)'

    async isAvailable(): Promise<boolean> {
        return typeof window !== 'undefined' && !!window.speechSynthesis
    }

    async listVoices(): Promise<TtsVoice[]> {
        const voices = this.getNativeVoices()
        if (voices.length > 0) return this.mapVoices(voices)

        // Voices sometimes load async; give the engine up to ~500ms to populate.
        await new Promise<void>(resolve => {
            if (typeof window === 'undefined' || !window.speechSynthesis) {
                resolve()
                return
            }
            const timeout = setTimeout(resolve, 500)
            const handler = () => {
                clearTimeout(timeout)
                resolve()
            }
            window.speechSynthesis.addEventListener('voiceschanged', handler, { once: true })
        })
        return this.mapVoices(this.getNativeVoices())
    }

    async speak(params: TtsSpeakParams): Promise<void> {
        if (typeof window === 'undefined' || !window.speechSynthesis) {
            throw new Error('speechSynthesis not available')
        }

        window.speechSynthesis.cancel()

        const utterance = new SpeechSynthesisUtterance(params.text)
        utterance.volume = params.volume
        utterance.rate = params.rate
        utterance.pitch = params.pitch

        if (params.voiceId) {
            const voice = this.getNativeVoices().find(v => v.name === params.voiceId)
            if (voice) utterance.voice = voice
        }

        utterance.onerror = e => {
            console.error('[claude-status] Web Speech TTS error:', (e as SpeechSynthesisErrorEvent).error)
        }

        window.speechSynthesis.speak(utterance)
    }

    cancel(): void {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.cancel()
        }
    }

    private getNativeVoices(): SpeechSynthesisVoice[] {
        if (typeof window === 'undefined' || !window.speechSynthesis) return []
        return window.speechSynthesis.getVoices()
    }

    private mapVoices(voices: SpeechSynthesisVoice[]): TtsVoice[] {
        return voices.map(v => ({
            id: v.name,
            label: `${v.name} (${v.lang})`,
            locale: v.lang,
        }))
    }
}
