/**
 * Tests for the run timeline grouping.
 */

import { buildTimelineGroups, formatDuration, stallTitle } from './trace-timeline.js';
import { computeTraceMetrics } from './trace-metrics.js';
import type { TraceActor, TraceEvent, TraceEventType, TraceOutcome, TraceRefs, TraceRoot } from './trace.types.js';

const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const MIN = 60_000;
const TRACE = 'tr-20261003-0000abcd';
const at = (m: number): string => new Date(T0 + m * MIN).toISOString();

function ev(m: number, type: TraceEventType, actor: TraceActor, opts: { refs?: TraceRefs; data?: TraceEvent['data']; outcome?: TraceOutcome; summary?: string } = {}): TraceEvent {
	return { ts: at(m), traceId: TRACE, type, actor, refs: opts.refs ?? {}, summary: opts.summary ?? type, outcome: opts.outcome ?? 'info', ...(opts.data ? { data: opts.data } : {}) };
}

const root: TraceRoot = { traceId: TRACE, kind: 'owner_message', summary: 'Fix the FAQ', createdAt: at(0), actor: { kind: 'owner' }, refs: {} };

describe('trace-timeline', () => {
	it('groups by turn and agent, with owner, harness and stall groups in time order', () => {
		const events: TraceEvent[] = [
			ev(0, 'turn.delivered', { kind: 'owner' }, { refs: { session: 'ella' }, data: { kind: 'owner_message' } }),
			ev(1, 'skill.call', { kind: 'agent', session: 'ella' }, { outcome: 'ok' }),
			ev(2, 'workitem.created', { kind: 'agent', session: 'ella' }, { refs: { workItemId: 'wi-1', session: 'sam' }, data: { type: 'delegate', status: 'queued' } }),
			ev(2.5, 'usage', { kind: 'agent', session: 'ella' }, { data: { input: 100, output: 50, model: 'deepseek/deepseek-chat', runtime: 'crewly-agent' } }),
			ev(3, 'turn.delivered', { kind: 'system' }, { refs: { session: 'sam' }, data: { kind: 'dispatch' } }),
			ev(4, 'guard.block', { kind: 'agent', session: 'sam' }, { outcome: 'blocked' }),
			ev(5, 'error', { kind: 'agent', session: 'sam' }, { outcome: 'failed' }),
			ev(6, 'workitem.status', { kind: 'system' }, { refs: { workItemId: 'wi-1', session: 'sam' }, data: { from: 'queued', to: 'running' } }),
			// 60 quiet minutes: a stall, then the owner and a harness event without a session.
			ev(70, 'owner.action', { kind: 'owner' }, { refs: { workItemId: 'wi-1' } }),
			ev(71, 'harness.correction', { kind: 'system' }, { refs: { workItemId: 'wi-1' } }),
			// Sam again after the gap: a new group for sam.
			ev(72, 'skill.call', { kind: 'agent', session: 'sam' }, { outcome: 'ok' }),
		];
		const m = computeTraceMetrics(root, events, { stallMinutes: 30, now: new Date(T0 + 72 * MIN) });
		const groups = buildTimelineGroups(events, m.stalls.items, 30 * MIN);
		expect(groups.map((g) => [g.kind, g.title, g.counts.events])).toEqual([
			['turn', 'Owner → ella', 4],
			['turn', 'Work item → sam', 4],
			['stall', 'Stalled 1h 4m — waiting on an agent', 0],
			['owner', 'Owner', 1],
			['system', 'Harness', 1],
			['turn', 'sam working', 1],
		]);
		const ella = groups[0];
		expect(ella.session).toBe('ella');
		expect(ella.counts.skillCalls).toBe(1);
		expect(ella.tokens).toBe(150);
		expect(ella.costUsd).toBeGreaterThan(0);
		const sam = groups[1];
		expect(sam.counts).toMatchObject({ blocks: 1, errors: 1 });
		expect(sam.outcome).toBe('failed');
		expect(groups[2].stall).toMatchObject({ cause: 'waiting_on_agent', sessions: ['sam'] });
		expect(groups[2].start).toBe(at(6));
	});

	it('names a session group with only harness pushes', () => {
		const groups = buildTimelineGroups([ev(1, 'harness.nudge', { kind: 'system' }, { refs: { session: 'sam' } })], [], 30 * MIN);
		expect(groups[0].title).toBe('Harness → sam');
	});

	it('formats durations and stall titles', () => {
		expect(formatDuration(30_000)).toBe('<1m');
		expect(formatDuration(35 * MIN)).toBe('35m');
		expect(formatDuration(120 * MIN)).toBe('2h');
		expect(formatDuration(252 * MIN)).toBe('4h 12m');
		expect(formatDuration(27 * 60 * MIN)).toBe('1d 3h');
		expect(formatDuration(48 * 60 * MIN)).toBe('2d');
		expect(stallTitle({ start: at(0), end: at(90), ms: 90 * MIN, cause: 'waiting_on_owner', detail: '', ongoing: true })).toBe('Stalled 1h 30m (still) — waiting on the owner');
	});
});
