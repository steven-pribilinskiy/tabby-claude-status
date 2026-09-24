import { Inject, Injectable, Optional } from '@angular/core'
import { NotificationsService } from 'tabby-core'
import type { AppRef, SpoolView } from './spoolArbitration'
import {
    type HandOverResult,
    type SpoolConsumer,
    SpoolOwnership,
    type SpoolPrompt,
} from './spoolOwnership'
import { WindowCoordinatorService } from './windowCoordinatorService'

/**
 * Keeps two different apps carrying this plugin from both reading the Claude
 * hook spool, which is consume-and-delete, so each would miss the events the
 * other read first. The decision is spoolArbitration.ts and the runtime is
 * spoolOwnership.ts; this wires them to this window's heartbeat, its
 * notifications and the settings tab.
 */
@Injectable({ providedIn: 'root' })
export class SpoolOwnershipService {
    private readonly ownership: SpoolOwnership

    constructor(
        coordinator: WindowCoordinatorService,
        @Optional()
        @Inject(NotificationsService)
        private notifications: NotificationsService | null,
    ) {
        this.ownership = new SpoolOwnership({
            dir: coordinator.heartbeatDir,
            platform: process.platform,
            self: { id: coordinator.instanceId, ...coordinator.app },
            now: () => Date.now(),
            peers: () => coordinator.peers(),
            publishConsuming: (consuming, since) => coordinator.setConsuming(consuming, since),
            notify: (notice) => this.notify(notice.title, notice.message),
            prompt: (prompt) => this.prompt(prompt),
        })
        coordinator.onChange(() => this.ownership.evaluate())
    }

    get view(): SpoolView {
        return this.ownership.view
    }

    setConsumer(consumer: SpoolConsumer): void {
        this.ownership.setConsumer(consumer)
    }

    setWanted(wanted: boolean): void {
        this.ownership.setWanted(wanted)
    }

    takeOver(confirmed = false): HandOverResult {
        return this.ownership.takeOver(confirmed)
    }

    leaveTo(app: AppRef): HandOverResult {
        return this.ownership.leaveTo(app.key)
    }

    shutdown(): void {
        this.ownership.shutdown()
    }

    private notify(title: string, message: string): void {
        console.log(`[claude-status] ${title}: ${message}`)
        this.notifications?.info(message, title)
    }

    /**
     * NotificationsService takes no action, so a prompt goes to the toastr
     * behind it, and clicking the toast runs the action. It has no close
     * button: in ngx-toastr that button sits inside the element whose click
     * runs the action. Without the toastr, the notice says where the same
     * button is in Settings.
     */
    private prompt(prompt: SpoolPrompt): { close(): void } {
        console.log(`[claude-status] ${prompt.title}: ${prompt.message}`)
        const toastr = (this.notifications as any)?.toastr
        try {
            const toast = toastr?.info?.(
                `${prompt.message} Click here to ${lowerFirst(prompt.action)}.`,
                prompt.title,
                { timeOut: 60000, tapToDismiss: true, closeButton: false },
            )
            const tap = toast?.onTap?.subscribe?.(() => prompt.run())
            if (tap) {
                return {
                    close: () => {
                        tap.unsubscribe()
                        toastr.clear?.(toast.toastId)
                    },
                }
            }
            if (toast) toastr.clear?.(toast.toastId)
        } catch {
            /* fall back to a plain notice */
        }
        this.notifications?.info(
            `${prompt.message} ${prompt.action} from Settings → Claude Status.`,
            prompt.title,
        )
        return { close: () => undefined }
    }
}

function lowerFirst(text: string): string {
    return text ? text.charAt(0).toLowerCase() + text.slice(1) : text
}
