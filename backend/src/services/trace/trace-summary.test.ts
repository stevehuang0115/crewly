/**
 * Tests for the compact trace summary (`trace-read`): content, key-event
 * selection, links and the size bound.
 */

import { buildTraceSummary, clampSummaryChars, formatTokens, formatUsd, keyEventScore, traceLinks } from './trace-summary.js';
import { computeTraceMetrics } from './trace-metrics.js';
import type { TraceActor, TraceEvent, TraceEventType, TraceOutcome, TraceRefs, TraceRoot } from './trace.types.js';

const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const MIN = 60_000;
const TRACE = 'tr-20261003-0000abcd';
const at = (m: number): string => new Date(T0 + m * MIN).toISOString();

function ev(m: number, type: TraceEventType, actor: TraceActor, opts: { refs?: TraceRefs; data?: TraceEvent['data']; outcome?: TraceOutcome; summary?: string } = {}): TraceEvent {
	return { ts: at(m), traceId: TRACE, type, actor, refs: opts.refs ?? {}, summary: opts.summary ?? `${type} at ${m}`, outcome: opts.outcome ?? 'info', ...(opts.data ? { data: opts.data } : {}) };
}

const root = (refs: TraceRefs = { requestId: 'req-1', ticketId: 'TKT-012' }): TraceRoot => ({
	traceId: TRACE,
	kind: 'request',
	summary: 'TKT-012: Fix the FAQ schema',
	createdAt: at(0),
	actor: { kind: 'owner' },
	refs,
});

/** A busy trace: many routine calls, a few notable events, a stall. */
function bigTrace(calls: number): TraceEvent[] {
	const events: TraceEvent[] = [
		ev(0, 'request.created', { kind: 'owner' }, { refs: { requestId: 'req-1' }, data: { status: 'open' }, summary: 'Ticket TKT-012 created: Fix the FAQ schema' }),
		ev(0.5, 'turn.delivered', { kind: 'system' }, { refs: { session: 'ella' }, data: { kind: 'dispatch' } }),
	];
	for (let i = 0; i < calls; i++) {
		events.push(ev(1 + i * 0.01, 'skill.call', { kind: 'agent', session: 'ella' }, { outcome: 'ok', summary: `ella called GET /x/${'y'.repeat(150)}` }));
		events.push(ev(1 + i * 0.01, 'usage', { kind: 'agent', session: 'ella' }, { data: { input: 1000, output: 100, model: 'deepseek/deepseek-chat', runtime: 'crewly-agent' } }));
	}
	events.push(ev(30, 'decision.created', { kind: 'agent', session: 'ella' }, { refs: { decisionId: 'D-7' }, summary: 'Decision D-7 asked: Publish now?' }));
	events.push(ev(150, 'decision.status', { kind: 'owner' }, { refs: { decisionId: 'D-7' }, data: { from: 'open', to: 'resolved' }, summary: 'Decision D-7 open → resolved (yes)' }));
	events.push(ev(151, 'guard.block', { kind: 'agent', session: 'ella' }, { outcome: 'blocked', summary: 'ella was refused POST /slack/send: not allowed' }));
	return events;
}

