import {
    type AppRef,
    type ArbiterEffect,
    type ArbiterInput,
    acknowledge,
    arbitrate,
    COORDINATING_VERSION,
    capitalize,
    describeApp,
    describeSpool,
    initialArbiterState,
    type PeerWindow,
    readersThatCannotHandOver,
    readingWindowOf,
    type SpoolView,
} from './spoolArbitration'
import { readOwner, releaseOwner, writeOwner } from './spoolFiles'

/** Starts and stops this window's spool watcher. */
export interface SpoolConsumer {
    start(): void
    stop(): void
}

export interface SpoolNotice {
    title: string
    message: string
}

/** A notice with one action, run when the user takes it. */
export interface SpoolPrompt extends SpoolNotice {
    action: string
    run(): void
}

/** What the arbitration needs from the window it runs in. */
export interface SpoolHost {
    /** The heartbeat directory, where `owner.json` lives too. */
    readonly dir: string
    readonly platform: string
    readonly self: { id: string; exe: string; name: string; pid: number }
    now(): number
    peers(): PeerWindow[]
    /** Put whether this window reads into its heartbeat. Called before the
     *  watcher starts and after it stops. */
    publishConsuming(consuming: boolean, since: number): void
    notify(notice: SpoolNotice): void
    /** Show a prompt. The handle withdraws it. */
    prompt(prompt: SpoolPrompt): { close(): void }
}

export type HandOverResult =
    | { ok: true }
    | { ok: false; confirm: AppRef[] }
    | { ok: false; error: string }

export function deferredNotice(to: AppRef): SpoolNotice {
    return {
        title: `Claude events go to ${to.name}`,
        message: `${describeApp(to, true)} is already reading Claude Code events, so this window leaves their sounds and tab colours to it. To handle them here, open Settings → Claude Status.`,
    }
}

export function movedNotice(to: AppRef): SpoolNotice {
    return {
        title: `Claude events moved to ${to.name}`,
        message: `${describeApp(to, true)} reads Claude Code events now, so this window stopped. Settings → Claude Status can take them back.`,
    }
}

export function resumedNotice(from: AppRef, reason: 'gone' | 'handed-over'): SpoolNotice {
    return {
        title: 'Claude events are read here again',
        message:
            reason === 'gone'
                ? `${describeApp(from, true)} stopped reading Claude Code events, so this window reads them again.`
                : 'Claude Code events were handed to this app, so this window reads them now.',
    }
}

export function conflictPrompt(app: AppRef, run: () => void): SpoolPrompt {
    return {
        title: `${capitalize(app.name)} is also reading Claude events`,
        message: app.legacy
            ? `${describeApp(app, true)} runs a tabby-claude-status older than ${COORDINATING_VERSION}, which cannot hand them over, so each app misses the events the other reads first.`
            : `${describeApp(app, true)} and this window are both reading Claude Code events, so each misses the events the other reads first.`,
        action: `Leave Claude events to ${app.name}`,
        run,
    }
}

/**
 * Runs the arbitration for one window: feeds it heartbeats and `owner.json`,
 * starts and stops the watcher it decides on, and tells the user when events
 * move between apps. Plain TypeScript, so the tests drive it against real files
 * in a scratch directory; SpoolOwnershipService wires it into Angular.
 */
export class SpoolOwnership {
    private state = initialArbiterState()
    private wanted = false
    private consumer: SpoolConsumer | null = null
    private readonly prompts = new Map<string, { close(): void }>()
    private evaluating = false
    private current: SpoolView
    private readonly host: SpoolHost

    constructor(host: SpoolHost) {
        this.host = host
        this.current = describeSpool(this.state, {
            now: 0,
            platform: host.platform,
            self: host.self,
            wanted: false,
            peers: [],
            owner: null,
        })
    }

    get view(): SpoolView {
        return this.current
    }

    get consuming(): boolean {
        return this.state.consuming
    }

    setConsumer(consumer: SpoolConsumer): void {
        this.consumer = consumer
    }

