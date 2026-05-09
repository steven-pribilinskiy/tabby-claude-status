import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

type ParamKind = "string" | "number" | "boolean" | "json";

interface Param {
	name: string;
	kind: ParamKind;
	optional?: boolean;
	placeholder?: string;
	help?: string;
}

interface ToolDef {
	name: string;
	summary: string;
	params: Param[];
}

interface ToolGroup {
	name: string;
	tools: ToolDef[];
}

const GROUPS: ToolGroup[] = [
	{
		name: "Tabs",
		tools: [
			{ name: "list_tabs", summary: "List all open tabs", params: [] },
			{
				name: "select_tab",
				summary: "Focus a tab",
				params: [
					{ name: "tabId", kind: "string", optional: true },
					{ name: "tabIndex", kind: "number", optional: true },
				],
			},
			{
				name: "close_tab",
				summary: "Close a tab",
				params: [
					{ name: "tabId", kind: "string", optional: true },
					{ name: "tabIndex", kind: "number", optional: true },
				],
			},
			{ name: "close_all_tabs", summary: "Close every tab", params: [] },
			{
				name: "duplicate_tab",
				summary: "Duplicate a tab",
				params: [{ name: "tabId", kind: "string" }],
			},
			{
				name: "move_tab_left",
				summary: "Move tab one slot left",
				params: [{ name: "tabId", kind: "string" }],
			},
			{
				name: "move_tab_right",
				summary: "Move tab one slot right",
				params: [{ name: "tabId", kind: "string" }],
			},
			{ name: "next_tab", summary: "Cycle to next tab", params: [] },
			{ name: "previous_tab", summary: "Cycle to previous tab", params: [] },
			{
				name: "reopen_last_tab",
				summary: "Undo last tab close",
				params: [],
			},
			{
				name: "split_tab",
				summary: "Split a tab",
				params: [
					{ name: "tabId", kind: "string" },
					{
						name: "direction",
						kind: "string",
						optional: true,
						placeholder: "right|down|left|up",
					},
				],
			},
			{
				name: "focus_pane",
				summary: "Focus a split pane",
				params: [
					{ name: "tabId", kind: "string" },
					{ name: "paneIndex", kind: "number" },
				],
			},
			{
				name: "show_profile_selector",
				summary: "Open profile selector modal",
				params: [],
			},
		],
	},
	{
		name: "Sessions",
		tools: [
			{
				name: "get_session_list",
				summary: "List terminal sessions",
				params: [],
			},
			{
				name: "get_terminal_buffer",
				summary: "Read terminal scrollback",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "tabIndex", kind: "number", optional: true },
					{ name: "lastNLines", kind: "number", optional: true },
					{ name: "startLine", kind: "number", optional: true },
					{ name: "endLine", kind: "number", optional: true },
				],
			},
			{
				name: "send_input",
				summary: "Type into terminal",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "tabIndex", kind: "number", optional: true },
					{ name: "text", kind: "string" },
					{ name: "addNewline", kind: "boolean", optional: true },
				],
			},
			{
				name: "exec_command",
				summary: "Run a command and capture output",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "command", kind: "string" },
					{ name: "timeout", kind: "number", optional: true },
					{ name: "waitForOutput", kind: "boolean", optional: true },
				],
			},
			{
				name: "abort_command",
				summary: "Send Ctrl+C to a session",
				params: [{ name: "sessionId", kind: "string" }],
			},
			{
				name: "get_command_status",
				summary: "Check last command in session",
				params: [{ name: "sessionId", kind: "string" }],
			},
		],
	},
	{
		name: "Profiles",
		tools: [
			{ name: "list_profiles", summary: "List all profiles", params: [] },
			{
				name: "open_profile",
				summary: "Open a new tab from profile",
				params: [
					{ name: "profileId", kind: "string", optional: true },
					{ name: "profileName", kind: "string", optional: true },
				],
			},
			{
				name: "quick_connect",
				summary: "SSH quick-connect",
				params: [
					{
						name: "target",
						kind: "string",
						placeholder: "user@host or ssh://user@host:22",
					},
				],
			},
		],
	},
	{
		name: "SFTP",
		tools: [
			{
				name: "sftp_list_files",
				summary: "List remote directory",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "path", kind: "string" },
				],
			},
			{
				name: "sftp_read_file",
				summary: "Read remote file",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "path", kind: "string" },
					{ name: "encoding", kind: "string", optional: true },
				],
			},
			{
				name: "sftp_write_file",
				summary: "Write remote file",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "path", kind: "string" },
					{ name: "content", kind: "string" },
					{ name: "encoding", kind: "string", optional: true },
				],
			},
			{
				name: "sftp_upload",
				summary: "Upload local → remote",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "localPath", kind: "string" },
					{ name: "remotePath", kind: "string" },
				],
			},
			{
				name: "sftp_download",
				summary: "Download remote → local",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "remotePath", kind: "string" },
					{ name: "localPath", kind: "string" },
				],
			},
			{
				name: "sftp_delete",
				summary: "Delete remote path",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "path", kind: "string" },
				],
			},
			{
				name: "sftp_mkdir",
				summary: "Create remote directory",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "path", kind: "string" },
				],
			},
			{
				name: "sftp_rename",
				summary: "Move/rename remote",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "from", kind: "string" },
					{ name: "to", kind: "string" },
				],
			},
			{
				name: "sftp_stat",
				summary: "Stat remote path",
				params: [
					{ name: "sessionId", kind: "string", optional: true },
					{ name: "path", kind: "string" },
				],
			},
			{
				name: "sftp_list_transfers",
				summary: "List active transfers",
				params: [{ name: "sessionId", kind: "string", optional: true }],
			},
			{
				name: "sftp_get_transfer_status",
				summary: "Check transfer progress",
				params: [{ name: "transferId", kind: "string" }],
			},
			{
				name: "sftp_cancel_transfer",
				summary: "Cancel transfer",
				params: [{ name: "transferId", kind: "string" }],
			},
		],
	},
];

