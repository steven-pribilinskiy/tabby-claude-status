import { resolve } from "node:path";

/**
 * Resolve the directory where tabby-sessions.json and tabby-profile-settings.json
 * live. Driven by DATA_DIR env (set in docker-compose to /app/data); falls back
 * to ./data relative to the process cwd for local dev.
 */
export function getDataDir(): string {
	return resolve(process.env.DATA_DIR ?? "./data");
}
