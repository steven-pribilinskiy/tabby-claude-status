import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'
import {
    applyHooks,
    buildHookCommand,
    HOOK_EVENTS,
    isPluginHookCommand,
    scanHooks,
} from '../src/services/hookInstaller.ts'
import {
    compareVersions,
    hookJsPathFromCommand,
    SHARED_HOOK_VERSION_FILE,
    sharedHookDir,
    syncSharedHook,
} from '../src/services/sharedHook.ts'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tcs-hook-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
let n = 0
const dir = (name) => {
    const d = path.join(scratch, `${n++}-${name}`)
    fs.mkdirSync(d, { recursive: true })
    return d
}

const winEnv = {
    APPDATA: 'C:\\Users\\steve\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\steve\\AppData\\Local',
}

describe('shared hook', () => {
    const bundled = (content) => {
        const d = dir('plugin')
        const p = path.join(d, 'hook.js')
        fs.writeFileSync(p, content)
        return p
    }

    test('lives in an app-neutral per-user dir', () => {
        assert.equal(
            sharedHookDir('win32', winEnv, 'C:\\Users\\steve'),
            'C:\\Users\\steve\\AppData\\Local\\tabby-claude-status',
        )
        assert.equal(
            sharedHookDir('linux', {}, '/home/s'),
            '/home/s/.local/share/tabby-claude-status',
        )
        assert.equal(
            sharedHookDir('darwin', {}, '/Users/s'),
            '/Users/s/Library/Application Support/tabby-claude-status',
        )
    })

    test('refresh-only does nothing until Setup installs it', () => {
        const shared = path.join(dir('s'), 'tabby-claude-status')
        const r = syncSharedHook({
            bundledHookPath: bundled('v1'),
            version: '1.2.3',
            dir: shared,
            install: false,
        })
        assert.equal(r.action, 'absent')
        assert.equal(fs.existsSync(shared), false)
    })

    test('install, stay current, update from a newer plugin, never downgrade', () => {
        const shared = path.join(dir('s'), 'tabby-claude-status')
        const hookPath = path.join(shared, 'hook.js')
        let r = syncSharedHook({
            bundledHookPath: bundled('v1'),
            version: '1.2.3',
            installedBy: 'Tabby',
            dir: shared,
            install: true,
        })
        assert.equal(r.action, 'installed')
        assert.equal(r.hookPath, hookPath)
        assert.equal(fs.readFileSync(hookPath, 'utf-8'), 'v1')
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(shared, SHARED_HOOK_VERSION_FILE), 'utf-8'))
                .installedBy,
            'Tabby',
        )

        r = syncSharedHook({
            bundledHookPath: bundled('v1'),
            version: '1.2.3',
            dir: shared,
            install: false,
        })
        assert.equal(r.action, 'current')

        // Torbie on a newer plugin refreshes it at startup…
        r = syncSharedHook({
            bundledHookPath: bundled('v2'),
            version: '1.3.0',
            installedBy: 'Torbie',
            dir: shared,
            install: false,
        })
        assert.equal(r.action, 'updated')
        assert.equal(fs.readFileSync(hookPath, 'utf-8'), 'v2')

        // …and Tabby, still on the older plugin, leaves it alone — even from Setup.
        r = syncSharedHook({
            bundledHookPath: bundled('v1'),
            version: '1.2.3',
            dir: shared,
            install: true,
        })
        assert.equal(r.action, 'newer-installed')
        assert.equal(r.installedVersion, '1.3.0')
        assert.equal(fs.readFileSync(hookPath, 'utf-8'), 'v2')
        assert.deepEqual(
            fs.readdirSync(shared).filter((f) => f.includes('.tmp-')),
            [],
        )
    })

    test('an unreadable bundled hook reports failure instead of throwing', () => {
        const r = syncSharedHook({
            bundledHookPath: path.join(scratch, 'nope.js'),
            version: '1.0.0',
            dir: dir('s'),
            install: true,
        })
        assert.equal(r.action, 'failed')
    })

    test('compareVersions', () => {
        assert.equal(compareVersions('1.2.10', '1.2.9'), 1)
        assert.equal(compareVersions('1.2.2', '1.2.2'), 0)
        assert.equal(compareVersions('1.2', '1.2.1'), -1)
        assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), 0)
    })
})

// The commands exactly as the live settings.json files hold them.
const LIVE_WIN =
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steve\\AppData\\Roaming\\tabby\\plugins\\node_modules\\tabby-claude-status\\hook.js"'
const LIVE_WSL =
    '"/mnt/c/Program Files/nodejs/node.exe" "C:\\\\Users\\\\steve\\\\AppData\\\\Roaming\\\\tabby\\\\plugins\\\\node_modules\\\\tabby-claude-status\\\\hook.js"'
const CURL =
    'curl -sSk --max-time 0.5 -X POST https://tabby-claude-status.lvh.me/api/claude/hook --data-binary @- 2>/dev/null || true'
const SHARED = 'C:\\Users\\steve\\AppData\\Local\\tabby-claude-status\\hook.js'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'

