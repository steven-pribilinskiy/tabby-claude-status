import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:3001/mcp";

export interface TabbyListTabsEntry {
	tabId: string;
	tabIndex: number;
	title: string;
	type: string;
	isActive: boolean;
	hasFocus: boolean;
	color: string | null;
	isTerminal: boolean;
}

export interface TabbySessionEntry {
	sessionId: string;
	tabIndex: number;
	title: string;
	type: string;
	isActive: boolean;
	hasActiveCommand: boolean;
	profile: { id: string; name: string; type: string };
	isSplit: boolean;
	splitTabIndex: number;
	paneIndex: number;
	totalPanes: number;
	isFocusedPane: boolean;
}

export class TabbyMcpError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "TabbyMcpError";
	}
}

/**
 * Tabby MCP plugin runs an Express server inside the Tabby desktop process
 * (tabby-mcp-server, https://github.com/GentlemanHu/Tabby-MCP). It exposes
 * every Tabby operation we care about — tabs, sessions, profiles, SFTP —
 * over StreamableHTTP transport at 127.0.0.1:3001/mcp by default.
 */
class TabbyMcpClient {
	private client: Client | null = null;
	private connecting: Promise<Client> | null = null;

	constructor(private endpoint: string = DEFAULT_ENDPOINT) {}

	private async connect(): Promise<Client> {
		if (this.client) return this.client;
		if (this.connecting) return this.connecting;
		this.connecting = (async () => {
			const transport = new StreamableHTTPClientTransport(new URL(this.endpoint));
			const client = new Client(
				{ name: "windows-settings", version: "1.0.0" },
				{ capabilities: {} },
			);
			await client.connect(transport);
			this.client = client;
			this.connecting = null;
			return client;
		})();
		try {
			return await this.connecting;
		} catch (err) {
			this.connecting = null;
			throw err;
		}
	}

	private reset(): void {
		try {
			this.client?.close();
		} catch {
			// ignore
		}
		this.client = null;
	}

