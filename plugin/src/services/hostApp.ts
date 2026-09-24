import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { appNameForExe } from './spoolArbitration'

/**
 * Which app the plugin is running in, and where that app keeps its data.
 *
 * The plugin loads unchanged in Tabby and in Torbie (a Tabby fork that keeps
 * the plugin API and the `tabby-*` module names), but the two apps have
 * different names, executables and userData directories: `%APPDATA%\tabby`
 * vs `%APPDATA%\torbie`, or `<exe dir>\data` for a portable install of either.
 * Everything the plugin persists per app (session registry, run registry,
 * crash log) resolves through here instead of hard-coding `…\tabby`.
 *
 * Shared, cross-app state is deliberately NOT here: the hook spool
 * (`tmpdir/tabby-claude-status.d`), the window heartbeats and the activity log
 * stay in the temp dir, because one hook install feeds every app.
 */

/** File names inside the host's data dir. Unchanged from the Tabby-only days
 *  so an existing Tabby install keeps reading the same files. */
export const SESSIONS_FILE_NAME = 'tabby-claude-status-sessions.json'
export const RUNS_DIR_NAME = 'tabby-claude-runs'
export const CRASH_LOG_FILE_NAME = 'tabby-claude-status-crash.log'

/** Inputs for {@link resolveHostDataDir}; every field is optional so tests and
 *  non-Electron callers can pass only what they have. */
export interface HostDataDirInput {
    /** `app.getPath('userData')` from the main process, via @electron/remote. */
    remoteUserData?: string | null
    /** The process environment (TABBY_CONFIG_DIRECTORY). */
    env?: NodeJS.ProcessEnv
    /** Directory this plugin was loaded from (`…/plugins/node_modules/<pkg>/dist`). */
    pluginDir?: string | null
    platform?: NodeJS.Platform
    home?: string
}

/**
 * Tabby's default per-user data dir. This is where every version of the plugin
 * before host detection wrote, whichever app it ran in — so it doubles as the
 * migration source for any other host.
 */
export function legacyTabbyDataDir(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string {
    if (platform === 'win32') return path.win32.join(env.APPDATA || home, 'tabby')
    if (platform === 'darwin')
        return path.posix.join(home, 'Library', 'Application Support', 'tabby')
    return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'tabby')
}

/**
 * The host's config dir inferred from where the plugin itself is installed:
 * user plugins live at `<userData>/plugins/node_modules/<pkg>`. Null when the
 * plugin isn't under a `plugins/node_modules` tree (dev link, TABBY_PLUGINS).
 */
export function dataDirFromPluginDir(pluginDir: string | null | undefined): string | null {
    if (!pluginDir) return null
    const parts = pluginDir.split(/[\\/]+/)
    for (let i = parts.length - 2; i > 0; i--) {
        if (
            parts[i].toLowerCase() === 'plugins' &&
            parts[i + 1]?.toLowerCase() === 'node_modules'
        ) {
            const sep = pluginDir.includes('\\') ? '\\' : '/'
            const joined = parts.slice(0, i).join(sep)
            // A POSIX path starts with '/', which split() turns into a leading ''.
            return joined || sep
        }
    }
    return null
}

/**
 * Resolve the directory the host app keeps its own data in. In order:
 *
 * 1. `app.getPath('userData')` — what the app itself uses for its plugins
 *    and logs, and the only answer that is right for a portable install.
 * 2. `TABBY_CONFIG_DIRECTORY` — both apps set it in
 *    the main process before any window exists, so a renderer inherits it.
 * 3. The directory the plugin was loaded from.
 * 4. Tabby's default location — the pre-host-detection behaviour.
 */
export function resolveHostDataDir(input: HostDataDirInput = {}): string {
    const env = input.env ?? process.env
    const platform = input.platform ?? process.platform
    const home = input.home ?? os.homedir()
    // Only TABBY_CONFIG_DIRECTORY: it is the variable both apps read their
    // own config from. TORBIE_CONFIG_DIRECTORY can reach a Tabby launched
    // from a Torbie shell, where it names the wrong app.
    const candidates = [
        input.remoteUserData,
        env.TABBY_CONFIG_DIRECTORY,
        dataDirFromPluginDir(input.pluginDir),
    ]
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim()
    }
    return legacyTabbyDataDir(platform, env, home)
}

/**
 * Display name for the host: "Tabby", "Torbie", or — for a source build
 * running as `electron.exe` — the app's own name, capitalised.
 */
