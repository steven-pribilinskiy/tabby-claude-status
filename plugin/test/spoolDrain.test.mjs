import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eventTsFromName, SpoolDrainer, STALE_EVENT_MS } from '../src/services/spoolDrain.ts'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tcs-spool-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
let n = 0
const newDir = () => {
    const d = path.join(scratch, String(n++))
    fs.mkdirSync(d, { recursive: true })
    return d
}

/** Write a spool file the way hook.js names it. */
function put(dir, ts, event, extra = {}) {
    const name = `${ts}-${1000 + (n++ % 9000)}-${Math.random().toString(36).slice(2, 8)}.json`
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ ts, event, session: 's', ...extra }))
    return name
}

/** Longest stretch the event loop went without running a 1 ms timer. */
function watchStalls() {
    let last = performance.now()
    let max = 0
    const t = setInterval(() => {
        const now = performance.now()
        max = Math.max(max, now - last)
        last = now
    }, 1)
    return () => {
        clearInterval(t)
        return max
    }
}

test('names carry the event time', () => {
    assert.equal(eventTsFromName('1790249311229-4242-abc123.json'), 1790249311229)
    assert.equal(eventTsFromName('1790249311229-4242-abc123.json.tmp'), 1790249311229)
    assert.equal(eventTsFromName('status.json'), null)
})

test('a 3,460-file backlog drains without holding the thread, speaking only fresh events', async () => {
    const dir = newDir()
    const now = Date.now()
    for (let i = 0; i < 3450; i++) put(dir, now - 60_000 - i * 1000, 'PreToolUse')
    // A hook that died mid-write long ago, and one writing right now.
    fs.writeFileSync(path.join(dir, `${now - 3_600_000}-1-dead00.json.tmp`), '{')
    fs.writeFileSync(path.join(dir, `${now}-2-live00.json.tmp`), '{')
    const fresh = []
    for (let i = 0; i < 10; i++) fresh.push(put(dir, now - 5000 + i, 'Stop', { seq: i }))

    const seen = []
    const drainer = new SpoolDrainer(dir, (d) => seen.push(d))
    const stalls = watchStalls()
    const t0 = performance.now()
    await drainer.request()
    const elapsed = performance.now() - t0
    const maxStall = stalls()

    assert.deepEqual(
        seen.map((d) => d.seq),
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        'only the fresh events, in order',
    )
    assert.deepEqual(
        fs.readdirSync(dir),
        [`${now}-2-live00.json.tmp`],
        'the in-flight write is left alone',
    )
    // The old synchronous drain held the thread for the whole backlog (24 s in
    // the field). Here the longest the thread goes without servicing a timer
    // must stay short no matter how big the backlog is.
    assert.ok(maxStall < 150, `event loop stalled ${maxStall.toFixed(1)} ms`)
    console.log(
        `  drained 3,462 files in ${elapsed.toFixed(0)} ms, longest stall ${maxStall.toFixed(1)} ms`,
    )
})

test('overlapping requests collapse, and every event is handled exactly once', async () => {
    const dir = newDir()
    const now = Date.now()
    for (let i = 0; i < 120; i++) put(dir, now - 1000 + i, 'PostToolUse', { seq: i })
    const seen = []
    const drainer = new SpoolDrainer(dir, (d) => seen.push(d.seq), { chunk: 7 })
    const all = []
    for (let i = 0; i < 25; i++) all.push(drainer.request())
    // Events that land mid-pass are picked up by the one follow-up pass.
    put(dir, Date.now(), 'Stop', { seq: 999 })
    all.push(drainer.request())
    await Promise.all(all)
    await drainer.request()
    assert.equal(seen.length, 121)
    assert.equal(new Set(seen).size, 121)
    assert.deepEqual(fs.readdirSync(dir), [])
})

test('an unreadable fresh file is left for the next pass; stop() halts between chunks', async () => {
    const dir = newDir()
    const now = Date.now()
    fs.writeFileSync(path.join(dir, `${now}-1-broken.json`), '{not json')
    const seen = []
    const drainer = new SpoolDrainer(dir, (d) => seen.push(d))
    const r = await drainer.drainOnce()
    assert.deepEqual(r, { delivered: 0, discarded: 0, skipped: 1 })
    assert.deepEqual(fs.readdirSync(dir), [`${now}-1-broken.json`])

    for (let i = 0; i < 40; i++) put(dir, now + i, 'Stop')
    let calls = 0
    const stopping = new SpoolDrainer(dir, () => {}, {
        chunk: 10,
        yieldFn: async () => {
            if (++calls === 1) stopping.stop()
        },
    })
    const r2 = await stopping.drainOnce()
    assert.equal(r2.delivered, 10)
})

test('a missing spool dir is not an error', async () => {
    const drainer = new SpoolDrainer(path.join(scratch, 'nope'), () => assert.fail('no events'))
    assert.deepEqual(await drainer.drainOnce(), { delivered: 0, discarded: 0, skipped: 0 })
})

test('the stale gate matches the handler', () => {
    assert.equal(STALE_EVENT_MS, 10_000)
})

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook.js')

/** Run hook.js for one event with the temp dir pointed at `tmp`. */
function runHook(tmp, event) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [HOOK], {
            env: {
                ...process.env,
                TEMP: tmp,
                TMP: tmp,
                TMPDIR: tmp,
                // Nothing listens on port 9: the fan-out fails fast and quietly.
                TABBY_CLAUDE_STATUS_WEBHOOK_URL: 'https://127.0.0.1:9/none',
            },
            stdio: ['pipe', 'ignore', 'ignore'],
            windowsHide: true,
        })
        child.on('error', reject)
        child.on('exit', resolve)
        child.stdin.end(JSON.stringify(event))
    })
}

test(
    'hook.js prunes a spool nobody reads, a bounded amount per event',
    { timeout: 30_000 },
    async () => {
        const tmp = newDir()
        const spool = path.join(tmp, 'tabby-claude-status.d')
        fs.mkdirSync(spool)
        const now = Date.now()
        for (let i = 0; i < 350; i++) put(spool, now - 120_000 - i, 'PreToolUse')
        for (let i = 0; i < 5; i++) put(spool, now - 2000 + i, 'Stop')

        await runHook(tmp, { hook_event_name: 'UserPromptSubmit', session_id: 'x', cwd: tmp })
        const names = fs.readdirSync(spool)
        assert.equal(names.length, 350 - 100 + 5 + 1, 'at most 100 removed per run')
        assert.ok(
            names.some(
                (f) =>
                    JSON.parse(fs.readFileSync(path.join(spool, f), 'utf-8')).event ===
                    'UserPromptSubmit',
            ),
            'the new event is written',
        )

        const staleCount = () =>
            fs.readdirSync(spool).filter((f) => eventTsFromName(f) < now - 60_000).length
        // Still over the threshold (256 files): another 100 go.
        await runHook(tmp, { hook_event_name: 'Stop', session_id: 'x' })
        assert.equal(staleCount(), 150)
        // At 157 files it is under the threshold: nothing is touched, so a spool
        // an app is reading is never pruned from under it.
        await runHook(tmp, { hook_event_name: 'Stop', session_id: 'x' })
        assert.equal(staleCount(), 150)
        // Fresh events are never pruned.
        assert.equal(fs.readdirSync(spool).length, 150 + 5 + 3)
    },
)
