import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { StorageKey } from "./enums/StorageKey";

// localStorage wrapper that drops the cache instead of throwing when the
// browser quota is exceeded. Cached endpoint data is derived state, so losing
// it only costs a refetch — better than crashing every fetchEndpoint call.
const quotaSafeStorage = createJSONStorage(() => ({
	getItem: (name) => localStorage.getItem(name),
	setItem: (name, value) => {
		try {
			localStorage.setItem(name, value);
		} catch (err) {
			const isQuota =
				err instanceof DOMException &&
				(err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
			if (!isQuota) throw err;
			console.warn("[store] localStorage quota exceeded — dropping cache");
			localStorage.removeItem(name);
		}
	},
	removeItem: (name) => localStorage.removeItem(name),
}));

interface CacheEntry {
	data: unknown;
	fetchedAt: number;
	loading: boolean;
}

interface AppStore {
	cache: Record<string, CacheEntry>;
	refreshInterval: number;

	fetchEndpoint: (key: string, url: string) => Promise<void>;
	invalidate: (key: string) => void;
	invalidateAll: () => void;
	setRefreshInterval: (ms: number) => void;
}

export const useStore = create<AppStore>()(
	persist(
		(set, get) => ({
			cache: {},
			// 1h default — endpoints can override via useCachedEndpoint({ staleAfter }).
			refreshInterval: 3_600_000,

			fetchEndpoint: async (key, url) => {
				set((s) => ({
					cache: {
						...s.cache,
						[key]: {
							data: s.cache[key]?.data ?? null,
							fetchedAt: s.cache[key]?.fetchedAt ?? 0,
							loading: true,
						},
					},
				}));
				try {
					const res = await fetch(url);
					const data = await res.json();
					set((s) => ({
						cache: {
							...s.cache,
							[key]: { data, fetchedAt: Date.now(), loading: false },
						},
					}));
				} catch {
					set((s) => ({
						cache: {
							...s.cache,
							[key]: { ...s.cache[key], loading: false },
						},
					}));
				}
			},

			invalidate: (key) => {
				const { cache } = get();
				if (cache[key]) {
					set((s) => ({
						cache: {
							...s.cache,
							[key]: { ...s.cache[key], fetchedAt: 0, loading: false },
						},
					}));
				}
			},

			invalidateAll: () => {
				const { cache } = get();
				const updated: Record<string, CacheEntry> = {};
				for (const [k, v] of Object.entries(cache)) {
					updated[k] = { ...v, fetchedAt: 0 };
				}
				set({ cache: updated });
			},

			setRefreshInterval: (ms) => set({ refreshInterval: ms }),
		}),
		{
			name: StorageKey.Cache,
			storage: quotaSafeStorage,
			partialize: (state) => ({
				cache: Object.fromEntries(
					Object.entries(state.cache).map(([k, v]) => [
						k,
						{ data: v.data, fetchedAt: v.fetchedAt, loading: false },
					]),
				),
				refreshInterval: state.refreshInterval,
			}),
		},
	),
);
