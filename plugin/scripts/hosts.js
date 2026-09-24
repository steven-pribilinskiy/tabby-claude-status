// Where each app that can host this plugin keeps its per-user data. The
// plugin itself resolves this at runtime from Electron (see
// src/services/hostApp.ts); the dev scripts have no Electron to ask, so they
// use the apps' default locations. Portable installs keep theirs in
// `<exe dir>\data` — pass that with --dir.

const os = require('node:os')
const path = require('node:path')

/** Apps known to load this plugin: Tabby, and Torbie (a Tabby fork that keeps
 *  the plugin API but has its own name, executable and userData dir). */
const HOSTS = [
    { id: 'tabby', name: 'Tabby' },
    { id: 'torbie', name: 'Torbie' },
]

/** Default per-user data dir for an app id, cross-platform. */
function hostDataDir(id) {
    if (process.platform === 'win32') {
        if (!process.env.APPDATA) {
            throw new Error(`APPDATA is not set — cannot locate the ${id} data directory.`)
        }
        return path.join(process.env.APPDATA, id)
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', id)
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), id)
}

/**
 * Hosts selected by `--app <id|all>` (repeatable) and/or `--dir <data dir>`.
 * Without either, `fallback` decides: 'all' = every known host, otherwise the
 * named id.
 */
function selectHosts(argv, fallback = 'all') {
    const apps = []
    const dirs = []
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--app' && argv[i + 1]) apps.push(argv[++i].toLowerCase())
        else if (argv[i] === '--dir' && argv[i + 1]) dirs.push(argv[++i])
    }
    const wanted = apps.length || dirs.length ? apps : [fallback]
    const out = []
    for (const a of wanted) {
        if (a === 'all') {
            for (const h of HOSTS) out.push({ ...h, dir: hostDataDir(h.id) })
            continue
        }
        const known = HOSTS.find((h) => h.id === a)
        if (!known)
            throw new Error(`Unknown app "${a}". Known: ${HOSTS.map((h) => h.id).join(', ')}, all.`)
        out.push({ ...known, dir: hostDataDir(known.id) })
    }
    for (const d of dirs) {
        out.push({ id: 'custom', name: `the app using ${path.resolve(d)}`, dir: path.resolve(d) })
    }
    return out
}

module.exports = { HOSTS, hostDataDir, selectHosts }
