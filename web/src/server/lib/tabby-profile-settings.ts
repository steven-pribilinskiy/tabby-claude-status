import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDataDir } from "./data-dir.js";

export interface ProfileSetting {
	// Milliseconds to wait after a new session appears in get_session_list
	// before sending `cd <cwd> && <command>`. WSL cold boot + oh-my-zsh can
	// take 1–2s to reach an interactive prompt; sending input earlier silently
	// drops characters or runs them against the wrong shell state.
	openDelayMs?: number;
}

export interface TabbyProfileSettingsFile {
	version: 1;
	defaults: ProfileSetting;
	profiles: Record<string, ProfileSetting>;
}

const DEFAULT_OPEN_DELAY_MS = 1500;

const EMPTY: TabbyProfileSettingsFile = {
	version: 1,
	defaults: { openDelayMs: DEFAULT_OPEN_DELAY_MS },
	profiles: {},
};

function filePath(): string {
	return resolve(getDataDir(), "tabby-profile-settings.json");
}

export async function readProfileSettings(): Promise<TabbyProfileSettingsFile> {
	try {
		const raw = await readFile(filePath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<TabbyProfileSettingsFile>;
		return {
			version: 1,
			defaults: { ...EMPTY.defaults, ...(parsed.defaults ?? {}) },
			profiles: parsed.profiles ?? {},
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
		throw err;
	}
}

export async function writeProfileSettings(
	settings: TabbyProfileSettingsFile,
): Promise<void> {
	const path = filePath();
	const tmp = `${path}.tmp`;
	await writeFile(tmp, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
	await rename(tmp, path);
}

export async function upsertProfileSetting(
	profileId: string,
	patch: ProfileSetting,
): Promise<TabbyProfileSettingsFile> {
	const current = await readProfileSettings();
	current.profiles[profileId] = {
		...(current.profiles[profileId] ?? {}),
		...patch,
	};
	await writeProfileSettings(current);
	return current;
}

export async function deleteProfileSetting(
	profileId: string,
): Promise<TabbyProfileSettingsFile> {
	const current = await readProfileSettings();
	delete current.profiles[profileId];
	await writeProfileSettings(current);
	return current;
}

export async function getOpenDelayMs(profileId: string): Promise<number> {
	const cfg = await readProfileSettings();
	const profile = cfg.profiles[profileId]?.openDelayMs;
	if (typeof profile === "number") return profile;
	return cfg.defaults.openDelayMs ?? DEFAULT_OPEN_DELAY_MS;
}
