import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import * as os from 'node:os'
import * as path from 'node:path'
import { URL as NodeURL } from 'node:url'
import { Injectable } from '@angular/core'

const ONLINE_CATALOG_TTL_MS = 24 * 60 * 60 * 1000 // 24 h

export type SoundSource = 'bundled' | 'cached' | 'windows' | 'custom'

export interface SoundEntry {
    /** Stable identifier — for non-cached sources, this is the absolute file path. */
    id: string
    label: string
    /** Absolute file path on disk. Empty until downloaded for online entries. */
    path: string
    source: SoundSource
}

export interface OnlineSoundEntry {
    id: string
    label: string
    /** One of working/question/done/error/idle/general — purely informational. */
    category?: string
    /** Direct download URL (HTTPS). */
    url: string
    /** Optional separate preview URL. Defaults to `url` if absent. */
    previewUrl?: string
    license: string
    attribution?: string
    bytes?: number
    durationMs?: number
}

interface OnlineCatalog {
    version: number
    updated?: string
    sounds: OnlineSoundEntry[]
}

interface BundledManifestEntry {
    id: string
    file: string
    label: string
    category?: string
    source_url?: string
    license?: string
}

interface BundledManifest {
    version: number
    sounds: BundledManifestEntry[]
}

const PLAYABLE_RE = /\.(wav|mp3|ogg|m4a|aac)$/i

/**
 * Plays sound files, lists available sounds across the four sources
 * (bundled, cached/downloaded, Windows system sounds, custom), and manages
 * the online catalog (browse + download to local cache).
 */
@Injectable({ providedIn: 'root' })
export class SoundService {
    private cachedDownloadsList: SoundEntry[] | undefined
    private bundledList: SoundEntry[] | undefined
    private windowsList: SoundEntry[] | undefined
    private currentAudio: HTMLAudioElement | null = null
    private currentAudioUrl: string | null = null

    /** Resolves to the directory where downloaded sounds are stored. */
    getCacheDir(): string {
        const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
        return path.join(local, 'tabby-claude-status', 'sounds')
    }

    private getCatalogCachePath(): string {
        return path.join(this.getCacheDir(), 'catalog-cache.json')
    }

    /**
     * The bundled catalog manifest — committed alongside the plugin source
     * at `online-sounds/catalog.json`. Resolved relative to dist/index.js
     * the same way the overlay PNG assets are resolved in
     * claudeStatusDecorator.ts.
     */
    private getBundledCatalogPath(): string {
        return path.resolve(__dirname, '..', 'online-sounds', 'catalog.json')
    }

    private getBundledSoundsDir(): string {
        return path.resolve(__dirname, '..', 'assets', 'sounds')
    }

