import { formatDistanceToNow } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SearchInput } from "../components/SearchInput";
import { useCachedEndpoint } from "../hooks/useCachedEndpoint";
import { useStore } from "../store";

interface LiveTab {
	tabId: string;
	tabIndex: number;
	title: string;
	type: string;
	isActive: boolean;
	hasFocus: boolean;
	color: string | null;
	isTerminal: boolean;
}

interface LiveSession {
	sessionId: string;
	tabIndex: number;
	title: string;
	profile: { id: string; name: string; type: string };
	isSplit: boolean;
	paneIndex: number;
	totalPanes: number;
}

interface TabbyTabDerived {
	cwd?: string;
	branch?: string;
	baseBranch?: string;
	diffStats?: string;
	claudeSessionId?: string;
	model?: string;
	mode?: string;
	contextUsage?: string;
	sessionAge?: string;
	usagePct?: string[];
	skills?: string[];
	projectName?: string;
	recap?: string;
	recentUserTurn?: string;
	recentAssistantTurn?: string;
	prNumbers?: string[];
	commitShas?: string[];
}

interface LiveDerivedRow {
	tab?: LiveTab;
	session: LiveSession;
	derived: TabbyTabDerived;
	bufferTail?: string;
}

interface LiveDerivedResponse {
	rows: LiveDerivedRow[];
	capturedAt: string;
}

interface Profile {
	profileId: string;
	name: string;
	type: string;
	icon?: string;
}

interface ProfilesResponse {
	profiles: Profile[];
	success?: boolean;
}

type LiveSortKey = "tabIndex" | "title" | "profile" | "branch";
type StoredSortKey = "updatedAt-desc" | "createdAt-desc" | "name-asc" | "tabCount-desc";

interface DisplayOptions {
	profileIcon: boolean;
	colorDot: boolean;
	profileName: boolean;
	sessionId: boolean;
	cwdBranch: boolean;
	skills: boolean;
	modelMode: boolean;
	contextUsage: boolean;
	sessionAge: boolean;
	usagePct: boolean;
	recap: boolean;
	userTurn: boolean;
	assistantTurn: boolean;
	prs: boolean;
	shas: boolean;
	manualCwd: boolean;
	manualCommand: boolean;
	bufferButton: boolean;
}

interface DisplayGroup {
	name: string;
	fields: Array<[keyof DisplayOptions, string]>;
}

const DISPLAY_GROUPS: DisplayGroup[] = [
	{
		name: "Tab",
		fields: [
			["profileIcon", "Profile icon"],
			["colorDot", "Color dot"],
			["profileName", "Profile name"],
		],
	},
	{
		name: "Project",
		fields: [["cwdBranch", "cwd · branch · diff"]],
	},
	{
		name: "Claude Code",
		fields: [
			["sessionId", "Claude Code Session ID"],
			["skills", "Skills"],
			["modelMode", "Model · mode"],
			["contextUsage", "Context usage"],
			["sessionAge", "Session age"],
			["usagePct", "Usage %"],
		],
	},
	{
		name: "Conversation",
		fields: [
			["recap", "Recap"],
			["userTurn", "Last user turn"],
			["assistantTurn", "Last assistant turn"],
		],
	},
	{
		name: "References",
		fields: [
			["prs", "PR numbers"],
			["shas", "Commit SHAs"],
		],
	},
	{
		name: "Stored overrides",
		fields: [
			["manualCwd", "Stored cwd"],
			["manualCommand", "Stored command"],
		],
	},
	{
		name: "Advanced",
		fields: [["bufferButton", "Buffer tail button"]],
	},
];

const DISPLAY_FIELDS: Array<[keyof DisplayOptions, string]> = DISPLAY_GROUPS.flatMap(
	(g) => g.fields,
);

const DEFAULT_DISPLAY: DisplayOptions = {
	profileIcon: true,
	colorDot: true,
	profileName: true,
	sessionId: true,
	cwdBranch: true,
	skills: true,
	modelMode: false,
	contextUsage: false,
	sessionAge: false,
	usagePct: false,
	recap: true,
	userTurn: true,
	assistantTurn: true,
	prs: true,
	shas: false,
	manualCwd: true,
	manualCommand: true,
	bufferButton: true,
};

const DISPLAY_STORAGE_KEY = "tabby:display-options";

function loadDisplayOptions(): DisplayOptions {
	if (typeof window === "undefined") return DEFAULT_DISPLAY;
	try {
		const raw = window.localStorage.getItem(DISPLAY_STORAGE_KEY);
		if (!raw) return DEFAULT_DISPLAY;
		const parsed = JSON.parse(raw) as Partial<DisplayOptions>;
		return { ...DEFAULT_DISPLAY, ...parsed };
	} catch {
		return DEFAULT_DISPLAY;
	}
}

interface StoredTab {
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
	raw: { bufferTail?: string; capturedAt: string };
}

interface StoredSession {
	id: string;
	name: string;
	comment?: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	tabs: StoredTab[];
}

