#!/usr/bin/env node
// Recover the sessions from the most-recent *closed* app run back into the
// "Previous run" bucket, so you can Fork/resume them where you left off.
//
// Why this exists: a pre-fix crash could force-close a run's still-open
// sessions into History with an empty `previousRunIds` (see
// sessionRestoreService.ts). Those sessions are still resumable from History,
// but this puts them back under "Previous run" where they belong.
//
// USAGE (run while the app is CLOSED, so the running instance can't clobber it):
//   node scripts/recover-previous-run.js            # reopen the last closed run
//   node scripts/recover-previous-run.js --run <id> # target a specific runId
//   node scripts/recover-previous-run.js --list     # just show closed runs
//   add --app tabby|torbie to pick the app (required when both have sessions),
//   or --dir <data dir> for a portable install
//
// It only flips `closed:false` and adds the run to `previousRunIds`; it never
// deletes anything, and it writes atomically (temp + rename).

const fs = require('node:fs')
const path = require('node:path')
const { selectHosts } = require('./hosts')

const args = process.argv.slice(2)

// Each app keeps its own sessions file (see src/services/hostApp.ts). Without
// --app/--dir, use whichever app has one, and refuse to guess between two.
const explicit = args.includes('--app') || args.includes('--dir')
const candidates = selectHosts(args, 'all')
    .map((h) => ({ ...h, file: path.join(h.dir, 'tabby-claude-status-sessions.json') }))
    .filter((h) => explicit || fs.existsSync(h.file))
if (candidates.length > 1) {
    const names = candidates.map((h) => h.name).join(' and ')
    const ids = candidates.map((h) => h.id).join('|')
    console.error(`Sessions files found for ${names}. Pick one with --app <${ids}>.`)
    process.exit(1)
}
const HOST = candidates[0] || { ...selectHosts(['--app', 'tabby'])[0] }
const SESSIONS_FILE = HOST.file || path.join(HOST.dir, 'tabby-claude-status-sessions.json')
const listOnly = args.includes('--list')
const runArgIdx = args.indexOf('--run')
const wantedRun = runArgIdx >= 0 ? args[runArgIdx + 1] : null

if (!fs.existsSync(SESSIONS_FILE)) {
    console.error(`No sessions file at ${SESSIONS_FILE} — nothing to recover.`)
    process.exit(1)
}

const file = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'))
const sessions = Array.isArray(file.sessions) ? file.sessions : []

// Group closed sessions by runId, tracking the newest lastSeen per run.
const runs = new Map()
for (const s of sessions) {
    if (!s.closed || !s.runId) continue
    const cur = runs.get(s.runId) || { count: 0, newest: 0, cwds: new Set() }
    cur.count++
    cur.newest = Math.max(cur.newest, s.lastSeen || 0)
    cur.cwds.add(s.cwd)
    runs.set(s.runId, cur)
}

if (runs.size === 0) {
    console.log('No closed runs with sessions found — nothing to recover.')
    process.exit(0)
}

const ordered = [...runs.entries()].sort((a, b) => b[1].newest - a[1].newest)
if (listOnly) {
    console.log('Closed runs (newest first):')
    for (const [id, r] of ordered) {
        console.log(
            `  ${id}  ${r.count} session(s)  last ${new Date(r.newest).toISOString()}\n    ${[...r.cwds].join('\n    ')}`,
        )
    }
    process.exit(0)
}

const targetRun = wantedRun || ordered[0][0]
const target = runs.get(targetRun)
if (!target) {
    console.error(`Run ${targetRun} not found among closed runs. Use --list to see options.`)
    process.exit(1)
}

let reopened = 0
for (const s of sessions) {
    if (s.runId === targetRun && s.closed) {
        s.closed = false
        reopened++
    }
}

const prev = new Set(Array.isArray(file.previousRunIds) ? file.previousRunIds : [])
prev.add(targetRun)
file.previousRunIds = [...prev]

const tmp = `${SESSIONS_FILE}.tmp-${process.pid}`
fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
fs.renameSync(tmp, SESSIONS_FILE)

console.log(
    `Reopened ${reopened} session(s) from run ${targetRun} into "Previous run".\n` +
        `  ${[...target.cwds].join('\n  ')}\n\nRestart ${HOST.name} → open Claude Status ▸ Sessions to Fork them.`,
)