    /**
     * Play a sound file. Reads the file via fs (avoiding the file://
     * webSecurity issues that <audio src="file://..."> hits in Tabby's
     * Electron renderer), wraps it in an object URL, plays through an
     * HTMLAudioElement, then revokes the URL on completion.
     *
     * Stops any previously-playing sound from this service so back-to-back
     * status events don't pile up overlapping playback.
     */
    async play(filePath: string, volume: number): Promise<void> {
        if (!filePath) return
        try {
            const buffer = await fsp.readFile(filePath)
            // Web Audio happily plays WAV, MP3, OGG, M4A — exact MIME doesn't
            // matter much; Chromium sniffs the format. Pass a sane default.
            const blob = new Blob(
                [buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)],
                { type: this.mimeFor(filePath) },
            )
            const url = URL.createObjectURL(blob)

            this.stopCurrent()

            const audio = new Audio(url)
            audio.volume = Math.max(0, Math.min(1, volume))
            const cleanup = () => {
                if (this.currentAudio === audio) {
                    this.currentAudio = null
                    this.currentAudioUrl = null
                }
                URL.revokeObjectURL(url)
            }
            audio.onended = cleanup
            audio.onerror = cleanup
            this.currentAudio = audio
            this.currentAudioUrl = url
            try {
                await audio.play()
            } catch (playErr) {
                // A rejected play() (autoplay policy, decode failure, unplayable
                // codec) does not reliably fire `error`, so `cleanup` may never
                // run — that left the object URL alive and `currentAudio`
                // pointing at an element that will never play, which then made
                // the next `stopCurrent()` pause a dead element instead of the
                // real one. Release it here.
                cleanup()
                throw playErr
            }
        } catch (err) {
            console.warn('[claude-status] Sound playback failed for', filePath, err)
        }
    }

    /** Public stop — lets AudioService halt a playing sound effect when a
     *  newer status event supersedes it (cross-output cancellation). */
    stop(): void {
        this.stopCurrent()
    }

    private stopCurrent(): void {
        if (this.currentAudio) {
            try {
                this.currentAudio.pause()
                this.currentAudio.currentTime = 0
            } catch {
                /* noop */
            }
            if (this.currentAudioUrl) URL.revokeObjectURL(this.currentAudioUrl)
            this.currentAudio = null
            this.currentAudioUrl = null
        }
    }

    private mimeFor(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase()
        switch (ext) {
            case '.mp3':
                return 'audio/mpeg'
            case '.ogg':
                return 'audio/ogg'
            case '.m4a':
            case '.aac':
                return 'audio/aac'
            default:
                return 'audio/wav'
        }
    }

    /**
     * Sounds shipped with the plugin. Driven by `assets/sounds/manifest.json`
     * so adding a sound is a data-only change. Empty manifest is fine.
     */
    listBundledSounds(): SoundEntry[] {
        if (this.bundledList) return this.bundledList
        const dir = this.getBundledSoundsDir()
        const manifestPath = path.join(dir, 'manifest.json')
        const out: SoundEntry[] = []
        try {
            if (fs.existsSync(manifestPath)) {
                const raw = fs.readFileSync(manifestPath, 'utf-8')
                const parsed = JSON.parse(raw) as BundledManifest
                for (const entry of parsed.sounds || []) {
                    const filePath = path.join(dir, entry.file)
                    if (!fs.existsSync(filePath)) continue
                    out.push({
                        id: filePath,
                        label: entry.label || entry.id,
                        path: filePath,
                        source: 'bundled',
                    })
                }
            }
        } catch (err) {
            console.warn('[claude-status] Failed to read bundled sound manifest:', err)
        }
        this.bundledList = out
        return out
    }

    /**
     * Sounds the user has downloaded into the local cache directory.
     * Refreshed on demand — call `invalidateCacheList()` after a download
     * completes. Cross-references the online catalog so files downloaded
     * from there get their proper human-readable label rather than the
     * sanitised filename.
     */
    async listCachedDownloads(): Promise<SoundEntry[]> {
        if (this.cachedDownloadsList) return this.cachedDownloadsList
        const dir = this.getCacheDir()
        const out: SoundEntry[] = []
        // Pre-build a label index from the catalog so each cached file's
        // friendly name survives. Keys are the same `safeId` we use when
        // saving the download.
        const labelByKey = new Map<string, string>()
        try {
            const catalog = await this.listOnlineCatalog()
            for (const entry of catalog) {
                const safeId = entry.id.replace(/[^a-zA-Z0-9._-]/g, '_')
                labelByKey.set(safeId, entry.label)
            }
        } catch {
            // Catalog read failure is non-fatal — we'll just fall back to
            // filename-as-label below.
        }
        try {
            await fsp.mkdir(dir, { recursive: true })
            const entries = await fsp.readdir(dir, { withFileTypes: true })
            for (const entry of entries) {
                if (!entry.isFile()) continue
                if (!PLAYABLE_RE.test(entry.name)) continue
                const filePath = path.join(dir, entry.name)
                const stem = entry.name.replace(PLAYABLE_RE, '')
                out.push({
                    id: filePath,
                    label: labelByKey.get(stem) || stem,
                    path: filePath,
                    source: 'cached',
                })
            }
        } catch (err) {
            console.warn('[claude-status] Failed to list cache dir:', err)
        }
        out.sort((a, b) => a.label.localeCompare(b.label))
        this.cachedDownloadsList = out
        return out
    }

    invalidateCacheList(): void {
        this.cachedDownloadsList = undefined
    }

    /**
     * Windows ships ~70 system sounds under %SystemRoot%\Media. They're
     * always available offline and most users recognise them, so they make
     * a great fallback library when the bundled set or downloaded library
     * is empty.
     */
    async listWindowsSounds(): Promise<SoundEntry[]> {
        if (this.windowsList) return this.windowsList
        if (process.platform !== 'win32') {
            this.windowsList = []
            return []
        }
        const root = path.join(process.env.SystemRoot || 'C:\\Windows', 'Media')
        const out: SoundEntry[] = []
        try {
            const entries = await fsp.readdir(root, { withFileTypes: true })
            for (const entry of entries) {
                if (entry.isDirectory()) continue
                if (!PLAYABLE_RE.test(entry.name)) continue
                const filePath = path.join(root, entry.name)
                out.push({
                    id: filePath,
                    label: entry.name.replace(PLAYABLE_RE, ''),
                    path: filePath,
                    source: 'windows',
                })
            }
        } catch (err) {
            console.warn('[claude-status] Failed to enumerate Windows Media:', err)
        }
        out.sort((a, b) => a.label.localeCompare(b.label))
        this.windowsList = out
        return out
    }

    /**
     * Returns the curated online catalog. Reads the local manifest at
     * `online-sounds/catalog.json` first; if a network-fetched copy exists
     * in the cache and is newer, prefer that (lets us update the catalog
     * out-of-band without shipping a new plugin version).
     */
    async listOnlineCatalog(): Promise<OnlineSoundEntry[]> {
        const local = await this.readBundledCatalog()
        const cached = await this.readCachedCatalog()
        if (cached && (!local || cached.version >= local.version)) {
            return cached.sounds || []
        }
        return local?.sounds || []
    }

    private async readBundledCatalog(): Promise<OnlineCatalog | null> {
        try {
            const raw = await fsp.readFile(this.getBundledCatalogPath(), 'utf-8')
            return JSON.parse(raw) as OnlineCatalog
        } catch {
            return null
        }
    }

    private async readCachedCatalog(): Promise<OnlineCatalog | null> {
        try {
            const cachePath = this.getCatalogCachePath()
            const stat = await fsp.stat(cachePath)
            if (Date.now() - stat.mtimeMs > ONLINE_CATALOG_TTL_MS) return null
            const raw = await fsp.readFile(cachePath, 'utf-8')
            return JSON.parse(raw) as OnlineCatalog
        } catch {
            return null
        }
    }

    /**
     * Downloads the MP3/WAV referenced by an online catalog entry into the
     * user's cache directory and returns the absolute local path. Subsequent
     * calls with the same id are no-ops if the file already exists.
     */
    async downloadOnlineSound(entry: OnlineSoundEntry): Promise<string> {
        const dir = this.getCacheDir()
        await fsp.mkdir(dir, { recursive: true })
        const ext = this.guessExtension(entry.url)
        const safeId = entry.id.replace(/[^a-zA-Z0-9._-]/g, '_')
        const targetPath = path.join(dir, `${safeId}${ext}`)
        if (fs.existsSync(targetPath)) {
            return targetPath
        }
        await this.downloadToFile(entry.url, targetPath)
        this.invalidateCacheList()
        return targetPath
    }

    private guessExtension(url: string): string {
        try {
            const parsed = new NodeURL(url)
            const ext = path.extname(parsed.pathname).toLowerCase()
            if (PLAYABLE_RE.test(ext)) return ext
        } catch {
            /* fall through */
        }
        return '.mp3'
    }

    private downloadToFile(url: string, targetPath: string, redirectsLeft = 5): Promise<void> {
        return new Promise((resolve, reject) => {
            let parsed: NodeURL
            try {
                parsed = new NodeURL(url)
            } catch (err) {
                reject(err)
                return
            }
            const client = parsed.protocol === 'http:' ? http : https
            const req = client.get(
                url,
                { headers: { 'User-Agent': 'tabby-claude-status' } },
                (res) => {
                    if (
                        res.statusCode &&
                        res.statusCode >= 300 &&
                        res.statusCode < 400 &&
                        res.headers.location
                    ) {
                        res.resume()
                        if (redirectsLeft <= 0) {
                            reject(new Error(`Too many redirects fetching ${url}`))
                            return
                        }
                        const next = new NodeURL(res.headers.location, url).toString()
                        this.downloadToFile(next, targetPath, redirectsLeft - 1).then(
                            resolve,
                            reject,
                        )
                        return
                    }
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        res.resume()
                        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
                        return
                    }
                    const tmpPath = `${targetPath}.partial`
                    const file = fs.createWriteStream(tmpPath)
                    res.pipe(file)
                    file.on('finish', () => {
                        file.close((err) => {
                            if (err) {
                                reject(err)
                                return
                            }
                            fsp.rename(tmpPath, targetPath).then(resolve, reject)
                        })
                    })
                    file.on('error', (err) => {
                        fsp.unlink(tmpPath).catch(() => undefined)
                        reject(err)
                    })
                },
            )
            req.on('error', reject)
            req.setTimeout(30_000, () => {
                req.destroy(new Error(`Timeout fetching ${url}`))
            })
        })
    }

    /**
     * Open the cache directory in the OS file manager so the user can
     * delete sounds they no longer want.
     */
    async openCacheDir(): Promise<void> {
        const dir = this.getCacheDir()
        try {
            await fsp.mkdir(dir, { recursive: true })
            const { shell } = require('@electron/remote')
            shell.openPath(dir)
        } catch (err) {
            console.warn('[claude-status] Failed to open cache dir:', err)
        }
    }

    /**
     * Convenience: fetch every entry in the catalog whose file is not yet
     * present in the cache. Returns the count of newly downloaded files.
     */
    async downloadAllMissing(): Promise<{
        downloaded: number
        failed: { entry: OnlineSoundEntry; error: string }[]
    }> {
        const catalog = await this.listOnlineCatalog()
        let downloaded = 0
        const failed: { entry: OnlineSoundEntry; error: string }[] = []
        for (const entry of catalog) {
            try {
                const before = fs.existsSync(
                    path.join(
                        this.getCacheDir(),
                        `${entry.id.replace(/[^a-zA-Z0-9._-]/g, '_')}${this.guessExtension(entry.url)}`,
                    ),
                )
                await this.downloadOnlineSound(entry)
                if (!before) downloaded++
            } catch (err) {
                failed.push({ entry, error: err instanceof Error ? err.message : String(err) })
            }
        }
        return { downloaded, failed }
    }
}
