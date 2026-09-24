import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, test } from 'node:test'
import {
    appNameForExe,
    HEARTBEAT_MS,
    pidFromWindowId,
    STALE_MS,
} from '../src/services/spoolArbitration.ts'
import {
    buildHeartbeat,
    heartbeatFile,
    LegacyExeCache,
    OWNER_FILE,
    readOwner,
    readPeerWindows,
    writeHeartbeat,
} from '../src/services/spoolFiles.ts'
import { SpoolOwnership } from '../src/services/spoolOwnership.ts'

// Two apps sharing one heartbeat directory and one spool: real files in a
// scratch directory, and a clock the test moves. A 1.2.2 window is wired the
// way WindowCoordinatorService and SpoolOwnershipService wire it. A 1.2.1
// window writes the heartbeat 1.2.1 writes and takes every spool file it sees.

const TABBY = 'C:\\Users\\steve\\AppData\\Local\\Programs\\Tabby\\Tabby.exe'
const TORBIE = 'C:\\Users\\steve\\AppData\\Local\\Programs\\Torbie\\Torbie.exe'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-status-two-apps-'))
after(() => fs.rmSync(root, { recursive: true, force: true }))
let cases = 0

/** `exes` answers the exe lookup for pre-1.2.2 PIDs. */
function machine(exes = {}) {
    const base = path.join(root, `case-${cases++}`)
    const m = {
        dir: path.join(base, 'windows'),
        spool: path.join(base, 'spool'),
        now: 1000000,
        exes,
    }
    fs.mkdirSync(m.dir, { recursive: true })
    fs.mkdirSync(m.spool, { recursive: true })
    return m
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const titles = (w) => w.notices.map((notice) => notice.title)
const readFile = (w, name) => w.read.some((file) => file.endsWith(`-${name}.json`))

/** A hook event landing in the spool. */
function emit(m, name) {
    fs.writeFileSync(path.join(m.spool, `${m.now}-${name}.json`), '{}')
}

/** What a reading window does with the spool: take every file there. */
function drain(m, w) {
    for (const name of fs.readdirSync(m.spool)) {
        try {
            fs.unlinkSync(path.join(m.spool, name))
            w.read.push(name)
        } catch {
            /* the other reader got it */
        }
    }
}

function window122(m, id, exe) {
    const self = { id, exe, name: appNameForExe(exe), pid: pidFromWindowId(id) }
    const w = {
        read: [],
        notices: [],
        prompts: [],
        starts: 0,
        stops: 0,
        reading: false,
        consuming: false,
        since: 0,
        open: true,
    }
    const exes = new LegacyExeCache(
        async (pid) => m.exes[pid] ?? null,
        () => w.ownership.evaluate(),
    )
    const publish = () => {
        if (!w.open) return
        writeHeartbeat(
            m.dir,
            buildHeartbeat({
                id,
                ts: m.now,
                sessions: [],
                pids: [],
                app: { exe, name: self.name, pid: self.pid },
                consuming: w.consuming,
                consumingSince: w.since,
            }),
        )
    }
    w.ownership = new SpoolOwnership({
        dir: m.dir,
        platform: 'win32',
        self,
        now: () => m.now,
        peers: () => readPeerWindows(m.dir, id, m.now, STALE_MS, 'win32', exes),
        publishConsuming: (consuming, since) => {
            w.consuming = consuming
            w.since = since
            publish()
        },
        notify: (notice) => w.notices.push(notice),
        prompt: (prompt) => {
            w.prompts.push(prompt)
            return { close: () => undefined }
        },
    })
    // The decorator's startFileWatcher: clean up and drain, then watch.
    w.ownership.setConsumer({
        start: () => {
            w.starts++
            w.reading = true
            drain(m, w)
        },
        stop: () => {
            w.stops++
            w.reading = false
        },
    })
    /** One heartbeat interval, as the coordinator's timer runs it. */
    w.beat = () => {
        publish()
        w.ownership.evaluate()
        if (w.reading) drain(m, w)
    }
    /** beforeunload. */
    w.close = () => {
        w.ownership.shutdown()
        w.open = false
        fs.rmSync(heartbeatFile(m.dir, id), { force: true })
    }
    publish()
    return w
}

function window121(m, id) {
    const w = { read: [], open: true }
    w.beat = () => {
        if (!w.open) return
        writeHeartbeat(m.dir, { id, ts: m.now, sessions: [], pids: [] })
        drain(m, w)
    }
    w.close = () => {
        w.open = false
        fs.rmSync(heartbeatFile(m.dir, id), { force: true })
    }
    w.beat()
    return w
}

/** Let `ms` pass, every window beating on the way. */
function run(m, windows, ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += HEARTBEAT_MS) {
        m.now += HEARTBEAT_MS
        for (const w of windows) w.beat()
    }
}