const ALL_TOOLS: ToolDef[] = GROUPS.flatMap((g) => g.tools);

export function TabbyMcpPage() {
	const [selected, setSelected] = useState<string>(ALL_TOOLS[0].name);
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<unknown>(null);
	const [error, setError] = useState<string | null>(null);

	const tool = useMemo(
		() => ALL_TOOLS.find((t) => t.name === selected) ?? ALL_TOOLS[0],
		[selected],
	);

	function setVal(name: string, v: string) {
		setValues((s) => ({ ...s, [name]: v }));
	}

	function clearForm() {
		setValues({});
		setResult(null);
		setError(null);
	}

	async function run() {
		setBusy(true);
		setError(null);
		setResult(null);
		const args: Record<string, unknown> = {};
		for (const p of tool.params) {
			const raw = values[p.name];
			if (raw == null || raw === "") {
				if (!p.optional) {
					setBusy(false);
					setError(`Missing required param: ${p.name}`);
					return;
				}
				continue;
			}
			if (p.kind === "number") {
				const n = Number(raw);
				if (Number.isNaN(n)) {
					setBusy(false);
					setError(`${p.name} must be a number`);
					return;
				}
				args[p.name] = n;
			} else if (p.kind === "boolean") {
				args[p.name] = raw === "true";
			} else if (p.kind === "json") {
				try {
					args[p.name] = JSON.parse(raw);
				} catch (err) {
					setBusy(false);
					setError(`${p.name} must be valid JSON: ${(err as Error).message}`);
					return;
				}
			} else {
				args[p.name] = raw;
			}
		}
		try {
			const res = await fetch(`/api/tabby/mcp/${tool.name}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(args),
			});
			const data = (await res.json()) as {
				ok: boolean;
				result?: unknown;
				error?: string;
			};
			if (!res.ok || !data.ok) {
				setError(data.error ?? `HTTP ${res.status}`);
			} else {
				setResult(data.result);
			}
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-center justify-between gap-2">
				<div>
					<div className="flex items-center gap-2 text-sm text-[var(--muted)]">
						<Link to="/tabby" className="hover:underline">
							Tabby
						</Link>
						<span>/</span>
						<span>MCP tools</span>
					</div>
					<h1 className="text-2xl font-bold">Tabby MCP playground</h1>
					<p className="text-sm text-[var(--muted)]">
						Every tabby-mcp tool exposed as a form — proxied through{" "}
						<code className="text-xs">POST /api/tabby/mcp/:tool</code>.
					</p>
				</div>
			</header>

			<div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
				<aside className="border border-[var(--border)] rounded-lg bg-[var(--card)] overflow-hidden">
					{GROUPS.map((group) => (
						<div key={group.name}>
							<div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)] bg-[var(--bg)] border-b border-[var(--border)]">
								{group.name}
							</div>
							{group.tools.map((t) => (
								<button
									type="button"
									key={t.name}
									onClick={() => {
										setSelected(t.name);
										clearForm();
									}}
									className={`block w-full text-left px-3 py-1.5 text-sm border-b border-[var(--border)] ${
										t.name === selected
											? "bg-[var(--accent)] text-white"
											: "hover:bg-[var(--border)]"
									}`}
								>
									<div className="font-mono text-xs">{t.name}</div>
									<div
										className={`text-[11px] truncate ${
											t.name === selected
												? "text-white/80"
												: "text-[var(--muted)]"
										}`}
									>
										{t.summary}
									</div>
								</button>
							))}
						</div>
					))}
				</aside>

				<section className="flex flex-col gap-3 min-w-0">
					<div className="border border-[var(--border)] rounded-lg p-4 bg-[var(--card)]">
						<div className="flex items-center justify-between gap-2 mb-3">
							<div>
								<div className="font-mono text-sm font-semibold">
									{tool.name}
								</div>
								<div className="text-xs text-[var(--muted)]">
									{tool.summary}
								</div>
							</div>
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									onClick={clearForm}
									className="px-2 py-1 rounded text-xs border border-[var(--border)] hover:bg-[var(--border)]"
								>
									Clear
								</button>
								<button
									type="button"
									onClick={run}
									disabled={busy}
									className="px-3 py-1 rounded text-sm bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
								>
									{busy ? "Running…" : "Run"}
								</button>
							</div>
						</div>

						{tool.params.length === 0 ? (
							<div className="text-xs text-[var(--muted)]">No parameters.</div>
						) : (
							<div className="grid grid-cols-1 md:grid-cols-2 gap-2">
								{tool.params.map((p) => {
									const inputId = `${tool.name}-${p.name}`;
									return (
										<div key={p.name} className="flex flex-col gap-1 text-xs">
											<label
												htmlFor={inputId}
												className="font-mono text-[var(--muted)]"
											>
												{p.name}
												{p.optional ? (
													<span className="text-[10px] ml-1 opacity-60">?</span>
												) : (
													<span className="text-[10px] ml-1 text-[var(--danger)]">
														*
													</span>
												)}
												<span className="text-[10px] ml-1 opacity-60">
													({p.kind})
												</span>
											</label>
											{p.kind === "boolean" ? (
												<select
													id={inputId}
													value={values[p.name] ?? ""}
													onChange={(e) => setVal(p.name, e.target.value)}
													className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-xs"
												>
													<option value="">—</option>
													<option value="true">true</option>
													<option value="false">false</option>
												</select>
											) : (
												<input
													id={inputId}
													type={p.kind === "number" ? "number" : "text"}
													value={values[p.name] ?? ""}
													onChange={(e) => setVal(p.name, e.target.value)}
													placeholder={p.placeholder ?? ""}
													className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-xs font-mono"
												/>
											)}
										</div>
									);
								})}
							</div>
						)}

						{error && (
							<div className="mt-3 p-2 rounded bg-[var(--bg)] border border-[var(--danger)] text-xs text-[var(--danger)]">
								{error}
							</div>
						)}
					</div>

					{result != null && (
						<div className="border border-[var(--border)] rounded-lg p-4 bg-[var(--card)]">
							<div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
								Result
							</div>
							<pre className="text-[11px] font-mono whitespace-pre-wrap max-h-[60vh] overflow-y-auto p-2 rounded bg-[var(--bg)] border border-[var(--border)]">
								{JSON.stringify(result, null, 2)}
							</pre>
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