async function jfetch<T>(
	url: string,
	init?: RequestInit,
): Promise<{ ok: boolean; data?: T; error?: string }> {
	try {
		const res = await fetch(url, {
			...init,
			headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
		});
		const data = (await res.json().catch(() => null)) as T | { error?: string };
		if (!res.ok) {
			return {
				ok: false,
				error: (data as { error?: string })?.error ?? `HTTP ${res.status}`,
			};
		}
		return { ok: true, data: data as T };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

export function TabbyPage() {
	const invalidate = useStore((s) => s.invalidate);
	const stored = useCachedEndpoint<StoredSession[]>("tabby-sessions", "/api/tabby/sessions", {
		staleAfter: 30_000,
	});
	const live = useCachedEndpoint<LiveDerivedResponse>(
		"tabby-live-derived",
		"/api/tabby/live/derived",
		{ staleAfter: 30_000 },
	);
	const profiles = useCachedEndpoint<ProfilesResponse>(
		"tabby-profiles",
		"/api/tabby/live/profiles",
		{ staleAfter: 3_600_000 },
	);
	const health = useCachedEndpoint<{ ok: boolean; endpoint: string }>(
		"tabby-health",
		"/api/tabby/health",
		{ staleAfter: 60_000 },
	);

	const profileMap = useMemo(() => {
		const map = new Map<string, Profile>();
		for (const p of profiles.data?.profiles ?? []) map.set(p.profileId, p);
		return map;
	}, [profiles.data]);

	const [selection, setSelection] = useState<Set<string>>(() => new Set());
	const [query, setQuery] = useState("");
	const [profileFilter, setProfileFilter] = useState<Set<string>>(new Set());
	const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
	const [liveSort, setLiveSort] = useState<LiveSortKey>("tabIndex");
	const [storedSort, setStoredSort] = useState<StoredSortKey>("updatedAt-desc");
	const [view, setView] = useState<"live" | "stored" | "profiles">("live");
	const [display, setDisplayState] = useState<DisplayOptions>(() => loadDisplayOptions());
	const setDisplay = useCallback((next: DisplayOptions) => {
		setDisplayState(next);
		try {
			window.localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(next));
		} catch {
			// localStorage disabled — keep in-memory state only
		}
	}, []);

	const refreshAll = useCallback(() => {
		invalidate("tabby-sessions");
		invalidate("tabby-live-derived");
		invalidate("tabby-profiles");
		invalidate("tabby-health");
		stored.refresh();
		live.refresh();
		profiles.refresh();
		health.refresh();
	}, [invalidate, stored, live, profiles, health]);

	// --- Filters pulled across both panels --------------------------------
	const usedProfileIds = useMemo(() => {
		const set = new Set<string>();
		for (const r of live.data?.rows ?? []) set.add(r.session.profile.id);
		for (const s of stored.data ?? []) for (const t of s.tabs) set.add(t.profileId);
		return set;
	}, [live.data, stored.data]);
	const usedTags = useMemo(() => {
		const set = new Set<string>();
		for (const s of stored.data ?? []) for (const t of s.tags) set.add(t);
		return [...set].sort();
	}, [stored.data]);

	const filteredLive = useMemo(() => {
		const rows = (live.data?.rows ?? []).filter((r) => {
			if (profileFilter.size && !profileFilter.has(r.session.profile.id)) return false;
			return matchQuery(query, [
				r.tab?.title,
				r.session.profile.name,
				r.derived?.cwd,
				r.derived?.branch,
				r.derived?.recap,
				r.derived?.recentUserTurn,
				r.derived?.recentAssistantTurn,
			]);
		});
		return sortLive(rows, liveSort);
	}, [live.data, liveSort, query, profileFilter]);

	const filteredStored = useMemo(() => {
		const sessions = (stored.data ?? []).filter((s) => {
			if (tagFilter.size && !s.tags.some((t) => tagFilter.has(t))) return false;
			if (profileFilter.size && !s.tabs.some((t) => profileFilter.has(t.profileId))) return false;
			if (!query) return true;
			if (
				matchQuery(query, [s.name, s.comment, ...s.tags]) ||
				s.tabs.some((t) =>
					matchQuery(query, [
						t.title,
						t.profileName,
						t.comment,
						t.cwd,
						t.command,
						t.derived?.cwd,
						t.derived?.branch,
						t.derived?.recap,
						t.derived?.recentUserTurn,
						t.derived?.recentAssistantTurn,
					]),
				)
			)
				return true;
			return false;
		});
		return sortStored(sessions, storedSort);
	}, [stored.data, storedSort, query, profileFilter, tagFilter]);

	const sessionsByTag = useMemo(() => {
		const groups = new Map<string, StoredSession[]>();
		for (const s of filteredStored) {
			const tags = s.tags.length ? s.tags : ["(untagged)"];
			for (const tag of tags) {
				if (!groups.has(tag)) groups.set(tag, []);
				groups.get(tag)?.push(s);
			}
		}
		return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [filteredStored]);

	function toggleIn(set: Set<string>, value: string): Set<string> {
		const next = new Set(set);
		if (next.has(value)) next.delete(value);
		else next.add(value);
		return next;
	}

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-center justify-between gap-2 flex-wrap">
				<div>
					<h1 className="text-2xl font-bold">Tabby</h1>
					<p className="text-sm text-[var(--muted)]">
						Live + stored Tabby sessions ·{" "}
						<span className={health.data?.ok ? "text-[var(--success)]" : "text-[var(--danger)]"}>
							{health.data?.ok ? "MCP connected" : "MCP offline"}
						</span>
						{health.data ? ` (${health.data.endpoint})` : ""}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Link
						to="/tabby/mcp"
						className="px-3 py-1.5 rounded text-sm border border-[var(--border)] text-[var(--text)] hover:bg-[var(--border)]"
					>
						MCP tools →
					</Link>
					<button
						type="button"
						onClick={refreshAll}
						className="px-3 py-1.5 rounded text-sm border border-[var(--border)] text-[var(--text)] hover:bg-[var(--border)]"
					>
						Refresh
					</button>
				</div>
			</header>

			<ViewTabs
				view={view}
				setView={setView}
				liveCount={live.data?.rows.length ?? 0}
				storedCount={stored.data?.length ?? 0}
				profilesCount={profileMap.size}
			/>

			<Toolbar
				query={query}
				setQuery={setQuery}
				profileMap={profileMap}
				usedProfileIds={usedProfileIds}
				profileFilter={profileFilter}
				toggleProfile={(id) => setProfileFilter((s) => toggleIn(s, id))}
				usedTags={usedTags}
				tagFilter={tagFilter}
				toggleTag={(t) => setTagFilter((s) => toggleIn(s, t))}
				display={display}
				setDisplay={setDisplay}
				showTagFilter={view === "stored"}
				clearFilters={() => {
					setQuery("");
					setProfileFilter(new Set());
					setTagFilter(new Set());
				}}
			/>

			{view === "live" && (
				<LivePanel
					rows={filteredLive}
					totalRows={live.data?.rows.length ?? 0}
					loading={live.loading}
					profileMap={profileMap}
					display={display}
					sortKey={liveSort}
					setSortKey={setLiveSort}
					onSnapshot={(newSession) => {
						// Optimistically drop the fresh session into the Zustand cache
						// so the Stored tab shows it instantly instead of waiting for
						// the /sessions refetch to complete.
						const state = useStore.getState();
						const current = (state.cache["tabby-sessions"]?.data as StoredSession[] | null) ?? [];
						useStore.setState({
							cache: {
								...state.cache,
								"tabby-sessions": {
									data: [newSession, ...current.filter((s) => s.id !== newSession.id)],
									fetchedAt: Date.now(),
									loading: false,
								},
							},
						});
						// Sync live data (tabs haven't moved but buffer contents may
						// have drifted) and switch to the Stored tab.
						invalidate("tabby-live-derived");
						live.refresh();
						setView("stored");
					}}
				/>
			)}
			{view === "stored" && (
				<StoredPanel
					groups={sessionsByTag}
					totalSessions={stored.data?.length ?? 0}
					filteredCount={filteredStored.length}
					hasLoaded={stored.data != null}
					loading={stored.loading}
					profileMap={profileMap}
					display={display}
					selection={selection}
					setSelection={setSelection}
					sortKey={storedSort}
					setSortKey={setStoredSort}
					onChange={refreshAll}
				/>
			)}
			{view === "profiles" && <ProfilesPanel profileMap={profileMap} query={query} />}

			{selection.size > 0 && (
				<BulkBar
					selection={selection}
					sessions={stored.data ?? []}
					onClear={() => setSelection(new Set())}
					onRestored={refreshAll}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

function matchQuery(q: string, fields: Array<string | undefined | null>): boolean {
	const needle = q.trim().toLowerCase();
	if (!needle) return true;
	for (const f of fields) {
		if (f?.toLowerCase().includes(needle)) return true;
	}
	return false;
}

function sortLive(rows: LiveDerivedRow[], key: LiveSortKey): LiveDerivedRow[] {
	const out = [...rows];
	out.sort((a, b) => {
		switch (key) {
			case "title":
				return (a.tab?.title ?? "").localeCompare(b.tab?.title ?? "");
			case "profile":
				return a.session.profile.name.localeCompare(b.session.profile.name);
			case "branch":
				return (a.derived?.branch ?? "").localeCompare(b.derived?.branch ?? "");
			default:
				return a.session.tabIndex - b.session.tabIndex;
		}
	});
	return out;
}

function sortStored(sessions: StoredSession[], key: StoredSortKey): StoredSession[] {
	const out = [...sessions];
	out.sort((a, b) => {
		switch (key) {
			case "createdAt-desc":
				return b.createdAt.localeCompare(a.createdAt);
			case "name-asc":
				return a.name.localeCompare(b.name);
			case "tabCount-desc":
				return b.tabs.length - a.tabs.length;
			default:
				return b.updatedAt.localeCompare(a.updatedAt);
		}
	});
	return out;
}

// ---------------------------------------------------------------------------
// View tabs
// ---------------------------------------------------------------------------

function ViewTabs({
	view,
	setView,
	liveCount,
	storedCount,
	profilesCount,
}: {
	view: "live" | "stored" | "profiles";
	setView: (v: "live" | "stored" | "profiles") => void;
	liveCount: number;
	storedCount: number;
	profilesCount: number;
}) {
	const tabClass = (active: boolean) =>
		`px-3 py-1.5 rounded-t text-sm font-medium border-b-2 ${
			active
				? "border-[var(--accent)] text-[var(--text)]"
				: "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
		}`;
	return (
		<div className="flex items-center gap-1 border-b border-[var(--border)]">
			<button type="button" onClick={() => setView("live")} className={tabClass(view === "live")}>
				Live <span className="text-xs opacity-70">({liveCount})</span>
			</button>
			<button
				type="button"
				onClick={() => setView("stored")}
				className={tabClass(view === "stored")}
			>
				Stored <span className="text-xs opacity-70">({storedCount})</span>
			</button>
			<button
				type="button"
				onClick={() => setView("profiles")}
				className={tabClass(view === "profiles")}
			>
				Profiles <span className="text-xs opacity-70">({profilesCount})</span>
			</button>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function Toolbar({
	query,
	setQuery,
	profileMap,
	usedProfileIds,
	profileFilter,
	toggleProfile,
	usedTags,
	tagFilter,
	toggleTag,
	display,
	setDisplay,
	showTagFilter,
	clearFilters,
}: {
	query: string;
	setQuery: (v: string) => void;
	profileMap: Map<string, Profile>;
	usedProfileIds: Set<string>;
	profileFilter: Set<string>;
	toggleProfile: (id: string) => void;
	usedTags: string[];
	tagFilter: Set<string>;
	toggleTag: (t: string) => void;
	display: DisplayOptions;
	setDisplay: (d: DisplayOptions) => void;
	showTagFilter: boolean;
	clearFilters: () => void;
}) {
	const profileChips = [...usedProfileIds]
		.map((id) => profileMap.get(id) ?? ({ profileId: id, name: id, type: "" } as Profile))
		.sort((a, b) => a.name.localeCompare(b.name));
	const hasAnyFilter = query !== "" || profileFilter.size > 0 || tagFilter.size > 0;

	return (
		<div className="border border-[var(--border)] rounded-lg p-3 bg-[var(--card)] flex flex-col gap-2">
			<div className="flex items-center gap-2 flex-wrap">
				<SearchInput
					name="tabby"
					value={query}
					onChange={setQuery}
					placeholder="Search titles, paths, branches, recaps, comments, tags…"
					className="flex-1 min-w-[240px]"
					inputClassName="w-full pl-2 pr-8 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--muted)]"
				/>
				<DisplayMenu display={display} setDisplay={setDisplay} />
				{hasAnyFilter && (
					<button
						type="button"
						onClick={clearFilters}
						className="px-2 py-1 rounded text-xs border border-[var(--border)] hover:bg-[var(--border)]"
					>
						Clear
					</button>
				)}
			</div>
			{profileChips.length > 0 && (
				<div className="flex items-center gap-1.5 flex-wrap">
					<span className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)] mr-1">
						Profile
					</span>
					{profileChips.map((p) => {
						const active = profileFilter.has(p.profileId);
						return (
							<button
								type="button"
								key={p.profileId}
								onClick={() => toggleProfile(p.profileId)}
								className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border ${
									active
										? "bg-[var(--accent)] text-white border-[var(--accent)]"
										: "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--border)]"
								}`}
							>
								<ProfileIcon profile={p} size={12} />
								<span>{p.name}</span>
							</button>
						);
					})}
				</div>
			)}
			{showTagFilter && usedTags.length > 0 && (
				<div className="flex items-center gap-1.5 flex-wrap">
					<span className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)] mr-1">
						Tag
					</span>
					{usedTags.map((tag) => {
						const active = tagFilter.has(tag);
						return (
							<button
								type="button"
								key={tag}
								onClick={() => toggleTag(tag)}
								className={`px-2 py-0.5 rounded text-xs border ${
									active
										? "bg-[var(--accent)] text-white border-[var(--accent)]"
										: "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--border)]"
								}`}
							>
								{tag}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Display dropdown
// ---------------------------------------------------------------------------

function DisplayMenu({
	display,
	setDisplay,
}: {
	display: DisplayOptions;
	setDisplay: (d: DisplayOptions) => void;
}) {
	const hiddenCount = DISPLAY_FIELDS.filter(([k]) => !display[k]).length;
	return (
		<details className="relative">
			<summary className="list-none cursor-pointer px-2 py-1 rounded text-xs border border-[var(--border)] hover:bg-[var(--border)] flex items-center gap-1.5">
				<span>Display</span>
				{hiddenCount > 0 && <span className="text-[10px] opacity-70">({hiddenCount} hidden)</span>}
				<span className="opacity-60">▾</span>
			</summary>
			<div className="absolute right-0 mt-1 z-10 min-w-[240px] border border-[var(--border)] rounded bg-[var(--card)] shadow-lg p-2 flex flex-col gap-1.5">
				{DISPLAY_GROUPS.map((group) => (
					<DisplayGroupToggles
						key={group.name}
						group={group}
						display={display}
						setDisplay={setDisplay}
					/>
				))}
				<div className="flex items-center gap-1 mt-1 pt-1 border-t border-[var(--border)]">
					<button
						type="button"
						onClick={() => setDisplay(DEFAULT_DISPLAY)}
						className="flex-1 px-2 py-1 rounded text-[11px] border border-[var(--border)] hover:bg-[var(--border)]"
					>
						Reset
					</button>
					<button
						type="button"
						onClick={() =>
							setDisplay(
								Object.fromEntries(
									DISPLAY_FIELDS.map(([k]) => [k, true]),
								) as unknown as DisplayOptions,
							)
						}
						className="flex-1 px-2 py-1 rounded text-[11px] border border-[var(--border)] hover:bg-[var(--border)]"
					>
						Show all
					</button>
					<button
						type="button"
						onClick={() =>
							setDisplay(
								Object.fromEntries(
									DISPLAY_FIELDS.map(([k]) => [k, false]),
								) as unknown as DisplayOptions,
							)
						}
						className="flex-1 px-2 py-1 rounded text-[11px] border border-[var(--border)] hover:bg-[var(--border)]"
					>
						Hide all
					</button>
				</div>
			</div>
		</details>
	);
}

function DisplayGroupToggles({
	group,
	display,
	setDisplay,
}: {
	group: DisplayGroup;
	display: DisplayOptions;
	setDisplay: (d: DisplayOptions) => void;
}) {
	const masterRef = useRef<HTMLInputElement>(null);
	const states = group.fields.map(([k]) => display[k]);
	const allOn = states.every(Boolean);
	const allOff = states.every((s) => !s);
	const mixed = !allOn && !allOff;

	useEffect(() => {
		if (masterRef.current) masterRef.current.indeterminate = mixed;
	}, [mixed]);

	function toggleAll() {
		const target = !allOn;
		const next = { ...display };
		for (const [k] of group.fields) next[k] = target;
		setDisplay(next);
	}

	return (
		<div className="flex flex-col gap-0.5">
			<label className="flex items-center gap-2 px-1.5 py-0.5 rounded hover:bg-[var(--border)] cursor-pointer">
				<input ref={masterRef} type="checkbox" checked={allOn} onChange={toggleAll} />
				<span className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">
					{group.name}
				</span>
			</label>
			<div className="pl-4 flex flex-col gap-0.5">
				{group.fields.map(([key, label]) => (
					<label
						key={key}
						className="flex items-center gap-2 px-1.5 py-1 rounded text-xs hover:bg-[var(--border)] cursor-pointer"
					>
						<input
							type="checkbox"
							checked={display[key]}
							onChange={(e) => setDisplay({ ...display, [key]: e.target.checked })}
						/>
						<span>{label}</span>
					</label>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Profile icon
// ---------------------------------------------------------------------------

function ProfileIcon({ profile, size = 16 }: { profile?: Profile; size?: number }) {
	if (!profile?.icon) {
		return (
			<span
				className="inline-block rounded-sm bg-[var(--border)]"
				style={{ width: size, height: size }}
				title={profile?.name}
			/>
		);
	}
	const icon = profile.icon.trim();
	const isSvg = icon.startsWith("<svg") || icon.startsWith("<?xml");
	if (isSvg) {
		return (
			// SVG icons are shipped inline by tabby-mcp; rendering as-is is safe
			// because the source is local.
			<span
				className="inline-flex items-center justify-center shrink-0"
				style={{ width: size, height: size }}
				title={profile.name}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG from local MCP
				dangerouslySetInnerHTML={{ __html: icon }}
			/>
		);
	}
	// Font Awesome class string (e.g. "fas fa-network-wired"). FA CSS is loaded
	// globally in main.tsx.
	return (
		<span
			className="inline-flex items-center justify-center shrink-0"
			style={{ width: size, height: size, fontSize: size }}
			title={profile.name}
		>
			<i className={icon} aria-hidden />
		</span>
	);
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

function LivePanel({
	rows,
	totalRows,
	loading,
	profileMap,
	display,
	sortKey,
	setSortKey,
	onSnapshot,
}: {
	rows: LiveDerivedRow[];
	totalRows: number;
	loading: boolean;
	profileMap: Map<string, Profile>;
	display: DisplayOptions;
	sortKey: LiveSortKey;
	setSortKey: (k: LiveSortKey) => void;
	onSnapshot: (session: StoredSession) => void;
}) {
	const [name, setName] = useState(() => new Date().toISOString().slice(0, 16).replace("T", " "));
	const [comment, setComment] = useState("");
	const [tags, setTags] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	async function snapshot() {
		setBusy(true);
		setMsg(null);
		const res = await jfetch<StoredSession>("/api/tabby/snapshot", {
			method: "POST",
			body: JSON.stringify({
				name: name || new Date().toISOString(),
				comment: comment || undefined,
				tags: tags
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean),
			}),
		});
		setBusy(false);
		if (res.ok && res.data) {
			setMsg(`Saved "${res.data.name}" (${res.data.tabs.length} tabs)`);
			setComment("");
			setTags("");
			onSnapshot(res.data);
		} else {
			setMsg(`Error: ${res.error}`);
		}
	}

	return (
		<section className="border border-[var(--border)] rounded-lg p-4 bg-[var(--card)]">
			<header className="flex items-center justify-between gap-2 mb-3">
				<h2 className="font-semibold">
					Live{" "}
					<span className="text-xs text-[var(--muted)]">
						({rows.length}
						{rows.length !== totalRows ? ` of ${totalRows}` : ""} tabs)
					</span>
				</h2>
				<label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
					Sort
					<select
						value={sortKey}
						onChange={(e) => setSortKey(e.target.value as LiveSortKey)}
						className="px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--bg)] text-xs"
					>
						<option value="tabIndex">Tab order</option>
						<option value="title">Title</option>
						<option value="profile">Profile</option>
						<option value="branch">Branch</option>
					</select>
				</label>
			</header>

			<div className="flex flex-col gap-2 mb-3 p-3 rounded bg-[var(--bg)] border border-[var(--border)]">
				<div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
					Snapshot all tabs
				</div>
				<div className="grid grid-cols-1 md:grid-cols-3 gap-2">
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Session name"
						className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-sm"
					/>
					<input
						type="text"
						value={tags}
						onChange={(e) => setTags(e.target.value)}
						placeholder="Tags (comma-separated)"
						className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-sm"
					/>
					<input
						type="text"
						value={comment}
						onChange={(e) => setComment(e.target.value)}
						placeholder="Comment (optional)"
						className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-sm"
					/>
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={snapshot}
						disabled={busy || loading || rows.length === 0}
						className="px-3 py-1.5 rounded text-sm bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
					>
						{busy ? "Snapshotting…" : "Snapshot now"}
					</button>
					{msg && <span className="text-xs text-[var(--muted)]">{msg}</span>}
				</div>
			</div>

			{loading && rows.length === 0 ? (
				<div className="text-sm text-[var(--muted)]">Loading…</div>
			) : rows.length === 0 ? (
				<div className="text-sm text-[var(--muted)]">
					{totalRows === 0 ? "No live tabs." : "No tabs match the current filters."}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{rows.map((row) => (
						<LiveRow
							key={row.session.sessionId}
							row={row}
							profileMap={profileMap}
							display={display}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function LiveRow({
	row,
	profileMap,
	display,
}: {
	row: LiveDerivedRow;
	profileMap: Map<string, Profile>;
	display: DisplayOptions;
}) {
	const [showBuffer, setShowBuffer] = useState(false);
	const { tab, session, derived } = row;
	const profile = profileMap.get(session.profile.id);
	return (
		<div className="border border-[var(--border)] rounded bg-[var(--bg)] p-2 flex flex-col gap-1">
			<div className="flex items-start gap-2">
				<span className="text-xs text-[var(--muted)] w-5 shrink-0 mt-0.5">{session.tabIndex}</span>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						{display.profileIcon && <ProfileIcon profile={profile} size={16} />}
						{display.colorDot && tab?.color && (
							<span
								className="inline-block w-2 h-2 rounded-full shrink-0"
								style={{ background: tab.color }}
							/>
						)}
						<span className="font-medium text-sm truncate">{tab?.title ?? session.title}</span>
						{tab?.isActive && (
							<span className="text-[10px] px-1 rounded bg-[var(--accent)] text-white">active</span>
						)}
						{display.profileName && (
							<span className="text-xs text-[var(--muted)]">{session.profile.name}</span>
						)}
						{session.isSplit && session.totalPanes > 1 && (
							<span className="text-[10px] px-1 rounded border border-[var(--border)] text-[var(--muted)]">
								pane {session.paneIndex + 1}/{session.totalPanes}
							</span>
						)}
					</div>
					<DerivedFields derived={derived} display={display} />
				</div>
				{display.bufferButton && row.bufferTail && (
					<button
						type="button"
						onClick={() => setShowBuffer((v) => !v)}
						className="text-[10px] text-[var(--muted)] hover:text-[var(--text)] shrink-0 self-center px-1.5 py-0.5 rounded border border-[var(--border)]"
					>
						{showBuffer ? "hide buffer" : "buffer"}
					</button>
				)}
			</div>
			{showBuffer && row.bufferTail && <BufferPre text={stripAnsi(row.bufferTail)} />}
		</div>
	);
}

function DerivedFields({
	derived,
	display,
}: {
	derived?: TabbyTabDerived;
	display: DisplayOptions;
}) {
	if (!derived) return null;
	const showCwdBranch =
		display.cwdBranch &&
		(derived.cwd || derived.branch || derived.diffStats) !== undefined &&
		(derived.cwd || derived.branch || derived.diffStats);
	const showSid = display.sessionId && derived.claudeSessionId;
	const showModelMode = display.modelMode && (derived.model || derived.mode);
	const showCtx = display.contextUsage && derived.contextUsage;
	const showAge = display.sessionAge && derived.sessionAge;
	const showPct = display.usagePct && derived.usagePct && derived.usagePct.length > 0;
	const showSkills = display.skills && derived.skills && derived.skills.length > 0;
	const showRecap = display.recap && derived.recap;
	const showUser = display.userTurn && derived.recentUserTurn;
	const showAssistant = display.assistantTurn && derived.recentAssistantTurn;
	const showPrs = display.prs && derived.prNumbers && derived.prNumbers.length > 0;
	const showShas = display.shas && derived.commitShas && derived.commitShas.length > 0;
	if (
		!showCwdBranch &&
		!showSid &&
		!showModelMode &&
		!showCtx &&
		!showAge &&
		!showPct &&
		!showSkills &&
		!showRecap &&
		!showUser &&
		!showAssistant &&
		!showPrs &&
		!showShas
	) {
		return null;
	}
	return (
		<div className="mt-1 flex flex-col gap-0.5 text-xs">
			{(showCwdBranch || showSid) && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[var(--muted)]">
					{showCwdBranch && derived.cwd && <span>{derived.cwd}</span>}
					{showCwdBranch && derived.branch && (
						<span>
							<span className="opacity-70">⎇</span> {derived.branch}
							{derived.baseBranch && derived.baseBranch !== derived.branch && (
								<span className="opacity-70"> · base {derived.baseBranch}</span>
							)}
						</span>
					)}
					{showCwdBranch && derived.diffStats && (
						<span className="opacity-70">({derived.diffStats})</span>
					)}
					{showSid && derived.claudeSessionId && (
						<button
							type="button"
							className="opacity-70 hover:opacity-100 cursor-pointer bg-transparent border-0 p-0 font-mono"
							title="Click to copy"
							onClick={() => {
								navigator.clipboard?.writeText(derived.claudeSessionId ?? "").catch(() => {});
							}}
						>
							session: {derived.claudeSessionId}
						</button>
					)}
				</div>
			)}
			{(showModelMode || showCtx || showAge || showPct) && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--muted)]">
					{showModelMode && (
						<span>
							{derived.model}
							{derived.mode && <span className="opacity-70"> · {derived.mode}</span>}
						</span>
					)}
					{showCtx && <span className="opacity-70">ctx {derived.contextUsage}</span>}
					{showAge && <span className="opacity-70">age {derived.sessionAge}</span>}
					{showPct && <span className="opacity-70">usage {derived.usagePct?.join(" / ")}</span>}
				</div>
			)}
			{showSkills && (
				<div className="flex flex-wrap items-center gap-1">
					<span className="text-[var(--muted)]">skills:</span>
					{derived.skills?.map((s) => (
						<span
							key={s}
							className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)]"
						>
							{s}
						</span>
					))}
				</div>
			)}
			{showRecap && (
				<div className="text-[var(--text)]">
					<span className="text-[var(--muted)]">recap:</span> {derived.recap}
				</div>
			)}
			{showUser && (
				<div className="text-[var(--muted)] italic truncate">❯ {derived.recentUserTurn}</div>
			)}
			{showAssistant && (
				<div className="text-[var(--muted)] truncate">● {derived.recentAssistantTurn}</div>
			)}
			{showPrs && <div className="text-[var(--muted)]">PRs: {derived.prNumbers?.join(" ")}</div>}
			{showShas && (
				<div className="text-[var(--muted)] font-mono">
					SHAs: {derived.commitShas?.slice(0, 8).join(" ")}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Profiles (per-profile settings)
// ---------------------------------------------------------------------------

interface ProfileSetting {
	openDelayMs?: number;
}

interface ProfileSettingsFile {
	version: 1;
	defaults: ProfileSetting;
	profiles: Record<string, ProfileSetting>;
}

function ProfilesPanel({ profileMap, query }: { profileMap: Map<string, Profile>; query: string }) {
	const settings = useCachedEndpoint<ProfileSettingsFile>(
		"tabby-profile-settings",
		"/api/tabby/profile-settings",
		{ staleAfter: 30_000 },
	);

	const profiles = [...profileMap.values()]
		.filter((p) => matchQuery(query, [p.name, p.profileId, p.type]))
		.sort((a, b) => a.name.localeCompare(b.name));

	const defaultDelay = settings.data?.defaults.openDelayMs ?? 1500;

	return (
		<section className="border border-[var(--border)] rounded-lg p-4 bg-[var(--card)] flex flex-col gap-3">
			<header className="flex items-start justify-between gap-3 flex-wrap">
				<div>
					<h2 className="font-semibold">Profile settings</h2>
					<p className="text-xs text-[var(--muted)] mt-0.5 max-w-2xl">
						<strong>Open delay</strong> is how long to wait after a profile's tab opens before
						running the stored <code>cd</code> + command. WSL cold boot + oh-my-zsh can need 1–2s
						before the shell accepts input. Leave blank to use the default ({defaultDelay} ms).
					</p>
				</div>
				<button
					type="button"
					onClick={() => settings.refresh()}
					className="px-2 py-1 rounded text-xs border border-[var(--border)] hover:bg-[var(--border)] shrink-0"
				>
					Refresh
				</button>
			</header>

			{profiles.length === 0 ? (
				<div className="text-sm text-[var(--muted)]">No profiles match.</div>
			) : (
				<div className="flex flex-col gap-1">
					{profiles.map((profile) => (
						<ProfileSettingRow
							key={profile.profileId}
							profile={profile}
							setting={settings.data?.profiles[profile.profileId]}
							defaultDelay={defaultDelay}
							onChanged={() => settings.refresh()}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function ProfileSettingRow({
	profile,
	setting,
	defaultDelay,
	onChanged,
}: {
	profile: Profile;
	setting?: ProfileSetting;
	defaultDelay: number;
	onChanged: () => void;
}) {
	const [value, setValue] = useState<string>(
		setting?.openDelayMs != null ? String(setting.openDelayMs) : "",
	);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	// When the fetched setting changes (e.g. after refresh), sync the input
	// if the user hasn't started editing.
	useEffect(() => {
		setValue(setting?.openDelayMs != null ? String(setting.openDelayMs) : "");
	}, [setting?.openDelayMs]);

	async function save() {
		setBusy(true);
		setMsg(null);
		const trimmed = value.trim();
		if (trimmed === "") {
			const res = await jfetch(
				`/api/tabby/profile-settings/${encodeURIComponent(profile.profileId)}`,
				{ method: "DELETE" },
			);
			setBusy(false);
			setMsg(res.ok ? "Cleared" : `Error: ${res.error}`);
			if (res.ok) onChanged();
			return;
		}
		const n = Number(trimmed);
		if (!Number.isFinite(n) || n < 0) {
			setBusy(false);
			setMsg("Must be a number ≥ 0");
			return;
		}
		const res = await jfetch(
			`/api/tabby/profile-settings/${encodeURIComponent(profile.profileId)}`,
			{
				method: "PUT",
				body: JSON.stringify({ openDelayMs: Math.round(n) }),
			},
		);
		setBusy(false);
		setMsg(res.ok ? "Saved" : `Error: ${res.error}`);
		if (res.ok) onChanged();
	}

	return (
		<div className="border border-[var(--border)] rounded p-2 flex items-center gap-3 bg-[var(--bg)]">
			<ProfileIcon profile={profile} size={16} />
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<span className="font-medium text-sm truncate">{profile.name}</span>
					<span className="text-xs text-[var(--muted)] truncate">{profile.type}</span>
				</div>
				<div className="text-[11px] font-mono text-[var(--muted)] truncate">
					{profile.profileId}
				</div>
			</div>
			<label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
				Open delay
				<input
					type="number"
					min={0}
					step={50}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onBlur={save}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					}}
					placeholder={`${defaultDelay}`}
					className="w-20 px-2 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-xs text-right"
				/>
				<span className="opacity-70">ms</span>
			</label>
			{busy && <span className="text-[10px] text-[var(--muted)]">…</span>}
			{msg && <span className="text-[10px] text-[var(--muted)]">{msg}</span>}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Stored
// ---------------------------------------------------------------------------

function StoredPanel({
	groups,
	totalSessions,
	filteredCount,
	hasLoaded,
	loading,
	profileMap,
	display,
	selection,
	setSelection,
	sortKey,
	setSortKey,
	onChange,
}: {
	groups: [string, StoredSession[]][];
	totalSessions: number;
	filteredCount: number;
	hasLoaded: boolean;
	loading: boolean;
	profileMap: Map<string, Profile>;
	display: DisplayOptions;
	selection: Set<string>;
	setSelection: (s: Set<string>) => void;
	sortKey: StoredSortKey;
	setSortKey: (k: StoredSortKey) => void;
	onChange: () => void;
}) {
	return (
		<section className="border border-[var(--border)] rounded-lg p-4 bg-[var(--card)]">
			<header className="flex items-center justify-between gap-2 mb-3">
				<h2 className="font-semibold">
					Stored sessions{" "}
					<span className="text-xs text-[var(--muted)]">
						({filteredCount}
						{filteredCount !== totalSessions ? ` of ${totalSessions}` : ""})
					</span>
				</h2>
				<label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
					Sort
					<select
						value={sortKey}
						onChange={(e) => setSortKey(e.target.value as StoredSortKey)}
						className="px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--bg)] text-xs"
					>
						<option value="updatedAt-desc">Updated (newest)</option>
						<option value="createdAt-desc">Created (newest)</option>
						<option value="name-asc">Name (A→Z)</option>
						<option value="tabCount-desc">Tab count</option>
					</select>
				</label>
			</header>

			{!hasLoaded && loading ? (
				<div className="text-sm text-[var(--muted)]">Loading…</div>
			) : totalSessions === 0 ? (
				<div className="text-sm text-[var(--muted)]">
					No sessions yet — use "Snapshot now" above to save your current Tabby layout.
				</div>
			) : filteredCount === 0 ? (
				<div className="text-sm text-[var(--muted)]">No sessions match the current filters.</div>
			) : (
				<div className="flex flex-col gap-4">
					{groups.map(([tag, list]) => (
						<div key={tag} className="flex flex-col gap-2">
							<div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
								{tag}
							</div>
							{list.map((session) => (
								<SessionCard
									key={session.id}
									session={session}
									profileMap={profileMap}
									display={display}
									selection={selection}
									setSelection={setSelection}
									onChange={onChange}
								/>
							))}
						</div>
					))}
				</div>
			)}
		</section>
	);
}

function SessionCard({
	session,
	profileMap,
	display,
	selection,
	setSelection,
	onChange,
}: {
	session: StoredSession;
	profileMap: Map<string, Profile>;
	display: DisplayOptions;
	selection: Set<string>;
	setSelection: (s: Set<string>) => void;
	onChange: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(session.name);
	const [comment, setComment] = useState(session.comment ?? "");
	const [tags, setTags] = useState(session.tags.join(", "));
	const [busy, setBusy] = useState<string | null>(null);
	const [lastResult, setLastResult] = useState<string | null>(null);

	async function saveEdit() {
		setBusy("save");
		const res = await jfetch(`/api/tabby/sessions/${session.id}`, {
			method: "PUT",
			body: JSON.stringify({
				name,
				comment: comment || undefined,
				tags: tags
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean),
			}),
		});
		setBusy(null);
		if (res.ok) {
			setEditing(false);
			onChange();
		} else {
			setLastResult(`Save failed: ${res.error}`);
		}
	}

	async function removeSession() {
		if (!confirm(`Delete session "${session.name}"?`)) return;
		setBusy("delete");
		const res = await jfetch(`/api/tabby/sessions/${session.id}`, {
			method: "DELETE",
		});
		setBusy(null);
		if (res.ok) onChange();
		else setLastResult(`Delete failed: ${res.error}`);
	}

	async function restoreAll() {
		if (!confirm(`Restore all ${session.tabs.length} tabs?`)) return;
		setBusy("restore");
		setLastResult(null);
		const res = await jfetch<{
			ok: boolean;
			results: Array<{ ok: boolean; error?: string }>;
		}>(`/api/tabby/sessions/${session.id}/restore`, { method: "POST" });
		setBusy(null);
		if (res.ok) {
			const failed = res.data?.results.filter((r) => !r.ok).length ?? 0;
			setLastResult(
				failed
					? `Restored with ${failed} failure(s)`
					: `Restored ${res.data?.results.length ?? 0} tabs`,
			);
			onChange();
		} else {
			setLastResult(`Restore failed: ${res.error}`);
		}
	}

	const tabKey = (tabId: string) => `${session.id}::${tabId}`;
	const allSelected =
		session.tabs.length > 0 && session.tabs.every((t) => selection.has(tabKey(t.id)));
	function toggleAll() {
		const next = new Set(selection);
		if (allSelected) {
			for (const t of session.tabs) next.delete(tabKey(t.id));
		} else {
			for (const t of session.tabs) next.add(tabKey(t.id));
		}
		setSelection(next);
	}
	function toggleOne(tabId: string) {
		const next = new Set(selection);
		const k = tabKey(tabId);
		if (next.has(k)) next.delete(k);
		else next.add(k);
		setSelection(next);
	}

	return (
		<div className="border border-[var(--border)] rounded-lg bg-[var(--bg)]">
			<div className="flex items-center gap-2 p-3">
				<button
					type="button"
					onClick={() => setExpanded((e) => !e)}
					className="text-[var(--muted)] hover:text-[var(--text)] w-4"
				>
					{expanded ? "▾" : "▸"}
				</button>
				<input
					type="checkbox"
					checked={allSelected}
					onChange={toggleAll}
					title="Select all tabs in this session"
				/>

				<div className="flex-1 min-w-0">
					{editing ? (
						<div className="flex flex-col gap-1">
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-sm font-medium"
							/>
							<input
								type="text"
								value={tags}
								onChange={(e) => setTags(e.target.value)}
								placeholder="Tags"
								className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-xs"
							/>
							<input
								type="text"
								value={comment}
								onChange={(e) => setComment(e.target.value)}
								placeholder="Comment"
								className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-xs"
							/>
						</div>
					) : (
						<button
							type="button"
							onClick={() => setExpanded((e) => !e)}
							className="flex flex-col text-left w-full bg-transparent border-0 p-0 cursor-pointer"
							title={expanded ? "Collapse" : "Expand"}
						>
							<div className="flex items-center gap-2">
								<span className="font-medium truncate">{session.name}</span>
								<span className="text-xs text-[var(--muted)]">
									{session.tabs.length} tabs ·{" "}
									{formatDistanceToNow(new Date(session.updatedAt), {
										addSuffix: true,
									})}
								</span>
							</div>
							{session.comment && (
								<div className="text-xs text-[var(--muted)] truncate">{session.comment}</div>
							)}
						</button>
					)}
				</div>

				<div className="flex items-center gap-1.5 shrink-0">
					{editing ? (
						<>
							<button
								type="button"
								onClick={saveEdit}
								disabled={busy === "save"}
								className="px-2 py-1 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
							>
								Save
							</button>
							<button
								type="button"
								onClick={() => {
									setEditing(false);
									setName(session.name);
									setComment(session.comment ?? "");
									setTags(session.tags.join(", "));
								}}
								className="px-2 py-1 rounded text-xs border border-[var(--border)] hover:bg-[var(--border)]"
							>
								Cancel
							</button>
						</>
					) : (
						<>
							<button
								type="button"
								onClick={restoreAll}
								disabled={busy === "restore"}
								className="px-2 py-1 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
							>
								{busy === "restore" ? "Restoring…" : "Restore"}
							</button>
							<button
								type="button"
								onClick={() => setEditing(true)}
								className="px-2 py-1 rounded text-xs border border-[var(--border)] hover:bg-[var(--border)]"
							>
								Edit
							</button>
							<button
								type="button"
								onClick={removeSession}
								disabled={busy === "delete"}
								className="px-2 py-1 rounded text-xs border border-[var(--border)] text-[var(--danger)] hover:bg-[var(--border)]"
							>
								Delete
							</button>
						</>
					)}
				</div>
			</div>

			{lastResult && <div className="px-3 pb-2 text-xs text-[var(--muted)]">{lastResult}</div>}

			{expanded && (
				<div className="border-t border-[var(--border)] p-3 flex flex-col gap-2">
					{session.tabs
						.slice()
						.sort((a, b) => a.order - b.order)
						.map((tab) => (
							<TabRow
								key={tab.id}
								sessionId={session.id}
								tab={tab}
								profileMap={profileMap}
								display={display}
								selected={selection.has(tabKey(tab.id))}
								onToggle={() => toggleOne(tab.id)}
								onChange={onChange}
							/>
						))}
				</div>
			)}
		</div>
	);
}

function TabRow({
	sessionId,
	tab,
	profileMap,
	display,
	selected,
	onToggle,
	onChange,
}: {
	sessionId: string;
	tab: StoredTab;
	profileMap: Map<string, Profile>;
	display: DisplayOptions;
	selected: boolean;
	onToggle: () => void;
	onChange: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [cwd, setCwd] = useState(tab.cwd ?? "");
	const [command, setCommand] = useState(tab.command ?? "");
	const [comment, setComment] = useState(tab.comment ?? "");
	const [showBuffer, setShowBuffer] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [msg, setMsg] = useState<string | null>(null);

	async function save() {
		setBusy("save");
		const res = await jfetch(`/api/tabby/sessions/${sessionId}/tabs/${tab.id}`, {
			method: "PUT",
			body: JSON.stringify({
				cwd: cwd || undefined,
				command: command || undefined,
				comment: comment || undefined,
			}),
		});
		setBusy(null);
		if (res.ok) {
			setEditing(false);
			onChange();
		} else {
			setMsg(`Save failed: ${res.error}`);
		}
	}

	async function restore() {
		setBusy("restore");
		setMsg(null);
		const res = await jfetch(`/api/tabby/sessions/${sessionId}/tabs/${tab.id}/restore`, {
			method: "POST",
		});
		setBusy(null);
		setMsg(res.ok ? "Opened" : `Restore failed: ${res.error}`);
	}

	async function remove() {
		if (!confirm(`Delete tab "${tab.title}"?`)) return;
		setBusy("delete");
		const res = await jfetch(`/api/tabby/sessions/${sessionId}/tabs/${tab.id}`, {
			method: "DELETE",
		});
		setBusy(null);
		if (res.ok) onChange();
		else setMsg(`Delete failed: ${res.error}`);
	}

	return (
		<div className="border border-[var(--border)] rounded bg-[var(--card)] p-2 flex flex-col gap-1.5">
			<div className="flex items-start gap-2">
				<input type="checkbox" checked={selected} onChange={onToggle} className="mt-1" />
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						{display.profileIcon && (
							<ProfileIcon profile={profileMap.get(tab.profileId)} size={14} />
						)}
						{display.colorDot && tab.color && (
							<span
								className="inline-block w-2 h-2 rounded-full shrink-0"
								style={{ background: tab.color }}
							/>
						)}
						<span className="font-medium text-sm truncate">{tab.title}</span>
						{display.profileName && (
							<span className="text-xs text-[var(--muted)]">{tab.profileName}</span>
						)}
						{tab.isSplit && tab.totalPanes && tab.totalPanes > 1 && (
							<span className="text-[10px] px-1 rounded border border-[var(--border)] text-[var(--muted)]">
								pane {(tab.paneIndex ?? 0) + 1}/{tab.totalPanes}
							</span>
						)}
					</div>
					{tab.comment && !editing && (
						<div className="text-xs text-[var(--muted)] mt-0.5">{tab.comment}</div>
					)}
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<button
						type="button"
						onClick={restore}
						disabled={busy === "restore"}
						className="px-2 py-0.5 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
					>
						Open
					</button>
					<button
						type="button"
						onClick={() => setEditing((e) => !e)}
						className="px-2 py-0.5 rounded text-xs border border-[var(--border)] hover:bg-[var(--border)]"
					>
						{editing ? "Cancel" : "Edit"}
					</button>
					<button
						type="button"
						onClick={remove}
						disabled={busy === "delete"}
						className="px-2 py-0.5 rounded text-xs border border-[var(--border)] text-[var(--danger)] hover:bg-[var(--border)]"
					>
						Delete
					</button>
				</div>
			</div>

			{editing ? (
				<div className="flex flex-col gap-1 pl-6">
					<label className="flex items-center gap-2 text-xs">
						<span className="w-16 text-[var(--muted)]">cwd</span>
						<input
							type="text"
							value={cwd}
							onChange={(e) => setCwd(e.target.value)}
							placeholder="/home/user/project"
							className="flex-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-xs font-mono"
						/>
					</label>
					<label className="flex items-center gap-2 text-xs">
						<span className="w-16 text-[var(--muted)]">command</span>
						<input
							type="text"
							value={command}
							onChange={(e) => setCommand(e.target.value)}
							placeholder="claude --resume <id>"
							className="flex-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-xs font-mono"
						/>
					</label>
					<label className="flex items-center gap-2 text-xs">
						<span className="w-16 text-[var(--muted)]">comment</span>
						<input
							type="text"
							value={comment}
							onChange={(e) => setComment(e.target.value)}
							className="flex-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-xs"
						/>
					</label>
					<button
						type="button"
						onClick={save}
						disabled={busy === "save"}
						className="self-start mt-1 px-2 py-1 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
					>
						{busy === "save" ? "Saving…" : "Save"}
					</button>
				</div>
			) : (
				<div className="pl-6 flex flex-col gap-1">
					{((display.manualCwd && tab.cwd) || (display.manualCommand && tab.command)) && (
						<div className="text-xs font-mono text-[var(--text)]">
							{display.manualCwd && tab.cwd && (
								<div>
									<span className="text-[var(--muted)]">cwd:</span> {tab.cwd}
								</div>
							)}
							{display.manualCommand && tab.command && <div>$ {tab.command}</div>}
						</div>
					)}
					<DerivedFields derived={tab.derived} display={display} />
				</div>
			)}

			{display.bufferButton && tab.raw.bufferTail && (
				<div className="pl-6">
					<button
						type="button"
						onClick={() => setShowBuffer((v) => !v)}
						className="text-xs text-[var(--muted)] hover:text-[var(--text)]"
					>
						{showBuffer ? "Hide" : "Show"} captured buffer (
						{new Date(tab.raw.capturedAt).toISOString().slice(0, 19)})
					</button>
					{showBuffer && <BufferPre text={stripAnsi(tab.raw.bufferTail)} className="mt-1" />}
				</div>
			)}

			{msg && <div className="pl-6 text-xs text-[var(--muted)]">{msg}</div>}
		</div>
	);
}

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function BufferPre({ text, className = "" }: { text: string; className?: string }) {
	const ref = useRef<HTMLPreElement>(null);
	useEffect(() => {
		// Scroll to the bottom when the buffer first mounts — the most recent
		// lines are what the user wants to see.
		const el = ref.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);
	return (
		<pre
			ref={ref}
			className={`text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto p-2 rounded bg-[var(--card)] border border-[var(--border)] text-[var(--muted)] ${className}`}
		>
			{text}
		</pre>
	);
}

// ---------------------------------------------------------------------------
// Bulk restore bar
// ---------------------------------------------------------------------------

function BulkBar({
	selection,
	sessions,
	onClear,
	onRestored,
}: {
	selection: Set<string>;
	sessions: StoredSession[];
	onClear: () => void;
	onRestored: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	const items = useMemo(() => {
		const out: Array<{ sessionId: string; tabId: string }> = [];
		for (const key of selection) {
			const [sessionId, tabId] = key.split("::");
			if (sessionId && tabId) out.push({ sessionId, tabId });
		}
		return out;
	}, [selection]);

	const unknownMissing = items.some(
		(item) => !sessions.find((s) => s.id === item.sessionId)?.tabs.some((t) => t.id === item.tabId),
	);

	async function restore() {
		if (!confirm(`Restore ${items.length} tab(s)?`)) return;
		setBusy(true);
		setMsg(null);
		const res = await jfetch<{
			ok: boolean;
			results: Array<{ ok: boolean; error?: string }>;
		}>("/api/tabby/restore-bulk", {
			method: "POST",
			body: JSON.stringify({ items }),
		});
		setBusy(false);
		if (res.ok) {
			const failed = res.data?.results.filter((r) => !r.ok).length ?? 0;
			setMsg(
				failed
					? `${items.length - failed}/${items.length} restored, ${failed} failed`
					: `Restored ${items.length} tabs`,
			);
			onRestored();
		} else {
			setMsg(`Bulk restore failed: ${res.error}`);
		}
	}

	return (
		<div className="fixed bottom-4 right-6 flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg z-50">
			<span className="text-sm font-medium">
				{selection.size} tab{selection.size === 1 ? "" : "s"} selected
			</span>
			{unknownMissing && <span className="text-xs text-[var(--danger)]">stale selection</span>}
			<button
				type="button"
				onClick={restore}
				disabled={busy || items.length === 0}
				className="px-3 py-1.5 rounded text-sm bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
			>
				{busy ? "Restoring…" : "Restore selected"}
			</button>
			<button
				type="button"
				onClick={onClear}
				className="px-3 py-1.5 rounded text-sm border border-[var(--border)] hover:bg-[var(--border)]"
			>
				Clear
			</button>
			{msg && <span className="text-xs text-[var(--muted)]">{msg}</span>}
		</div>
	);
}
