import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { deriveFromBuffer, type TabbyTabDerived } from "../lib/tabby-derive.js";
import {
	getTabbyMcpEndpoint,
	type TabbyListTabsEntry,
	type TabbySessionEntry,
	tabbyMcp,
} from "../lib/tabby-mcp-client.js";
import {
	deleteProfileSetting,
	getOpenDelayMs,
	type ProfileSetting,
	readProfileSettings,
	upsertProfileSetting,
} from "../lib/tabby-profile-settings.js";
import {
	addTab,
	createSession,
	deleteSession,
	deleteTab,
	getSession,
	listSessions,
	newSession,
	type StoredTab,
	type TabbySession,
	updateSession,
	updateTab,
} from "../lib/tabby-store.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

app.get("/health", async (c) => {
	const ok = await tabbyMcp.health();
	return c.json({ ok, endpoint: getTabbyMcpEndpoint() });
});

// ---------------------------------------------------------------------------
// Live — proxy to every tabby-mcp tool
// ---------------------------------------------------------------------------

// Generic escape hatch for any tool not named below (and for ad-hoc UI).
app.post("/mcp/:tool", async (c) => {
	const tool = c.req.param("tool");
	let args: Record<string, unknown> = {};
	try {
		const body = await c.req.json().catch(() => null);
		if (body && typeof body === "object") args = body as Record<string, unknown>;
	} catch {
		// empty body is fine
	}
	try {
		const result = await tabbyMcp.callTool(tool, args);
		return c.json({ ok: true, result });
	} catch (err) {
		return c.json({ ok: false, error: (err as Error).message }, 502);
	}
});

// ---- Tabs -----------------------------------------------------------------

app.get("/live/tabs", async (c) => c.json(await tabbyMcp.listTabs()));

app.post("/live/tabs/:tabId/select", async (c) =>
	c.json(await tabbyMcp.selectTab({ tabId: c.req.param("tabId") })),
);
app.post("/live/tabs/:tabId/close", async (c) =>
	c.json(await tabbyMcp.closeTab({ tabId: c.req.param("tabId") })),
);
app.post("/live/tabs/:tabId/duplicate", async (c) =>
	c.json(await tabbyMcp.duplicateTab({ tabId: c.req.param("tabId") })),
);
app.post("/live/tabs/:tabId/move-left", async (c) =>
	c.json(await tabbyMcp.moveTabLeft({ tabId: c.req.param("tabId") })),
);
app.post("/live/tabs/:tabId/move-right", async (c) =>
	c.json(await tabbyMcp.moveTabRight({ tabId: c.req.param("tabId") })),
);
app.post("/live/tabs/:tabId/split", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { direction?: string };
	return c.json(
		await tabbyMcp.splitTab({
			tabId: c.req.param("tabId"),
			direction: body.direction,
		}),
	);
});
app.post("/live/tabs/close-all", async (c) => c.json(await tabbyMcp.closeAllTabs()));
app.post("/live/tabs/next", async (c) => c.json(await tabbyMcp.nextTab()));
app.post("/live/tabs/previous", async (c) => c.json(await tabbyMcp.previousTab()));
app.post("/live/tabs/reopen-last", async (c) => c.json(await tabbyMcp.reopenLastTab()));
app.post("/live/tabs/:tabId/focus-pane", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		paneIndex: number;
	};
	return c.json(
		await tabbyMcp.focusPane({
			tabId: c.req.param("tabId"),
			paneIndex: body.paneIndex ?? 0,
		}),
	);
});

// ---- Sessions -------------------------------------------------------------

app.get("/live/sessions", async (c) => c.json(await tabbyMcp.getSessionList()));

/**
 * One-call enrichment: list tabs + list sessions + grab the scrollback tail
 * for every session and derive structured fields (cwd, branch, recap, etc.).
 * This is what the Tabby page leans on to render rich rows without N round
 * trips from the browser.
 */
app.get("/live/derived", async (c) => {
	// Reach far enough back to reliably include Claude Code's statusline — it's
	// redrawn continuously via cursor-positioning ANSI, so most of the lines
	// at the tail are tool output rather than the footer. 1200 lines covers
	// even very chatty sessions without being ridiculous.
	const lastN = Number(c.req.query("lastN") ?? "1200");
	const [tabsResp, sessions] = await Promise.all([tabbyMcp.listTabs(), tabbyMcp.getSessionList()]);
	const buffers = await Promise.allSettled(
		sessions.map((s) =>
			tabbyMcp.getTerminalBuffer({
				sessionId: s.sessionId,
				lastNLines: lastN,
			}),
		),
	);
	const rows = sessions.map((session, i) => {
		const tab = tabsResp.tabs.find((t) => t.tabIndex === session.tabIndex);
		const buf = buffers[i];
		const bufferTail = buf.status === "fulfilled" ? buf.value.content : undefined;
		const derived: TabbyTabDerived = bufferTail ? deriveFromBuffer(bufferTail) : {};
		return { tab, session, derived, bufferTail };
	});
	return c.json({ rows, capturedAt: new Date().toISOString() });
});

