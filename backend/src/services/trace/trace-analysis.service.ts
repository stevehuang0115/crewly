/**
 * Reads whole traces and serves their autonomy metrics, timeline and summary
 * (specs/2026-10-03-autonomy-metrics.md §API). Metrics are cached per trace,
 * keyed by its event count, last event and the stall threshold, for
 * METRICS_CACHE_TTL_MS (an ongoing stall keeps growing with the clock).
 *
 * @module services/trace/trace-analysis.service
 */

import { TRACE_CONSTANTS } from '../../constants.js';
import { getTraceStore, type TraceStore } from './trace-store.js';
import { clampStallMinutes, computeTraceMetrics, defaultStallMinutes, summarizeTraceMetrics, type TraceMetrics, type TraceMetricsSummary } from './trace-metrics.js';
import { buildTimelineGroups, type TimelineGroup } from './trace-timeline.js';
import { buildTraceSummary, type TraceSummary } from './trace-summary.js';
import type { TraceEvent, TraceIndexEntry, TraceRoot } from './trace.types.js';

/** A whole trace. */
export interface FullTrace {
	root: TraceRoot;
	events: TraceEvent[];
	truncated: boolean;
}

/** `GET /api/traces/:id/timeline`. */
export interface TraceTimelineResponse {
	root: TraceRoot;
	metrics: TraceMetrics;
	groups: TimelineGroup[];
	truncated: boolean;
}

/** A cached metrics result. */
interface CacheEntry {
	key: string;
	at: number;
	metrics: TraceMetrics;
}

/**
 * Trace reader with a metrics cache. One per process (see {@link getTraceAnalysis}).
 */
export class TraceAnalysisService {
	private readonly cache = new Map<string, CacheEntry>();

	/**
	 * @param storeOf - Store accessor (default: the process-wide store)
	 * @param now - Clock (ms)
	 */
	constructor(
		private readonly storeOf: () => TraceStore = getTraceStore,
		private readonly now: () => number = () => Date.now(),
	) {}

	/**
	 * Every event of a trace (all pages).
	 *
	 * @param traceId - Trace id (validated by the caller)
	 * @returns Root, events and the truncated flag, or null when unknown
	 */
	async readAll(traceId: string): Promise<FullTrace | null> {
		const store = this.storeOf();
		const events: TraceEvent[] = [];
		let offset = 0;
		let root: TraceRoot | null = null;
		let truncated = false;
		for (;;) {
			const page = await store.read(traceId, offset, TRACE_CONSTANTS.MAX_PAGE_SIZE);
			if (!page) return root ? { root, events, truncated } : null;
			root = page.root;
			truncated = page.truncated;
			events.push(...page.events);
			offset += page.events.length;
			if (page.events.length === 0 || offset >= page.total) break;
		}
		return { root, events, truncated };
	}

	/**
	 * Metrics of a trace (cached).
	 *
	 * @param traceId - Trace id
	 * @param stallMinutes - Stall threshold (default {@link defaultStallMinutes})
	 * @param full - The trace, when the caller already read it
	 * @returns Metrics, or null when the trace is unknown
	 */
	async metrics(traceId: string, stallMinutes?: number, full?: FullTrace): Promise<TraceMetrics | null> {
		const entry = this.storeOf().getEntry(traceId);
		if (!entry) return null;
		const minutes = clampStallMinutes(stallMinutes ?? defaultStallMinutes());
		const key = `${entry.eventCount}|${entry.updatedAt}|${minutes}`;
		const cached = this.cache.get(traceId);
		const now = this.now();
		if (cached && cached.key === key && now - cached.at < TRACE_CONSTANTS.METRICS_CACHE_TTL_MS) return cached.metrics;
		const trace = full ?? (await this.readAll(traceId));
		if (!trace) return null;
		const metrics = computeTraceMetrics(trace.root, trace.events, { stallMinutes: minutes, now: new Date(now) });
		this.cache.delete(traceId);
		this.cache.set(traceId, { key, at: now, metrics });
		while (this.cache.size > TRACE_CONSTANTS.METRICS_CACHE_MAX) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
		return metrics;
	}

	/**
	 * The grouped timeline of a trace.
	 *
	 * @param traceId - Trace id
	 * @param stallMinutes - Stall threshold
	 * @returns Root, metrics, groups, or null when unknown
	 */
	async timeline(traceId: string, stallMinutes?: number): Promise<TraceTimelineResponse | null> {
		const trace = await this.readAll(traceId);
		if (!trace) return null;
		const metrics = await this.metrics(traceId, stallMinutes, trace);
		if (!metrics) return null;
		const groups = buildTimelineGroups(trace.events, metrics.stalls.items, metrics.stalls.thresholdMinutes * 60_000);
		return { root: trace.root, metrics, groups, truncated: trace.truncated };
	}

	/**
	 * The compact summary `trace-read` prints.
	 *
	 * @param traceId - Trace id
	 * @param maxChars - Size bound
	 * @param stallMinutes - Stall threshold
	 * @returns Summary and metrics, or null when unknown
	 */
	async summary(traceId: string, maxChars?: number, stallMinutes?: number): Promise<(TraceSummary & { metrics: TraceMetrics }) | null> {
		const trace = await this.readAll(traceId);
		if (!trace) return null;
		const metrics = await this.metrics(traceId, stallMinutes, trace);
		if (!metrics) return null;
		return { ...buildTraceSummary(trace.root, trace.events, metrics, maxChars), metrics };
	}

	/**
	 * Metrics summaries for list rows (a trace that fails to read gets none).
	 *
	 * @param entries - Index entries
	 * @param stallMinutes - Stall threshold
	 * @returns Entries with `metrics`
	 */
	async withMetrics(entries: ReadonlyArray<TraceIndexEntry>, stallMinutes?: number): Promise<Array<TraceIndexEntry & { metrics?: TraceMetricsSummary }>> {
		const out: Array<TraceIndexEntry & { metrics?: TraceMetricsSummary }> = [];
		for (const entry of entries) {
			try {
				const m = await this.metrics(entry.traceId, stallMinutes);
				out.push(m ? { ...entry, metrics: summarizeTraceMetrics(m) } : { ...entry });
			} catch {
				out.push({ ...entry });
			}
		}
		return out;
	}

	/** Forget cached metrics (tests). */
	clear(): void {
		this.cache.clear();
	}
}

let instance: TraceAnalysisService | null = null;

/**
 * The process-wide trace analysis service.
 *
 * @returns The service (created on first use)
 */
export function getTraceAnalysis(): TraceAnalysisService {
	if (!instance) instance = new TraceAnalysisService();
	return instance;
}

/**
 * Replace the process-wide service (tests).
 *
 * @param service - Service, or null to rebuild the default lazily
 */
export function setTraceAnalysisForTesting(service: TraceAnalysisService | null): void {
	instance = service;
}
