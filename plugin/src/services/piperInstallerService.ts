import { Injectable } from '@angular/core'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as https from 'https'
import * as os from 'os'
import * as path from 'path'
import { URL } from 'url'

export interface PiperInstallPaths {
    installDir: string
    exePath: string
    modelPath: string
    modelJsonPath: string
}

export interface InstallProgress {
    phase: 'start' | 'download-binary' | 'extract' | 'download-model' | 'done' | 'error'
    message: string
    bytesReceived?: number
    bytesTotal?: number
}

const RHASSPY_RELEASES_API = 'https://api.github.com/repos/rhasspy/piper/releases/latest'
const RHASSPY_WINDOWS_ASSET = 'piper_windows_amd64.zip'
const DEFAULT_MODEL_NAME = 'en_US-lessac-medium'
// Hugging Face hosts the voice models in a public repo maintained by rhasspy.
const MODEL_BASE =
    'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium'

/**
 * Installs Piper TTS (https://github.com/rhasspy/piper) locally for the user.
 *
 * Piper is not on winget/chocolatey/scoop, so the only reliable path is to
 * download the official release zip from GitHub and extract it. We also fetch
 * a single English voice model from Hugging Face so the backend can speak
 * immediately after install without forcing the user to hunt for a `.onnx`.
 *
 * Install target: `%LOCALAPPDATA%\tabby-claude-status\piper\` on Windows, a
 * matching `~/.local/share/...` on *nix. Layout post-install:
 *   <installDir>/piper/piper.exe
 *   <installDir>/models/en_US-lessac-medium.onnx
 *   <installDir>/models/en_US-lessac-medium.onnx.json
 */
@Injectable({ providedIn: 'root' })
export class PiperInstallerService {
    readonly homepageUrl = 'https://github.com/rhasspy/piper'
    readonly releasesUrl = 'https://github.com/rhasspy/piper/releases/latest'
    readonly voicesUrl = 'https://huggingface.co/rhasspy/piper-voices'

    getInstallPaths(): PiperInstallPaths {
        const root =
            process.platform === 'win32'
                ? path.join(
                      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
                      'tabby-claude-status',
                      'piper',
                  )
                : path.join(os.homedir(), '.local', 'share', 'tabby-claude-status', 'piper')

        const exeName = process.platform === 'win32' ? 'piper.exe' : 'piper'
        return {
            installDir: root,
            // The zip extracts as `piper/piper.exe` under whatever dir we give it.
            exePath: path.join(root, 'piper', exeName),
            modelPath: path.join(root, 'models', `${DEFAULT_MODEL_NAME}.onnx`),
            modelJsonPath: path.join(root, 'models', `${DEFAULT_MODEL_NAME}.onnx.json`),
        }
    }

    isInstalled(): boolean {
        const { exePath, modelPath, modelJsonPath } = this.getInstallPaths()
        try {
            return fs.existsSync(exePath) && fs.existsSync(modelPath) && fs.existsSync(modelJsonPath)
        } catch {
            return false
        }
    }

    /**
     * Detect any CLI package manager that we could theoretically shell out to.
     * Piper itself isn't available in any of these, but we still surface the
     * detection so a future manifest can take advantage of it.
     */
    async detectInstallers(): Promise<string[]> {
        const detected: string[] = []
        const candidates =
            process.platform === 'win32' ? ['winget', 'scoop', 'choco'] : ['brew', 'apt', 'pacman']
        for (const name of candidates) {
            if (await this.commandExists(name)) detected.push(name)
        }
        return detected
    }

    private commandExists(name: string): Promise<boolean> {
        return new Promise(resolve => {
            const which = process.platform === 'win32' ? 'where' : 'which'
            const proc = spawn(which, [name], { windowsHide: true, stdio: 'ignore' })
            proc.on('error', () => resolve(false))
            proc.on('close', code => resolve(code === 0))
        })
    }