    /** Whether this window wants the spool, i.e. has a terminal open. */
    setWanted(wanted: boolean): void {
        if (this.wanted === wanted) return
        this.wanted = wanted
        this.evaluate()
    }

    evaluate(): void {
        // Starting the watcher drains the spool synchronously; anything that
        // asks again from inside it is answered on the next tick.
        if (this.evaluating) return
        this.evaluating = true
        try {
            const input = this.input()
            const { state, effects } = arbitrate(this.state, input)
            this.state = state
            for (const effect of effects) this.apply(effect)
            this.current = describeSpool(this.state, input)
        } finally {
            this.evaluating = false
        }
    }

    /** Handle Claude events in this app. Apps that cannot hand over go on
     *  reading as well, so that takes `confirmed`. */
    takeOver(confirmed = false): HandOverResult {
        const input = this.input()
        const stubborn = readersThatCannotHandOver(input)
        if (stubborn.length && !confirmed) return { ok: false, confirm: stubborn }
        const self = this.host.self
        try {
            writeOwner(this.host.dir, {
                exe: self.exe,
                name: self.name,
                pid: self.pid,
                ts: input.now,
                window: self.id,
            })
        } catch (err: any) {
            return { ok: false, error: `Could not record the hand-over: ${err?.message ?? err}` }
        }
        const keys = stubborn.map((app) => app.key)
        this.state = acknowledge(this.state, keys)
        for (const key of keys) this.closePrompt(key)
        this.evaluate()
        return { ok: true }
    }

    /** Leave Claude events to the app `key` names, which is reading them. */
    leaveTo(key: string): HandOverResult {
        const input = this.input()
        const target = readingWindowOf(input, key)
        if (!target) return { ok: false, error: 'That app is no longer reading Claude events.' }
        try {
            writeOwner(this.host.dir, {
                exe: target.exePath ?? '',
                name: target.name,
                pid: target.pid,
                ts: input.now,
                window: target.id,
            })
        } catch (err: any) {
            return { ok: false, error: `Could not record the hand-over: ${err?.message ?? err}` }
        }
        this.closePrompt(key)
        this.evaluate()
        return { ok: true }
    }

    /** The window is closing, and a hand-over to it ends with it. */
    shutdown(): void {
        for (const key of [...this.prompts.keys()]) this.closePrompt(key)
        try {
            releaseOwner(this.host.dir, this.host.self.id)
        } catch {
            /* best effort */
        }
    }

    private input(): ArbiterInput {
        return {
            now: this.host.now(),
            platform: this.host.platform,
            self: this.host.self,
            wanted: this.wanted,
            peers: this.host.peers(),
            owner: readOwner(this.host.dir),
        }
    }

    private apply(effect: ArbiterEffect): void {
        switch (effect.kind) {
            case 'start':
                this.host.publishConsuming(true, this.state.consumingSince)
                this.consumer?.start()
                return
            case 'stop':
                this.consumer?.stop()
                this.host.publishConsuming(false, 0)
                return
            case 'deferred':
                this.host.notify(deferredNotice(effect.to))
                return
            case 'moved':
                this.host.notify(movedNotice(effect.to))
                return
            case 'resumed':
                this.host.notify(resumedNotice(effect.from, effect.reason))
                return
            case 'conflict':
                this.openPrompt(effect.with)
                return
            case 'conflict-over':
                this.closePrompt(effect.key)
                return
        }
    }

    private openPrompt(app: AppRef): void {
        if (this.prompts.has(app.key)) return
        const handle = this.host.prompt(
            conflictPrompt(app, () => {
                this.prompts.delete(app.key)
                const result = this.leaveTo(app.key)
                if ('error' in result) {
                    this.host.notify({ title: 'Claude events stayed here', message: result.error })
                }
            }),
        )
        this.prompts.set(app.key, handle)
    }

    private closePrompt(key: string): void {
        const handle = this.prompts.get(key)
        if (!handle) return
        this.prompts.delete(key)
        try {
            handle.close()
        } catch {
            /* already gone */
        }
    }
}
