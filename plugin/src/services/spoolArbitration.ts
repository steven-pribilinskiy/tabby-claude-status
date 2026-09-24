/**
 * Which app reads the Claude hook spool. Pure decision logic, no I/O.
 *
 * The spool (`tmpdir/tabby-claude-status.d`) is consume-and-delete: whichever
 * reader deletes an event file first is the only one that ever sees it.
 * Windows of one app share it through heartbeats (WindowCoordinatorService)
 * and keep doing exactly that. Two different apps carrying this plugin, Tabby
 * and Torbie say, are the problem: each takes the events it happens to read
 * first, and plays the sounds and colours the tabs for only those.
 *
 * App identity is the normalised executable path, so windows sharing one are
 * one app. Between apps:
 *
 *  - An app starts reading unless a live window of another app already is.
 *  - `owner.json` records a hand-over made from Settings. It wins while the
 *    window it names is alive and that window's app is actually reading.
 *  - Two apps that began reading together, before either saw the other,
 *    settle it without asking: the one that has been reading longer keeps it.
 *  - A window from before 1.2.2 has no `app` field and cannot hand over. It
 *    always counts as reading, and meeting one while reading asks the user.
 *
 * Free of imports on purpose, so the tests run it under plain node.
 */

/** How often a window refreshes its heartbeat. */
export const HEARTBEAT_MS = 2000
/** A heartbeat older than this belongs to a window that is gone. Generous
 *  relative to HEARTBEAT_MS so a briefly-janked renderer (GC pause, heavy
 *  paint) is never mistaken for a crashed one. */
export const STALE_MS = 8000
/** The first plugin version whose windows can hand the spool over. */
export const COORDINATING_VERSION = '1.2.2'
export const UNIDENTIFIED_APP = 'an unidentified app'

export interface AppIdentity {
    /** `process.execPath`, as the app reports it. */
    exe: string
    /** For display: Tabby, Torbie, or "a source build". */
    name: string
    /** The renderer that wrote the heartbeat, the same PID that prefixes its id. */
    pid: number
}

/**
 * A heartbeat file, `<pid>-<rand>.json`. The first four fields are 1.2.1's and
 * keep their meaning. A heartbeat without `app` comes from a window older than
 * 1.2.2.
 */
export interface WindowHeartbeat {
    id: string
    ts: number
    sessions: string[]
    pids: number[]
    app?: AppIdentity
    /** Whether this window's watcher is reading the spool. */
    consuming?: boolean
    /** When it started reading, which settles two apps that started together. */
    consumingSince?: number
}

/**
 * `owner.json`: the app Claude events were handed to from Settings.
 *
 * It has no `id` field, on purpose. 1.2.1 lists the same directory and skips a
 * file without one; a file carrying `id` and `ts` would be taken for a window
 * and deleted as stale eight seconds later.
 */
export interface OwnerRecord {
    exe: string
    name: string
    pid: number
    ts: number
    /** Heartbeat id of the window the events went to. The hand-over lapses with
     *  that window, so the next run of its app does not inherit it. */
    window?: string
}

/** A live window other than this one, as arbitration sees it. */
export interface PeerWindow {
    id: string
    /** Normalised exe, or null for a pre-1.2.2 window not (yet) identified. */
    exe: string | null
    /** The exe path as reported, for display. */
    exePath: string | null
    name: string
    pid: number
    /** Written by a plugin older than 1.2.2, which cannot hand over. */
    legacy: boolean
    /** Its exe lookup is still running. */
    resolving: boolean
    consuming: boolean
    consumingSince: number
    sessions: string[]
    pids: number[]
}

/** An app, named by one of its windows. */
export interface AppRef {
    /** Normalised exe, or `?<pid>` for a window nobody could identify. */
    key: string
    exe: string | null
    exePath: string | null
    name: string
    pid: number
    /** At least one of its windows cannot hand over. */
    legacy: boolean
}

