import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import claudeHookRoutes from "./routes/claude-hook.js";
import tabbyRoutes from "./routes/tabby.js";

// Path of the built SPA, relative to process.cwd(). In Docker, WORKDIR=/app so
// `public/` resolves to /app/public; locally, run the server from the web/
// directory and `public/` resolves to web/public after `vite build`. In dev,
// Vite serves the SPA itself on :5173 and proxies /api here, so this dir is
// allowed to be missing.
const STATIC_ROOT = "./public";
const STATIC_AVAILABLE = existsSync(resolve(STATIC_ROOT));

const app = new Hono();

app.use("*", cors());

app.route("/api/tabby", tabbyRoutes);
app.route("/api/claude", claudeHookRoutes);

app.get("/healthz", (c) => c.json({ ok: true }));

if (STATIC_AVAILABLE) {
	app.use("/*", serveStatic({ root: STATIC_ROOT }));
	// SPA fallback: every unmatched non-/api request returns index.html so
	// react-router can take over client-side.
	app.notFound(async (c) => {
		try {
			const html = await readFile(resolve(STATIC_ROOT, "index.html"), "utf-8");
			return c.html(html);
		} catch {
			return c.text("Not found", 404);
		}
	});
}

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";

console.log(`tabby-claude-status web listening on http://${hostname}:${port}`);
serve({ fetch: app.fetch, port, hostname });
