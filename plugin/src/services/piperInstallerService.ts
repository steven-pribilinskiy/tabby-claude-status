import { Injectable } from '@angular/core'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as https from 'https'
import * as os from 'os'
import * as path from 'path'
import { URL } from 'url'

export interface PiperInstallPaths {
    installDir: string
    venvDir: string
    exePath: string
    modelPath: string
    modelJsonPath: string
}

export interface InstallProgress {
    phase:
        | 'start'
        | 'detect-python'
        | 'create-venv'
        | 'pip-install'
        | 'download-model'
        | 'done'
        | 'error'
    message: string
    bytesReceived?: number
    bytesTotal?: number
}

const PIPER_PIP_PACKAGE = 'piper-tts'
const DEFAULT_MODEL_NAME = 'en_US-lessac-medium'
// Hugging Face hosts the voice models in a public repo originally maintained
// by rhasspy. Models are still hosted there and remain compatible with the
// piper1-gpl successor.
const MODEL_BASE =
    'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium'

/**
 * Installs Piper TTS locally for the user.
 *
 * Background: the original rhasspy/piper repo (which used to ship a
 * standalone piper.exe) was archived in October 2025. The supported
 * successor is OHF-Voice/piper1-gpl, distributed exclusively as the
 * `piper-tts` PyPI package. The package's setuptools console_scripts entry
 * still installs a `piper.exe` (Windows) / `piper` (POSIX) launcher in the
 * venv's bin/Scripts dir, so the spoken-side CLI surface stays the same as
 * the old binary.
 *
 * Install flow:
 *   1. Detect a usable Python 3.9+ on PATH (`py -3`, `python`, `python3`).
 *   2. Create a private venv at <installDir>/venv to avoid polluting the
 *      user's global Python.
 *   3. `pip install --upgrade piper-tts` into that venv.
 *   4. Download a default English voice (en_US-lessac-medium .onnx + .json)
 *      from Hugging Face so the backend has something to speak immediately.
 *
 * Layout post-install:
 *   <installDir>/venv/Scripts/piper.exe   (Windows)
 *   <installDir>/venv/bin/piper           (POSIX)
 *   <installDir>/models/en_US-lessac-medium.onnx
 *   <installDir>/models/en_US-lessac-medium.onnx.json
 */
@Injectable({ providedIn: 'root' })
export class PiperInstallerService {
    readonly homepageUrl = 'https://github.com/OHF-Voice/piper1-gpl'
    readonly releasesUrl = 'https://github.com/OHF-Voice/piper1-gpl/releases/latest'
    readonly voicesUrl = 'https://huggingface.co/rhasspy/piper-voices'
    readonly pythonDownloadUrl = 'https://www.python.org/downloads/'