export function normalizeExe(exe: string, platform: string): string {
    let out = String(exe ?? '').trim()
    if (platform === 'win32') {
        out = out.replace(/\//g, '\\')
        if (out.startsWith('\\\\?\\')) out = out.slice(4)
        out = out.toLowerCase()
    }
    return out
}

export function appNameForExe(exe: string | null | undefined): string {
    if (!exe) return UNIDENTIFIED_APP
    const base = exe.split(/[\\/]/).pop() || exe
    const stem = base.replace(/\.exe$/i, '')
    switch (stem.toLowerCase()) {
        case 'tabby':
            return 'Tabby'
        case 'torbie':
            return 'Torbie'
        case 'electron':
            return 'a source build'
        default:
            return stem
    }
}

export function capitalize(text: string): string {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** "Tabby (PID 5716)". `opening` capitalises a name that starts a sentence. */
export function describeApp(app: { name: string; pid: number }, opening = false): string {
    const name = opening ? capitalize(app.name) : app.name
    return app.pid > 0 ? `${name} (PID ${app.pid})` : name
}

export function pidFromWindowId(id: string): number {
    const match = /^(\d+)-/.exec(String(id))
    return match ? Number(match[1]) : 0
}

/**
 * `lookupExe` answers a PID with its exe path, null when the lookup failed, or
 * undefined while it is still running.
 */
export function toPeerWindow(
    heartbeat: WindowHeartbeat,
    platform: string,
    lookupExe: (pid: number) => string | null | undefined,
): PeerWindow {
    const sessions = Array.isArray(heartbeat.sessions) ? heartbeat.sessions : []
    const pids = Array.isArray(heartbeat.pids) ? heartbeat.pids : []
    const app = heartbeat.app
    if (app && typeof app.exe === 'string' && app.exe) {
        const consuming = heartbeat.consuming === true
        return {
            id: heartbeat.id,
            exe: normalizeExe(app.exe, platform),
            exePath: app.exe,
            name: typeof app.name === 'string' && app.name ? app.name : appNameForExe(app.exe),
            pid: Number(app.pid) > 0 ? Number(app.pid) : pidFromWindowId(heartbeat.id),
            legacy: false,
            resolving: false,
            consuming,
            consumingSince: consuming ? Number(heartbeat.consumingSince) || 0 : 0,
            sessions,
            pids,
        }
    }
    const pid = pidFromWindowId(heartbeat.id)
    const found = pid > 0 ? lookupExe(pid) : null
    return {
        id: heartbeat.id,
        exe: found ? normalizeExe(found, platform) : null,
        exePath: found || null,
        name: appNameForExe(found),
        pid,
        legacy: true,
        resolving: found === undefined,
        // 1.2.1 has no way to stand aside, so a live one is reading, or will be
        // the moment it opens a terminal.
        consuming: true,
        consumingSince: 0,
        sessions,
        pids,
    }
}

// ── Per-event questions ────────────────────────────────────────────

/**
 * The peers whose heartbeats speak for the events this window reads: windows
 * of this app that are reading too. A window that is not reading acts on no
 * event, and another app's windows do not see the same events. Among windows
 * of one app that all read, the only arrangement 1.2.1 knew, that is every
 * peer, as before. A peer still being identified counts, as every peer did.
 */
export function eventPeers(peers: PeerWindow[], selfExe: string): PeerWindow[] {
    return peers.filter((p) => p.consuming && (p.resolving || p.exe === selfExe))
}

/** True when a reading window of this app owns the event's session or hosts a
 *  terminal in its process ancestry, and so announces it itself. */
export function claimedByPeer(
    peers: PeerWindow[],
    selfExe: string,
    session: string | undefined,
    ancestors: number[] | undefined,
): boolean {
    const mates = eventPeers(peers, selfExe)
    if (mates.length === 0) return false
    if (session) {
        for (const peer of mates) {
            if (peer.sessions.includes(session)) return true
        }
    }
    if (ancestors?.length) {
        for (const peer of mates) {
            if (peer.pids.some((pid) => ancestors.includes(pid))) return true
        }
    }
    return false
}

/** True when this window announces events no window owns: it has the lowest id
 *  among itself and the reading windows of its app. */
export function leads(selfId: string, peers: PeerWindow[], selfExe: string): boolean {
    const ids = eventPeers(peers, selfExe).map((p) => p.id)
    ids.push(selfId)
    ids.sort()
    return ids[0] === selfId
}

// ── Which app reads ────────────────────────────────────────────────

export interface ArbiterState {
    consuming: boolean
    consumingSince: number
    /** The app this window leaves Claude events to while it wants them. */
    deferringTo: AppRef | null
    /** When each other app was first seen reading alongside this window. */
    conflictSince: Record<string, number>
    /** Apps already asked about, asked once while they keep reading. */
    prompted: string[]
    /** Apps that cannot hand over, which the user chose to read alongside. */
    acknowledged: string[]
    /** No resuming before this, after this window's own timer stalled. */
    quietUntil: number
    lastTick: number
}

export function initialArbiterState(): ArbiterState {
    return {
        consuming: false,
        consumingSince: 0,
        deferringTo: null,
        conflictSince: {},
        prompted: [],
        acknowledged: [],
        quietUntil: 0,
        lastTick: 0,
    }
}

export interface ArbiterInput {
    now: number
    platform: string
    self: { id: string; exe: string; name: string; pid: number }
    /** This window has a terminal open and the plugin is enabled. */
    wanted: boolean
    /** Live windows other than this one. */
    peers: PeerWindow[]
    owner: OwnerRecord | null
}

export type ArbiterEffect =
    | { kind: 'start' }
    | { kind: 'stop' }
    /** Wanted the spool and found another app reading it. */
    | { kind: 'deferred'; to: AppRef }
    /** Was reading, and the events were handed to another app. */
    | { kind: 'moved'; to: AppRef }
    /** Was leaving the events to an app, and now reads them itself. */
    | { kind: 'resumed'; from: AppRef; reason: 'gone' | 'handed-over' }
    /** Reading alongside another app that is not going to stop. */
    | { kind: 'conflict'; with: AppRef }
    /** A conflict that no longer holds. */
    | { kind: 'conflict-over'; key: string }

interface AppGroup {
    ref: AppRef
    /** Earliest `consumingSince` among its reading windows that can hand over. */
    since: number
    /** Lowest window id, the tie-break after `since`. */
    minId: string
}

function byId(a: { id: string }, b: { id: string }): number {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function appKey(window: PeerWindow): string {
    return window.exe ?? `?${window.pid}`
}

function groupApps(windows: PeerWindow[]): AppGroup[] {
    const byApp = new Map<string, PeerWindow[]>()
    for (const window of windows) {
        const list = byApp.get(appKey(window))
        if (list) list.push(window)
        else byApp.set(appKey(window), [window])
    }
    const groups: AppGroup[] = []
    for (const [key, list] of byApp) {
        const sorted = list.slice().sort(byId)
        const lead = sorted.find((w) => w.consuming) ?? sorted[0]
        const handing = sorted.filter((w) => w.consuming && !w.legacy)
        groups.push({
            ref: {
                key,
                exe: lead.exe,
                exePath: lead.exePath,
                name: lead.name,
                pid: lead.pid,
                legacy: sorted.some((w) => w.legacy),
            },
            since: handing.length ? Math.min(...handing.map((w) => w.consumingSince)) : 0,
            minId: sorted[0].id,
        })
    }
    return groups.sort((a, b) => (a.minId < b.minId ? -1 : a.minId > b.minId ? 1 : 0))
}

function precedes(
    a: { since: number; minId: string },
    b: { since: number; minId: string },
): boolean {
    return a.since !== b.since ? a.since < b.since : a.minId < b.minId
}

function earliest(groups: AppGroup[]): AppGroup {
    return groups.slice().sort((a, b) => (precedes(a, b) ? -1 : precedes(b, a) ? 1 : 0))[0]
}

/** Other apps' windows that are reading, and are identified or given up on. */
function foreignReaders(input: ArbiterInput, selfExe: string): PeerWindow[] {
    return input.peers.filter((p) => p.consuming && !p.resolving && p.exe !== selfExe)
}

/**
 * The app `owner.json` hands Claude events to, if the hand-over still holds:
 * the window it names is alive and runs that app, and, for another app, that
 * app is reading. Handing events to an app that is not reading would leave
 * nobody reading them.
 */
function handedTo(
    input: ArbiterInput,
    selfExe: string,
    readers: PeerWindow[],
): 'self' | AppGroup | null {
    const owner = input.owner
    if (!owner || typeof owner.exe !== 'string') return null
    const ownerExe = owner.exe ? normalizeExe(owner.exe, input.platform) : ''
    const named = (w: { id: string; pid: number }): boolean =>
        owner.window ? w.id === owner.window : w.pid === owner.pid
    let windowExe: string | null
    if (named(input.self)) {
        windowExe = selfExe
    } else {
        const peer = input.peers.find(named)
        if (!peer || peer.resolving) return null
        windowExe = peer.exe
    }
    // A recycled PID, or a window since identified as some other app.
    if ((windowExe ?? '') !== ownerExe) return null
    if (ownerExe && ownerExe === selfExe) return 'self'
    const reading = readers.filter((p) => (ownerExe ? p.exe === ownerExe : named(p)))
    return reading.length ? groupApps(reading)[0] : null
}

function ownOrder(
    input: ArbiterInput,
    selfExe: string,
    state: ArbiterState,
): { since: number; minId: string } {
    const mates = input.peers.filter((p) => p.consuming && !p.resolving && p.exe === selfExe)
    const since = [
        state.consumingSince,
        ...mates.filter((p) => !p.legacy).map((p) => p.consumingSince),
    ]
    const ids = [input.self.id, ...mates.map((p) => p.id)].sort()
    return { since: Math.min(...since), minId: ids[0] }
}

/**
 * One step: given the previous state and what the heartbeats and `owner.json`
 * say now, whether this window reads the spool and what to tell the user. Run
 * on every heartbeat tick and whenever something it depends on changes.
 */
export function arbitrate(
    prev: ArbiterState,
    input: ArbiterInput,
): { state: ArbiterState; effects: ArbiterEffect[] } {
    const s: ArbiterState = {
        ...prev,
        conflictSince: { ...prev.conflictSince },
        prompted: prev.prompted.slice(),
        acknowledged: prev.acknowledged.slice(),
    }
    const effects: ArbiterEffect[] = []
    const now = input.now
    const selfExe = normalizeExe(input.self.exe, input.platform)

    // A tick long after the last one means this renderer was blocked or the
    // machine slept, so every heartbeat reads as old. Nobody is taken for gone
    // until the peers have had time to write again.
    if (prev.lastTick > 0 && now - prev.lastTick > STALE_MS) s.quietUntil = now + STALE_MS
    s.lastTick = now

    const readers = foreignReaders(input, selfExe)
    const apps = groupApps(readers)
    const present = new Set(apps.map((app) => app.ref.key))

    const forget = (keep: (key: string) => boolean): void => {
        for (const key of s.prompted) {
            if (!keep(key)) effects.push({ kind: 'conflict-over', key })
        }
        s.prompted = s.prompted.filter(keep)
        for (const key of Object.keys(s.conflictSince)) {
            if (!keep(key)) delete s.conflictSince[key]
        }
    }
    const stop = (): void => {
        effects.push({ kind: 'stop' })
        s.consuming = false
        s.consumingSince = 0
    }
    const start = (reason: 'gone' | 'handed-over'): void => {
        effects.push({ kind: 'start' })
        if (s.deferringTo) effects.push({ kind: 'resumed', from: s.deferringTo, reason })
        s.consuming = true
        s.consumingSince = now
        s.deferringTo = null
    }
    const deferTo = (app: AppGroup, handedOver: boolean): void => {
        const wasReading = s.consuming
        if (wasReading) stop()
        if (s.deferringTo?.key !== app.ref.key) {
            effects.push(
                wasReading && handedOver
                    ? { kind: 'moved', to: app.ref }
                    : { kind: 'deferred', to: app.ref },
            )
        }
        s.deferringTo = app.ref
        forget(() => false)
    }
    const consider = (app: AppGroup): void => {
        const key = app.ref.key
        if (s.prompted.includes(key) || s.acknowledged.includes(key)) return
        if (s.conflictSince[key] === undefined) s.conflictSince[key] = now
        // An app that can hand over gets a few heartbeats to stand aside, which
        // is how a race between two starting apps ends. Only one that cannot,
        // or has not, is worth asking about.
        if (!app.ref.legacy && now - s.conflictSince[key] < STALE_MS) return
        s.prompted.push(key)
        effects.push({ kind: 'conflict', with: app.ref })
    }
    const done = () => ({ state: s, effects })

    forget((key) => present.has(key))
    s.acknowledged = s.acknowledged.filter((key) => present.has(key))

    if (!input.wanted) {
        if (s.consuming) stop()
        s.deferringTo = null
        forget(() => false)
        return done()
    }

    const owner = handedTo(input, selfExe, readers)
    if (owner === 'self') {
        if (!s.consuming) start('handed-over')
        for (const app of apps) consider(app)
        return done()
    }
    if (owner) {
        deferTo(owner, true)
        return done()
    }

    if (!s.consuming) {
        if (apps.length) {
            deferTo(earliest(apps), false)
            return done()
        }
        // A pre-1.2.2 window may yet turn out to be another app, and starting
        // means deleting event files, so wait for the answer.
        if (input.peers.some((p) => p.resolving)) return done()
        if (s.deferringTo && now < s.quietUntil) return done()
        start('gone')
        return done()
    }

    const own = ownOrder(input, selfExe, s)
    const ahead = apps.filter((app) => !app.ref.legacy && precedes(app, own))
    if (ahead.length) {
        deferTo(earliest(ahead), false)
        return done()
    }
    for (const app of apps) consider(app)
    return done()
}

/** Other apps reading the spool that cannot hand over. Taking the events over
 *  leaves them reading as well. */
export function readersThatCannotHandOver(input: ArbiterInput): AppRef[] {
    const selfExe = normalizeExe(input.self.exe, input.platform)
    return groupApps(foreignReaders(input, selfExe))
        .filter((app) => app.ref.legacy)
        .map((app) => app.ref)
}

/** The window to hand Claude events to for the app `key` names: its reading
 *  window with the lowest id. */
export function readingWindowOf(input: ArbiterInput, key: string): PeerWindow | null {
    const selfExe = normalizeExe(input.self.exe, input.platform)
    const windows = foreignReaders(input, selfExe)
        .filter((p) => appKey(p) === key)
        .sort(byId)
    return windows[0] ?? null
}

export function acknowledge(state: ArbiterState, keys: string[]): ArbiterState {
    return {
        ...state,
        acknowledged: [...new Set([...state.acknowledged, ...keys])],
        prompted: state.prompted.filter((key) => !keys.includes(key)),
    }
}

// ── What the settings tab shows ────────────────────────────────────

export interface OtherApp extends AppRef {
    windows: number
    reading: boolean
}

export interface SpoolView {
    /** off: no terminal here. waiting: identifying peers first. */
    mode: 'off' | 'waiting' | 'reading' | 'deferring'
    self: AppRef
    deferringTo: AppRef | null
    /** Other apps reading alongside this window that are not standing aside. */
    sharingWith: AppRef[]
    /** Every other app with a live window, and whether it reads. */
    others: OtherApp[]
}

export function describeSpool(state: ArbiterState, input: ArbiterInput): SpoolView {
    const selfExe = normalizeExe(input.self.exe, input.platform)
    const known = input.peers.filter((p) => !p.resolving && p.exe !== selfExe)
    const others = groupApps(known).map((app): OtherApp => {
        const windows = known.filter((p) => appKey(p) === app.ref.key)
        return { ...app.ref, windows: windows.length, reading: windows.some((p) => p.consuming) }
    })
    const sharingWith = state.consuming
        ? groupApps(known.filter((p) => p.consuming))
              .map((app) => app.ref)
              .filter((ref) => ref.legacy || state.prompted.includes(ref.key))
        : []
    let mode: SpoolView['mode'] = 'waiting'
    if (!input.wanted) mode = 'off'
    else if (state.consuming) mode = 'reading'
    else if (state.deferringTo) mode = 'deferring'
    return {
        mode,
        self: {
            key: selfExe,
            exe: selfExe,
            exePath: input.self.exe,
            name: input.self.name,
            pid: input.self.pid,
            legacy: false,
        },
        deferringTo: state.deferringTo,
        sharingWith,
        others,
    }
}
