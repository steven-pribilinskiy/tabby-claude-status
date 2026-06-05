import { spawn } from 'node:child_process'
import type { TtsBackend, TtsSpeakParams, TtsVoice } from './tts.interface'

/**
 * Uses Windows Runtime `Windows.Media.SpeechSynthesis` via PowerShell.
 * Unlike SAPI 5 (which is what `window.speechSynthesis` and
 * `System.Speech.SpeechSynthesizer` both use on Windows), this surface
 * exposes the modern OneCore / "Natural" voices that ship with Windows
 * 10/11 and the ones users add from Settings → Time & Language → Speech.
 *
 * Offline. Windows-only.
 */
export class WinRtBackend implements TtsBackend {
    readonly id = 'winrt' as const
    readonly label = 'Windows OneCore (offline)'

    private currentProcess: ReturnType<typeof spawn> | null = null
    private currentWatchdog: ReturnType<typeof setTimeout> | null = null
    private voicesCache: TtsVoice[] | null = null

    /** Hard upper bound on how long a single utterance's PowerShell host may
     *  live. The script self-terminates after a computed Start-Sleep, but a
     *  bad stream size or a hung WinRT call could otherwise leave the host
     *  alive indefinitely — this watchdog guarantees it's reaped. */
    private static readonly MAX_UTTERANCE_MS = 30_000

    async isAvailable(): Promise<boolean> {
        if (process.platform !== 'win32') return false
        try {
            const voices = await this.listVoices()
            return voices.length > 0
        } catch {
            return false
        }
    }

    async listVoices(): Promise<TtsVoice[]> {
        if (this.voicesCache) return this.voicesCache
        if (process.platform !== 'win32') return []

        const ps = `
            Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
            [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime] | Out-Null
            [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
                ForEach-Object { [PSCustomObject]@{ Id = $_.Id; DisplayName = $_.DisplayName; Language = $_.Language; Gender = $_.Gender.ToString() } } |
                ConvertTo-Json -Compress
        `
        try {
            const out = await this.runPowerShell(ps)
            if (!out) return []
            const parsed = JSON.parse(out)
            const arr = Array.isArray(parsed) ? parsed : [parsed]
            this.voicesCache = arr.map((v: any) => ({
                id: v.Id,
                label: `${v.DisplayName} — ${v.Language} (${v.Gender})`,
                locale: v.Language,
                gender: v.Gender,
            }))
            return this.voicesCache
        } catch (err) {
            console.error('[claude-status] WinRT listVoices failed:', err)
            return []
        }
    }

    async speak(params: TtsSpeakParams): Promise<void> {
        if (process.platform !== 'win32') {
            throw new Error('WinRT backend is Windows-only')
        }

        // Rate on WinRT's SpeakingRate is 0.5..6, default 1. Pitch maps to
        // AudioPitch in 0..2. Volume is AudioVolume in 0..1 (matches ours).
        const rate = Math.max(0.5, Math.min(6, params.rate))
        const pitch = Math.max(0, Math.min(2, params.pitch))
        const volume = Math.max(0, Math.min(1, params.volume))

        // Escape the text for PowerShell's single-quoted string literals.
        const psText = params.text.replace(/'/g, "''")
        const voiceLine = params.voiceId
            ? `$v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object Id -eq '${params.voiceId.replace(/'/g, "''")}' | Select-Object -First 1; if ($v) { $synth.Voice = $v }`
            : ''

        const ps = `
            Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
            [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime] | Out-Null
            [Windows.Media.Playback.MediaPlayer,Windows.Media.Playback,ContentType=WindowsRuntime] | Out-Null
            [Windows.Media.Core.MediaSource,Windows.Media.Core,ContentType=WindowsRuntime] | Out-Null

            $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
                Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } |
                Select-Object -First 1)
            function Await($WinRtTask, $ResultType) {
                $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
                $netTask = $asTask.Invoke($null, @($WinRtTask))
                $netTask.Wait() | Out-Null
                $netTask.Result
            }

            $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
            $synth.Options.SpeakingRate = ${rate}
            $synth.Options.AudioPitch = ${pitch}
            $synth.Options.AudioVolume = ${volume}
            ${voiceLine}

            $op = $synth.SynthesizeTextToStreamAsync('${psText}')
            $stream = Await $op ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])

            $player = New-Object Windows.Media.Playback.MediaPlayer
            $player.AutoPlay = $true
            $player.Source = [Windows.Media.Core.MediaSource]::CreateFromStream($stream, $stream.ContentType)
            $player.Play()

            # Keep the process alive long enough for playback to finish. Clamp
            # so a bogus stream size can't sleep for minutes; the JS watchdog is
            # the hard backstop.
            $dur = [Math]::Min([Math]::Max($stream.Size / 32000.0 + 1.5, 0.5), 30)
            Start-Sleep -Seconds $dur
        `

        this.cancel()
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
            windowsHide: true,
        })
        this.currentProcess = proc
        proc.on('error', (err) => {
            console.error('[claude-status] WinRT speak spawn error:', err)
        })
        // Clear our handle once the host exits on its own so a later cancel()
        // doesn't kill an unrelated recycled PID and we don't hold a dead ref.
        proc.on('exit', () => {
            if (this.currentProcess === proc) {
                this.currentProcess = null
                if (this.currentWatchdog) {
                    clearTimeout(this.currentWatchdog)
                    this.currentWatchdog = null
                }
            }
        })
        this.currentWatchdog = setTimeout(() => {
            if (this.currentProcess === proc) this.cancel()
        }, WinRtBackend.MAX_UTTERANCE_MS)
    }

    cancel(): void {
        if (this.currentWatchdog) {
            clearTimeout(this.currentWatchdog)
            this.currentWatchdog = null
        }
        if (this.currentProcess) {
            try {
                this.currentProcess.kill()
            } catch {
                /* already dead */
            }
            this.currentProcess = null
        }
    }

    private runPowerShell(script: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', script],
                {
                    windowsHide: true,
                },
            )
            let stdout = ''
            let stderr = ''
            proc.stdout.on('data', (d) => {
                stdout += d.toString()
            })
            proc.stderr.on('data', (d) => {
                stderr += d.toString()
            })
            proc.on('error', reject)
            proc.on('close', (code) => {
                if (code === 0) resolve(stdout.trim())
                else reject(new Error(`powershell exited ${code}: ${stderr}`))
            })
        })
    }
}
