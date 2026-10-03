/**
 * Run timeline: a trace's events grouped by turn and agent, with stalls as
 * their own groups, for the Timeline tab (specs/2026-10-03-autonomy-metrics.md
 * §Timeline groups). Pure.
 *
 * @module services/trace/trace-timeline
 */

import { isProgressEvent, sessionOfEvent, sortTraceEvents, usageOfEvent, type StallCause, type TraceStall } from './trace-metrics.js';
import type { TraceEvent, TraceOutcome } from './trace.types.js';

/** What a group is. */
export type TimelineGroupKind = 'turn' | 'owner' | 'system' | 'stall';

/** One row of the timeline. */
export interface TimelineGroup {
	/** Stable within one response (`g0`, `g1`, … / `s0`, …) */
	id: string;
	kind: TimelineGroupKind;
	/** Agent session of a turn group */
	session?: string;
	/** "Owner → ella", "Work item → sam", "Stalled 2h 10m — waiting on the owner" */
	title: string;
	/** ISO */
	start: string;
	/** ISO */
	end: string;
	counts: { events: number; skillCalls: number; blocks: number; errors: number };
	tokens: number;
	costUsd: number;
	/** Worst outcome in the group: failed, blocked, or ok */
	outcome: Extract<TraceOutcome, 'failed' | 'blocked' | 'ok'>;
	/** The group's events, in time order (empty for a stall) */
	events: TraceEvent[];
	/** The stall, for a stall group */
	stall?: TraceStall;
}

/** How a delivery is named in a group title. */
const DELIVERY_TITLES: Record<string, string> = {
	owner_message: 'Owner',
	dispatch: 'Work item',
	redelivery: 'Work item (redelivered)',
	status: 'Status report',
	decision: 'Decision answer',
	follow_up: 'Follow-up',
	system: 'Message',
};

/** Short English name of a stall cause. */
export const STALL_CAUSE_LABELS: Record<StallCause, string> = {
	runtime_quota: 'runtime out of usage or signed out',
	delivery_failure: 'a message was not delivered',
	waiting_on_owner: 'waiting on the owner',
	waiting_on_agent: 'waiting on an agent',
	nobody_pushing: 'nobody pushing',
};

/**
 * A duration in words.
 *
 * @param ms - Milliseconds
 * @returns "2d 3h", "4h 12m", "35m", "<1m"
 *
 * @example
 * formatDuration(4 * 3_600_000 + 12 * 60_000) // '4h 12m'
 */
export function formatDuration(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return '<1m';
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	return `${mins}m`;
}

/**
 * Title of a stall group.
 *
 * @param stall - The stall
 * @returns "Stalled 2h 10m — waiting on the owner"
 */
export function stallTitle(stall: TraceStall): string {
	return `Stalled ${formatDuration(stall.ms)}${stall.ongoing ? ' (still)' : ''} — ${STALL_CAUSE_LABELS[stall.cause]}`;
}

/** Group under construction. */
interface Building extends TimelineGroup {
	lastT: number;
}

/**
 * Group a trace's events by turn and agent and add its stalls.
 *
 * @param events - The trace's events (any order; the root event is dropped)
 * @param stalls - Stalls from the trace's metrics
 * @param gapMs - A session's group is closed after this long without its events (the stall threshold)
 * @returns Groups in time order
 *
 * @example
 * ```typescript
 * const m = computeTraceMetrics(root, events);
 * const groups = buildTimelineGroups(events, m.stalls.items, m.stalls.thresholdMinutes * 60_000);
 * ```
 */
export function buildTimelineGroups(events: ReadonlyArray<TraceEvent>, stalls: ReadonlyArray<TraceStall>, gapMs: number): TimelineGroup[] {
	const groups: Building[] = [];
	const bySession = new Map<string, Building>();
	const open = (kind: TimelineGroupKind, title: string, t: number, session?: string): Building => {
		const g: Building = {
			id: `g${groups.length}`,
			kind,
			...(session ? { session } : {}),
			title,
			start: new Date(t).toISOString(),
			end: new Date(t).toISOString(),
			counts: { events: 0, skillCalls: 0, blocks: 0, errors: 0 },
			tokens: 0,
			costUsd: 0,
			outcome: 'ok',
			events: [],
			lastT: t,
		};
		groups.push(g);
		if (session) bySession.set(session, g);
		return g;
	};

	for (const { e, t } of sortTraceEvents(events)) {
		let group: Building;
		const session = sessionOfEvent(e);
		if (e.type === 'turn.delivered' && e.refs.session) {
			const label = DELIVERY_TITLES[String(e.data?.kind ?? 'system')] ?? 'Message';
			group = open('turn', `${label} → ${e.refs.session}`, t, e.refs.session);
		} else if (e.actor.kind === 'owner') {
			const last = groups[groups.length - 1];
			group = last && last.kind === 'owner' && t - last.lastT <= gapMs ? last : open('owner', 'Owner', t);
		} else if (session) {
			const current = bySession.get(session);
			group = current && t - current.lastT <= gapMs ? current : open('turn', `${session} working`, t, session);
		} else {
			const last = groups[groups.length - 1];
			group = last && last.kind === 'system' && t - last.lastT <= gapMs ? last : open('system', 'Harness', t);
		}
		group.events.push(e);
		group.lastT = Math.max(group.lastT, t);
		group.end = new Date(group.lastT).toISOString();
		group.counts.events += 1;
		if (e.type === 'skill.call') group.counts.skillCalls += 1;
		if (e.type === 'guard.block' || e.outcome === 'blocked') group.counts.blocks += 1;
		if (e.type === 'error' || e.type === 'turn.error' || e.outcome === 'failed') group.counts.errors += 1;
		if (e.outcome === 'failed') group.outcome = 'failed';
		else if (e.outcome === 'blocked' && group.outcome !== 'failed') group.outcome = 'blocked';
		const usage = usageOfEvent(e);
		if (usage) {
			group.tokens += usage.total;
			group.costUsd += usage.costUsd;
		}
	}
	// A session group with no delivery and no progress of its own holds only
	// harness pushes (nudges, redeliveries, refusals).
	for (const g of groups) {
		if (g.kind === 'turn' && g.title === `${g.session} working` && !g.events.some(isProgressEvent)) g.title = `Harness → ${g.session}`;
	}

	const out: TimelineGroup[] = groups.map(({ lastT: _lastT, ...g }) => ({ ...g, costUsd: Math.round(g.costUsd * 10_000) / 10_000 }));
	stalls.forEach((stall, i) => {
		out.push({
			id: `s${i}`,
			kind: 'stall',
			title: stallTitle(stall),
			start: stall.start,
			end: stall.end,
			counts: { events: 0, skillCalls: 0, blocks: 0, errors: 0 },
			tokens: 0,
			costUsd: 0,
			outcome: 'blocked',
			events: [],
			stall,
		});
	});
	// Stable: a stall starting at a group's last event comes after that group.
	return out
		.map((g, i) => ({ g, i }))
		.sort((a, b) => a.g.start.localeCompare(b.g.start) || (a.g.kind === 'stall' ? 1 : 0) - (b.g.kind === 'stall' ? 1 : 0) || a.i - b.i)
		.map(({ g }) => g);
}
