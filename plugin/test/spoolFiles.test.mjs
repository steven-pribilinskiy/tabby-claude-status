import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
    buildHeartbeat,
    LegacyExeCache,
    lookupExeForPid,
    OWNER_FILE,
    readHeartbeats,
    readOwner,
    releaseOwner,
    writeHeartbeat,
    writeOwner,
} from '../src/services/spoolFiles.ts'

const TORBIE = 'C:\\Users\\steve\\AppData\\Local\\Programs\\Torbie\\Torbie.exe'

// Everything here happens in a directory of its own. The real
// tabby-claude-status.windows belongs to the apps running on this machine.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-status-files-'))
after(() => fs.rmSync(root, { recursive: true, force: true }))
let cases = 0
function freshDir() {
    const dir = path.join(root, `case-${cases++}`)
    fs.mkdirSync(dir)
    return dir
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 1.2.1's WindowCoordinatorService.readPeers, transcribed. */
function readPeersBefore(dir, selfId, now) {
    const claims = []
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const full = path.join(dir, name)
        try {
            const claim = JSON.parse(fs.readFileSync(full, 'utf-8'))
            if (!claim?.id || typeof claim.ts !== 'number') continue
            if (claim.id === selfId) continue
            if (now - claim.ts > 8000) {
                try {
                    fs.unlinkSync(full)
                } catch {
                    /* another window beat us to it */
                }
                continue
            }
            claims.push(claim)
        } catch {
            /* unreadable/partial */
        }
    }
    return claims
}

test('owner.json round-trips, leaves no temp file, and never carries an id', () => {
    const dir = freshDir()
    writeOwner(dir, { exe: TORBIE, name: 'Torbie', pid: 9000, ts: 1000, window: '9000-a', id: 'x' })
    const raw = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf-8'))
    assert.equal('id' in raw, false)
    assert.deepEqual(readOwner(dir), {
        exe: TORBIE,
        name: 'Torbie',
        pid: 9000,
        ts: 1000,
        window: '9000-a',
    })
    assert.deepEqual(fs.readdirSync(dir), [OWNER_FILE])
})

test('a 1.2.1 reader neither counts owner.json as a window nor reaps it', () => {
    const dir = freshDir()
    writeOwner(dir, { exe: TORBIE, name: 'Torbie', pid: 9000, ts: 1000, window: '9000-a' })
    assert.deepEqual(readPeersBefore(dir, 'someone', 1000 + 3600000), [])
    assert.ok(fs.existsSync(path.join(dir, OWNER_FILE)))
    assert.deepEqual(readHeartbeats(dir, 'someone', 1000, 8000), [])
})

test('a 1.2.1 reader sees a 1.2.2 heartbeat with its own fields intact', () => {
    const dir = freshDir()
    const app = { exe: TORBIE, name: 'Torbie', pid: 9000 }
    writeHeartbeat(
        dir,
        buildHeartbeat({
            id: '9000-a',
            ts: 5000,
            sessions: new Set(['s']),
            pids: new Set([7]),
            app,
            consuming: true,
            consumingSince: 4000,
        }),
    )
    assert.deepEqual(readPeersBefore(dir, 'someone', 6000), [
        {
            id: '9000-a',
            ts: 5000,
            sessions: ['s'],
            pids: [7],
            app,
            consuming: true,
            consumingSince: 4000,
        },
    ])
})

test('a window that is not reading claims no sessions and no terminals', () => {
    const heartbeat = buildHeartbeat({
        id: '9000-a',
        ts: 5000,
        sessions: ['s'],
        pids: [7],
        app: { exe: TORBIE, name: 'Torbie', pid: 9000 },
        consuming: false,
        consumingSince: 4000,
    })
    assert.deepEqual(heartbeat.sessions, [])
    assert.deepEqual(heartbeat.pids, [])
    assert.equal(heartbeat.consuming, false)
    assert.equal('consumingSince' in heartbeat, false)
})

