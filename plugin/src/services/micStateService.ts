import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Injectable } from '@angular/core'
import type { AudioMode, ClaudeStatusAudioConfig } from '../interfaces/types'

const execFileAsync = promisify(execFile)

const PROBE_TTL_MS = 10_000
const IS_WIN32 = process.platform === 'win32'

const MIC_REGISTRY_PATH =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'

// Windows tracks per-app mic access in the registry alongside the values
// shown in Settings → Privacy → Microphone. Each app subkey holds a
// LastUsedTimeStop QWORD that is 0x0 while the app currently holds the mic
// and a non-zero FILETIME after release. Match the in-use sentinel directly.
const ACTIVE_RE = /LastUsedTimeStop\s+REG_QWORD\s+0x0\b/i

interface CachedProbe<T> {
    value: T
    at: number
}

/**
 * Detects whether any app on the system is currently capturing audio from
 * the microphone, so the AudioService can stay silent during dictation,
 * meetings, voice notes, and so on. Mirrors `ZoomStateService` in
 * structure: lazy probes triggered from `shouldMute()`, 10 s probe cache to
 * keep bursty hook traffic from re-entering `reg query`, fail-open on probe
 * error so a flaky environment never silences the user permanently.
 */
@Injectable({ providedIn: 'root' })
export class MicStateService {
    private cache: CachedProbe<boolean> | undefined

    async shouldMute(cfg: ClaudeStatusAudioConfig, mode: AudioMode): Promise<boolean> {
        if (!IS_WIN32) return false
        const flag = mode === 'sound' ? cfg.muteSoundDuringMicActive : cfg.muteTtsDuringMicActive
        if (!flag) return false
        return this.isMicInUse()
    }

    async isMicInUse(): Promise<boolean> {
        const now = Date.now()
        if (this.cache && now - this.cache.at < PROBE_TTL_MS) {
            return this.cache.value
        }

        let result = false
        try {
            const { stdout } = await execFileAsync(
                'reg',
                ['query', MIC_REGISTRY_PATH, '/s', '/v', 'LastUsedTimeStop'],
                { windowsHide: true },
            )
            result = ACTIVE_RE.test(stdout)
        } catch {
            // Registry key may not exist yet on a fresh Windows profile that
            // has never granted mic access to anything. `reg query` exits 1
            // and we treat that as "not in use" — fail open.
        }

        this.cache = { value: result, at: now }
        return result
    }
}
