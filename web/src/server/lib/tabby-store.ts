import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDataDir } from "./data-dir.js";
import type { TabbyTabDerived } from "./tabby-derive.js";

export interface StoredTabRaw {
	listTabsEntry?: unknown;
	sessionListEntry?: unknown;
	bufferTail?: string;
	capturedAt: string;
}

export interface StoredTab {
	id: string;
	order: number;
	title: string;
	color?: string | null;

	profileId: string;
	profileName: string;
	profileType: string;

	cwd?: string;
	command?: string;
	comment?: string;

	isSplit: boolean;
	splitTabIndex?: number;
	paneIndex?: number;
	totalPanes?: number;

	derived?: TabbyTabDerived;
	raw: StoredTabRaw;
}

export interface TabbySession {
	id: string;
	name: string;
	comment?: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	tabs: StoredTab[];
}

export interface TabbyStoreFile {
	version: 1;
	sessions: TabbySession[];
}

const EMPTY_STORE: TabbyStoreFile = { version: 1, sessions: [] };

function storePath(): string {
	return resolve(getDataDir(), "tabby-sessions.json");
}

export async function readTabbyStore(): Promise<TabbyStoreFile> {
	try {
		const raw = await readFile(storePath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<TabbyStoreFile>;
		return {
			version: 1,
			sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return { ...EMPTY_STORE };
		throw err;
	}
}

export async function writeTabbyStore(store: TabbyStoreFile): Promise<void> {
	const path = storePath();
	const tmp = `${path}.tmp`;
	await writeFile(tmp, `${JSON.stringify(store, null, "\t")}\n`, "utf-8");
	await rename(tmp, path);
}

function now(): string {
	return new Date().toISOString();
}

export function newSession(input: {
	name: string;
	comment?: string;
	tags?: string[];
	tabs?: StoredTab[];
}): TabbySession {
	const t = now();
	return {
		id: randomUUID(),
		name: input.name,
		comment: input.comment,
		tags: input.tags ?? [],
		createdAt: t,
		updatedAt: t,
		tabs: (input.tabs ?? []).map((tab, i) => ({
			...tab,
			id: tab.id && tab.id.length > 0 ? tab.id : randomUUID(),
			order: tab.order ?? i,
		})),
	};
}

export async function listSessions(): Promise<TabbySession[]> {
	const store = await readTabbyStore();
	return store.sessions;
}

export async function getSession(id: string): Promise<TabbySession | null> {
	const store = await readTabbyStore();
	return store.sessions.find((s) => s.id === id) ?? null;
}

export async function createSession(
	session: TabbySession,
): Promise<TabbySession> {
	const store = await readTabbyStore();
	store.sessions.unshift(session);
	await writeTabbyStore(store);
	return session;
}

export async function updateSession(
	id: string,
	patch: Partial<Pick<TabbySession, "name" | "comment" | "tags" | "tabs">>,
): Promise<TabbySession> {
	const store = await readTabbyStore();
	const idx = store.sessions.findIndex((s) => s.id === id);
	if (idx === -1) throw new Error(`Session ${id} not found`);
	const existing = store.sessions[idx];
	const merged: TabbySession = {
		...existing,
		...patch,
		tabs: patch.tabs ?? existing.tabs,
		updatedAt: now(),
	};
	store.sessions[idx] = merged;
	await writeTabbyStore(store);
	return merged;
}

export async function deleteSession(id: string): Promise<void> {
	const store = await readTabbyStore();
	const next = store.sessions.filter((s) => s.id !== id);
	if (next.length === store.sessions.length) {
		throw new Error(`Session ${id} not found`);
	}
	store.sessions = next;
	await writeTabbyStore(store);
}

export async function addTab(
	sessionId: string,
	tab: Omit<StoredTab, "id" | "order"> & { id?: string; order?: number },
): Promise<TabbySession> {
	const store = await readTabbyStore();
	const session = store.sessions.find((s) => s.id === sessionId);
	if (!session) throw new Error(`Session ${sessionId} not found`);
	const full: StoredTab = {
		...tab,
		id: tab.id ?? randomUUID(),
		order: tab.order ?? session.tabs.length,
	};
	session.tabs.push(full);
	session.updatedAt = now();
	await writeTabbyStore(store);
	return session;
}

export async function updateTab(
	sessionId: string,
	tabId: string,
	patch: Partial<StoredTab>,
): Promise<TabbySession> {
	const store = await readTabbyStore();
	const session = store.sessions.find((s) => s.id === sessionId);
	if (!session) throw new Error(`Session ${sessionId} not found`);
	const idx = session.tabs.findIndex((t) => t.id === tabId);
	if (idx === -1) throw new Error(`Tab ${tabId} not found`);
	session.tabs[idx] = {
		...session.tabs[idx],
		...patch,
		id: session.tabs[idx].id,
	};
	session.updatedAt = now();
	await writeTabbyStore(store);
	return session;
}

export async function deleteTab(
	sessionId: string,
	tabId: string,
): Promise<TabbySession> {
	const store = await readTabbyStore();
	const session = store.sessions.find((s) => s.id === sessionId);
	if (!session) throw new Error(`Session ${sessionId} not found`);
	const before = session.tabs.length;
	session.tabs = session.tabs.filter((t) => t.id !== tabId);
	if (session.tabs.length === before) {
		throw new Error(`Tab ${tabId} not found`);
	}
	session.updatedAt = now();
	await writeTabbyStore(store);
	return session;
}
