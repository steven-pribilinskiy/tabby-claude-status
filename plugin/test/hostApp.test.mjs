import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'
import {
    dataDirFromPluginDir,
    legacyTabbyDataDir,
    migrateLegacyHostData,
    RUNS_DIR_NAME,
    resolveHostDataDir,
    resolveHostName,
    SESSIONS_FILE_NAME,
} from '../src/services/hostApp.ts'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tcs-host-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
let n = 0
const dir = (name) => {
    const d = path.join(scratch, `${n++}-${name}`)
    fs.mkdirSync(d, { recursive: true })
    return d
}

const APPDATA = 'C:\\Users\\steve\\AppData\\Roaming'
const winEnv = { APPDATA, LOCALAPPDATA: 'C:\\Users\\steve\\AppData\\Local' }

describe('host data dir', () => {
    test('Electron userData wins: Torbie gets its own dir, Tabby keeps %APPDATA%\\tabby', () => {
        const torbie = `${APPDATA}\\torbie`
        assert.equal(
            resolveHostDataDir({
                remoteUserData: torbie,
                env: { ...winEnv, TABBY_CONFIG_DIRECTORY: `${APPDATA}\\tabby` },
            }),
            torbie,
        )
        assert.equal(
            resolveHostDataDir({ remoteUserData: `${APPDATA}\\tabby`, env: winEnv }),
            `${APPDATA}\\tabby`,
        )
    })

    test('a portable install resolves to its own data dir', () => {
        const portable = 'D:\\Apps\\Torbie\\data'
        assert.equal(
            resolveHostDataDir({ remoteUserData: portable, env: winEnv, platform: 'win32' }),
            portable,
        )
    })

    test('without remote: TABBY_CONFIG_DIRECTORY, then the plugin folder, then Tabby default', () => {
        const pluginDir = `${APPDATA}\\torbie\\plugins\\node_modules\\tabby-claude-status\\dist`
        assert.equal(
            resolveHostDataDir({
                env: { ...winEnv, TABBY_CONFIG_DIRECTORY: 'X:\\cfg' },
                pluginDir,
            }),
            'X:\\cfg',
        )
        assert.equal(resolveHostDataDir({ env: winEnv, pluginDir }), `${APPDATA}\\torbie`)
        assert.equal(
            resolveHostDataDir({
                env: winEnv,
                pluginDir: 'C:\\dev\\plugin\\dist',
                platform: 'win32',
                home: 'C:\\Users\\steve',
            }),
            `${APPDATA}\\tabby`,
        )
    })

    test('TORBIE_CONFIG_DIRECTORY alone is ignored (it can leak into a Tabby launched from Torbie)', () => {
        assert.equal(
            resolveHostDataDir({
                env: { ...winEnv, TORBIE_CONFIG_DIRECTORY: `${APPDATA}\\torbie` },
                platform: 'win32',
            }),
            `${APPDATA}\\tabby`,
        )
    })

    test('plugin-folder inference handles both separators and a case-insensitive "Plugins"', () => {
        assert.equal(
            dataDirFromPluginDir(
                '/home/u/.config/torbie/plugins/node_modules/tabby-claude-status/dist',
            ),
            '/home/u/.config/torbie',
        )
        assert.equal(dataDirFromPluginDir('C:\\x\\Plugins\\node_modules\\p\\dist'), 'C:\\x')
        assert.equal(dataDirFromPluginDir('C:\\x\\plugin\\dist'), null)
        assert.equal(dataDirFromPluginDir(null), null)
    })

    test('legacy Tabby dir per platform', () => {
        assert.equal(legacyTabbyDataDir('win32', winEnv, 'C:\\Users\\steve'), `${APPDATA}\\tabby`)
        assert.equal(
            legacyTabbyDataDir('darwin', {}, '/Users/s'),
            '/Users/s/Library/Application Support/tabby',
        )
        assert.equal(legacyTabbyDataDir('linux', {}, '/home/s'), '/home/s/.config/tabby')
        assert.equal(legacyTabbyDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/s'), '/x/tabby')
    })
})

describe('host name', () => {
    test('by executable', () => {
        assert.equal(
            resolveHostName('C:\\Users\\steve\\AppData\\Local\\Programs\\Torbie\\Torbie.exe'),
            'Torbie',
        )
        assert.equal(resolveHostName('C:\\Program Files\\Tabby\\Tabby.exe', 'tabby'), 'Tabby')
        assert.equal(resolveHostName('/opt/Tabby/tabby'), 'Tabby')
    })
    test('a source build (electron.exe) falls back to the app name', () => {
        assert.equal(
            resolveHostName('C:\\src\\node_modules\\electron\\dist\\electron.exe', 'torbie'),
            'Torbie',
        )
        assert.equal(resolveHostName('C:\\src\\electron.exe', 'Electron'), 'Tabby')
        assert.equal(resolveHostName(null, null), 'Tabby')
    })
})

describe('legacy session migration', () => {
    const writeLegacy = (legacy, runs) => {
        fs.writeFileSync(
            path.join(legacy, SESSIONS_FILE_NAME),
            JSON.stringify({ version: 1, sessions: [{ sessionId: 's1', runId: 'r-dead' }] }),
        )
        fs.mkdirSync(path.join(legacy, RUNS_DIR_NAME), { recursive: true })
        for (const [id, pid] of Object.entries(runs)) {
            fs.writeFileSync(
                path.join(legacy, RUNS_DIR_NAME, `${id}.json`),
                JSON.stringify({ pid, startedAt: 1 }),
            )
        }
        fs.writeFileSync(path.join(legacy, RUNS_DIR_NAME, 'x.json.tmp-1'), '{}')
    }

    test('copies sessions and dead runs into a new host dir; never touches the legacy dir', () => {
        const legacy = dir('legacy')
        const host = path.join(dir('roaming'), 'torbie')
        writeLegacy(legacy, { 'r-dead': 111, 'r-live': 222 })
        const before = fs.readdirSync(path.join(legacy, RUNS_DIR_NAME)).sort()
        const { copied } = migrateLegacyHostData(host, legacy, (pid) => pid === 222)
        assert.deepEqual(copied.sort(), [`${RUNS_DIR_NAME}/r-dead.json`, SESSIONS_FILE_NAME].sort())
        assert.equal(
            fs.readFileSync(path.join(host, SESSIONS_FILE_NAME), 'utf-8'),
            fs.readFileSync(path.join(legacy, SESSIONS_FILE_NAME), 'utf-8'),
        )
        assert.deepEqual(fs.readdirSync(path.join(host, RUNS_DIR_NAME)), ['r-dead.json'])
        assert.deepEqual(fs.readdirSync(path.join(legacy, RUNS_DIR_NAME)).sort(), before)
    })

    test('runs once: an existing host sessions file is never overwritten', () => {
        const legacy = dir('legacy')
        const host = dir('host')
        writeLegacy(legacy, {})
        fs.writeFileSync(path.join(host, SESSIONS_FILE_NAME), '{"mine":true}')
        assert.deepEqual(migrateLegacyHostData(host, legacy).copied, [])
        assert.equal(fs.readFileSync(path.join(host, SESSIONS_FILE_NAME), 'utf-8'), '{"mine":true}')
    })

    test('Tabby itself (host dir == legacy dir) is a no-op', () => {
        const legacy = dir('tabby')
        writeLegacy(legacy, { r: 1 })
        assert.deepEqual(migrateLegacyHostData(legacy, `${legacy}${path.sep}`).copied, [])
    })

    test('nothing to carry when the legacy dir has no sessions', () => {
        const host = path.join(dir('h'), 'torbie')
        assert.deepEqual(migrateLegacyHostData(host, dir('empty')).copied, [])
        assert.equal(fs.existsSync(host), false)
    })
})