app.get("/live/sessions/:sessionId/buffer", async (c) => {
	const { lastN, startLine, endLine } = c.req.query();
	return c.json(
		await tabbyMcp.getTerminalBuffer({
			sessionId: c.req.param("sessionId"),
			lastNLines: lastN ? Number(lastN) : undefined,
			startLine: startLine ? Number(startLine) : undefined,
			endLine: endLine ? Number(endLine) : undefined,
		}),
	);
});
app.post("/live/sessions/:sessionId/input", async (c) => {
	const body = (await c.req.json()) as {
		text: string;
		addNewline?: boolean;
	};
	return c.json(
		await tabbyMcp.sendInput({
			sessionId: c.req.param("sessionId"),
			text: body.text,
			addNewline: body.addNewline,
		}),
	);
});
app.post("/live/sessions/:sessionId/exec", async (c) => {
	const body = (await c.req.json()) as {
		command: string;
		timeout?: number;
		waitForOutput?: boolean;
	};
	return c.json(
		await tabbyMcp.execCommand({
			sessionId: c.req.param("sessionId"),
			...body,
		}),
	);
});
app.post("/live/sessions/:sessionId/abort", async (c) =>
	c.json(await tabbyMcp.abortCommand({ sessionId: c.req.param("sessionId") })),
);
app.get("/live/sessions/:sessionId/command-status", async (c) =>
	c.json(await tabbyMcp.getCommandStatus({ sessionId: c.req.param("sessionId") })),
);

// ---- Profiles -------------------------------------------------------------

app.get("/live/profiles", async (c) => c.json(await tabbyMcp.listProfiles()));
app.post("/live/profiles/open", async (c) => {
	const body = (await c.req.json()) as {
		profileId?: string;
		profileName?: string;
	};
	return c.json(await tabbyMcp.openProfile(body));
});
app.post("/live/profiles/quick-connect", async (c) => {
	const body = (await c.req.json()) as { target: string };
	return c.json(await tabbyMcp.quickConnect(body));
});
app.post("/live/profiles/selector", async (c) => c.json(await tabbyMcp.showProfileSelector()));

// ---- SFTP (thin pass-throughs) --------------------------------------------

app.get("/live/sftp/ls", async (c) => {
	const { sessionId, path } = c.req.query();
	return c.json(await tabbyMcp.sftpListFiles({ sessionId, path: path ?? "" }));
});
app.post("/live/sftp/read", async (c) =>
	c.json(await tabbyMcp.sftpReadFile((await c.req.json()) as never)),
);
app.post("/live/sftp/write", async (c) =>
	c.json(await tabbyMcp.sftpWriteFile((await c.req.json()) as never)),
);
app.post("/live/sftp/upload", async (c) =>
	c.json(await tabbyMcp.sftpUpload((await c.req.json()) as never)),
);
app.post("/live/sftp/download", async (c) =>
	c.json(await tabbyMcp.sftpDownload((await c.req.json()) as never)),
);
app.delete("/live/sftp", async (c) =>
	c.json(await tabbyMcp.sftpDelete((await c.req.json()) as never)),
);
app.post("/live/sftp/mkdir", async (c) =>
	c.json(await tabbyMcp.sftpMkdir((await c.req.json()) as never)),
);
app.post("/live/sftp/rename", async (c) =>
	c.json(await tabbyMcp.sftpRename((await c.req.json()) as never)),
);
app.get("/live/sftp/stat", async (c) => {
	const { sessionId, path } = c.req.query();
	return c.json(await tabbyMcp.sftpStat({ sessionId, path: path ?? "" }));
});
app.get("/live/sftp/transfers", async (c) => {
	const { sessionId } = c.req.query();
	return c.json(await tabbyMcp.sftpListTransfers({ sessionId }));
});
app.get("/live/sftp/transfers/:transferId", async (c) =>
	c.json(
		await tabbyMcp.sftpGetTransferStatus({
			transferId: c.req.param("transferId"),
		}),
	),
);
app.post("/live/sftp/transfers/:transferId/cancel", async (c) =>
	c.json(
		await tabbyMcp.sftpCancelTransfer({
			transferId: c.req.param("transferId"),
		}),
	),
);

