import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TtsBackend, TtsSpeakParams, TtsVoice } from './tts.interface'

/**
 * Piper TTS — local ONNX neural voices. Originally https://github.com/rhasspy/piper
 * (now archived); the supported successor is https://github.com/OHF-Voice/piper1-gpl
 * which ships the `piper-tts` PyPI package. Either binary works: both expose
 * the same `-m <model> -f <out.wav>` CLI and read text from stdin.
 *
 * The user supplies:
 *   - `piperExePath`: path to a `piper.exe` (`<venv>/Scripts/piper.exe` after
 *     install, or any standalone build that still works)
 *   - `piperModelPath`: path to a `.onnx` model file (a matching `.onnx.json`
 *     must live next to it)
 *
 * We synthesise into a temp WAV file and play it back via an HTMLAudio
 * element. We deliberately do *not* pipe WAV bytes through the child's
 * stdout: on Windows the CRT defaults stdout to text mode, which translates
 * every 0x0A byte to 0x0D 0x0A — that shreds binary samples and is what
 * caused the "extreme distortion" people heard before this change.
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

        const tmpWav = path.join(
            os.tmpdir(),
            `piper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
        )

        const proc = spawn(this.exePath, ['-m', this.modelPath, '-f', tmpWav], {
            windowsHide: true,
        })

        proc.stdin.write(params.text + '\n')
        proc.stdin.end()

        await new Promise<void>((resolve, reject) => {
            let stderr = ''
            proc.stderr.on('data', d => { stderr += d.toString() })
            proc.on('error', reject)
            proc.on('close', code => {
                if (code === 0) resolve()
                else reject(new Error(`piper exited ${code}: ${stderr.trim() || '(no stderr)'}`))
            })
        })

        let wav: Buffer
        try {
            wav = await fs.promises.readFile(tmpWav)
        } finally {
            fs.promises.unlink(tmpWav).catch(() => { /* best-effort cleanup */ })
        }
        if (wav.length < 44) {
            throw new Error(`piper produced an empty/too-small WAV (${wav.length} bytes)`)
        }

        const blob = new Blob([wav], { type: 'audio/wav' })
        const url = URL.createObjectURL(blob)

        this.cancel()
        const audio = new Audio(url)
        audio.volume = params.volume
        audio.playbackRate = Math.max(0.5, Math.min(4, params.rate))
        this.currentAudio = audio
        audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })
        audio.addEventListener('error', () => URL.revokeObjectURL(url), { once: true })
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