test('heartbeats: this window and owner.json are skipped, stale ones reaped', () => {
    const dir = freshDir()
    writeHeartbeat(dir, { id: '1-me', ts: 10000, sessions: [], pids: [] })
    writeHeartbeat(dir, { id: '2-live', ts: 9000, sessions: [], pids: [] })
    writeHeartbeat(dir, { id: '3-dead', ts: 1000, sessions: [], pids: [] })
    writeOwner(dir, { exe: TORBIE, name: 'Torbie', pid: 1, ts: 1, window: '1-me' })
    assert.deepEqual(
        readHeartbeats(dir, '1-me', 10000, 8000).map((heartbeat) => heartbeat.id),
        ['2-live'],
    )
    assert.deepEqual(fs.readdirSync(dir).sort(), ['1-me.json', '2-live.json', OWNER_FILE].sort())
})

test('releasing owner.json removes only a record naming that window', () => {
    const dir = freshDir()
    writeOwner(dir, { exe: TORBIE, name: 'Torbie', pid: 1, ts: 1, window: '1-a' })
    releaseOwner(dir, '2-b')
    assert.ok(readOwner(dir))
    releaseOwner(dir, '1-a')
    assert.equal(readOwner(dir), null)
})

test('two processes rewriting owner.json never show a reader half a file', async () => {
    const dir = freshDir()
    const ownerFile = path.join(dir, OWNER_FILE)
    const hook = pathToFileURL(fileURLToPath(new URL('./register-ts.mjs', import.meta.url))).href
    const files = new URL('../src/services/spoolFiles.ts', import.meta.url).href
    const writer = (name) =>
        [
            `const { writeOwner } = await import(${JSON.stringify(files)})`,
            'let attempts = 0',
            'let failures = 0',
            'const until = Date.now() + 1500',
            'while (Date.now() < until) {',
            '    attempts++',
            `    try { writeOwner(${JSON.stringify(dir)}, { exe: 'x', name: ${JSON.stringify(name.repeat(400))}, pid: attempts, ts: attempts }) } catch { failures++ }`,
            '}',
            'console.log(attempts, failures)',
        ].join('\n')
    const outcomes = ['alpha', 'beta'].map((name) => {
        const child = spawn(
            process.execPath,
            ['--import', hook, '--input-type=module', '-e', writer(name)],
            { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
        )
        let out = ''
        child.stdout.on('data', (chunk) => {
            out += chunk
        })
        return new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })))
    })

    for (let i = 0; i < 250 && !fs.existsSync(ownerFile); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    let reads = 0
    let torn = 0
    const until = Date.now() + 1000
    while (Date.now() < until) {
        let text
        try {
            text = fs.readFileSync(ownerFile, 'utf-8')
        } catch {
            continue // a rename in flight
        }
        reads++
        try {
            JSON.parse(text)
        } catch {
            torn++
        }
    }

    const results = await Promise.all(outcomes)
    assert.ok(reads > 100, `only ${reads} reads`)
    assert.equal(torn, 0)
    for (const { code, out } of results) {
        assert.equal(code, 0)
        const [attempts, failures] = out.trim().split(/\s+/).map(Number)
        assert.ok(attempts > 100, `only ${attempts} writes`)
        assert.ok(failures / attempts < 0.01, `${failures} of ${attempts} writes failed`)
    }
    assert.deepEqual(fs.readdirSync(dir), [OWNER_FILE])
})

test('exe lookups: once per PID, and a failure answers null until it is retried', async () => {
    const asked = []
    let settled = 0
    const tabby = 'C:\\Programs\\Tabby\\Tabby.exe'
    const cache = new LegacyExeCache(
        async (pid) => {
            asked.push(pid)
            return pid === 5716 ? tabby : null
        },
        () => settled++,
    )
    assert.equal(cache.get(5716, 0), undefined)
    assert.equal(cache.get(5716, 10), undefined)
    await flush()
    assert.deepEqual(asked, [5716])
    assert.equal(settled, 1)
    assert.equal(cache.get(5716, 20), tabby)

    assert.equal(cache.get(77, 0), undefined)
    await flush()
    assert.equal(cache.get(77, 1000), null)
    assert.deepEqual(asked, [5716, 77])
    assert.equal(cache.get(77, 30000), null)
    await flush()
    assert.deepEqual(asked, [5716, 77, 77])
})

test('the real lookup names this process, and nothing for a PID that is not running', async () => {
    const found = await lookupExeForPid(process.pid)
    assert.equal(found?.toLowerCase(), process.execPath.toLowerCase())
    assert.equal(await lookupExeForPid(4194301), null)
    assert.equal(await lookupExeForPid(0), null)
})
