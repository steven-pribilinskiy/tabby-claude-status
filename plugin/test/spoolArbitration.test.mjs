import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
    acknowledge,
    appNameForExe,
    arbitrate,
    claimedByPeer,
    describeApp,
    describeSpool,
    initialArbiterState,
    leads,
    normalizeExe,
    pidFromWindowId,
    readersThatCannotHandOver,
    readingWindowOf,
    STALE_MS,
    toPeerWindow,
    UNIDENTIFIED_APP,
} from '../src/services/spoolArbitration.ts'

const TABBY = 'C:\\Users\\steve\\AppData\\Local\\Programs\\Tabby\\Tabby.exe'
const TORBIE = 'C:\\Users\\steve\\AppData\\Local\\Programs\\Torbie\\Torbie.exe'
const SOURCE = 'C:\\Users\\steve\\projects\\tabby\\node_modules\\electron\\dist\\electron.exe'
const key = (exe) => normalizeExe(exe, 'win32')

function me(id = '9000-torbie', exe = TORBIE) {
    return { id, exe, name: appNameForExe(exe), pid: pidFromWindowId(id) }
}

/** A 1.2.2 window, as its heartbeat reads. */
function modern(id, exe, { consuming = true, since = 1, sessions = [], pids = [] } = {}) {
    const heartbeat = {
        id,
        ts: 0,
        sessions,
        pids,
        app: { exe, name: appNameForExe(exe), pid: pidFromWindowId(id) },
        consuming,
    }
    if (consuming) heartbeat.consumingSince = since
    return toPeerWindow(heartbeat, 'win32', () => {
        throw new Error('a 1.2.2 heartbeat names its app')
    })
}

/** A 1.2.1 window. `exe` is the lookup's answer: undefined while it runs, null when it failed. */
function legacy(id, exe, { sessions = [], pids = [] } = {}) {
    return toPeerWindow({ id, ts: 0, sessions, pids }, 'win32', () => exe)
}

/** One window's arbitration, stepped tick by tick. */
function windowOf(self = me()) {
    let state = initialArbiterState()
    let input = null
    return {
        tick(now, { peers = [], owner = null, wanted = true } = {}) {
            input = { now, platform: 'win32', self, wanted, peers, owner }
            const result = arbitrate(state, input)
            state = result.state
            return result.effects
        },
        acknowledge(keys) {
            state = acknowledge(state, keys)
        },
        get input() {
            return input
        },
        get view() {
            return describeSpool(state, input)
        },
    }
}

const kinds = (effects) => effects.map((effect) => effect.kind)
const torbieOwner = (ts) => ({ exe: TORBIE, name: 'Torbie', pid: 9000, ts, window: '9000-torbie' })

describe('identity', () => {
    test('an exe compares case- and slash-insensitively, on Windows only', () => {
        assert.equal(
            normalizeExe('C:/Users/Steve/Torbie.exe', 'win32'),
            'c:\\users\\steve\\torbie.exe',
        )
        assert.equal(normalizeExe('\\\\?\\C:\\Apps\\Tabby.exe', 'win32'), 'c:\\apps\\tabby.exe')
        assert.equal(normalizeExe('/opt/Tabby/tabby', 'linux'), '/opt/Tabby/tabby')
    })

    test('names are for display', () => {
        assert.equal(appNameForExe(TABBY), 'Tabby')
        assert.equal(appNameForExe(TORBIE), 'Torbie')
        assert.equal(appNameForExe(SOURCE), 'a source build')
        assert.equal(appNameForExe('/Applications/Tabby.app/Contents/MacOS/Tabby'), 'Tabby')
        assert.equal(appNameForExe('D:\\Tools\\Hyper.exe'), 'Hyper')
        assert.equal(appNameForExe(null), UNIDENTIFIED_APP)
        assert.equal(describeApp({ name: 'Tabby', pid: 5716 }), 'Tabby (PID 5716)')
        assert.equal(
            describeApp({ name: 'a source build', pid: 42 }, true),
            'A source build (PID 42)',
        )
    })

    test('a heartbeat without app is a 1.2.1 window, and counts as reading', () => {
        const peer = legacy('5716-plebdz', undefined)
        assert.equal(peer.legacy, true)
        assert.equal(peer.resolving, true)
        assert.equal(peer.consuming, true)
        assert.equal(peer.pid, 5716)
        assert.equal(legacy('5716-plebdz', TABBY).exe, key(TABBY))
        assert.equal(modern('7-x', TABBY, { consuming: false }).consumingSince, 0)
    })
})

