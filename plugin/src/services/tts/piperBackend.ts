import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { TtsBackend, TtsSpeakParams, TtsVoice } from './tts.interface'

/**
 * Piper TTS (https://github.com/rhasspy/piper) — local ONNX neural voices.
 * The user supplies:
 *   - `piperExePath`: path to `piper.exe` (or `piper` on *nix)
 *   - `piperModelPath`: path to a `.onnx` model file (a matching `.onnx.json` must live next to it)
 *
 * We pipe the synthesised WAV to stdout and play it back via an HTMLAudio
 * element. The backend reports "unavailable" if either path is missing or
 * points at a non-existent file.
 */
export class PiperBackend implements TtsBackend {
    readonly id = 'piper' as const
    readonly label = 'Piper (local neural)'

    private exePath = ''
    private modelPath = ''
    private currentAudio: HTMLAudioElement | null = null

    configure(exePath: string, modelPath: string): void {
        this.exePath = exePath
        this.modelPath = modelPath
    }

    async isAvailable(): Promise<boolean> {
        if (!this.exePath || !this.modelPath) return false
        try {
            return fs.existsSync(this.exePath) && fs.existsSync(this.modelPath)
        } catch {
            return false
        }
    }

    async listVoices(): Promise<TtsVoice[]> {
        if (!await this.isAvailable()) return []
        // Piper speaks one model at a time. Surface the configured model as a
        // single "voice" entry so the UI has something to display.
        const base = path.basename(this.modelPath, '.onnx')
        return [{
            id: this.modelPath,
            label: `${base} (${this.modelPath})`,
        }]
    }

    async speak(params: TtsSpeakParams): Promise<void> {
        if (!await this.isAvailable()) {
            throw new Error('Piper backend not configured — set piperExePath and piperModelPath')
        }

        const proc = spawn(this.exePath, ['--model', this.modelPath, '--output_file', '-'], {
            windowsHide: true,
        })

        const chunks: Buffer[] = []
        proc.stdout.on('data', d => chunks.push(Buffer.from(d)))
        proc.stdin.write(params.text + '\n')
        proc.stdin.end()

        await new Promise<void>((resolve, reject) => {
            let stderr = ''
            proc.stderr.on('data', d => { stderr += d.toString() })
            proc.on('error', reject)
            proc.on('close', code => {
                if (code === 0) resolve()
                else reject(new Error(`piper exited ${code}: ${stderr}`))
            })
        })

        const wav = Buffer.concat(chunks)
        const blob = new Blob([wav], { type: 'audio/wav' })
        const url = URL.createObjectURL(blob)

        this.cancel()
        const audio = new Audio(url)
        audio.volume = params.volume
        audio.playbackRate = Math.max(0.5, Math.min(4, params.rate))
        this.currentAudio = audio
        audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })
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