test('beside Tabby on 1.2.1: Torbie defers without touching the spool, takes over when confirmed, and keeps reading once Tabby goes', async () => {
    const m = machine({ 5716: TABBY })
    const tabby = window121(m, '5716-plebdz')
    const torbie = window122(m, '9000-torbie', TORBIE)
    emit(m, 'before-start')

    torbie.ownership.setWanted(true)
    assert.equal(torbie.ownership.view.mode, 'waiting')
    await flush()
    assert.equal(torbie.starts, 0)
    assert.deepEqual(titles(torbie), ['Claude events go to Tabby'])
    assert.match(torbie.notices[0].message, /^Tabby \(PID 5716\) is already reading/)

    run(m, [tabby, torbie], 20000)
    emit(m, 'while-deferring')
    run(m, [tabby, torbie], HEARTBEAT_MS)
    assert.equal(torbie.starts, 0)
    assert.deepEqual(torbie.read, [])
    assert.ok(readFile(tabby, 'before-start') && readFile(tabby, 'while-deferring'))
    assert.equal(torbie.notices.length, 1)

    const asked = torbie.ownership.takeOver()
    assert.equal(asked.ok, false)
    assert.deepEqual(
        asked.confirm.map((app) => app.name),
        ['Tabby'],
    )
    assert.equal(readOwner(m.dir), null)

    assert.deepEqual(torbie.ownership.takeOver(true), { ok: true })
    assert.deepEqual(readOwner(m.dir), {
        exe: TORBIE,
        name: 'Torbie',
        pid: 9000,
        ts: m.now,
        window: '9000-torbie',
    })
    assert.deepEqual(
        fs.readdirSync(m.dir).filter((name) => name.endsWith('.tmp')),
        [],
    )
    assert.equal(torbie.starts, 1)
    assert.deepEqual(titles(torbie), [
        'Claude events go to Tabby',
        'Claude events are read here again',
    ])

    run(m, [tabby, torbie], 20000)
    assert.deepEqual(torbie.prompts, [])
    assert.deepEqual(
        torbie.ownership.view.sharingWith.map((app) => app.name),
        ['Tabby'],
    )

    tabby.close()
    run(m, [torbie], 20000)
    assert.equal(torbie.starts, 1)
    assert.equal(torbie.stops, 0)
    assert.equal(torbie.notices.length, 2)
    emit(m, 'after-tabby')
    run(m, [torbie], HEARTBEAT_MS)
    assert.ok(readFile(torbie, 'after-tabby'))
})

test('beside Tabby on 1.2.2: Torbie defers, taking over moves the events, and closing Torbie gives them back', () => {
    const m = machine()
    const tabby = window122(m, '5716-tabby', TABBY)
    tabby.ownership.setWanted(true)
    assert.equal(tabby.starts, 1)
    run(m, [tabby], 4000)

    const torbie = window122(m, '9000-torbie', TORBIE)
    torbie.ownership.setWanted(true)
    assert.equal(torbie.starts, 0)
    assert.deepEqual(titles(torbie), ['Claude events go to Tabby'])

    assert.deepEqual(torbie.ownership.takeOver(), { ok: true })
    assert.equal(torbie.starts, 1)
    run(m, [tabby, torbie], HEARTBEAT_MS)
    assert.equal(tabby.stops, 1)
    assert.deepEqual(titles(tabby), ['Claude events moved to Torbie'])
    assert.match(tabby.notices[0].message, /^Torbie \(PID 9000\) reads Claude Code events now/)

    emit(m, 'handed-over')
    run(m, [tabby, torbie], 10000)
    assert.deepEqual(tabby.read, [])
    assert.ok(readFile(torbie, 'handed-over'))
    assert.equal(tabby.notices.length, 1)
    assert.deepEqual(torbie.prompts, [])

    torbie.close()
    assert.equal(fs.existsSync(path.join(m.dir, OWNER_FILE)), false)
    run(m, [tabby], HEARTBEAT_MS)
    assert.equal(tabby.starts, 2)
    assert.deepEqual(titles(tabby), [
        'Claude events moved to Torbie',
        'Claude events are read here again',
    ])
    assert.match(tabby.notices[1].message, /^Torbie \(PID 9000\) stopped reading/)
})

test('Tabby on 1.2.1 starting while Torbie reads: one prompt, and taking it leaves the events to Tabby', async () => {
    const m = machine({ 5716: TABBY })
    const torbie = window122(m, '9000-torbie', TORBIE)
    torbie.ownership.setWanted(true)
    assert.equal(torbie.starts, 1)

    const tabby = window121(m, '5716-plebdz')
    run(m, [torbie, tabby], HEARTBEAT_MS)
    await flush()
    assert.equal(torbie.prompts.length, 1)
    const [prompt] = torbie.prompts
    assert.equal(prompt.title, 'Tabby is also reading Claude events')
    assert.equal(prompt.action, 'Leave Claude events to Tabby')
    assert.match(prompt.message, /older than 1\.2\.2/)
    run(m, [torbie, tabby], 20000)
    assert.equal(torbie.prompts.length, 1)
    assert.equal(torbie.starts, 1)

    prompt.run()
    assert.equal(torbie.stops, 1)
    assert.equal(readOwner(m.dir).window, '5716-plebdz')
    assert.deepEqual(titles(torbie), ['Claude events moved to Tabby'])
    emit(m, 'left-to-tabby')
    run(m, [torbie, tabby], 10000)
    assert.equal(readFile(torbie, 'left-to-tabby'), false)
    assert.ok(readFile(tabby, 'left-to-tabby'))

    tabby.close()
    run(m, [torbie], HEARTBEAT_MS)
    assert.equal(torbie.starts, 2)
    assert.deepEqual(titles(torbie), [
        'Claude events moved to Tabby',
        'Claude events are read here again',
    ])
})

test('windows of one app all read and say nothing, whichever plugin version they run', async () => {
    const m = machine({ 9100: TORBIE })
    const first = window122(m, '9000-a', TORBIE)
    const old = window121(m, '9100-b')
    const second = window122(m, '9200-c', TORBIE)
    first.ownership.setWanted(true)
    second.ownership.setWanted(true)
    await flush()
    run(m, [first, old, second], 20000)
    for (const w of [first, second]) {
        assert.equal(w.starts, 1)
        assert.equal(w.stops, 0)
        assert.deepEqual(w.notices, [])
        assert.deepEqual(w.prompts, [])
    }
})
