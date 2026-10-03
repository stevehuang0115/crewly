/**
 * Tests for the autonomy metrics, on synthetic traces
 * (specs/2026-10-03-autonomy-metrics.md).
 */

import {
	clampStallMinutes,
	computeTraceMetrics,
	defaultStallMinutes,
	isProgressEvent,
	mergeIntervals,
	subtractIntervals,
	summarizeTraceMetrics,
	usageOfEvent,
} from './trace-metrics.js';
import { eventCostUsd } from '../monitoring/token-usage.service.js';
import type { TraceActor, TraceEvent, TraceEventType, TraceOutcome, TraceRefs, TraceRoot } from './trace.types.js';

const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const MIN = 60_000;
const TRACE = 'tr-20261003-0000abcd';

/** Time `m` minutes after T0. */
const at = (m: number): string => new Date(T0 + m * MIN).toISOString();
/** The clock `m` minutes after T0. */
const atMin = (m: number): Date => new Date(T0 + m * MIN);

const owner: TraceActor = { kind: 'owner' };
const system: TraceActor = { kind: 'system' };
const agent = (session: string): TraceActor => ({ kind: 'agent', session });

/**
 * One event `m` minutes after T0.
 */
function ev(
	m: number,
	type: TraceEventType,
	actor: TraceActor,
	opts: { refs?: TraceRefs; data?: TraceEvent['data']; outcome?: TraceOutcome; summary?: string } = {},
): TraceEvent {
	return {
		ts: at(m),
		traceId: TRACE,
		type,
		actor,
		refs: opts.refs ?? {},
		summary: opts.summary ?? `${type} at ${m}`,
		outcome: opts.outcome ?? 'info',
		...(opts.data ? { data: opts.data } : {}),
	};
}

function root(overrides: Partial<TraceRoot> = {}): TraceRoot {
	return { traceId: TRACE, kind: 'request', summary: 'TKT-012: Fix the FAQ schema', createdAt: at(0), actor: owner, refs: {}, ...overrides };
}

const delivered = (m: number, session: string, kind: string, text = 'please fix it', actor: TraceActor = kind === 'owner_message' ? owner : system): TraceEvent =>
	ev(m, 'turn.delivered', actor, { refs: { session }, data: { kind, runtime: 'pty' }, summary: `${kind === 'owner_message' ? 'Owner message' : 'Message'} delivered to ${session}: ${text}` });
const turnEnded = (m: number, session: string, busyMin: number): TraceEvent => ev(m, 'turn.ended', agent(session), { refs: { session }, data: { busyMs: busyMin * MIN, runtime: 'pty' } });
const skill = (m: number, session: string): TraceEvent => ev(m, 'skill.call', agent(session), { refs: { session, skill: 'POST /task-pool/add' }, outcome: 'ok' });
const wiCreated = (m: number, id: string, target: string, type = 'delegate', by: TraceActor = system): TraceEvent =>
	ev(m, 'workitem.created', by, { refs: { workItemId: id, session: target }, data: { type, status: 'queued' }, outcome: 'queued' });
const wiStatus = (m: number, id: string, target: string, from: string, to: string, retryCount = 0): TraceEvent =>
	ev(m, 'workitem.status', to === 'running' ? agent(target) : system, { refs: { workItemId: id, session: target }, data: { from, to, retryCount } });
const decisionCreated = (m: number, id: string, asker: string, data: TraceEvent['data'] = {}): TraceEvent =>
	ev(m, 'decision.created', agent(asker), { refs: { decisionId: id, session: asker }, data, outcome: 'queued' });
const decisionStatus = (m: number, id: string, to: string, actor: TraceActor = owner): TraceEvent =>
	ev(m, 'decision.status', actor, { refs: { decisionId: id }, data: { from: 'open', to } });
const requestCreated = (m: number, id: string, status = 'open'): TraceEvent => ev(m, 'request.created', owner, { refs: { requestId: id }, data: { status } });
const requestStatus = (m: number, id: string, from: string, to: string, data: TraceEvent['data'] = {}): TraceEvent =>
	ev(m, 'request.status', data.acceptedBy === 'owner' ? owner : system, { refs: { requestId: id }, data: { from, to, ...data } });
const outbound = (m: number, session: string, ok = true): TraceEvent =>
	ev(m, 'message.outbound', agent(session), { refs: { session }, outcome: ok ? 'ok' : 'failed', summary: ok ? `${session} → conversation c1: done` : `Message from ${session} not delivered: no destination` });

