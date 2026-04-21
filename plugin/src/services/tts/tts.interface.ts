import { TtsBackendId } from '../../interfaces/types'

/**
 * A voice offered by a TTS backend. `id` is the identifier passed back to
 * `speak()`; `label` is what we show in the settings dropdown.
 */
export interface TtsVoice {
    id: string
    label: string
    locale?: string
    gender?: string
}

/**
 * Speak parameters. `volume` 0..1, `rate` 0.5..2, `pitch` 0..2
 * (matches the existing `ClaudeStatusAudioConfig` scale).
 */
export interface TtsSpeakParams {
    text: string
    voiceId?: string
    volume: number
    rate: number
    pitch: number
}

/**
 * A TTS backend. Every implementation must be safe to construct regardless
 * of whether the backend is reachable; availability is discovered via
 * `isAvailable()` and `listVoices()`.
 */
export interface TtsBackend {
    readonly id: TtsBackendId
    readonly label: string

    /** Lightweight probe used by the settings UI to show a ✓/✗ next to each backend. */
    isAvailable(): Promise<boolean>

    /** Return voices this backend exposes. May reach the network. */
    listVoices(): Promise<TtsVoice[]>

    /** Speak the utterance. Resolves when playback begins (not when it ends). */
    speak(params: TtsSpeakParams): Promise<void>

    /** Cancel any currently-playing utterance from this backend. */
    cancel(): void
}
