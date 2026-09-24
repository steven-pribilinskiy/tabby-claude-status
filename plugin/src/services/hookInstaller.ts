/**
 * The pure half of "Setup Claude Hooks": which events to wire, what command
 * to write for each target, and how to merge it into a `settings.json` object
 * without touching anyone else's hooks. The settings tab does the file I/O.
 */

/** Every Claude Code event the plugin reacts to. `UserPromptSubmit` is what
 *  marks a tab "working" the moment a prompt is sent — without it a tab stays
 *  idle until the first tool call. */
export const HOOK_EVENTS = [
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'Notification',
    'Stop',
    'UserPromptSubmit',
    'PermissionRequest',
    'SessionStart',
    'SessionEnd',
] as const

export type HookTargetKind = 'windows' | 'wsl'

export interface HookCommand {
    type: 'command'
    command: string
}

/**
 * Recognise a hook command that invokes this plugin's hook.js, no matter
 * which node binary (win32 node, WSL node, /mnt/c/... passthrough), which
 * copy (Tabby's plugin folder, Torbie's, or the shared per-user copy) or path
 * style (forward/backward slashes, escaped backslashes) it uses.
 */
export function isPluginHookCommand(command: unknown): boolean {
    if (typeof command !== 'string' || !command) return false
    const lower = command.toLowerCase().replace(/\\\\/g, '\\')
    return lower.includes('tabby-claude-status') && lower.includes('hook.js')
}

/** `C:\Program Files\nodejs\node.exe` → `/mnt/c/Program Files/nodejs/node.exe`. */
export function toWslMountPath(winPath: string): string {
    const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/)
    if (!m) return winPath
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

/**
 * Build the hook command for a target.
 *
 * Windows: native `"<node.exe>" "<hook.js>"` — both args are JS strings with
 * single backslashes; JSON.stringify escapes them on write.
 *
 * WSL: bash invokes the Windows `node.exe` via the `/mnt/<drive>/…`
 * passthrough, then passes the Windows `hook.js` path as its argv. Inside
 * bash double quotes, `\\` collapses to `\` — so the command holds doubled
 * backslashes (written to JSON as `\\\\`).
 */
export function buildHookCommand(
    kind: HookTargetKind,
    hookJs: string,
    nodePath: string | null,
): HookCommand {
    if (kind === 'windows') {
        const node = nodePath ? `"${nodePath}"` : 'node'
        return { type: 'command', command: `${node} "${hookJs}"` }
    }
    const nodeWslPath = toWslMountPath(nodePath || 'C:\\Program Files\\nodejs\\node.exe')
    const hookJsForBash = hookJs.replace(/\\/g, '\\\\')
    return { type: 'command', command: `"${nodeWslPath}" "${hookJsForBash}"` }
}

/**
 * Wire `cmd` into every {@link HOOK_EVENTS} entry of a parsed settings.json,
 * in place. An existing plugin hook — whichever copy of hook.js it points at —
 * is replaced where it stands, so installing from Tabby and then from Torbie
 * leaves one entry per event, not two. Other hooks (curl sinks, other tools'
 * hook.js) are left alone. Returns the same object.
 */
export function applyHooks(settings: any, cmd: HookCommand): any {
    const out = settings && typeof settings === 'object' ? settings : {}
    if (!out.hooks || typeof out.hooks !== 'object') out.hooks = {}
    for (const event of HOOK_EVENTS) {
        if (!Array.isArray(out.hooks[event])) out.hooks[event] = []
        const groups: any[] = out.hooks[event]
        // Replace the first plugin hook where it stands; drop any further ones
        // (two copies of hook.js per event would put every event in the spool
        // twice).
        let found = false
        for (const group of groups) {
            if (!Array.isArray(group?.hooks)) continue
            group.hooks = group.hooks.flatMap((h: any) => {
                if (h?.type !== 'command' || !isPluginHookCommand(h.command)) return [h]
                if (found) return []
                found = true
                return [{ ...cmd }]
            })
        }
        out.hooks[event] = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0)
        if (!found) out.hooks[event].push({ hooks: [{ ...cmd }] })
    }
    return out
}

/** Events in a parsed settings.json that have a plugin hook, and the hook.js
 *  paths those hooks point at. */
export function scanHooks(settings: any): {
    configured: string[]
    missing: string[]
    commands: string[]
} {
    const hooks = settings?.hooks || {}
    const configured: string[] = []
    const missing: string[] = []
    const commands: string[] = []
    for (const event of HOOK_EVENTS) {
        const groups: any[] = Array.isArray(hooks[event]) ? hooks[event] : []
        const hits = groups.flatMap((g: any) =>
            (Array.isArray(g?.hooks) ? g.hooks : []).filter((h: any) =>
                isPluginHookCommand(h?.command),
            ),
        )
        if (hits.length) {
            configured.push(event)
            for (const h of hits) commands.push(h.command)
        } else {
            missing.push(event)
        }
    }
    return { configured, missing, commands }
}
