export interface TabbyTabDerived {
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI-strip
const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI-strip OSC
const ANSI_OSC = /\x1b\][0-9;]*[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_CSI, "").replace(ANSI_OSC, "");
}

// Claude Code's statusline uses non-breaking spaces and Powerline separator
// glyphs as visual padding between segments. Convert them all to ASCII space
// so `\s+` style matching works.
// U+00A0  NBSP
// U+2000–200A  various unicode spaces
// U+202F  narrow no-break space
// U+E0B0–E0BF  Powerline glyphs (private-use)
function normaliseSeparators(s: string): string {
	return s.replace(/[  -  \u{E0B0}-\u{E0BF}]/gu, " ");
}

/**
 * Claude Code prints a statusline footer that looks like:
 *   Opus 4.7 (1M context)  default  112.6k  2hr 49m  48.0%  65.0%  33.8G/82.5G  5hr 27m  Session ID: 2c9a0909-e8c0-48cf-8cf0-d55bf501919a
 *   .claude ⎇ main 𖠰 main (+1066,-238) /home/stevenp/.claude
 * We extract what we can, per line, with forgiving regex.
 */
export function deriveFromBuffer(raw: string): TabbyTabDerived {
	const text = normaliseSeparators(stripAnsi(raw));
	const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
	const derived: TabbyTabDerived = {};

	// --- Claude statusline ---------------------------------------------------
	// The footer Claude Code prints looks like two lines near the end of
	// the buffer:
	//   <model> … Session ID: <uuid>
	//   <project> ⎇ <branch> 𖠰 <base> (+A,-D) <cwd>
	// Find the most recent `⎇ ` line AND the most recent `Session ID:` line
	// and only pull fields from those. Scanning the whole buffer catches stray
	// matches from tool output and previous messages.
	const sessionIdLineIdx = findLastIndex(lines, (l) => /Session ID:/.test(l));
	// The real Claude statusline looks like
	//   <project> ⎇ <branch> 𖠰 <base> (+A,-D) /cwd
	// Require both branch markers with realistic token shapes and the diff
	// stats tuple — rejects stray mentions of ⎇/𖠰 in quoted text (including
	// regex literals like this one in scrollback).
	const statusLineIdx = findLastIndex(lines, (l) =>
		/⎇\s+[A-Za-z0-9_./+-]+\s+𖠰\s+[A-Za-z0-9_./+-]+.*\([+-][0-9,]+,[+-][0-9,]+\)/.test(
			l,
		),
	);

	if (statusLineIdx >= 0) {
		const line = lines[statusLineIdx];
		const branchMatch = line.match(/⎇\s*(\S+?)(?:\s|$|│|\|)/);
		if (branchMatch) derived.branch = trimTrailingPunct(branchMatch[1]);
		const baseMatch = line.match(/𖠰\s*(\S+?)(?:\s|$|│|\|)/);
		if (baseMatch) derived.baseBranch = trimTrailingPunct(baseMatch[1]);
		const diffMatch = line.match(/\(([+-][0-9,]+,[+-][0-9,]+)\)/);
		if (diffMatch) derived.diffStats = diffMatch[1];
		// cwd is the last absolute-looking path on the statusline. Greedy-stop
		// on whitespace, pipe, box-drawing, or ellipsis.
		const cwdMatches = [
			...line.matchAll(/(\/(?:home|Users|mnt|root)\/[^\s│|]+)/g),
		];
		if (cwdMatches.length) {
			let cwd = cwdMatches[cwdMatches.length - 1][1];
			// The footer truncates long paths with "…" — record the best we got.
			cwd = cwd.replace(/\.\.\.$|…$/, "");
			derived.cwd = cwd;
		}
		// Project name: first non-whitespace token on the line before `⎇`.
		const projectMatch = line.match(
			/(?:^|\s|│)([.A-Za-z0-9_-][.A-Za-z0-9_-]*)\s+⎇/,
		);
		if (projectMatch) derived.projectName = projectMatch[1];
	}

	if (sessionIdLineIdx >= 0) {
		const line = lines[sessionIdLineIdx];
		const idMatch = line.match(/Session ID:\s*([a-f0-9][a-f0-9-]{7,})/i);
		if (idMatch) derived.claudeSessionId = idMatch[1];
		const modelMatch = line.match(
			/\b(Opus|Sonnet|Haiku)\s+[0-9.]+(?:\s*\([^)]*\))?/,
		);
		if (modelMatch) derived.model = modelMatch[0];

		// Context-window usage like "119.3k". The model's label already
		// contains "(1M context)" which would false-match — skip the line up
		// to the end of the model's parenthetical before scanning.
		const afterModel = modelMatch
			? line.slice(line.indexOf(modelMatch[0]) + modelMatch[0].length)
			: line;
		const ctxMatch = afterModel.match(/\b([0-9]+(?:\.[0-9]+)?[kKmM])\b/);
		if (ctxMatch) derived.contextUsage = ctxMatch[1];

		// First time-like token on the line is the session age.
		const ageMatch = line.match(/\b(\d+hr\s+\d+m|\d+m\b|\d+h)\b/);
		if (ageMatch) derived.sessionAge = ageMatch[1];

		// Percentages like "58.0%  66.0%" — session + weekly usage.
		const pctMatches = [...line.matchAll(/\b(\d+(?:\.\d+)?%)/g)];
		if (pctMatches.length > 0)
			derived.usagePct = pctMatches.map((m) => m[1]).slice(0, 2);

		// Mode sits between model and the first k-token or %.
		// The statusline renders `<model>  <mode>  <tokens>  ...` separated by
		// 2+ spaces. Known values: "default", "auto mode on", "bypass
		// permissions on", "plan".
		const modeMatch = line.match(
			/\b(default|auto mode(?:\s+on)?|bypass permissions(?:\s+on)?|plan)\b/i,
		);
		if (modeMatch) derived.mode = modeMatch[1];
	} else {
		// Non-Claude tab: still try to grab the model tag if it appears anywhere.
		for (const line of lines) {
			const m = line.match(/\b(Opus|Sonnet|Haiku)\s+[0-9.]+(?:\s*\([^)]*\))?/);
			if (m) {
				derived.model = m[0];
				break;
			}
		}
	}

	// --- Skills line (e.g. "Skills: rename-session, personal-brand-voice") ---
	// Stop at 2+ spaces or the mode/permissions indicator `⏵` — the footer
	// sometimes packs multiple status segments on the same rendered line.
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const m = line.match(/(?:^|\s)Skills:\s+([^⏵]+?)(?:\s{2,}|\s*⏵|\s*$)/);
		if (!m) continue;
		const value = m[1].trim();
		if (!value || /^none$/i.test(value)) {
			derived.skills = [];
		} else {
			derived.skills = value
				.split(/\s*,\s*/)
				.map((s) => s.trim())
				.filter(Boolean);
		}
		break;
	}

	// --- recap line (Claude Code prints `※ recap:` near the bottom) ----------
	// There can be multiple over a long session; take the most recent.
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const m = line.match(/※\s*recap:\s*(.+)$/);
		if (m) {
			// recap sometimes wraps to the next line — grab up to 3 continuation
			// lines that don't look like UI chrome.
			let recap = m[1].trim();
			for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
				const cont = lines[j].trim();
				if (!cont || /^[─━-]+/.test(cont) || /^❯/.test(cont) || /^●/.test(cont))
					break;
				recap += ` ${cont}`;
			}
			derived.recap = normaliseSpaces(recap).slice(0, 500);
			break;
		}
	}

	// --- last user prompt + assistant reply summary --------------------------
	// Claude Code marks user turns with `❯ ` prefix and assistant turns with `● `.
	// Walk from the end and grab the most recent of each (first non-empty line
	// after the marker, clipped).
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!derived.recentUserTurn) {
			const m = line.match(/^\s*❯\s+(.*\S.*)$/);
			if (m && !isUiChrome(m[1])) {
				derived.recentUserTurn = clip(m[1]);
			}
		}
		if (!derived.recentAssistantTurn) {
			const m = line.match(/^\s*●\s+(.*\S.*)$/);
			if (m && !isUiChrome(m[1])) {
				derived.recentAssistantTurn = clip(m[1]);
			}
		}
		if (derived.recentUserTurn && derived.recentAssistantTurn) break;
	}

	// --- Reference IDs (PRs, commit SHAs) found in visible text --------------
	const prSet = new Set<string>();
	const shaSet = new Set<string>();
	for (const line of lines) {
		for (const m of line.matchAll(/(?:PR\s*)?#(\d{2,6})\b/gi)) {
			prSet.add(`#${m[1]}`);
		}
		for (const m of line.matchAll(/\b([0-9a-f]{7,12})\b/g)) {
			// Skip obvious non-SHAs: all digits (line numbers/sizes)
			if (!/^\d+$/.test(m[1])) shaSet.add(m[1]);
		}
	}
	if (prSet.size) derived.prNumbers = [...prSet].slice(0, 20);
	if (shaSet.size) {
		// UUIDs (like the Claude session id) contain 8- and 12-char hex segments
		// that trigger the SHA regex. Strip anything that's a substring of the
		// session uuid.
		const uuid = derived.claudeSessionId ?? "";
		const filtered = [...shaSet].filter((sha) => !uuid.includes(sha));
		if (filtered.length) derived.commitShas = filtered.slice(0, 20);
	}

	return derived;
}

function normaliseSpaces(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, max = 240): string {
	const t = normaliseSpaces(s);
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function findLastIndex<T>(
	arr: T[],
	pred: (v: T, i: number) => boolean,
): number {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (pred(arr[i], i)) return i;
	}
	return -1;
}

function trimTrailingPunct(s: string): string {
	return s.replace(/[,;:]+$/, "");
}

function isUiChrome(s: string): boolean {
	// Filter out box-drawing fragments and footer chrome that aren't real text.
	if (!/[A-Za-z0-9]/.test(s)) return true;
	if (/^[─━│┃┌┐└┘├┤┬┴┼]+/.test(s)) return true;
	return false;
}
