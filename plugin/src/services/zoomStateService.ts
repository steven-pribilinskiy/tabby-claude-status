import { Injectable } from '@angular/core'
import { execFile } from 'child_process'
import { readdir, stat } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { ClaudeStatusAudioConfig } from '../interfaces/types'

const execFileAsync = promisify(execFile)

const PROBE_TTL_MS = 10_000
const RECORDING_MTIME_WINDOW_MS = 15_000
const IS_WIN32 = process.platform === 'win32'

// Zoom.exe's window title is "N/A" when the client is just sitting in the
// tray, and becomes e.g. "Zoom Meeting" / "Zoom Webinar" the moment a
// meeting window opens. That's a far cleaner signal than counting UDP
// endpoints — idle Zoom keeps mDNS responders (:5353) and a handful of
// listening sockets open, which falsely tripped a UDP-count heuristic.
const MEETING_TITLE_RE = /^Zoom (Meeting|Webinar)/i

interface CachedProbe<T> {
    value: T
    at: number
}

/**
 * Detects whether Zoom is currently recording or in a meeting so the
 * AudioService can stay silent in those contexts. All work is lazy: the
 * probes only run when `shouldMute()` is called (i.e. when TTS is about to
 * speak), and each probe's result is cached for PROBE_TTL_MS so bursty hook
 * traffic doesn't re-enter the shell tools.
 */
@Injectable({ providedIn: 'root' })
export class ZoomStateService {
    private recordingPath: string | undefined
    private recordingPathResolving: Promise<string> | undefined

    private recordingCache: CachedProbe<boolean> | undefined
    private meetingCache: CachedProbe<boolean> | undefined

    async shouldMute(cfg: ClaudeStatusAudioConfig): Promise<boolean> {
        if (!IS_WIN32) return false
        if (!cfg.muteDuringZoomRecording && !cfg.muteDuringZoomMeeting) return false

        if (cfg.muteDuringZoomRecording && await this.isRecording()) return true
        if (cfg.muteDuringZoomMeeting && await this.isInMeeting()) return true
        return false
    }

    async isRecording(): Promise<boolean> {
        const now = Date.now()
        if (this.recordingCache && now - this.recordingCache.at < PROBE_TTL_MS) {
            return this.recordingCache.value
        }

        let result = false
        try {
            const root = await this.getRecordingPath()
            const entries = await readdir(root, { withFileTypes: true })
            const cutoff = now - RECORDING_MTIME_WINDOW_MS
            for (const entry of entries) {
                if (!entry.isDirectory()) continue
                try {
                    const st = await stat(path.join(root, entry.name))
                    if (st.mtimeMs >= cutoff) {
                        result = true
                        break
                    }
                } catch {
                    // Folder may have been deleted between readdir and stat —
                    // just skip it.
                }
            }
        } catch {
            // No recording folder, no permission, etc. — treat as "not recording".
        }

        this.recordingCache = { value: result, at: now }
        return result
    }

    async isInMeeting(): Promise<boolean> {
        const now = Date.now()
        if (this.meetingCache && now - this.meetingCache.at < PROBE_TTL_MS) {
            return this.meetingCache.value
        }

        let result = false
        try {
            result = await this.hasZoomMeetingWindow()
        } catch {
            // tasklist failed — fail open (not muted) rather than silencing
            // the user's TTS based on a flaky probe.
        }

        this.meetingCache = { value: result, at: now }
        return result
    }

    /**
     * Resolve the Zoom recording folder from the registry, falling back to
     * `~/Documents/Zoom` when the key is missing or empty. Memoised for the
     * process lifetime — users who change Zoom's recording location need to
     * restart Tabby.
     */
    private getRecordingPath(): Promise<string> {
        if (this.recordingPath) return Promise.resolve(this.recordingPath)
        if (this.recordingPathResolving) return this.recordingPathResolving

        const fallback = path.join(os.homedir(), 'Documents', 'Zoom')
        this.recordingPathResolving = (async () => {
            try {
                const { stdout } = await execFileAsync(
                    'reg',
                    ['query', 'HKCU\\Software\\Zoom\\ZoomChat\\General', '/v', 'rec.path'],
                    { windowsHide: true },
                )
                const match = stdout.match(/rec\.path\s+REG_\w+\s+(.+)/i)
                const raw = match?.[1]?.trim()
                this.recordingPath = raw && raw.length > 0 ? raw : fallback
            } catch {
                this.recordingPath = fallback
            }
            return this.recordingPath
        })()
        return this.recordingPathResolving
    }

    private async hasZoomMeetingWindow(): Promise<boolean> {
        // `tasklist /V` is ~30 ms and produces one row per Zoom.exe process
        // with its top-level window title in the last CSV column. Idle rows
        // report "N/A"; a live meeting window reports "Zoom Meeting" (or
        // "Zoom Webinar"). We only match those two so opening the main
        // client without joining a meeting doesn't trip the mute.
        const { stdout } = await execFileAsync(
            'tasklist',
            ['/V', '/FI', 'IMAGENAME eq Zoom.exe', '/FO', 'CSV', '/NH'],
            { windowsHide: true },
        )
        for (const line of stdout.split(/\r?\n/)) {
            if (!line.startsWith('"Zoom.exe"')) continue
            const cols = line.split('","').map(c => c.replace(/^"|"$/g, ''))
            const title = cols[cols.length - 1]
            if (title && title !== 'N/A' && MEETING_TITLE_RE.test(title)) {
                return true
            }
        }
        return false
    }
}