    async install(onProgress: (p: InstallProgress) => void): Promise<PiperInstallPaths> {
        const paths = this.getInstallPaths()
        onProgress({ phase: 'start', message: `Installing to ${paths.installDir}` })

        await fs.promises.mkdir(paths.installDir, { recursive: true })
        await fs.promises.mkdir(path.dirname(paths.modelPath), { recursive: true })

        // 1. Resolve the latest Piper release zip URL.
        onProgress({ phase: 'download-binary', message: 'Looking up latest Piper release…' })
        const zipUrl = await this.resolveLatestBinaryUrl()
        const zipPath = path.join(paths.installDir, RHASSPY_WINDOWS_ASSET)

        onProgress({ phase: 'download-binary', message: `Downloading ${RHASSPY_WINDOWS_ASSET}…` })
        await this.downloadFile(zipUrl, zipPath, (bytesReceived, bytesTotal) => {
            onProgress({
                phase: 'download-binary',
                message: `Downloading Piper binary (${fmtBytes(bytesReceived)} / ${fmtBytes(bytesTotal)})`,
                bytesReceived,
                bytesTotal,
            })
        })

        // 2. Extract the archive. On Windows we use PowerShell's Expand-Archive
        //    which is built-in; on other platforms we'd need to extend this.
        onProgress({ phase: 'extract', message: 'Extracting archive…' })
        await this.extractZip(zipPath, paths.installDir)
        try {
            await fs.promises.unlink(zipPath)
        } catch {
            /* keep the zip around if the OS won't delete it; not fatal */
        }

        // 3. Download the default voice model + its json sidecar.
        onProgress({
            phase: 'download-model',
            message: `Downloading voice model ${DEFAULT_MODEL_NAME}.onnx…`,
        })
        await this.downloadFile(
            `${MODEL_BASE}/${DEFAULT_MODEL_NAME}.onnx`,
            paths.modelPath,
            (bytesReceived, bytesTotal) => {
                onProgress({
                    phase: 'download-model',
                    message: `Downloading voice model (${fmtBytes(bytesReceived)} / ${fmtBytes(bytesTotal)})`,
                    bytesReceived,
                    bytesTotal,
                })
            },
        )
        await this.downloadFile(
            `${MODEL_BASE}/${DEFAULT_MODEL_NAME}.onnx.json`,
            paths.modelJsonPath,
            () => {},
        )

        // 4. Sanity check.
        if (!this.isInstalled()) {
            throw new Error(
                `Install ran but expected files are missing:\n  ${paths.exePath}\n  ${paths.modelPath}`,
            )
        }

        onProgress({ phase: 'done', message: 'Piper installed successfully.' })
        return paths
    }

    private async resolveLatestBinaryUrl(): Promise<string> {
        const release = await this.fetchJson(RHASSPY_RELEASES_API)
        const asset = (release?.assets as Array<{ name: string; browser_download_url: string }> | undefined)?.find(
            a => a.name === RHASSPY_WINDOWS_ASSET,
        )
        if (!asset) {
            throw new Error(
                `Latest Piper release has no ${RHASSPY_WINDOWS_ASSET} asset — GitHub release layout may have changed.`,
            )
        }
        return asset.browser_download_url
    }

    private fetchJson(url: string): Promise<any> {
        return new Promise((resolve, reject) => {
            this.httpGet(url, res => {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(Buffer.from(c)))
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
                    } catch (e) {
                        reject(e)
                    }
                })
                res.on('error', reject)
            }).catch(reject)
        })
    }

    private downloadFile(
        url: string,
        destPath: string,
        onProgress: (bytesReceived: number, bytesTotal: number) => void,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            this.httpGet(url, res => {
                const total = Number(res.headers['content-length'] || 0)
                let received = 0
                const file = fs.createWriteStream(destPath)
                res.on('data', c => {
                    received += c.length
                    onProgress(received, total)
                })
                res.pipe(file)
                file.on('finish', () => file.close(err => (err ? reject(err) : resolve())))
                file.on('error', reject)
                res.on('error', reject)
            }).catch(reject)
        })
    }

    /**
     * GET with automatic redirect following — GitHub and Hugging Face both
     * respond with 302 to CDN URLs for binary assets.
     */
    private httpGet(
        url: string,
        cb: (res: import('http').IncomingMessage) => void,
        depth = 0,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (depth > 5) {
                reject(new Error(`Too many redirects fetching ${url}`))
                return
            }
            const parsed = new URL(url)
            const req = https.get(
                {
                    hostname: parsed.hostname,
                    path: parsed.pathname + parsed.search,
                    headers: {
                        'User-Agent': 'tabby-claude-status-plugin',
                        Accept:
                            parsed.pathname.endsWith('.json') || parsed.hostname.includes('api.github.com')
                                ? 'application/json'
                                : '*/*',
                    },
                },
                res => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const next = new URL(res.headers.location, url).toString()
                        res.resume()
                        this.httpGet(next, cb, depth + 1).then(resolve, reject)
                        return
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
                        return
                    }
                    cb(res)
                    res.on('end', resolve)
                },
            )
            req.on('error', reject)
        })
    }

    private extractZip(zipPath: string, destDir: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (process.platform === 'win32') {
                // PowerShell Expand-Archive is built into Windows 10+.
                const proc = spawn(
                    'powershell.exe',
                    [
                        '-NoProfile',
                        '-ExecutionPolicy',
                        'Bypass',
                        '-Command',
                        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(
                            /'/g,
                            "''",
                        )}' -Force`,
                    ],
                    { windowsHide: true },
                )
                let stderr = ''
                proc.stderr.on('data', d => {
                    stderr += d.toString()
                })
                proc.on('error', reject)
                proc.on('close', code => {
                    if (code === 0) resolve()
                    else reject(new Error(`Expand-Archive exited ${code}: ${stderr}`))
                })
            } else {
                // Mac/Linux fallback — `unzip` is near-universal.
                const proc = spawn('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'pipe' })
                let stderr = ''
                proc.stderr.on('data', d => {
                    stderr += d.toString()
                })
                proc.on('error', reject)
                proc.on('close', code => {
                    if (code === 0) resolve()
                    else reject(new Error(`unzip exited ${code}: ${stderr}`))
                })
            }
        })
    }
}

function fmtBytes(n: number): string {
    if (!n) return '0 B'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
}
