import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src/client"),
		},
	},
	build: {
		// In production, the SPA is built into ./public so the Hono server can
		// serve it under the same origin as /api.
		outDir: "public",
		emptyOutDir: true,
	},
	server: {
		host: true,
		port: 5173,
		allowedHosts: ["tabby-claude-status.lvh.me"],
		proxy: {
			"/api": "http://localhost:3000",
		},
	},
});
