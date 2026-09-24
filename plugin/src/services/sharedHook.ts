import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * One hook install for every app that has the plugin.
 *
 * Claude Code hooks live in `~/.claude/settings.json`, which is per user, not
 * per app — so Tabby and Torbie with the plugin installed share one set of
 * hook commands, and those commands feed one shared spool
 * (`tmpdir/tabby-claude-status.d`) that both apps read. The hook therefore
 * must not point into either app's plugin folder: it would break the moment
 * that app (or its copy of the plugin) is removed, and "Setup hooks" in the
 * other app would flip it back and forth.
 *
 * Instead the installer copies `hook.js` to an app-neutral per-user location
 * (the same `tabby-claude-status` folder Piper already uses) and points the
 * hook command there. Whichever app runs the newest plugin keeps that copy
 * current; neither ever downgrades it.
 */

export const SHARED_HOOK_FILE = 'hook.js'
export const SHARED_HOOK_VERSION_FILE = 'hook-version.json'

/** App-neutral per-user directory for the shared hook. */
export function sharedHookDir(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string {
    if (platform === 'win32') {
        return path.win32.join(
            env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'),
            'tabby-claude-status',
        )
    }
    if (platform === 'darwin') {
        return path.posix.join(home, 'Library', 'Application Support', 'tabby-claude-status')
    }
    return path.posix.join(
        env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'),
        'tabby-claude-status',
    )
}

/** Numeric semver-ish compare: -1, 0 or 1. Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) =>
        String(v || '0')
            .split('-')[0]
            .split('.')
            .map((n) => Number.parseInt(n, 10) || 0)
    const pa = parse(a)
    const pb = parse(b)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0)
        if (d) return d < 0 ? -1 : 1
    }
    return 0
}

export type SharedHookAction =
    /** Copied for the first time. */
    | 'installed'
    /** Replaced an older copy. */
    | 'updated'
    /** Already identical. */
    | 'current'
    /** Left alone: another app installed it from a newer plugin. */
    | 'newer-installed'
    /** Not installed and not asked to install (startup refresh). */
    | 'absent'
    | 'failed'

export interface SyncSharedHookOptions {
    /** This plugin's own hook.js. */
    bundledHookPath: string
    /** This plugin's version. */
    version: string
    /** The host app, recorded for diagnostics ("installed by Torbie 1.2.3"). */
    installedBy?: string
    /** Target directory; defaults to {@link sharedHookDir}. */
    dir?: string
    /** Install when absent. False = only refresh an existing copy. */
    install: boolean
}

export interface SyncSharedHookResult {
    action: SharedHookAction
    /** Where the shared hook is (or would be). */
    hookPath: string
    /** Version of the copy on disk after the call, if known. */
    installedVersion: string | null
    error?: string
}

function readInstalledVersion(dir: string): string | null {
    try {
        const v = JSON.parse(
            fs.readFileSync(path.join(dir, SHARED_HOOK_VERSION_FILE), 'utf-8'),
        )?.version
        return typeof v === 'string' ? v : null
    } catch {
        return null
    }
}

function writeAtomic(file: string, data: string | Buffer): void {
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
}

/**
 * Install or refresh the shared hook copy. Never throws; never downgrades.
 *
 * The content is written with an atomic rename, so a Claude hook firing
 * mid-update runs either the old file or the new one, never half of one.
 */
export function syncSharedHook(opts: SyncSharedHookOptions): SyncSharedHookResult {
    const dir = opts.dir ?? sharedHookDir()
    const hookPath = path.join(dir, SHARED_HOOK_FILE)
    try {
        const exists = fs.existsSync(hookPath)
        const installedVersion = exists ? readInstalledVersion(dir) : null
        if (!exists && !opts.install) return { action: 'absent', hookPath, installedVersion: null }

        const bundled = fs.readFileSync(opts.bundledHookPath)
        if (exists) {
            if (installedVersion && compareVersions(installedVersion, opts.version) > 0) {
                return { action: 'newer-installed', hookPath, installedVersion }
            }
            const current = fs.readFileSync(hookPath)
            if (current.equals(bundled) && installedVersion === opts.version) {
                return { action: 'current', hookPath, installedVersion }
            }
        }

        fs.mkdirSync(dir, { recursive: true })
        writeAtomic(hookPath, bundled)
        writeAtomic(
            path.join(dir, SHARED_HOOK_VERSION_FILE),
            JSON.stringify(
                {
                    version: opts.version,
                    installedBy: opts.installedBy ?? null,
                    at: new Date().toISOString(),
                },
                null,
                2,
            ),
        )
        return {
            action: exists ? 'updated' : 'installed',
            hookPath,
            installedVersion: opts.version,
        }
    } catch (err: any) {
        return {
            action: 'failed',
            hookPath,
            installedVersion: null,
            error: err?.message || String(err),
        }
    }
}

/**
 * Pull the hook.js path out of a hook command written by any version of the
 * installer, Windows (`"node.exe" "C:\…\hook.js"`) or WSL (`"/mnt/c/…/node.exe"
 * "C:\\…\\hook.js"`, backslashes doubled for bash). Null when the command
 * doesn't name a hook.js.
 */
export function hookJsPathFromCommand(command: unknown): string | null {
    if (typeof command !== 'string') return null
    const quoted = [...command.matchAll(/"([^"]*hook\.js)"/gi)].map((m) => m[1])
    const bare = quoted.length
        ? quoted
        : [...command.matchAll(/(\S*hook\.js)\b/gi)].map((m) => m[1])
    const raw = bare[bare.length - 1]
    if (!raw) return null
    return raw.replace(/\\\\/g, '\\')
}