// ---------------------------------------------------------------------------
// Stored CRUD
// ---------------------------------------------------------------------------

app.get("/sessions", async (c) => c.json(await listSessions()));

app.get("/sessions/:id", async (c) => {
	const session = await getSession(c.req.param("id"));
	if (!session) return c.json({ error: "Not found" }, 404);
	return c.json(session);
});

app.post("/sessions", async (c) => {
	const body = (await c.req.json()) as {
		name: string;
		comment?: string;
		tags?: string[];
		tabs?: StoredTab[];
	};
	if (!body.name) return c.json({ error: "name is required" }, 400);
	const session = newSession(body);
	await createSession(session);
	return c.json(session, 201);
});

app.put("/sessions/:id", async (c) => {
	try {
		const body = (await c.req.json()) as Partial<TabbySession>;
		const session = await updateSession(c.req.param("id"), body);
		return c.json(session);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 404);
	}
});

app.delete("/sessions/:id", async (c) => {
	try {
		await deleteSession(c.req.param("id"));
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ error: (err as Error).message }, 404);
	}
});

app.post("/sessions/:id/tabs", async (c) => {
	try {
		const body = (await c.req.json()) as Omit<StoredTab, "id" | "order"> & {
			id?: string;
			order?: number;
		};
		const session = await addTab(c.req.param("id"), body);
		return c.json(session);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 404);
	}
});

app.put("/sessions/:id/tabs/:tabId", async (c) => {
	try {
		const body = (await c.req.json()) as Partial<StoredTab>;
		const session = await updateTab(c.req.param("id"), c.req.param("tabId"), body);
		return c.json(session);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 404);
	}
});

app.delete("/sessions/:id/tabs/:tabId", async (c) => {
	try {
		const session = await deleteTab(c.req.param("id"), c.req.param("tabId"));
		return c.json(session);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 404);
	}
});

// ---------------------------------------------------------------------------
// High-level actions
// ---------------------------------------------------------------------------

app.post("/snapshot", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		name?: string;
		comment?: string;
		tags?: string[];
		bufferLines?: number;
	};
	const name = body.name ?? new Date().toISOString();
	const bufferLines = body.bufferLines ?? 400;

	const [tabsResp, sessions] = await Promise.all([tabbyMcp.listTabs(), tabbyMcp.getSessionList()]);
	const tabs = tabsResp.tabs;

	const buffers = await Promise.allSettled(
		sessions.map((s) =>
			tabbyMcp.getTerminalBuffer({
				sessionId: s.sessionId,
				lastNLines: bufferLines,
			}),
		),
	);

	const storedTabs: StoredTab[] = sessions.map((s, i) => {
		const listTabsEntry = tabs.find((t) => t.tabIndex === s.tabIndex);
		const buf = buffers[i];
		const bufferTail = buf.status === "fulfilled" ? buf.value.content : undefined;
		const derived = bufferTail ? deriveFromBuffer(bufferTail) : undefined;
		// Claude Code sessions get a sensible default restore command so the
		// user doesn't have to type it for every tab. `ccr` is the user's
		// alias for `claude --resume` (see ~/.bashrc / ~/.zshrc).
		const autoCommand = derived?.claudeSessionId ? `ccr ${derived.claudeSessionId}` : undefined;
		return {
			id: randomUUID(),
			order: i,
			title: listTabsEntry?.title ?? s.title,
			color: listTabsEntry?.color ?? undefined,

			profileId: s.profile.id,
			profileName: s.profile.name,
			profileType: s.profile.type,

			cwd: derived?.cwd,
			command: autoCommand,

			isSplit: s.isSplit,
			splitTabIndex: s.splitTabIndex,
			paneIndex: s.paneIndex,
			totalPanes: s.totalPanes,

			derived,
			raw: {
				listTabsEntry,
				sessionListEntry: s,
				bufferTail,
				capturedAt: new Date().toISOString(),
			},
		};
	});

	const session = newSession({
		name,
		comment: body.comment,
		tags: body.tags ?? [],
		tabs: storedTabs,
	});
	await createSession(session);
	return c.json(session, 201);
});

/**
 * Open a profile, then wait up to 2s for a new session under that profileId
 * to appear in get_session_list. Returns the new sessionId or null.
 */