describe('starting', () => {
    test('alone, it reads at once and says nothing', () => {
        const w = windowOf()
        assert.deepEqual(kinds(w.tick(1000)), ['start'])
        assert.equal(w.view.mode, 'reading')
    })

    test('beside a 1.2.1 reader, it waits for the lookup, then defers with one notice', () => {
        const w = windowOf()
        assert.deepEqual(w.tick(1000, { peers: [legacy('5716-plebdz', undefined)] }), [])
        assert.equal(w.view.mode, 'waiting')
        const tabby = legacy('5716-plebdz', TABBY)
        const effects = w.tick(1400, { peers: [tabby] })
        assert.deepEqual(kinds(effects), ['deferred'])
        assert.equal(effects[0].to.name, 'Tabby')
        assert.equal(effects[0].to.pid, 5716)
        assert.equal(effects[0].to.legacy, true)
        for (let now = 3400; now < 30000; now += 2000) {
            assert.deepEqual(w.tick(now, { peers: [tabby] }), [])
        }
        assert.equal(w.view.mode, 'deferring')
        assert.equal(w.view.deferringTo.name, 'Tabby')
    })

    test('a 1.2.1 window nobody could identify counts as another app', () => {
        const effects = windowOf().tick(1000, { peers: [legacy('77-lost', null)] })
        assert.deepEqual(kinds(effects), ['deferred'])
        assert.equal(effects[0].to.key, '?77')
        assert.equal(effects[0].to.name, UNIDENTIFIED_APP)
    })

    test('windows of the same app all read, whatever their plugin version', () => {
        const otherSpelling = 'c:/users/steve/appdata/local/programs/torbie/TORBIE.EXE'
        const peers = [
            modern('9100-b', TORBIE),
            legacy('9200-c', otherSpelling),
            modern('9300-d', TORBIE, { consuming: false }),
        ]
        const w = windowOf()
        assert.deepEqual(kinds(w.tick(1000, { peers })), ['start'])
        for (let now = 3000; now < 30000; now += 2000) {
            assert.deepEqual(w.tick(now, { peers }), [])
        }
        assert.deepEqual(w.view.others, [])
    })

    test('beside a 1.2.2 app that is open but not reading, it reads', () => {
        const w = windowOf()
        const tabby = modern('5716-tab', TABBY, { consuming: false })
        assert.deepEqual(kinds(w.tick(1000, { peers: [tabby] })), ['start'])
        assert.deepEqual(
            w.view.others.map((app) => [app.name, app.reading]),
            [['Tabby', false]],
        )
    })
})

describe('handing over', () => {
    test('from a 1.2.1 reader: confirmed first, then both read and nobody is asked again', () => {
        const w = windowOf()
        const tabby = legacy('5716-plebdz', TABBY)
        w.tick(1000, { peers: [tabby] })
        assert.deepEqual(
            readersThatCannotHandOver({ ...w.input, now: 3000 }).map((app) => app.name),
            ['Tabby'],
        )
        w.acknowledge([key(TABBY)])
        const effects = w.tick(3000, { peers: [tabby], owner: torbieOwner(3000) })
        assert.deepEqual(kinds(effects), ['start', 'resumed'])
        assert.equal(effects[1].reason, 'handed-over')
        for (let now = 5000; now < 40000; now += 2000) {
            assert.deepEqual(w.tick(now, { peers: [tabby], owner: torbieOwner(3000) }), [])
        }
        assert.deepEqual(
            w.view.sharingWith.map((app) => app.name),
            ['Tabby'],
        )
    })

    test('a 1.2.2 app that was reading stops, and says where the events went', () => {
        const tabby = windowOf(me('5716-tab', TABBY))
        tabby.tick(1000)
        const torbie = modern('9000-torbie', TORBIE, { since: 3000 })
        const effects = tabby.tick(3000, { peers: [torbie], owner: torbieOwner(3000) })
        assert.deepEqual(kinds(effects), ['stop', 'moved'])
        assert.equal(effects[1].to.name, 'Torbie')
        assert.equal(tabby.view.mode, 'deferring')
    })

    test('the app handed to gives a 1.2.2 reader a few heartbeats to stop before asking', () => {
        const w = windowOf()
        const tabby = modern('5716-tab', TABBY, { since: 500 })
        assert.deepEqual(kinds(w.tick(1000, { peers: [tabby] })), ['deferred'])
        const owner = torbieOwner(3000)
        assert.deepEqual(kinds(w.tick(3000, { peers: [tabby], owner })), ['start', 'resumed'])
        assert.deepEqual(w.tick(5000, { peers: [tabby], owner }), [])
        assert.deepEqual(kinds(w.tick(3000 + STALE_MS, { peers: [tabby], owner })), ['conflict'])
    })

    test('a hand-over to an app that is not reading is ignored', () => {
        const tabby = windowOf(me('5716-tab', TABBY))
        tabby.tick(1000)
        const idle = modern('9000-torbie', TORBIE, { consuming: false })
        assert.deepEqual(tabby.tick(3000, { peers: [idle], owner: torbieOwner(3000) }), [])
        assert.equal(tabby.view.mode, 'reading')
    })

    test('a hand-over lapses with its window, so the next run of that app does not inherit it', () => {
        const restarted = windowOf(me('9500-torbie', TORBIE))
        const tabby = modern('5716-tab', TABBY, { since: 500 })
        const effects = restarted.tick(9000, { peers: [tabby], owner: torbieOwner(1000) })
        assert.deepEqual(kinds(effects), ['deferred'])
    })

    test('a record whose PID now belongs to another app is ignored', () => {
        const tabby = windowOf(me('5716-tab', TABBY))
        tabby.tick(1000)
        const owner = { exe: TORBIE, name: 'Torbie', pid: 300, ts: 900 }
        const recycled = modern('300-hyper', 'D:\\Tools\\Hyper.exe', { consuming: false })
        assert.deepEqual(tabby.tick(3000, { peers: [recycled], owner }), [])
        assert.equal(tabby.view.mode, 'reading')
    })

    test('leaving to a 1.2.1 app names its window, and this window stops', () => {
        const w = windowOf()
        w.tick(1000)
        const tabby = legacy('5716-plebdz', TABBY)
        assert.deepEqual(kinds(w.tick(3000, { peers: [tabby] })), ['conflict'])
        const target = readingWindowOf(w.input, key(TABBY))
        assert.equal(target.id, '5716-plebdz')
        const owner = {
            exe: target.exePath,
            name: target.name,
            pid: target.pid,
            ts: 5000,
            window: target.id,
        }
        assert.deepEqual(kinds(w.tick(5000, { peers: [tabby], owner })), [
            'stop',
            'moved',
            'conflict-over',
        ])
        assert.deepEqual(w.tick(7000, { peers: [tabby], owner }), [])
    })
})

