import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TtsBackend, TtsSpeakParams, TtsVoice } from './tts.interface'

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
        // Deliberately not gated on isAvailable() — we still want to surface
        // any installed sibling .onnx files in the dropdown even when the
        // currently-configured model path is bogus. Selecting a sibling auto-
        // updates piperModelPath via the settings component's onVoiceChange.
        // The configured model is the first entry; sibling .onnx files in the
        // same directory get listed too so users who downloaded extra voices
        // (via the catalog modal in the settings UI) can pick them from the
        // dropdown instead of having to re-type the full path each time.
        const voices: TtsVoice[] = []
        const seen = new Set<string>()
        const push = (full: string) => {
            if (seen.has(full)) return
            seen.add(full)
            const base = path.basename(full, '.onnx')
            voices.push({ id: full, label: base, locale: this.localeFromKey(base) })
        }
        if (this.modelPath && fs.existsSync(this.modelPath)) push(this.modelPath)

        const modelsDir = path.dirname(this.modelPath)
        try {
            if (modelsDir && fs.existsSync(modelsDir)) {
                for (const f of await fs.promises.readdir(modelsDir)) {
                    if (f.endsWith('.onnx')) push(path.join(modelsDir, f))
                }
            }
        } catch (err) {
            console.warn('[claude-status] Piper modelsDir scan failed:', err)
        }
        return voices
    }

    /** Map a Piper voice key like `en_US-lessac-medium` to its BCP-47 locale. */
    private localeFromKey(key: string): string | undefined {
        const m = /^([a-z]{2,3})_([A-Z]{2})/.exec(key)
        return m ? `${m[1]}-${m[2]}` : undefined
    }

    async speak(params: TtsSpeakParams): Promise<void> {
        if (!(await this.isAvailable())) {
            throw new Error('Piper backend not configured — set piperExePath and piperModelPath')
        }

        const tmpWav = path.join(
            os.tmpdir(),
            `piper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
        )

        const proc = spawn(this.exePath, ['-m', this.modelPath, '-f', tmpWav], {
            windowsHide: true,
        })

        proc.stdin.write(`${params.text}\n`)
        proc.stdin.end()

        await new Promise<void>((resolve, reject) => {
            let stderr = ''
            proc.stderr.on('data', (d) => {
                stderr += d.toString()
            })
            proc.on('error', reject)
            proc.on('close', (code) => {
                if (code === 0) resolve()
                else reject(new Error(`piper exited ${code}: ${stderr.trim() || '(no stderr)'}`))
            })
        })

        let wav: Buffer
        try {
            wav = await fs.promises.readFile(tmpWav)
        } finally {
            fs.promises.unlink(tmpWav).catch(() => {
                /* best-effort cleanup */
            })
        }
        if (wav.length < 44) {
            throw new Error(`piper produced an empty/too-small WAV (${wav.length} bytes)`)
        }

        // `wav` is a Node Buffer (subclass of Uint8Array). @types/node@25
        // narrows Buffer's underlying ArrayBuffer to `ArrayBufferLike`
        // (= ArrayBuffer | SharedArrayBuffer), which is no longer assignable
        // to BlobPart's expected ArrayBufferView<ArrayBuffer>. Wrapping in a
        // fresh Uint8Array gives the type system the ArrayBuffer it wants
        // without copying bytes — Uint8Array shares the backing storage.
        const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' })
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