    getInstallPaths(): PiperInstallPaths {
        const root =
            process.platform === 'win32'
                ? path.join(
                      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
                      'tabby-claude-status',
                      'piper',
                  )
                : path.join(os.homedir(), '.local', 'share', 'tabby-claude-status', 'piper')

        const venvDir = path.join(root, 'venv')
        const exePath =
            process.platform === 'win32'
                ? path.join(venvDir, 'Scripts', 'piper.exe')
                : path.join(venvDir, 'bin', 'piper')
        return {
            installDir: root,
            venvDir,
            exePath,
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
     * Surface them informationally even though piper-tts itself only comes
     * via pip — it lets the UI hint that other tools exist.
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

    /**
     * Find a Python interpreter ≥3.9 we can use to bootstrap the venv.
     * Tries the Windows `py -3` launcher first (handles multiple installs
     * cleanly), then `python`, then `python3`.
     */
    async detectPython(): Promise<{ exe: string; args: string[]; version: string } | null> {
        const candidates: { exe: string; args: string[] }[] =
            process.platform === 'win32'
                ? [
                      { exe: 'py', args: ['-3'] },
                      { exe: 'python', args: [] },
                      { exe: 'python3', args: [] },
                  ]
                : [
                      { exe: 'python3', args: [] },
                      { exe: 'python', args: [] },
                  ]

        for (const c of candidates) {
            try {
                const out = await this.runCapture(c.exe, [...c.args, '--version'])
                const m = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i)
                if (!m) continue
                const major = Number(m[1])
                const minor = Number(m[2])
                if (major < 3 || (major === 3 && minor < 9)) continue
                return { exe: c.exe, args: c.args, version: `${major}.${minor}.${m[3]}` }
            } catch {
                /* try next candidate */
            }
        }
        return null
    }

    async install(onProgress: (p: InstallProgress) => void): Promise<PiperInstallPaths> {
        const paths = this.getInstallPaths()
        onProgress({ phase: 'start', message: `Installing to ${paths.installDir}` })

        // 1. Find Python.
        onProgress({ phase: 'detect-python', message: 'Looking for Python 3.9+ on PATH…' })
        const python = await this.detectPython()
        if (!python) {
            throw new Error(
                `Python 3.9 or later is required to install Piper TTS, but none was found on PATH.\n\n` +
                    `Piper switched from a standalone C++ binary to the piper-tts Python package after the original repo was archived.\n\n` +
                    `Install Python from ${this.pythonDownloadUrl} (or the Microsoft Store), then click Install again.`,
            )
        }
        onProgress({
            phase: 'detect-python',
            message: `Found Python ${python.version} (${python.exe}).`,
        })

        await fs.promises.mkdir(paths.installDir, { recursive: true })
        await fs.promises.mkdir(path.dirname(paths.modelPath), { recursive: true })

        // 2. Create venv. `python -m venv` is idempotent — re-running is fine,
        //    it just refreshes pyvenv.cfg.
        onProgress({ phase: 'create-venv', message: 'Creating Python virtual environment…' })
        await this.runStream(
            python.exe,
            [...python.args, '-m', 'venv', paths.venvDir],
            'venv',
        )

        // 3. Pip-install (or upgrade) piper-tts into the venv. Using the venv's
        //    own python ensures we never touch the system site-packages.
        const venvPython =
            process.platform === 'win32'
                ? path.join(paths.venvDir, 'Scripts', 'python.exe')
                : path.join(paths.venvDir, 'bin', 'python')

        onProgress({ phase: 'pip-install', message: 'Upgrading pip in venv…' })
        await this.runStream(
            venvPython,
            ['-m', 'pip', 'install', '--upgrade', '--quiet', 'pip'],
            'pip-upgrade',
        )

        onProgress({
            phase: 'pip-install',
            message: `Installing latest ${PIPER_PIP_PACKAGE} (and its onnxruntime dependency)…`,
        })
        await this.runStream(
            venvPython,
            ['-m', 'pip', 'install', '--upgrade', PIPER_PIP_PACKAGE],
            'pip-install',
        )

        // 4. Download the default voice model + its json sidecar.
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

        // 5. Sanity check.
        if (!this.isInstalled()) {
            throw new Error(
                `Install ran but expected files are missing:\n  ${paths.exePath}\n  ${paths.modelPath}\n\n` +
                    `If the venv didn't get a piper.exe entrypoint, the pip install probably failed silently — try running it manually:\n` +
                    `  "${venvPython}" -m pip install --upgrade ${PIPER_PIP_PACKAGE}`,
            )
        }

        onProgress({ phase: 'done', message: 'Piper installed successfully.' })
        return paths
    }

    /**
     * Run a child process and capture its full stdout (used for short-lived
     * commands like `python --version`). Rejects with stderr when the
     * process exits non-zero.
     */
    private runCapture(exe: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn(exe, args, { windowsHide: true })
            let stdout = ''
            let stderr = ''
            proc.stdout.on('data', d => { stdout += d.toString() })
            proc.stderr.on('data', d => { stderr += d.toString() })
            proc.on('error', reject)
            proc.on('close', code => {
                if (code === 0) resolve(stdout + stderr) // some versions of python print to stderr
                else reject(new Error(`${exe} ${args.join(' ')} exited ${code}: ${stderr.trim()}`))
            })
        })
    }

    /**
     * Run a child process whose stderr/stdout we want to surface in errors
     * but don't need to stream live. `phase` is included in the error
     * message so the user can tell which step failed.
     */
    private runStream(exe: string, args: string[], phase: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn(exe, args, { windowsHide: true })
            let stderr = ''
            let stdout = ''
            proc.stdout.on('data', d => { stdout += d.toString() })
            proc.stderr.on('data', d => { stderr += d.toString() })
            proc.on('error', reject)
            proc.on('close', code => {
                if (code === 0) {
                    resolve()
                } else {
                    const detail = (stderr.trim() || stdout.trim() || '(no output)').slice(-2000)
                    reject(new Error(`${phase} failed (exit ${code}): ${detail}`))
                }
            })
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
     * GET with automatic redirect following — Hugging Face responds with 302
     * to CDN URLs for binary assets.
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
                        Accept: '*/*',
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
}

function fmtBytes(n: number): string {
    if (!n) return '0 B'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
}
