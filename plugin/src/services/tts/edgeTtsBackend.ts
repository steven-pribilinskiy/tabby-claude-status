import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import type { TtsBackend, TtsSpeakParams, TtsVoice } from './tts.interface'

/**
 * Microsoft Edge "Read Aloud" neural TTS via the free Azure endpoint used
 * by Edge. No API key needed; requires internet. Voice ids are Azure
 * `ShortName` strings like `en-US-AriaNeural`.
 *
 * The msedge-tts package opens a WebSocket per utterance. We cache the
 * voice list for the process lifetime since it rarely changes and the
 * settings UI may call listVoices() repeatedly.
 */
export class EdgeTtsBackend implements TtsBackend {
    readonly id = 'edge' as const
    readonly label = 'Edge TTS (neural, online)'

    private voicesCache: TtsVoice[] | null = null
    private currentAudio: HTMLAudioElement | null = null

    async isAvailable(): Promise<boolean> {
        try {
            const voices = await this.listVoices()
            return voices.length > 0
        } catch {
            return false
        }
    }

    async listVoices(): Promise<TtsVoice[]> {
        if (this.voicesCache) return this.voicesCache
        const tts = new MsEdgeTTS()
        try {
            const raw = await tts.getVoices()
            this.voicesCache = raw
                .map((v) => ({
                    id: v.ShortName,
                    label: `${v.FriendlyName || v.ShortName} — ${v.Locale} (${v.Gender})`,
                    locale: v.Locale,
                    gender: v.Gender,
                }))
                .sort((a, b) => a.label.localeCompare(b.label))
            return this.voicesCache
        } catch (err) {
            console.error('[claude-status] Edge TTS listVoices failed:', err)
            return []
        }
    }

    async speak(params: TtsSpeakParams): Promise<void> {
        if (!params.voiceId) {
            // No silent fallback: if the settings UI didn't hand us a voice id,
            // fail loudly so speakText() can fall back to Web Speech rather
            // than always playing the hard-coded Aria voice.
            throw new Error(
                'Edge TTS: no voice selected. Pick one in Settings → Audio / TTS → Voice.',
            )
        }
        const voiceId = params.voiceId
        console.info('[claude-status] Edge TTS speaking with voice:', voiceId)
        const tts = new MsEdgeTTS()
        await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)

        // Map the existing 0..1 / 0.5..2 / 0..2 scales into Edge's SSML prosody
        // syntax. Azure accepts signed percentages for rate/pitch/volume.
        const ratePct = Math.round((params.rate - 1) * 100)
        const pitchPct = Math.round((params.pitch - 1) * 100)
        const volumePct = Math.max(0, Math.min(100, Math.round(params.volume * 100)))

        const { audioStream } = tts.toStream(params.text, {
            rate: `${ratePct >= 0 ? '+' : ''}${ratePct}%`,
            pitch: `${pitchPct >= 0 ? '+' : ''}${pitchPct}%`,
            volume: volumePct,
        })

        // Buffer the MP3 stream into a data URL and hand it to <audio>.
        const chunks: Buffer[] = []
        for await (const chunk of audioStream as any) {
            chunks.push(Buffer.from(chunk))
        }
        tts.close()

        const mp3 = Buffer.concat(chunks)
        const blob = new Blob([mp3], { type: 'audio/mpeg' })
        const url = URL.createObjectURL(blob)

        this.cancel()
        const audio = new Audio(url)
        audio.volume = params.volume
        this.currentAudio = audio
        audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })
        audio.addEventListener(
            'error',
            (e) => {
                console.error('[claude-status] Edge TTS playback error:', e)
                URL.revokeObjectURL(url)
            },
            { once: true },
        )

        await audio.play()
    }

    cancel(): void {
        if (this.currentAudio) {
            this.currentAudio.pause()
            this.currentAudio.src = ''
            this.currentAudio = null
        }
    }
}