describe('hook installer', () => {
    test('hook.js path is recovered from Windows and WSL commands', () => {
        const tabbyHook =
            'C:\\Users\\steve\\AppData\\Roaming\\tabby\\plugins\\node_modules\\tabby-claude-status\\hook.js'
        assert.equal(hookJsPathFromCommand(LIVE_WIN), tabbyHook)
        assert.equal(hookJsPathFromCommand(LIVE_WSL), tabbyHook)
        assert.equal(
            hookJsPathFromCommand('node /x/tabby-claude-status/hook.js'),
            '/x/tabby-claude-status/hook.js',
        )
        assert.equal(hookJsPathFromCommand(CURL), null)
    })

    test('every copy of hook.js is recognised as ours: Tabby, Torbie, shared', () => {
        assert.ok(isPluginHookCommand(LIVE_WIN))
        assert.ok(isPluginHookCommand(LIVE_WSL))
        assert.ok(isPluginHookCommand(buildHookCommand('windows', SHARED, NODE).command))
        assert.ok(isPluginHookCommand(buildHookCommand('wsl', SHARED, NODE).command))
        assert.ok(!isPluginHookCommand(CURL))
        assert.ok(!isPluginHookCommand('node C:\\agent-flow\\hook.js'))
    })

    test('WSL command runs Windows node via /mnt/c with bash-escaped backslashes', () => {
        assert.equal(
            buildHookCommand('wsl', SHARED, NODE).command,
            '"/mnt/c/Program Files/nodejs/node.exe" "C:\\\\Users\\\\steve\\\\AppData\\\\Local\\\\tabby-claude-status\\\\hook.js"',
        )
        assert.equal(buildHookCommand('windows', SHARED, null).command, `node "${SHARED}"`)
    })

    test('WSL setup wires all events, UserPromptSubmit included, into the live WSL shape', () => {
        // The live WSL file: every event has curl + hook.js, except
        // UserPromptSubmit, which only has curl.
        const settings = { hooks: {} }
        for (const e of HOOK_EVENTS) {
            settings.hooks[e] = [
                {
                    hooks: [
                        { type: 'command', command: CURL },
                        ...(e === 'UserPromptSubmit'
                            ? []
                            : [{ type: 'command', command: LIVE_WSL }]),
                    ],
                },
            ]
        }
        settings.hooks.SessionStart = [{ hooks: [{ type: 'command', command: LIVE_WSL }] }]
        assert.deepEqual(scanHooks(settings).missing, ['UserPromptSubmit'])

        const cmd = buildHookCommand('wsl', SHARED, NODE)
        applyHooks(settings, cmd)
        const scan = scanHooks(settings)
        assert.deepEqual(scan.missing, [])
        assert.deepEqual(scan.configured, [...HOOK_EVENTS])
        for (const e of HOOK_EVENTS) {
            const all = settings.hooks[e].flatMap((g) => g.hooks)
            assert.equal(all.filter((h) => isPluginHookCommand(h.command)).length, 1, e)
            assert.equal(
                all.filter((h) => isPluginHookCommand(h.command))[0].command,
                cmd.command,
                e,
            )
            if (e !== 'SessionStart')
                assert.ok(
                    all.some((h) => h.command === CURL),
                    `${e} keeps curl`,
                )
        }
        // Replaced in place: the Stop group still holds curl first, then ours.
        assert.deepEqual(
            settings.hooks.Stop[0].hooks.map((h) => h.command),
            [CURL, cmd.command],
        )
    })

    test('installing from Tabby then Torbie leaves one entry per event, and removes duplicates', () => {
        const torbieHook =
            'C:\\Users\\steve\\AppData\\Roaming\\torbie\\plugins\\node_modules\\tabby-claude-status\\hook.js'
        const settings = {
            hooks: {
                Stop: [
                    { hooks: [{ type: 'command', command: LIVE_WIN }] },
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: buildHookCommand('windows', torbieHook, NODE).command,
                            },
                        ],
                    },
                ],
                Other: [{ hooks: [{ type: 'command', command: 'x' }] }],
            },
            model: 'keep-me',
        }
        applyHooks(settings, buildHookCommand('windows', SHARED, NODE))
        applyHooks(settings, buildHookCommand('windows', SHARED, NODE))
        assert.equal(settings.model, 'keep-me')
        assert.deepEqual(settings.hooks.Other, [{ hooks: [{ type: 'command', command: 'x' }] }])
        for (const e of HOOK_EVENTS) {
            const ours = settings.hooks[e]
                .flatMap((g) => g.hooks)
                .filter((h) => isPluginHookCommand(h.command))
            assert.equal(ours.length, 1, e)
            assert.equal(hookJsPathFromCommand(ours[0].command), SHARED)
        }
        assert.equal(settings.hooks.Stop.length, 1, 'the emptied duplicate group is pruned')
    })

    test('an empty settings object gets every event', () => {
        const s = applyHooks({}, buildHookCommand('windows', SHARED, NODE))
        assert.deepEqual(Object.keys(s.hooks), [...HOOK_EVENTS])
    })
})