async function openProfileAndAwaitSession(
	profileId: string,
	before: Set<string>,
): Promise<string | null> {
	await tabbyMcp.openProfile({ profileId });
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 150));
		const sessions = await tabbyMcp.getSessionList();
		const fresh = sessions.find((s) => s.profile.id === profileId && !before.has(s.sessionId));
		if (fresh) return fresh.sessionId;
	}
	return null;
}

async function restoreOneTab(tab: StoredTab): Promise<{
	ok: boolean;
	sessionId?: string;
	error?: string;
}> {
	try {
		const existing = await tabbyMcp.getSessionList();
		const before = new Set(existing.map((s) => s.sessionId));
		const sessionId = await openProfileAndAwaitSession(tab.profileId, before);
		if (!sessionId) {
			return { ok: false, error: "timed out waiting for new session" };
		}
		// Fall back to `ccr <claudeSessionId>` if the user didn't set a command
		// but we detected a Claude Code session at capture time.
		const command =
			tab.command ??
			(tab.derived?.claudeSessionId ? `ccr ${tab.derived.claudeSessionId}` : undefined);
		const cwd = tab.cwd ?? tab.derived?.cwd;
		const parts: string[] = [];
		if (cwd) parts.push(`cd ${shellQuote(cwd)}`);
		if (command) parts.push(command);
		if (parts.length) {
			// Shell startup (WSL boot, oh-my-zsh, etc.) takes time after the
			// session object exists. Per-profile configurable — see
			// /api/tabby/profile-settings.
			const delayMs = await getOpenDelayMs(tab.profileId);
			if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
			await tabbyMcp.sendInput({
				sessionId,
				text: parts.join(" && "),
				addNewline: true,
			});
		}
		return { ok: true, sessionId };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

function shellQuote(p: string): string {
	if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(p)) return p;
	return `'${p.replace(/'/g, "'\\''")}'`;
}

app.post("/sessions/:id/restore", async (c) => {
	const session = await getSession(c.req.param("id"));
	if (!session) return c.json({ error: "Not found" }, 404);
	const results: Array<{
		tabId: string;
		ok: boolean;
		sessionId?: string;
		error?: string;
	}> = [];
	for (const tab of [...session.tabs].sort((a, b) => a.order - b.order)) {
		const r = await restoreOneTab(tab);
		results.push({ tabId: tab.id, ...r });
	}
	return c.json({ ok: results.every((r) => r.ok), results });
});

app.post("/sessions/:id/tabs/:tabId/restore", async (c) => {
	const session = await getSession(c.req.param("id"));
	if (!session) return c.json({ error: "Session not found" }, 404);
	const tab = session.tabs.find((t) => t.id === c.req.param("tabId"));
	if (!tab) return c.json({ error: "Tab not found" }, 404);
	const r = await restoreOneTab(tab);
	return c.json({ ok: r.ok, result: r });
});

app.post("/restore-bulk", async (c) => {
	const body = (await c.req.json()) as {
		items: Array<{ sessionId: string; tabId: string }>;
	};
	if (!Array.isArray(body.items)) {
		return c.json({ error: "items[] required" }, 400);
	}
	const results: Array<{
		sessionId: string;
		tabId: string;
		ok: boolean;
		newSessionId?: string;
		error?: string;
	}> = [];
	for (const item of body.items) {
		const session = await getSession(item.sessionId);
		if (!session) {
			results.push({ ...item, ok: false, error: "session missing" });
			continue;
		}
		const tab = session.tabs.find((t) => t.id === item.tabId);
		if (!tab) {
			results.push({ ...item, ok: false, error: "tab missing" });
			continue;
		}
		const r = await restoreOneTab(tab);
		results.push({
			...item,
			ok: r.ok,
			newSessionId: r.sessionId,
			error: r.error,
		});
	}
	return c.json({ ok: results.every((r) => r.ok), results });
});

// ---------------------------------------------------------------------------
// Profile settings
// ---------------------------------------------------------------------------

app.get("/profile-settings", async (c) => c.json(await readProfileSettings()));

app.put("/profile-settings/:profileId", async (c) => {
	const body = (await c.req.json()) as ProfileSetting;
	const settings = await upsertProfileSetting(c.req.param("profileId"), body);
	return c.json(settings);
});

app.delete("/profile-settings/:profileId", async (c) => {
	const settings = await deleteProfileSetting(c.req.param("profileId"));
	return c.json(settings);
});

export default app;

// Unused import protection — these types are re-exported for the page.
export type { TabbyListTabsEntry, TabbySessionEntry };