describe('while reading', () => {
    test('a 1.2.1 app that starts reading later is asked about once, and again if it returns', () => {
        const w = windowOf()
        w.tick(1000)
        const tabby = legacy('5716-plebdz', TABBY)
        const effects = w.tick(3000, { peers: [tabby] })
        assert.deepEqual(kinds(effects), ['conflict'])
        assert.equal(effects[0].with.name, 'Tabby')
        assert.deepEqual(w.tick(5000, { peers: [tabby] }), [])
        assert.equal(w.view.mode, 'reading')
        assert.deepEqual(
            w.view.sharingWith.map((app) => app.name),
            ['Tabby'],
        )
        assert.deepEqual(kinds(w.tick(7000)), ['conflict-over'])
        assert.deepEqual(kinds(w.tick(9000, { peers: [tabby] })), ['conflict'])
    })

    test('two 1.2.2 apps that started together settle it without asking', () => {
        const torbie = windowOf(me('9000-torbie', TORBIE))
        const tabby = windowOf(me('5716-tab', TABBY))
        torbie.tick(1000)
        tabby.tick(1001)
        const torbieBeat = modern('9000-torbie', TORBIE, { since: 1000 })
        const tabbyBeat = modern('5716-tab', TABBY, { since: 1001 })
        assert.deepEqual(kinds(tabby.tick(3001, { peers: [torbieBeat] })), ['stop', 'deferred'])
        assert.deepEqual(torbie.tick(3000, { peers: [tabbyBeat] }), [])
        const stoodAside = modern('5716-tab', TABBY, { consuming: false })
        for (let now = 5000; now < 30000; now += 2000) {
            assert.deepEqual(torbie.tick(now, { peers: [stoodAside] }), [])
        }
    })

    test('a tie on start time goes to the lower window id, the same from both sides', () => {
        const a = windowOf(me('1000-a', TORBIE))
        const b = windowOf(me('2000-b', TABBY))
        a.tick(1000)
        b.tick(1000)
        assert.deepEqual(a.tick(3000, { peers: [modern('2000-b', TABBY, { since: 1000 })] }), [])
        assert.deepEqual(
            kinds(b.tick(3000, { peers: [modern('1000-a', TORBIE, { since: 1000 })] })),
            ['stop', 'deferred'],
        )
    })

    test('a 1.2.2 app that should stand aside and does not is asked about after a few heartbeats', () => {
        const w = windowOf()
        w.tick(1000)
        const late = modern('5716-tab', TABBY, { since: 2000 })
        assert.deepEqual(w.tick(3000, { peers: [late] }), [])
        assert.deepEqual(w.tick(9000, { peers: [late] }), [])
        assert.deepEqual(kinds(w.tick(3000 + STALE_MS, { peers: [late] })), ['conflict'])
    })
})

