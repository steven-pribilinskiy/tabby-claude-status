import { NavLink, Outlet } from "react-router-dom";

interface NavItem {
	to: string;
	label: string;
}

const NAV: NavItem[] = [
	{ to: "/tabby", label: "Sessions" },
	{ to: "/tabby/mcp", label: "MCP tools" },
];

const ALL_PATHS = NAV.map((n) => n.to);
const isParentOfAnother = (path: string) =>
	ALL_PATHS.some((p) => p !== path && p.startsWith(`${path}/`));

export function Layout() {
	return (
		<div className="flex h-screen overflow-hidden">
			<nav className="w-52 border-r border-[var(--border)] flex flex-col overflow-hidden">
				<div className="px-4 pt-4 pb-3 border-b border-[var(--border)] shrink-0">
					<h1 className="text-base font-bold mb-0.5">tabby-claude-status</h1>
					<div className="text-[11px] text-[var(--muted)]">
						Tabby control panel
					</div>
				</div>
				<div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-0.5">
					{NAV.map((link) => (
						<NavLink
							key={link.to}
							to={link.to}
							end={isParentOfAnother(link.to)}
							className={({ isActive }) =>
								`block px-3 py-1.5 rounded text-sm ${
									isActive
										? "bg-[var(--accent)] text-white"
										: "text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--border)]"
								}`
							}
						>
							{link.label}
						</NavLink>
					))}
				</div>
				<div className="px-4 py-3 border-t border-[var(--border)] shrink-0">
					<a
						href="https://github.com/steven-pribilinskiy/tabby-claude-status"
						target="_blank"
						rel="noreferrer"
						className="text-[11px] text-[var(--muted)] hover:text-[var(--text)]"
					>
						GitHub →
					</a>
				</div>
			</nav>
			<main className="flex-1 p-6 overflow-y-auto">
				<Outlet />
			</main>
		</div>
	);
}