	async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
		let attempt = 0;
		while (true) {
			try {
				const client = await this.connect();
				const res = await client.callTool({ name, arguments: args });
				return parseToolResult<T>(res);
			} catch (err) {
				this.reset();
				attempt++;
				if (attempt >= 2) {
					throw new TabbyMcpError(`MCP call ${name} failed: ${(err as Error).message}`, err);
				}
			}
		}
	}

	// ---- Tabs -------------------------------------------------------------
	listTabs = () => this.callTool<{ tabs: TabbyListTabsEntry[]; count: number }>("list_tabs");
	selectTab = (args: { tabId?: string; tabIndex?: number }) => this.callTool("select_tab", args);
	closeTab = (args: { tabId?: string; tabIndex?: number }) => this.callTool("close_tab", args);
	closeAllTabs = () => this.callTool("close_all_tabs");
	duplicateTab = (args: { tabId?: string; tabIndex?: number }) =>
		this.callTool("duplicate_tab", args);
	moveTabLeft = (args: { tabId?: string; tabIndex?: number }) =>
		this.callTool("move_tab_left", args);
	moveTabRight = (args: { tabId?: string; tabIndex?: number }) =>
		this.callTool("move_tab_right", args);
	nextTab = () => this.callTool("next_tab");
	previousTab = () => this.callTool("previous_tab");
	reopenLastTab = () => this.callTool("reopen_last_tab");
	splitTab = (args: { tabId?: string; tabIndex?: number; direction?: string }) =>
		this.callTool("split_tab", args);
	focusPane = (args: { tabId?: string; tabIndex?: number; paneIndex: number }) =>
		this.callTool("focus_pane", args);

	// ---- Sessions ---------------------------------------------------------
	getSessionList = () => this.callTool<TabbySessionEntry[]>("get_session_list");
	getTerminalBuffer = (args: {
		sessionId?: string;
		tabIndex?: number;
		title?: string;
		profileName?: string;
		startLine?: number;
		endLine?: number;
		lastNLines?: number;
	}) =>
		this.callTool<{
			success: boolean;
			sessionId?: string;
			tabIndex?: number;
			totalLines?: number;
			returnedLines?: number;
			content: string;
		}>("get_terminal_buffer", args);
	sendInput = (args: {
		sessionId?: string;
		tabIndex?: number;
		title?: string;
		profileName?: string;
		text: string;
		addNewline?: boolean;
	}) => this.callTool("send_input", args);
	execCommand = (args: {
		sessionId?: string;
		tabIndex?: number;
		title?: string;
		profileName?: string;
		command: string;
		timeout?: number;
		waitForOutput?: boolean;
	}) => this.callTool("exec_command", args);
	abortCommand = (args: { sessionId?: string; tabIndex?: number }) =>
		this.callTool("abort_command", args);
	getCommandStatus = (args: { sessionId?: string; tabIndex?: number }) =>
		this.callTool("get_command_status", args);

	// ---- Profiles ---------------------------------------------------------
	listProfiles = () => this.callTool("list_profiles");
	openProfile = (args: { profileId?: string; profileName?: string }) =>
		this.callTool("open_profile", args);
	quickConnect = (args: { target: string }) => this.callTool("quick_connect", args);
	showProfileSelector = () => this.callTool("show_profile_selector");

	// ---- SFTP -------------------------------------------------------------
	sftpListFiles = (args: { sessionId?: string; path: string }) =>
		this.callTool("sftp_list_files", args);
	sftpReadFile = (args: { sessionId?: string; path: string; encoding?: string }) =>
		this.callTool("sftp_read_file", args);
	sftpWriteFile = (args: {
		sessionId?: string;
		path: string;
		content: string;
		encoding?: string;
	}) => this.callTool("sftp_write_file", args);
	sftpUpload = (args: { sessionId?: string; localPath: string; remotePath: string }) =>
		this.callTool("sftp_upload", args);
	sftpDownload = (args: { sessionId?: string; remotePath: string; localPath: string }) =>
		this.callTool("sftp_download", args);
	sftpDelete = (args: { sessionId?: string; path: string }) => this.callTool("sftp_delete", args);
	sftpMkdir = (args: { sessionId?: string; path: string }) => this.callTool("sftp_mkdir", args);
	sftpRename = (args: { sessionId?: string; from: string; to: string }) =>
		this.callTool("sftp_rename", args);
	sftpStat = (args: { sessionId?: string; path: string }) => this.callTool("sftp_stat", args);
	sftpListTransfers = (args: { sessionId?: string } = {}) =>
		this.callTool("sftp_list_transfers", args);
	sftpGetTransferStatus = (args: { transferId: string }) =>
		this.callTool("sftp_get_transfer_status", args);
	sftpCancelTransfer = (args: { transferId: string }) =>
		this.callTool("sftp_cancel_transfer", args);

	async health(): Promise<boolean> {
		try {
			await this.listTabs();
			return true;
		} catch {
			return false;
		}
	}
}

function parseToolResult<T>(res: unknown): T {
	const content = (res as { content?: Array<{ type: string; text?: string }> })?.content;
	if (!Array.isArray(content) || content.length === 0) {
		return res as T;
	}
	// tabby-mcp returns a single { type: 'text', text: JSON-string } block
	const first = content[0];
	if (first?.type === "text" && typeof first.text === "string") {
		try {
			return JSON.parse(first.text) as T;
		} catch {
			return first.text as unknown as T;
		}
	}
	return content as unknown as T;
}

export const tabbyMcp = new TabbyMcpClient(process.env.TABBY_MCP_URL ?? DEFAULT_ENDPOINT);

export function getTabbyMcpEndpoint(): string {
	return process.env.TABBY_MCP_URL ?? DEFAULT_ENDPOINT;
}
