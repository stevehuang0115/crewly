/**
 * Run traces API client (read-only: `GET /api/traces/...`,
 * specs/2026-10-03-autonomy-metrics.md §API).
 *
 * Uses `fetch` (the API-token guard installed in `main.tsx` adds the token
 * header to same-origin calls) and unwraps `{ success, data }`.
 *
 * @module services/traces.service
 */

import type { TraceMetrics, TraceRefParam, TraceRoot, TraceTimelineData } from '../types/trace.types';

/** Base path of the traces API. */
export const TRACES_API_BASE = '/api/traces';

/** A failed traces call, with its HTTP status (404 = no trace). */
export class TraceApiError extends Error {
	/**
	 * @param message - Server error text
	 * @param status - HTTP status
	 */
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = 'TraceApiError';
	}
}

/**
 * GET a traces endpoint and unwrap the envelope.
 *
 * @param path - Path under {@link TRACES_API_BASE} (with query string)
 * @returns The `data` field
 * @throws TraceApiError on a non-2xx status or `success: false`
 */
async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${TRACES_API_BASE}${path}`);
	let body: { success?: boolean; data?: T; error?: string } = {};
	try {
		body = (await res.json()) as typeof body;
	} catch {
		body = {};
	}
	if (!res.ok || body.success === false) throw new TraceApiError(body.error || `HTTP ${res.status}`, res.status);
	return body.data as T;
}

/**
 * Query string for the stall threshold.
 *
 * @param stallMinutes - Minutes, if any
 * @returns `?stallMinutes=N` or ''
 */
function stallQuery(stallMinutes?: number): string {
	return stallMinutes ? `?stallMinutes=${encodeURIComponent(String(stallMinutes))}` : '';
}

/**
 * The trace of an entity.
 *
 * @param param - Which kind of id
 * @param id - The id
 * @returns `{ traceId, root }`, or null when the entity has no trace (404)
 * @throws TraceApiError on other failures
 */
export async function fetchTraceByRef(param: TraceRefParam, id: string): Promise<{ traceId: string; root: TraceRoot } | null> {
	try {
		return await get<{ traceId: string; root: TraceRoot }>(`/by-ref?${param}=${encodeURIComponent(id)}`);
	} catch (err) {
		if (err instanceof TraceApiError && err.status === 404) return null;
		throw err;
	}
}

/**
 * A trace's grouped timeline with its metrics.
 *
 * @param traceId - Trace id
 * @param stallMinutes - Stall threshold (default: the backend's)
 * @returns Root, metrics, groups
 */
export function fetchTraceTimeline(traceId: string, stallMinutes?: number): Promise<TraceTimelineData> {
	return get<TraceTimelineData>(`/${encodeURIComponent(traceId)}/timeline${stallQuery(stallMinutes)}`);
}

/**
 * A trace's metrics.
 *
 * @param traceId - Trace id
 * @param stallMinutes - Stall threshold
 * @returns Metrics
 */
export function fetchTraceMetrics(traceId: string, stallMinutes?: number): Promise<TraceMetrics> {
	return get<TraceMetrics>(`/${encodeURIComponent(traceId)}/metrics${stallQuery(stallMinutes)}`);
}