describe('trace-metrics', () => {
	const now = new Date(T0 + 200 * MIN);

	describe('time buckets', () => {
		it('splits wall time into active, waiting on owner, waiting on agent and idle from turn events', () => {
			const events = [
				delivered(0, 'ella', 'owner_message'),
				turnEnded(10, 'ella', 10),
				decisionCreated(10, 'D-1', 'ella'),
				decisionStatus(70, 'D-1', 'resolved'),
				wiCreated(70, 'wi-1', 'sam', 'delegate', agent('ella')),
				turnEnded(75, 'ella', 5),
				wiStatus(100, 'wi-1', 'sam', 'queued', 'running'),
				turnEnded(130, 'sam', 30),
				wiStatus(130, 'wi-1', 'sam', 'running', 'done'),
			];
			const m = computeTraceMetrics(root(), events, { now, stallMinutes: 30 });
			expect(m.time).toEqual({
				wallMs: 130 * MIN,
				activeMs: 45 * MIN,
				waitingOwnerMs: 60 * MIN,
				waitingAgentMs: 25 * MIN,
				idleMs: 0,
				activeSource: 'turn_events',
			});
			expect(m.agents).toEqual(['ella', 'sam']);
			expect(m.window).toEqual({ start: at(0), end: at(130) });
			// The root's owner message is the ask, not a touch; the decision answer is.
			expect(m.ownerTouches).toMatchObject({ answered: 1, corrected: 0, total: 1 });
		});

		it('infers busy periods from deliveries and activity when there are no turn events', () => {
			const events = [delivered(0, 'ella', 'dispatch'), skill(2, 'ella'), skill(4, 'ella'), skill(20, 'ella'), skill(22, 'ella')];
			const m = computeTraceMetrics(root({ kind: 'goal' }), events, { now, stallMinutes: 30 });
			expect(m.time.activeSource).toBe('inferred');
			expect(m.time.activeMs).toBe(6 * MIN);
			expect(m.time.idleMs).toBe(16 * MIN);
			expect(m.time.wallMs).toBe(22 * MIN);
		});

		it('counts an unanswered agent message and an open ticket as waiting on an agent', () => {
			const events = [
				requestCreated(0, 'req-1', 'running'),
				ev(5, 'message.agent', agent('orc'), { refs: { session: 'sam' } }),
				skill(20, 'sam'),
			];
			const m = computeTraceMetrics(root({ refs: { requestId: 'req-1' } }), events, { now: new Date(T0 + 21 * MIN), stallMinutes: 30 });
			expect(m.time.waitingAgentMs).toBe(20 * MIN);
			expect(m.time.idleMs).toBe(0);
		});

		it('uses mixed when one agent has turn events and another does not', () => {
			const m = computeTraceMetrics(root(), [delivered(0, 'ella', 'dispatch'), turnEnded(5, 'ella', 5), skill(6, 'sam'), skill(7, 'sam')], { now });
			expect(m.time.activeSource).toBe('mixed');
			expect(m.time.activeMs).toBe(6 * MIN);
		});

		it('handles an empty trace', () => {
			const m = computeTraceMetrics(root(), [], { now });
			expect(m.time).toMatchObject({ wallMs: 0, activeMs: 0, activeSource: 'none' });
			expect(m.outcome.state).toBe('no_open_work');
			expect(m.stalls.count).toBe(0);
		});

		it('starts the window at a usage entry recorded with an earlier time than the root', () => {
			const usage = ev(-3, 'usage', agent('ella'), { data: { input: 10, output: 5, model: 'claude-sonnet-4-5' } });
			const m = computeTraceMetrics(root(), [skill(2, 'ella'), usage], { now });
			expect(m.window.start).toBe(at(-3));
		});
	});

	describe('owner touches', () => {
		it('classifies answered, corrected, approved, sent back and manual', () => {
			const events = [
				requestCreated(0, 'req-1', 'open'),
				delivered(0, 'ella', 'owner_message', 'build the page'),
				// Unprompted: a correction.
				delivered(20, 'ella', 'owner_message', 'make it blue'),
				// Agent replies, then the owner answers.
				outbound(30, 'ella'),
				delivered(40, 'ella', 'owner_message', 'yes go ahead'),
				// The same message delivered to a second agent is one touch.
				delivered(40.5, 'sam', 'owner_message', 'yes go ahead'),
				// A sensitive decision resolved: an approval.
				decisionCreated(50, 'D-2', 'ella', { sensitive: 'publish' }),
				decisionStatus(55, 'D-2', 'resolved'),
				// The dashboard write that answered it is the same touch.
				ev(55.05, 'owner.action', owner, { refs: { decisionId: 'D-2' }, data: { method: 'POST' } }),
				// Submitted, sent back, resubmitted, accepted.
				requestStatus(60, 'req-1', 'running', 'waiting_confirmation', { rejectCount: 0 }),
				requestStatus(65, 'req-1', 'waiting_confirmation', 'running', { rejectCount: 1 }),
				requestStatus(80, 'req-1', 'running', 'waiting_confirmation', { rejectCount: 1 }),
				requestStatus(90, 'req-1', 'waiting_confirmation', 'done', { rejectCount: 1, acceptedBy: 'owner' }),
				// A dashboard write nowhere near a touch: manual.
				ev(95, 'owner.action', owner, { refs: { workItemId: 'wi-9' }, data: { method: 'POST' } }),
			];
			const m = computeTraceMetrics(root({ refs: { requestId: 'req-1' } }), events, { now });
			expect(m.ownerTouches).toEqual({ answered: 1, approved: 2, sentBack: 1, corrected: 1, manual: 1, total: 6 });
			expect(m.rework.sendBacks).toBe(1);
		});

		it('counts a decision answer as answered and an approval-kind decision as approved', () => {
			const events = [decisionCreated(5, 'D-1', 'ella'), decisionStatus(10, 'D-1', 'resolved'), decisionCreated(20, 'D-2', 'ella', { kind: 'spend_cap' }), decisionStatus(25, 'D-2', 'skipped')];
			const m = computeTraceMetrics(root(), events, { now });
			expect(m.ownerTouches).toMatchObject({ answered: 1, approved: 1 });
		});

		it('ignores decisions closed by the harness (default applied)', () => {
			const m = computeTraceMetrics(root(), [decisionCreated(5, 'D-1', 'ella'), decisionStatus(10, 'D-1', 'defaulted', system)], { now });
			expect(m.ownerTouches.total).toBe(0);
		});

		it('treats a send-back without rejectCount as a send-back when it leaves review', () => {
			const events = [requestCreated(0, 'req-1'), requestStatus(10, 'req-1', 'running', 'waiting_confirmation'), requestStatus(20, 'req-1', 'waiting_confirmation', 'open')];
			const m = computeTraceMetrics(root(), events, { now });
			expect(m.ownerTouches.sentBack).toBe(1);
		});

		it('does not count an auto-accept as an approval', () => {
			const events = [requestCreated(0, 'req-1'), requestStatus(10, 'req-1', 'running', 'waiting_confirmation'), requestStatus(20, 'req-1', 'waiting_confirmation', 'done', { acceptedBy: 'silence' })];
			const m = computeTraceMetrics(root(), events, { now });
			expect(m.ownerTouches.approved).toBe(0);
		});
	});

	describe('rework', () => {
		it('counts retries, failed verifications and subagent send-backs', () => {
			const events = [
				wiCreated(0, 'wi-1', 'sam'),
				wiStatus(1, 'wi-1', 'sam', 'queued', 'running'),
				wiStatus(2, 'wi-1', 'sam', 'running', 'queued'),
				wiStatus(3, 'wi-1', 'sam', 'queued', 'running', 1),
				wiStatus(4, 'wi-1', 'sam', 'running', 'done_by_worker', 1),
				wiStatus(5, 'wi-1', 'sam', 'done_by_worker', 'rejected', 1),
				wiCreated(6, 'wi-2', 'qa', 'check'),
				wiStatus(7, 'wi-2', 'qa', 'running', 'failed'),
				ev(8, 'harness.subagent_sendback', system, { refs: { session: 'sam' }, outcome: 'blocked' }),
				// Scheduled → queued is the schedule firing, not a retry.
				wiCreated(9, 'wi-3', 'sam'),
				wiStatus(10, 'wi-3', 'sam', 'scheduled', 'queued'),
			];
			const m = computeTraceMetrics(root(), events, { now });
			expect(m.rework).toEqual({ sendBacks: 0, retries: 2, failedVerifications: 2, subagentSendBacks: 1, total: 5 });
		});
	});

	describe('stalls', () => {
		it('waiting_on_owner while a decision is open', () => {
			const m = computeTraceMetrics(root(), [decisionCreated(0, 'D-1', 'ella'), decisionStatus(90, 'D-1', 'resolved')], { now, stallMinutes: 30 });
			expect(m.stalls.items).toEqual([expect.objectContaining({ cause: 'waiting_on_owner', start: at(0), end: at(90), ms: 90 * MIN })]);
			expect(m.stalls.items[0].detail).toContain('Decision D-1 open');
		});

		it('waiting_on_owner while the ticket waits for review', () => {
			const events = [requestCreated(0, 'req-1'), requestStatus(5, 'req-1', 'running', 'waiting_confirmation'), requestStatus(100, 'req-1', 'waiting_confirmation', 'done', { acceptedBy: 'owner' })];
			const m = computeTraceMetrics(root(), events, { now });
			expect(m.stalls.items.map((s) => s.cause)).toEqual(['waiting_on_owner']);
		});

		it("waiting_on_owner when the agent spoke last and the owner answered after the gap", () => {
			const events = [delivered(0, 'ella', 'owner_message'), outbound(2, 'ella'), delivered(80, 'ella', 'owner_message', 'ok do it')];
			const m = computeTraceMetrics(root({ kind: 'owner_message' }), events, { now });
			expect(m.stalls.items).toEqual([expect.objectContaining({ cause: 'waiting_on_owner' })]);
		});

		it('runtime_quota when the runtime ran out around the gap', () => {
			const events = [
				wiCreated(0, 'wi-1', 'sam'),
				ev(1, 'runtime.blocked', system, { refs: { session: 'sam' }, data: { reason: 'usage_limit' }, outcome: 'blocked', summary: 'Runtime claude-code of sam is out of usage' }),
				wiStatus(120, 'wi-1', 'sam', 'queued', 'running'),
			];
			const m = computeTraceMetrics(root(), events, { now: atMin(120) });
			expect(m.stalls.items).toEqual([expect.objectContaining({ cause: 'runtime_quota', sessions: ['sam'] })]);
		});

		it('runtime_quota from a nudge refused for a sign-in, and from a turn error naming a usage limit', () => {
			const nudge = computeTraceMetrics(
				root(),
				[wiCreated(0, 'wi-1', 'sam'), ev(40, 'harness.nudge', system, { refs: { session: 'sam' }, data: { reason: 'login' }, outcome: 'blocked' }), skill(90, 'sam')],
				{ now },
			);
			expect(nudge.stalls.items[0].cause).toBe('runtime_quota');
			const err = computeTraceMetrics(
				root(),
				[skill(0, 'sam'), ev(1, 'turn.error', agent('sam'), { outcome: 'failed', summary: 'Turn of sam failed: 429 rate limit exceeded' }), skill(90, 'sam')],
				{ now },
			);
			expect(err.stalls.items[0].cause).toBe('runtime_quota');
		});

		it('delivery_failure after a refused outbound message', () => {
			const events = [requestCreated(0, 'req-1', 'running'), outbound(1, 'ella', false), skill(100, 'ella')];
			const m = computeTraceMetrics(root(), events, { now: atMin(100) });
			expect(m.stalls.items).toEqual([expect.objectContaining({ cause: 'delivery_failure' })]);
			expect(m.interventions.misroutes).toBe(1);
		});

		it('waiting_on_agent while a work item sits queued, naming the agent', () => {
			const m = computeTraceMetrics(root(), [wiCreated(0, 'wi-1', 'sam'), wiStatus(60, 'wi-1', 'sam', 'queued', 'running')], { now: atMin(60) });
			expect(m.stalls.items).toEqual([expect.objectContaining({ cause: 'waiting_on_agent', sessions: ['sam'] })]);
		});

		it('nobody_pushing when nothing is open and nobody works', () => {
			const m = computeTraceMetrics(root({ kind: 'goal' }), [skill(0, 'ella'), skill(100, 'ella')], { now });
			expect(m.stalls.items).toEqual([expect.objectContaining({ cause: 'nobody_pushing', ms: 100 * MIN })]);
			expect(m.stalls.byCause).toEqual({ runtime_quota: 0, delivery_failure: 0, waiting_on_owner: 0, waiting_on_agent: 0, nobody_pushing: 1 });
		});

		it('is not a stall while an agent is busy, and harness pushes are not progress', () => {
			const busy = computeTraceMetrics(root(), [wiCreated(0, 'wi-1', 'sam'), turnEnded(100, 'sam', 99)], { now: new Date(T0 + 101 * MIN) });
			expect(busy.stalls.count).toBe(0);
			const pushed = computeTraceMetrics(
				root(),
				[wiCreated(0, 'wi-1', 'sam'), ev(20, 'harness.redelivery', system, { refs: { workItemId: 'wi-1' } }), ev(40, 'harness.wake', system, { refs: { session: 'sam' } }), wiStatus(70, 'wi-1', 'sam', 'queued', 'running')],
				{ now: atMin(70) },
			);
			expect(pushed.stalls.items).toEqual([expect.objectContaining({ start: at(0), end: at(70), cause: 'waiting_on_agent' })]);
			expect(pushed.interventions).toMatchObject({ redeliveries: 1, wakes: 1, total: 2 });
		});

		it('reports an ongoing stall for an open trace that has gone quiet', () => {
			const events = [wiCreated(0, 'wi-1', 'sam'), wiStatus(1, 'wi-1', 'sam', 'queued', 'running')];
			const m = computeTraceMetrics(root(), events, { now: new Date(T0 + 120 * MIN), stallMinutes: 30 });
			expect(m.stalls.items).toEqual([expect.objectContaining({ ongoing: true, cause: 'waiting_on_agent', start: at(1), ms: 119 * MIN })]);
			expect(m.time.wallMs).toBe(1 * MIN);
			expect(m.outcome.state).toBe('in_progress');
			expect(summarizeTraceMetrics(m).ongoingStall).toBe(true);
		});

		it('extends a trailing stall to now when the trace is still open', () => {
			const events = [wiCreated(0, 'wi-1', 'sam'), ev(60, 'harness.nudge', system, { refs: { session: 'sam' } })];
			const m = computeTraceMetrics(root(), events, { now: new Date(T0 + 100 * MIN), stallMinutes: 30 });
			expect(m.stalls.items).toEqual([expect.objectContaining({ ongoing: true, start: at(0), end: at(100) })]);
		});

		it('has no ongoing stall once nothing is open', () => {
			const m = computeTraceMetrics(root(), [wiCreated(0, 'wi-1', 'sam'), wiStatus(5, 'wi-1', 'sam', 'queued', 'done')], { now: new Date(T0 + 500 * MIN) });
			expect(m.stalls.count).toBe(0);
		});

		it('honours the threshold', () => {
			const events = [skill(0, 'ella'), skill(20, 'ella')];
			expect(computeTraceMetrics(root(), events, { now, stallMinutes: 30 }).stalls.count).toBe(0);
			expect(computeTraceMetrics(root(), events, { now, stallMinutes: 10 }).stalls.count).toBe(1);
			expect(computeTraceMetrics(root(), events, { now, stallMinutes: 10 }).stalls.thresholdMinutes).toBe(10);
		});
	});

	describe('interventions, usage, outcome', () => {
		it('counts each intervention kind', () => {
			const events = [
				ev(1, 'harness.nudge', system),
				ev(2, 'harness.redelivery', system),
				ev(3, 'harness.wake', system),
				ev(4, 'harness.correction', system),
				ev(5, 'guard.block', agent('sam'), { outcome: 'blocked' }),
				outbound(6, 'sam', false),
			];
			expect(computeTraceMetrics(root(), events, { now }).interventions).toEqual({ nudges: 1, redeliveries: 1, wakes: 1, corrections: 1, guardBlocks: 1, misroutes: 1, total: 6 });
		});

		it('sums tokens and cost by agent and model with the ledger prices', () => {
			const u1 = ev(1, 'usage', agent('ella'), { data: { input: 1000, output: 500, cachedInput: 20_000, cacheWrite: 2_000, model: 'claude-opus-4-1', runtime: 'claude-code' } });
			const u2 = ev(2, 'usage', agent('sam'), { data: { input: 4000, output: 1000, cachedInput: 3000, model: 'deepseek/deepseek-chat', runtime: 'crewly-agent' } });
			const u3 = ev(3, 'usage', agent('ella'), { data: { input: 10, output: 10, model: 'deepseek/deepseek-chat', runtime: 'crewly-agent' } });
			const m = computeTraceMetrics(root(), [u1, u2, u3], { now });
			const cost = (e: TraceEvent): number =>
				eventCostUsd({ input: Number(e.data?.input), output: Number(e.data?.output), model: String(e.data?.model), cachedInput: Number(e.data?.cachedInput ?? 0), cacheWrite: Number(e.data?.cacheWrite ?? 0) });
			expect(m.usage.totalTokens).toBe(1000 + 20_000 + 500 + 4000 + 1000 + 20);
			expect(m.usage.cachedInputTokens).toBe(23_000);
			expect(m.usage.costUsd).toBeCloseTo(cost(u1) + cost(u2) + cost(u3), 3);
			expect(m.usage.byAgent.map((r) => r.key)).toEqual(['ella', 'sam']);
			expect(m.usage.byModel.find((r) => r.key === 'deepseek/deepseek-chat')?.totalTokens).toBe(5020);
			expect(usageOfEvent(skill(1, 'x'))).toBeNull();
		});

		it('reads the outcome from the ticket, work items and experiment', () => {
			const done = computeTraceMetrics(root({ refs: { requestId: 'req-1' } }), [requestCreated(0, 'req-1'), requestStatus(5, 'req-1', 'running', 'done', { acceptedBy: 'owner' })], { now });
			expect(done.outcome).toMatchObject({ state: 'done', requestStatus: 'done' });

			const failed = computeTraceMetrics(root(), [wiCreated(0, 'wi-1', 'sam'), wiStatus(1, 'wi-1', 'sam', 'running', 'failed')], { now });
			expect(failed.outcome).toMatchObject({ state: 'failed', workItems: { total: 1, done: 0, failed: 1, open: 0 } });

			const exp = computeTraceMetrics(
				root({ kind: 'experiment', refs: { experimentId: 'EXP-3' } }),
				[
					ev(0, 'experiment.event', system, { refs: { experimentId: 'EXP-3' }, data: { event: 'created' } }),
					ev(1, 'experiment.event', system, { refs: { experimentId: 'EXP-3' }, data: { event: 'shipped' } }),
					ev(2, 'experiment.event', system, { refs: { experimentId: 'EXP-3' }, data: { event: 'measured' }, summary: 'EXP-3 measured: worked: clicks 100 → 140' }),
				],
				{ now },
			);
			expect(exp.outcome).toMatchObject({ state: 'done', experiment: { id: 'EXP-3', status: 'done', verdict: 'worked' } });

			const waiting = computeTraceMetrics(root(), [decisionCreated(0, 'D-1', 'ella')], { now });
			expect(waiting.outcome.state).toBe('waiting_on_owner');
		});
	});

	describe('helpers', () => {
		it('merges and subtracts intervals', () => {
			expect(mergeIntervals([[5, 10], [0, 3], [2, 4], [10, 12], [7, 7]])).toEqual([[0, 4], [5, 12]]);
			expect(subtractIntervals([[0, 10], [20, 30]], [[2, 4], [8, 22]])).toEqual([[0, 2], [4, 8], [22, 30]]);
			expect(subtractIntervals([[0, 10]], [])).toEqual([[0, 10]]);
		});

		it('classifies progress', () => {
			expect(isProgressEvent(skill(0, 'a'))).toBe(true);
			expect(isProgressEvent(ev(0, 'harness.nudge', system))).toBe(false);
			expect(isProgressEvent(delivered(0, 'a', 'redelivery'))).toBe(false);
			expect(isProgressEvent(outbound(0, 'a', false))).toBe(false);
		});

		it('clamps the stall threshold and reads the env default', () => {
			expect(clampStallMinutes(0)).toBe(1);
			expect(clampStallMinutes(1e9)).toBe(7 * 24 * 60);
			const old = process.env.CREWLY_TRACE_STALL_MINUTES;
			try {
				delete process.env.CREWLY_TRACE_STALL_MINUTES;
				expect(defaultStallMinutes()).toBe(30);
				process.env.CREWLY_TRACE_STALL_MINUTES = '45';
				expect(defaultStallMinutes()).toBe(45);
				process.env.CREWLY_TRACE_STALL_MINUTES = 'nope';
				expect(defaultStallMinutes()).toBe(30);
			} finally {
				if (old === undefined) delete process.env.CREWLY_TRACE_STALL_MINUTES;
				else process.env.CREWLY_TRACE_STALL_MINUTES = old;
			}
		});
	});
});
