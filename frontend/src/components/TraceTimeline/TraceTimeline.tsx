/**
 * Run timeline (specs/2026-10-03-autonomy-metrics.md §UI): the metrics strip,
 * then one vertical list of the run's turns, owner actions, harness activity
 * and stalls. Loads `GET /api/traces/:id/timeline`, finding the trace from an
 * entity (`by-ref`) when no trace id is known.
 *
 * @module components/TraceTimeline/TraceTimeline
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { EmptyState } from '@crewly/ui/EmptyState';
import { IconButton, Button } from '@crewly/ui/Button';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import type { TraceRefParam, TraceTimelineData } from '../../types/trace.types';
import { fetchTraceByRef, fetchTraceTimeline } from '../../services/traces.service';
import { MetricsStrip } from './MetricsStrip';
import { TimelineGroupRow } from './TimelineGroupRow';

export interface TraceTimelineProps {
	/** The trace, when known */
	traceId?: string | null;
	/** Otherwise: look it up from an entity */
	refParam?: TraceRefParam;
	refId?: string;
	/** Display name of an agent session */
	nameOf?: (session: string) => string;
	/**
	 * Reload after N ms while the run is not finished (0 = never; default 30 s).
	 * The interval doubles each time nothing changed (up to
	 * {@link TRACE_TIMELINE_MAX_POLL_MS}) and polling pauses while the tab is hidden.
	 */
	pollMs?: number;
	/** Clock for times (tests) */
	now?: Date;
	/** Told about every successful load (a page title from the root) */
	onLoaded?: (data: TraceTimelineData) => void;
}

/** Default reload interval of an unfinished run. */
export const TRACE_TIMELINE_POLL_MS = 30_000;
/** Longest interval the poll backs off to when the run does not change. */
export const TRACE_TIMELINE_MAX_POLL_MS = 5 * 60_000;

/** States after which a run no longer changes on its own. */
const FINISHED = new Set(['done', 'cancelled', 'failed']);

/** What the component is showing. */
type View = { kind: 'loading' } | { kind: 'none' } | { kind: 'error'; message: string } | { kind: 'ready'; data: TraceTimelineData };

/**
 * Run timeline.
 *
 * @param props - {@link TraceTimelineProps}
 * @returns The timeline
 */
export const TraceTimeline: React.FC<TraceTimelineProps> = ({ traceId, refParam, refId, nameOf, pollMs = TRACE_TIMELINE_POLL_MS, now, onLoaded }) => {
	const [view, setView] = useState<View>({ kind: 'loading' });
	const [refreshing, setRefreshing] = useState(false);
	const resolved = useRef<string | null>(traceId ?? null);
	/** Event count + last event of the last load, and how many polls in a row saw no change */
	const lastKey = useRef<string | null>(null);
	const unchanged = useRef(0);
	const onLoadedRef = useRef(onLoaded);
	onLoadedRef.current = onLoaded;

	const load = useCallback(
		async (quiet: boolean): Promise<void> => {
			if (quiet) setRefreshing(true);
			try {
				let id = traceId ?? resolved.current;
				if (!id && refParam && refId) {
					const hit = await fetchTraceByRef(refParam, refId);
					id = hit?.traceId ?? null;
				}
				if (!id) {
					setView({ kind: 'none' });
					return;
				}
				resolved.current = id;
				const data = await fetchTraceTimeline(id);
				const key = `${data.metrics.eventCount}|${data.metrics.window.end}`;
				if (key === lastKey.current) unchanged.current += 1;
				else {
					lastKey.current = key;
					unchanged.current = 0;
				}
				setView({ kind: 'ready', data });
				onLoadedRef.current?.(data);
			} catch (err) {
				if (!quiet) setView({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load the timeline' });
			} finally {
				setRefreshing(false);
			}
		},
		[traceId, refParam, refId],
	);

	useEffect(() => {
		resolved.current = traceId ?? null;
		lastKey.current = null;
		unchanged.current = 0;
		setView({ kind: 'loading' });
		void load(false);
	}, [load, traceId]);

	const finished = view.kind === 'ready' && FINISHED.has(view.data.metrics.outcome.state);
	useEffect(() => {
		if (!pollMs || view.kind !== 'ready' || finished) return undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancelled = false;
		/** Next poll: backs off while nothing changes; none while the tab is hidden. */
		const schedule = (): void => {
			if (cancelled || document.hidden) return;
			const delay = Math.max(pollMs, Math.min(pollMs * 2 ** unchanged.current, TRACE_TIMELINE_MAX_POLL_MS));
			timer = setTimeout(() => {
				void load(true).then(schedule);
			}, delay);
		};
		const onVisibility = (): void => {
			clearTimeout(timer);
			if (!document.hidden && !cancelled) void load(true).then(schedule);
		};
		schedule();
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	}, [pollMs, view.kind, finished, load]);

	if (view.kind === 'loading') {
		return (
			<div className="flex justify-center py-10" data-testid="trace-timeline-loading">
				<LoadingSpinner />
			</div>
		);
	}
	if (view.kind === 'none') {
		return (
			<EmptyState
				icon={Activity}
				title="No timeline for this yet"
				description="A timeline is recorded for work started after run traces were turned on."
				compact
				data-testid="trace-timeline-none"
			/>
		);
	}
	if (view.kind === 'error') {
		return (
			<div className="flex flex-col items-center gap-3 py-8 text-center" data-testid="trace-timeline-error">
				<p className="text-sm text-danger">{view.message}</p>
				<Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void load(false)}>
					Retry
				</Button>
			</div>
		);
	}

	const { data } = view;
	return (
		<div className="flex flex-col gap-4" data-testid="trace-timeline">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<MetricsStrip metrics={data.metrics} nameOf={nameOf} />
				</div>
				<IconButton icon={RefreshCw} variant="ghost" aria-label="Refresh timeline" onClick={() => void load(true)} loading={refreshing} data-testid="trace-timeline-refresh" />
			</div>
			{data.groups.length === 0 ? (
				<p className="py-6 text-[13px] text-text-3" data-testid="trace-timeline-empty">
					Nothing has happened in this run yet.
				</p>
			) : (
				<ol className="overflow-hidden rounded-2xl bg-surface" aria-label="Run timeline" data-testid="trace-timeline-groups">
					{data.groups.map((g) => (
						<TimelineGroupRow key={g.id} group={g} nameOf={nameOf} now={now} />
					))}
				</ol>
			)}
			{data.truncated && <p className="text-[12px] text-text-3">This run hit the trace size limit; later events were not recorded.</p>}
		</div>
	);
};

TraceTimeline.displayName = 'TraceTimeline';