describe('trace-summary', () => {
	it('prints the header, metrics, stalls, key events and links', () => {
		const events = bigTrace(5);
		const m = computeTraceMetrics(root(), events, { now: new Date(T0 + 151 * MIN) });
		const { text, links } = buildTraceSummary(root(), events, m, 4000);
		expect(text).toContain(`Trace ${TRACE} · request · TKT-012: Fix the FAQ schema`);
		expect(text).toMatch(/Time: wall 2h 31m · active .* · waiting on owner 2h/);
		expect(text).toContain('Owner touches 1 (answered 1, approved 0, sent back 0, corrected 0, manual 0)');
		expect(text).toContain('Harness interventions 1 (nudges 0, redeliveries 0, wakes 0, corrections 0, guard blocks 1, misroutes 0)');
		expect(text).toMatch(/Tokens 6k · <\$0\.01 · by agent: ella 6k <\$0\.01 · by model: deepseek\/deepseek-chat 6k/);
		expect(text).toMatch(/Stalls \(> 30m\): 1, 2h in total\n- 10:30–12:30 \(2h\) waiting on the owner: Decision D-7 open/);
		expect(text).toContain('12:31 ella guard.block [blocked]: ella was refused POST /slack/send');
		expect(text).toContain('10:30 ella decision.created: Decision D-7 asked: Publish now?');
		// Routine calls and usage lines are summed, never listed.
		expect(text).not.toContain('skill.call');
		expect(text).not.toContain(' usage');
		expect(links).toEqual({ ui: '/tickets/requests/req-1?tab=timeline', api: `/api/traces/${TRACE}/timeline` });
		expect(text).toContain(`Links: UI /tickets/requests/req-1?tab=timeline · API /api/traces/${TRACE}/timeline`);
	});

	it('never exceeds maxChars, keeps the most important events and the links', () => {
		const events = bigTrace(400);
		// Lots of notable events too.
		for (let i = 0; i < 300; i++) events.push(ev(200 + i, 'message.agent', { kind: 'agent', session: 'ella' }, { refs: { session: 'sam' }, summary: `ella → sam: ${'note '.repeat(40)}` }));
		const m = computeTraceMetrics(root(), events, { now: new Date(T0 + 600 * MIN) });
		for (const max of [600, 1500, 4000, 16_000]) {
			const { text } = buildTraceSummary(root(), events, m, max);
			expect(text.length).toBeLessThanOrEqual(max);
			if (max >= 1500) {
				expect(text).toContain('Links: UI');
				expect(text).toContain('decision.status');
				expect(text).toMatch(/Key events \(\d+ of 305 notable, \d+ in all\)/);
			}
		}
		expect(buildTraceSummary(root(), events, m, 10).text.length).toBeLessThanOrEqual(600);
	});

	it('scores events', () => {
		expect(keyEventScore(ev(0, 'skill.call', { kind: 'agent', session: 'a' }))).toBe(0);
		expect(keyEventScore(ev(0, 'usage', { kind: 'agent', session: 'a' }))).toBe(0);
		expect(keyEventScore(ev(0, 'turn.delivered', { kind: 'system' }, { data: { kind: 'status' } }))).toBe(0);
		expect(keyEventScore(ev(0, 'turn.delivered', { kind: 'owner' }, { data: { kind: 'owner_message' } }))).toBe(3);
		expect(keyEventScore(ev(0, 'error', { kind: 'agent', session: 'a' }, { outcome: 'failed' }))).toBe(3);
		expect(keyEventScore(ev(0, 'workitem.status', { kind: 'system' }))).toBe(2);
		expect(keyEventScore(ev(0, 'message.agent', { kind: 'agent', session: 'a' }))).toBe(1);
	});

	it('links to the experiment card or the generic trace page', () => {
		expect(traceLinks(root({ experimentId: 'EXP-3' })).ui).toBe('/tickets/experiments/EXP-3?tab=timeline');
		expect(traceLinks(root({})).ui).toBe(`/tickets/traces/${TRACE}`);
		expect(traceLinks(root({}), [ev(0, 'request.created', { kind: 'owner' }, { refs: { requestId: 'r 2' } })]).ui).toBe('/tickets/requests/r%202?tab=timeline');
	});

	it('formats numbers and clamps sizes', () => {
		expect(formatTokens(512)).toBe('512');
		expect(formatTokens(28_000)).toBe('28k');
		expect(formatTokens(1_250_000)).toBe('1.3M');
		expect(formatUsd(0.004)).toBe('<$0.01');
		expect(formatUsd(3.411)).toBe('$3.41');
		expect(clampSummaryChars(Number.NaN)).toBe(4000);
		expect(clampSummaryChars(1)).toBe(600);
		expect(clampSummaryChars(1e9)).toBe(16_000);
	});
});
