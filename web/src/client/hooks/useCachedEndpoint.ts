import { useCallback, useEffect } from "react";
import { useStore } from "../store";

interface Options {
	// Override the global refresh interval for this specific call. When set,
	// the data is considered fresh until `staleAfter` ms has passed since the
	// last fetch. Useful for expensive endpoints (tools detection, networking
	// scans) that should NOT refetch on every page visit.
	staleAfter?: number;
	// When true, no automatic fetch is ever triggered — caller drives refreshes
	// manually via the returned `refresh` callback. Useful when a page owns an
	// SSE stream that supplies the data and the REST endpoint is only a
	// fallback / manual re-fetch path.
	manual?: boolean;
}

export function useCachedEndpoint<T = unknown>(
	key: string,
	url: string,
	options: Options = {},
) {
	const data = useStore((s) => s.cache[key]?.data ?? null) as T | null;
	const fetchedAt = useStore((s) => s.cache[key]?.fetchedAt ?? 0);
	const loading = useStore((s) => s.cache[key]?.loading ?? false);
	const fetchEndpoint = useStore((s) => s.fetchEndpoint);
	const globalRefreshInterval = useStore((s) => s.refreshInterval);

	const effectiveInterval = options.staleAfter ?? globalRefreshInterval;

	const refresh = useCallback(() => {
		fetchEndpoint(key, url);
	}, [key, url, fetchEndpoint]);

	const stale =
		fetchedAt === 0 ||
		(effectiveInterval > 0 && Date.now() - fetchedAt > effectiveInterval);

	// Initial fetch — when never fetched or stale beyond the interval
	useEffect(() => {
		if (options.manual) return;
		if (loading) return;
		if (stale) refresh();
	}, [stale, loading, refresh, options.manual]);

	// Auto-refresh interval
	useEffect(() => {
		if (options.manual) return;
		if (effectiveInterval <= 0) return;
		const id = setInterval(() => {
			fetchEndpoint(key, url);
		}, effectiveInterval);
		return () => clearInterval(id);
	}, [key, url, effectiveInterval, fetchEndpoint, options.manual]);

	return {
		data,
		loading: loading || (fetchedAt === 0 && !data),
		fetchedAt,
		isStale: stale,
		refresh,
	};
}