export function resolveHostName(exe: string | null | undefined, appName?: string | null): string {
    const byExe = appNameForExe(exe)
    if (byExe === 'Tabby' || byExe === 'Torbie') return byExe
    const name = String(appName ?? '').trim()
    if (name && name.toLowerCase() !== 'electron') {
        return name.charAt(0).toUpperCase() + name.slice(1)
    }
    return 'Tabby'
}

/**
 * Carry the session registry forward from the legacy Tabby dir into a host
 * dir that differs from it (Torbie, a portable install) the first time the
 * host runs a host-aware plugin.
 *
 * Same rules as Torbie's own userData migration:
 * - **Copy, never move.** The legacy dir belongs to a Tabby that may still be
 *   installed and running. Nothing here opens it for writing.
 * - **Only into an empty target.** An existing sessions file means this has
 *   already run (or the host started fresh); a second copy would overwrite it.
 * - **Never throw.** A failed copy costs the migration, nothing else.
 *
 * Run-registry files are copied only for runs whose process is gone: a live
 * PID belongs to a window still writing the legacy dir (Tabby, or a window of
 * this host still on the old plugin), and copying it would make this host
 * treat that window's sessions as its own live ones.
 */
export function migrateLegacyHostData(
    hostDir: string,
    legacyDir: string,
    isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): { copied: string[] } {
    const copied: string[] = []
    try {
        if (samePath(hostDir, legacyDir)) return { copied }
        const legacySessions = path.join(legacyDir, SESSIONS_FILE_NAME)
        const hostSessions = path.join(hostDir, SESSIONS_FILE_NAME)
        if (!fs.existsSync(legacySessions) || fs.existsSync(hostSessions)) return { copied }

        fs.mkdirSync(hostDir, { recursive: true })
        const tmp = `${hostSessions}.tmp-${process.pid}`
        fs.copyFileSync(legacySessions, tmp)
        fs.renameSync(tmp, hostSessions)
        copied.push(SESSIONS_FILE_NAME)

        const legacyRuns = path.join(legacyDir, RUNS_DIR_NAME)
        const hostRuns = path.join(hostDir, RUNS_DIR_NAME)
        let names: string[] = []
        try {
            names = fs.readdirSync(legacyRuns)
        } catch {
            /* no registry — nothing more to carry */
        }
        for (const name of names) {
            if (!name.endsWith('.json') || name.includes('.tmp-')) continue
            try {
                const from = path.join(legacyRuns, name)
                const pid = Number(JSON.parse(fs.readFileSync(from, 'utf-8'))?.pid) || 0
                if (pid && isPidAlive(pid)) continue
                const to = path.join(hostRuns, name)
                if (fs.existsSync(to)) continue
                fs.mkdirSync(hostRuns, { recursive: true })
                fs.copyFileSync(from, to)
                copied.push(`${RUNS_DIR_NAME}/${name}`)
            } catch {
                /* one bad registry file must not cost the rest */
            }
        }
    } catch (err) {
        console.warn('[claude-status] legacy session migration failed:', err)
    }
    return { copied }
}

function samePath(a: string, b: string): boolean {
    const norm = (p: string) => {
        const r = path.resolve(p)
        return process.platform === 'win32' ? r.toLowerCase() : r
    }
    return norm(a) === norm(b)
}

function defaultIsPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (err: any) {
        return err?.code === 'EPERM'
    }
}

// ── Runtime (Electron renderer) ─────────────────────────────────────

export interface HostApp {
    /** "Tabby", "Torbie", … — for user-facing text. */
    name: string
    /** The app's data dir; per-app plugin state lives here. */
    dataDir: string
    /** Tabby's default data dir — where pre-host-detection versions wrote. */
    legacyDataDir: string
    exe: string
}

let cached: HostApp | null = null

function remoteApp(): any | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('@electron/remote')?.app ?? null
    } catch {
        return null
    }
}

/** The app this renderer belongs to. Resolved once; the answer can't change. */
export function hostApp(): HostApp {
    if (cached) return cached
    const app = remoteApp()
    let remoteUserData: string | null = null
    let appName: string | null = null
    try {
        remoteUserData = app?.getPath?.('userData') ?? null
    } catch {
        /* remote unavailable — fall through to env / plugin dir */
    }
    try {
        appName = app?.getName?.() ?? null
    } catch {
        /* ignore */
    }
    cached = {
        name: resolveHostName(process.execPath, appName),
        dataDir: resolveHostDataDir({
            remoteUserData,
            pluginDir: typeof __dirname === 'string' ? __dirname : null,
        }),
        legacyDataDir: legacyTabbyDataDir(),
        exe: process.execPath,
    }
    return cached
}

/** Tests only: forget the resolved host so the next call re-resolves. */
export function resetHostAppForTests(value: HostApp | null = null): void {
    cached = value
}
