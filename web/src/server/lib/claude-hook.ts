interface SessionState {
	ancestors: number[];
	ppid?: number;
}

interface HookPayload {
	hook_event_name?: string;
	session_id?: string;
	tool_name?: string;
	notification_type?: string;
	ancestors?: number[];
	ppid?: number;
	[key: string]: unknown;
}

const sessionCache = new Map<string, SessionState>();

/**
 * Cache the session→ancestors mapping. We do NOT write
 * `%TEMP%/tabby-claude-status.json` here — that file belongs to
 * `tabby-claude-status/hook.js` and is read by the Tabby plugin's
 * fileWatcher. Having two writers (this server + the node hook) caused the
 * activity log to record 3 entries per real event when both fired in
 * sequence (Claude's http/curl hooks + the node hook all POSTed here),
 * each stamping a distinct `ts` and bypassing the decorator's
 * `data.ts <= lastFileTs` dedup.
 *
 * The server is now sink-only: it remembers ancestors so subsequent
 * curl-only events can still resolve a tab, but it does not impersonate
 * the Tabby plugin's IPC channel.
 */
export async function handleHookEvent(payload: HookPayload): Promise<void> {
	const session = payload.session_id ?? "";
	const ancestors = Array.isArray(payload.ancestors) ? payload.ancestors : [];
	const ppid = typeof payload.ppid === "number" ? payload.ppid : undefined;

	if (session) {
		const existing = sessionCache.get(session);
		sessionCache.set(session, {
			ancestors: ancestors.length ? ancestors : (existing?.ancestors ?? []),
			ppid: ppid ?? existing?.ppid,
		});
	}
}