describe('when the other app goes away', () => {
    test('a deferring window reads again, and says so once', () => {
        const w = windowOf()
        const tabby = legacy('5716-plebdz', TABBY)
        w.tick(1000, { peers: [tabby] })
        const effects = w.tick(3000)
        assert.deepEqual(kinds(effects), ['start', 'resumed'])
        assert.equal(effects[1].reason, 'gone')
        assert.equal(effects[1].from.name, 'Tabby')
        assert.deepEqual(w.tick(5000), [])
    })

    test('not on a tick that comes after a stall, when every heartbeat looks old', () => {
        const w = windowOf()
        const tabby = legacy('5716-plebdz', TABBY)
        w.tick(1000, { peers: [tabby] })
        assert.deepEqual(w.tick(20000), [])
        assert.deepEqual(w.tick(22000, { peers: [tabby] }), [])
        assert.deepEqual(w.tick(26000), [])
        assert.deepEqual(kinds(w.tick(28000)), ['start', 'resumed'])
    })

    test('closing the last terminal stops reading', () => {
        const w = windowOf()
        w.tick(1000)
        assert.deepEqual(kinds(w.tick(3000, { wanted: false })), ['stop'])
        assert.equal(w.view.mode, 'off')
    })
})

describe('per-event questions', () => {
    // 1.2.1's WindowCoordinatorService, transcribed, over raw heartbeats.
    function claimedBefore(heartbeats, session, ancestors) {
        if (heartbeats.length === 0) return false
        if (session) {
            for (const peer of heartbeats) {
                if (peer.sessions?.includes(session)) return true
            }
        }
        if (ancestors?.length) {
            for (const peer of heartbeats) {
                if (peer.pids?.some((pid) => ancestors.includes(pid))) return true
            }
        }
        return false
    }

    function leaderBefore(selfId, heartbeats) {
        const ids = heartbeats.map((p) => p.id)
        ids.push(selfId)
        ids.sort()
        return ids[0] === selfId
    }

    /** mulberry32, so a failure reproduces. */
    function seeded(seed) {
        let s = seed
        return () => {
            s = (s + 0x6d2b79f5) | 0
            let t = s
            t = Math.imul(t ^ (t >>> 15), t | 1)
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
    }

    test('among reading windows of one app, the answers match 1.2.1', () => {
        const rand = seeded(1221)
        const sessionPool = ['s1', 's2', 's3']
        const pidPool = [11, 12, 13, 14]
        const some = (pool) => pool.filter(() => rand() < 0.3)
        for (let round = 0; round < 2000; round++) {
            const selfId = `${100 + Math.floor(rand() * 900)}-self`
            const heartbeats = []
            const peers = []
            const count = Math.floor(rand() * 4)
            for (let i = 0; i < count; i++) {
                const id = `${100 + Math.floor(rand() * 900)}-p${i}`
                const heartbeat = { id, ts: 0, sessions: some(sessionPool), pids: some(pidPool) }
                heartbeats.push(heartbeat)
                if (rand() < 0.5) {
                    peers.push(toPeerWindow(heartbeat, 'win32', () => TORBIE))
                } else {
                    const app = { exe: TORBIE, name: 'Torbie', pid: pidFromWindowId(id) }
                    const current = { ...heartbeat, app, consuming: true, consumingSince: 1 }
                    peers.push(toPeerWindow(current, 'win32', () => undefined))
                }
            }
            const session = rand() < 0.8 ? sessionPool[Math.floor(rand() * 3)] : undefined
            const ancestors = rand() < 0.8 ? some(pidPool) : undefined
            assert.equal(
                claimedByPeer(peers, key(TORBIE), session, ancestors),
                claimedBefore(heartbeats, session, ancestors),
            )
            assert.equal(leads(selfId, peers, key(TORBIE)), leaderBefore(selfId, heartbeats))
        }
    })

    test('another app, a window not reading, and a window still being identified', () => {
        const tabby = modern('100-tab', TABBY, { sessions: ['s1'], pids: [11] })
        assert.equal(claimedByPeer([tabby], key(TORBIE), 's1', [11]), false)
        const idle = modern('100-idle', TORBIE, { consuming: false, sessions: ['s1'], pids: [11] })
        assert.equal(claimedByPeer([idle], key(TORBIE), 's1', [11]), false)
        assert.equal(leads('200-me', [idle, tabby], key(TORBIE)), true)
        const unknown = legacy('100-who', undefined, { sessions: ['s1'] })
        assert.equal(claimedByPeer([unknown], key(TORBIE), 's1', undefined), true)
        assert.equal(leads('200-me', [unknown], key(TORBIE)), false)
    })
})
