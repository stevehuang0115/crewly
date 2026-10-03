/**
 * Test data for the run timeline components (used by their tests only).
 *
 * @module test/trace.fixtures
 */

import type { TimelineGroup, TraceEvent, TraceMetrics, TraceTimelineData } from '../types/trace.types';
import type { ExperimentCard } from '../services/experiments.service';

export const TRACE_ID = 'tr-20261003-0000abcd';

/**
 * An event.
 *
 * @param minute - Minutes after 10:00 UTC
 * @param type - Event type
 * @param extra - Overrides
 * @returns Event
 */
export function traceEvent(minute: number, type: string, extra: Partial<TraceEvent> = {}): TraceEvent {
	return {
		ts: new Date(Date.UTC(2026, 9, 3, 10, minute)).toISOString(),
		traceId: TRACE_ID,
		type,
		actor: { kind: 'agent', session: 'ella' },
		refs: {},
		summary: `${type} summary`,
		outcome: 'info',
		...extra,
	};
}

/**
 * Metrics with overrides.
 *
 * @param over - Fields to replace
 * @returns Metrics
 */
export function traceMetrics(over: Partial<TraceMetrics> = {}): TraceMetrics {
	return {
		traceId: TRACE_ID,
		window: { start: '2026-10-03T10:00:00.000Z', end: '2026-10-03T12:30:00.000Z' },
		eventCount: 12,
		agents: ['ella', 'sam'],
		time: { wallMs: 150 * 60_000, activeMs: 45 * 60_000, waitingOwnerMs: 60 * 60_000, waitingAgentMs: 40 * 60_000, idleMs: 5 * 60_000, activeSource: 'turn_events' },
		ownerTouches: { answered: 1, approved: 1, sentBack: 1, corrected: 0, manual: 0, total: 3 },
		rework: { sendBacks: 1, retries: 1, failedVerifications: 0, subagentSendBacks: 0, total: 2 },
		stalls: {
			thresholdMinutes: 30,
			count: 1,
			totalMs: 60 * 60_000,
			byCause: { runtime_quota: 0, delivery_failure: 0, waiting_on_owner: 1, waiting_on_agent: 0, nobody_pushing: 0 },
			items: [{ start: '2026-10-03T10:10:00.000Z', end: '2026-10-03T11:10:00.000Z', ms: 60 * 60_000, cause: 'waiting_on_owner', detail: 'Decision D-1 open' }],
		},
		interventions: { nudges: 2, redeliveries: 0, wakes: 1, corrections: 0, guardBlocks: 1, misroutes: 0, total: 4 },
		usage: {
			inputTokens: 30_000,
			cachedInputTokens: 20_000,
			outputTokens: 4_000,
			totalTokens: 34_000,
			costUsd: 1.234,
			byAgent: [{ key: 'ella', inputTokens: 30_000, cachedInputTokens: 20_000, outputTokens: 4_000, totalTokens: 34_000, costUsd: 1.234 }],
			byModel: [{ key: 'claude-opus-4-1', inputTokens: 30_000, cachedInputTokens: 20_000, outputTokens: 4_000, totalTokens: 34_000, costUsd: 1.234 }],
		},
		outcome: { state: 'waiting_on_owner', requestStatus: 'waiting_confirmation', workItems: { total: 2, done: 1, failed: 0, open: 1 } },
		...over,
	};
}

/** A turn group with a mix of notable and routine events. */
export function turnGroup(over: Partial<TimelineGroup> = {}): TimelineGroup {
	return {
		id: 'g0',
		kind: 'turn',
		session: 'ella',
		title: 'Owner → ella',
		start: '2026-10-03T10:00:00.000Z',
		end: '2026-10-03T10:09:00.000Z',
		counts: { events: 4, skillCalls: 2, blocks: 1, errors: 0 },
		tokens: 34_000,
		costUsd: 1.234,
		outcome: 'blocked',
		events: [
			traceEvent(0, 'turn.delivered', { actor: { kind: 'owner' }, summary: 'Owner message delivered to ella: fix the FAQ' }),
			traceEvent(1, 'skill.call', { summary: 'ella called POST /task-pool/add' }),
			traceEvent(2, 'skill.call', { summary: 'ella called GET /x' }),
			traceEvent(9, 'guard.block', { outcome: 'blocked', summary: 'ella was refused POST /slack/send: not allowed' }),
		],
		...over,
	};
}

/** A stall group. */
export function stallGroup(over: Partial<TimelineGroup> = {}): TimelineGroup {
	const stall = traceMetrics().stalls.items[0];
	return {
		id: 's0',
		kind: 'stall',
		title: 'Stalled 1h — waiting on the owner',
		start: stall.start,
		end: stall.end,
		counts: { events: 0, skillCalls: 0, blocks: 0, errors: 0 },
		tokens: 0,
		costUsd: 0,
		outcome: 'blocked',
		events: [],
		stall,
		...over,
	};
}

/** A whole timeline response. */
export function timelineData(over: Partial<TraceTimelineData> = {}): TraceTimelineData {
	return {
		root: { traceId: TRACE_ID, kind: 'request', summary: 'TKT-012: Fix the FAQ schema', createdAt: '2026-10-03T10:00:00.000Z', actor: { kind: 'owner' }, refs: {} },
		metrics: traceMetrics(),
		groups: [turnGroup(), stallGroup(), { ...turnGroup({ id: 'g1', kind: 'owner', session: undefined, title: 'Owner', outcome: 'ok' }), events: [traceEvent(70, 'decision.status', { actor: { kind: 'owner' } })] }],
		truncated: false,
		...over,
	};
}

/**
 * An experiment card.
 *
 * @param over - Fields to replace
 * @returns Card
 */
export function experimentCard(over: Partial<ExperimentCard> = {}): ExperimentCard {
	return {
		id: 'EXP-3',
		traceId: 'tr-20261003-0000abcd',
		title: 'FAQ schema on the H-1B page',
		hypothesis: 'FAQ schema → clicks from 100 to 140',
		direction: 'increase',
		metric: { source: 'gsc', measure: 'clicks', page: 'https://visa.example/h1b' },
		windowDays: 14,
		ticket: { kind: 'project', project: 'ce', id: 'CE-7' },
		createdBy: 'seo-lead',
		confidence: 0.6,
		status: 'running',
		createdAt: '2026-10-01T10:00:00.000Z',
		updatedAt: '2026-10-02T10:00:00.000Z',
		timeline: [],
		...over,
	};
}
