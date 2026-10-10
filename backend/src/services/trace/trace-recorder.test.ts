/**
 * Tests for the run trace hooks: request roots, work item inheritance,
 * decisions, outbound replies, usage tagging, and that failures are swallowed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceStore, setTraceStoreForTesting } from './trace-store.js';
import { getTraceContext, setTraceContextForTesting } from './trace-context.service.js';
import {
	assignRequestTrace,
	assignWorkItemTrace,
	carryAgentMessageTrace,
	noteTurnDelivery,
	startGoalTrace,
	traceDecisionChanged,
	traceDecisionCreated,
	traceHarness,
	traceOutboundReply,
	traceProjectTicketCreated,
	traceRequestStatus,
	traceStatusRouted,
	traceOwnerAction,
	traceRuntimeBlocked,
	traceSubagentSendBack,
	traceTurnActivity,
	traceTurnError,
	traceUsage,
	traceWorkItemCreated,
	traceWorkItemStatus,
	withWorkItemTraceMarker,
	workItemTraceMarker,
} from './trace-recorder.js';
import { createRequest } from '../../types/v2/request.types.js';
import { createWorkItem, type WorkItem } from '../../types/v2/work-item.types.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';

const WI_ID = '2c2a1c55-2222-4222-8222-222222222222';

function request(overrides: Record<string, unknown> = {}) {
	return createRequest({
		sourceConversationItemId: 'msg-1',
		title: 'Build the landing page',
		description: 'Build the landing page',
		ticketNumber: 12,
		origin: { channel: 'slack-dm', ref: 'msg-1', author: 'U1' },
		...overrides,
	} as Parameters<typeof createRequest>[0]);
}

function workItem(overrides: Partial<Parameters<typeof createWorkItem>[0]> = {}): WorkItem {
	return createWorkItem({ type: 'delegate', owner: 'orchestrator', target: 'dev-1', title: 'Build it', ...overrides });
}

function decision(overrides: Partial<OwnerDecision> = {}): OwnerDecision {
	return {
		id: 'D-1',
		question: 'Ship it?',
		options: [],
		defaultKey: 'wait',
		deadline: '2026-10-04T00:00:00Z',
		requestedBy: 'dev-1',
		asker: 'dev-1',
		status: 'open',
		createdAt: '2026-10-03T10:00:00Z',
		updatedAt: '2026-10-03T10:00:00Z',
		...overrides,
	} as OwnerDecision;
}

describe('trace-recorder', () => {
	let dir: string;
	let store: TraceStore;

	const events = async (traceId: string) => (await store.read(traceId, 0, 1000))!.events;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-rec-'));
		store = new TraceStore({ dir, indexFlushDelayMs: 5 });
		setTraceStoreForTesting(store);
		setTraceContextForTesting(null);
	});

	afterEach(async () => {
		await store.idle();
		setTraceStoreForTesting(null);
		setTraceContextForTesting(null);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('autonomy metric events (#984)', () => {
		it('records runtime blocks and subagent send-backs in the session trace', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'dev-1' })!;
			expect(traceRuntimeBlocked('dev-1', 'usage_limit', 'claude-code', 'five_hour, until 2026-10-03T15:00:00Z')).toBe(true);
			expect(traceRuntimeBlocked('dev-1', 'login', 'claude-code@work')).toBe(true);
			expect(traceSubagentSendBack('dev-1')).toBe(true);
			expect(traceRuntimeBlocked('nobody', 'billing', 'codex')).toBe(false);
			expect(traceSubagentSendBack('nobody')).toBe(false);
			const evs = await events(id);
			expect(evs.filter((e) => e.type === 'runtime.blocked').map((e) => [e.data?.reason, e.summary])).toEqual([
				['usage_limit', 'Runtime claude-code of dev-1 is out of usage (five_hour, until 2026-10-03T15:00:00Z)'],
				['login', 'Runtime claude-code@work of dev-1 needs a new sign-in'],
			]);
			expect(evs.find((e) => e.type === 'harness.subagent_sendback')).toMatchObject({ outcome: 'blocked', refs: { session: 'dev-1' } });
		});

		it('records an owner action on any entity of a trace named in the path', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g' })!;
			store.linkRef('workItem', WI_ID, id);
			store.linkRef('ticket', 'CE-7', id);
			expect(traceOwnerAction({ method: 'post', path: `/task-pool/items/${WI_ID}/cancel`, status: 200 })).toBe(id);
			expect(traceOwnerAction({ method: 'PATCH', path: '/project-tickets/ce/CE-7', status: 200 })).toBe(id);
			expect(traceOwnerAction({ method: 'POST', path: '/teams/t1/start', status: 200 })).toBeNull();
			const actions = (await events(id)).filter((e) => e.type === 'owner.action');
			expect(actions.map((e) => [e.actor.kind, e.refs])).toEqual([
				['owner', { workItemId: WI_ID }],
				['owner', { ticketId: 'CE-7' }],
			]);
			expect(actions[0].data).toMatchObject({ method: 'POST', route: 'POST /task-pool/items/:id/cancel', status: 200 });
		});

		it('passes turn activity through', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'dev-1' })!;
			const realNow = Date.now;
			let t = realNow();
			Date.now = () => t;
			try {
				setTraceContextForTesting(null);
				// The default context reads Date.now.
				noteTurnDelivery('dev-1', `[TASK] go\n[TRACE:${id}]`);
				traceTurnActivity('dev-1', true);
				t += 15_000;
				expect(traceTurnActivity('dev-1', false)).toBe(true);
			} finally {
				Date.now = realNow;
			}
			expect((await events(id)).some((e) => e.type === 'turn.ended')).toBe(true);
		});

		it('carries cacheWrite on usage events', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'dev-1' })!;
			traceUsage('dev-1', { timestamp: new Date().toISOString(), input: 10, output: 5, model: 'claude-opus-4-1', cachedInput: 100, cacheWrite: 40 });
			expect((await events(id)).find((e) => e.type === 'usage')?.data).toMatchObject({ cachedInput: 100, cacheWrite: 40 });
		});
	});

	describe('requests', () => {
		it('an owner ticket starts a request trace', async () => {
			const r = request();
			const id = assignRequestTrace(r)!;
			expect(r.traceId).toBe(id);
			const entry = store.getEntry(id)!;
			expect(entry.root).toMatchObject({ kind: 'request', actor: { kind: 'owner' }, refs: { requestId: r.id, ticketId: 'TKT-012' } });
			expect(store.traceByRef('request', r.id)).toBe(id);
			expect(store.traceByRef('ticket', 'TKT-012')).toBe(id);
			expect((await events(id)).map((e) => e.type)).toEqual(['trace.root', 'request.created']);
		});

		it('a child ticket and an explicit trace join the existing trace', () => {
			const parent = request();
			const id = assignRequestTrace(parent)!;
			const child = request({ parentTicketId: parent.id, ticketNumber: 13 });
			expect(assignRequestTrace(child)).toBe(id);
			const other = request({ ticketNumber: 14 });
			expect(assignRequestTrace(other, { traceId: id })).toBe(id);
			expect(store.list()).toHaveLength(1);
		});

		it('records status changes (sent for review, accepted)', async () => {
			const r = request();
			const id = assignRequestTrace(r)!;
			traceRequestStatus({ ...r, status: 'waiting_confirmation' }, 'open');
			traceRequestStatus({ ...r, status: 'done', acceptedBy: 'owner' }, 'waiting_confirmation');
			traceRequestStatus({ ...r, status: 'done' }, 'done');
			const statuses = (await events(id)).filter((e) => e.type === 'request.status');
			expect(statuses.map((e) => [e.data?.to, e.outcome, e.actor.kind])).toEqual([
				['waiting_confirmation', 'queued', 'system'],
				['done', 'ok', 'owner'],
			]);
		});
	});

	describe('awaiting_followup (CREW-440)', () => {
		const item = (status: string): never => ({ id: 'c-1', type: 'commitment', status, agent: 'a', text: 't', sourceMessageId: 'm', createdAt: '2026-10-09T16:31:00Z' }) as never;

		it('marks who the ticket waits on: the owner when only conditional promises are active, else an agent', async () => {
			const r = request();
			const id = assignRequestTrace(r)!;
			traceRequestStatus({ ...r, status: 'awaiting_followup', openItems: [item('waiting_owner'), item('skipped')] }, 'waiting_confirmation');
			traceRequestStatus({ ...r, status: 'done' }, 'awaiting_followup');
			traceRequestStatus({ ...r, status: 'awaiting_followup', openItems: [item('waiting_owner'), item('overdue')] }, 'done');
			const statuses = (await events(id)).filter((e) => e.type === 'request.status');
			expect(statuses.map((e) => e.data?.followupWaitsOn)).toEqual(['owner', undefined, 'agent']);
		});
	});

	describe('work items', () => {
		it('inherit from the item they continue, the request, the project ticket, then the creator turn', () => {
			const r = request();
			const reqTrace = assignRequestTrace(r)!;

			const byRequest = workItem({ requestId: r.id });
			expect(assignWorkItemTrace(byRequest)).toBe(reqTrace);

			const child = workItem({ parentWorkItemId: byRequest.id });
			expect(assignWorkItemTrace(child)).toBe(reqTrace);

			const verify = workItem({ metadata: { verifyOf: byRequest.id } });
			expect(assignWorkItemTrace(verify)).toBe(reqTrace);

			const goal = startGoalTrace({ kind: 'goal', summary: 'grow traffic' })!;
			traceProjectTicketCreated({ id: 'CE-7', title: 'Fix titles' }, 'nobody');
			store.linkRef('ticket', 'CE-7', goal);
			const byTicket = workItem({ metadata: { [PROJECT_TICKET_CONSTANTS.WORK_ITEM_METADATA_KEY]: { projectPath: '/p', id: 'CE-7' } } });
			expect(assignWorkItemTrace(byTicket)).toBe(goal);

			getTraceContext().noteTurnDelivery('tl-1', `[TRACE:${goal}] work on the goal`);
			const byCreator = workItem({ metadata: { delegatedBy: 'tl-1' } });
			expect(assignWorkItemTrace(byCreator)).toBe(goal);

			const orphan = workItem();
			expect(assignWorkItemTrace(orphan)).toBeNull();
			expect(orphan.traceId).toBeUndefined();
		});

		it('a terminal status ends the trace for the agent that worked it, not for others', () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g' })!;
			const ctx = getTraceContext();
			const wi = workItem({ traceId: id, target: 'dev-1' });
			traceWorkItemCreated(wi);
			ctx.setCurrent('dev-1', id);
			ctx.setCurrent('crewly-orc', id);
			traceWorkItemStatus({ ...wi, status: 'running' }, 'queued');
			expect(ctx.currentTrace('dev-1')).toBe(id);
			traceWorkItemStatus({ ...wi, status: 'done_by_worker' }, 'running');
			expect(ctx.currentTrace('dev-1')).toBeNull();
			expect(ctx.currentTrace('crewly-orc')).toBe(id);
			// A worker already on another run keeps it.
			const other = startGoalTrace({ kind: 'goal', summary: 'other', session: 'dev-2' })!;
			traceWorkItemStatus({ ...workItem({ traceId: id, target: 'dev-2' }), status: 'cancelled' }, 'queued');
			expect(ctx.currentTrace('dev-2')).toBe(other);
		});

		it('records creation and status changes, and builds the prompt header', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g' })!;
			const wi = workItem({ traceId: id });
			traceWorkItemCreated(wi);
			expect(store.traceByRef('workItem', wi.id)).toBe(id);
			traceWorkItemStatus({ ...wi, status: 'running' }, 'queued');
			traceWorkItemStatus({ ...wi, status: 'failed', error: 'tests failed' }, 'running');
			traceWorkItemStatus({ ...wi, status: 'failed' }, 'failed');
			const evs = await events(id);
			expect(evs.filter((e) => e.type === 'workitem.status').map((e) => [e.data?.to, e.outcome, e.actor.kind])).toEqual([
				['running', 'info', 'agent'],
				['failed', 'failed', 'system'],
			]);
			expect(evs.find((e) => e.data?.to === 'failed')?.summary).toContain('tests failed');
			expect(workItemTraceMarker(wi)).toBe(`[TRACE:${id}]`);
			expect(withWorkItemTraceMarker('do it', wi)).toBe(`do it\n[TRACE:${id}]`);
			expect(withWorkItemTraceMarker(`do it\n[TRACE:${id}]`, wi)).toBe(`do it\n[TRACE:${id}]`);
			expect(withWorkItemTraceMarker('[CHAT:c1:abcd1234] do it', wi).startsWith('[CHAT:c1:abcd1234]')).toBe(true);
			expect(withWorkItemTraceMarker('do it', workItem())).toBe('do it');
		});
	});

	describe('decisions, replies, status, harness', () => {
		it('a decision card joins its work item trace and records state changes', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g' })!;
			const wi = workItem({ traceId: id });
			traceWorkItemCreated(wi);
			const d = decision({ workItemId: wi.id });
			traceDecisionCreated(d);
			traceDecisionChanged(d, { ...d, status: 'resolved', chosenKey: 'yes', answeredVia: 'button' } as OwnerDecision);
			const evs = await events(id);
			expect(evs.find((e) => e.type === 'decision.created')?.refs).toMatchObject({ decisionId: 'D-1', workItemId: wi.id });
			expect(evs.find((e) => e.type === 'decision.status')).toMatchObject({ outcome: 'ok', actor: { kind: 'owner' }, data: { to: 'resolved', chosenKey: 'yes' } });
		});

		it('an outbound reply is recorded by its reference, or the turn, with its outcome', async () => {
			const r = request();
			const id = assignRequestTrace(r)!;
			traceOutboundReply({ session: 'owen', content: 'Here is the link', reference: { ticket: 'TKT-012' } }, { ok: true, conversationId: 'c1', messageId: 'm1', destination: { kind: 'conversation', source: 'ticket' } });
			getTraceContext().setCurrent('owen', id);
			traceOutboundReply({ session: 'owen', content: 'x' }, { ok: false, error: 'not delivered: no place' });
			const out = (await events(id)).filter((e) => e.type === 'message.outbound');
			expect(out.map((e) => e.outcome)).toEqual(['ok', 'failed']);
			expect(out[0].refs).toMatchObject({ messageId: 'm1', ticketId: 'TKT-012', session: 'owen' });
			expect(out[0].data).toMatchObject({ source: 'ticket' });
		});

		it('status routing returns the work item trace; harness events land in it', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g' })!;
			const wi = workItem({ traceId: id });
			traceWorkItemCreated(wi);
			expect(traceStatusRouted({ sender: 'dev-1', content: '[DONE] shipped', workItem: wi, action: 'orc', target: 'orchestrator' })).toBe(id);
			expect(traceStatusRouted({ sender: 'nobody', content: 'x', action: 'record' })).toBeNull();
			expect(traceHarness('harness.wake', { workItemId: wi.id, session: 'dev-1', summary: 'woke dev-1', outcome: 'ok' })).toBe(true);
			expect(traceHarness('harness.nudge', { session: 'idle-agent', summary: 'nudged' })).toBe(false);
			const types = (await events(id)).map((e) => e.type);
			expect(types).toEqual(expect.arrayContaining(['status.routed', 'harness.wake']));
		});

		it('agent → agent messages carry the sender trace', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'tl-1' })!;
			expect(carryAgentMessageTrace('tl-1', 'dev-1', 'please check the build')).toBe(`please check the build\n[TRACE:${id}]`);
			expect(carryAgentMessageTrace('nobody', 'dev-1', 'hi')).toBe('hi');
			// Never pushed over the terminal input limit.
			const near = 'x'.repeat(9_990);
			expect(carryAgentMessageTrace('tl-1', 'dev-1', near)).toBe(near);
			expect(carryAgentMessageTrace('tl-1', 'dev-1', 'short', 20)).toBe('short');
			expect(noteTurnDelivery('dev-1', `please check the build\n[TRACE:${id}]`)).toBe(id);
			expect((await events(id)).some((e) => e.type === 'message.agent')).toBe(true);
		});

		it('records turn errors in the current trace', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'dev-1' })!;
			traceTurnError('dev-1', new Error('model timeout'));
			expect((await events(id)).find((e) => e.type === 'turn.error')?.summary).toContain('model timeout');
		});
	});

	describe('usage', () => {
		afterEach(() => TokenUsageService.resetInstance());

		it('ledger entries recorded during a traced turn carry its id', async () => {
			const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'dev-1' })!;
			const svc = TokenUsageService.getInstance();
			svc.recordUsage('dev-1', 'dev-1', 1000, 200, 'claude-sonnet-5', undefined, { cachedInput: 800 });
			svc.recordUsage('idle', 'idle', 10, 2, 'claude-sonnet-5');
			const evs: Array<{ traceId?: string }> = [];
			svc.forEachEvent((_session, e) => evs.push(e));
			expect(evs.map((e) => e.traceId)).toEqual([id, undefined]);
			const usage = (await events(id)).find((e) => e.type === 'usage');
			expect(usage?.data).toMatchObject({ input: 1000, output: 200, cachedInput: 800, model: 'claude-sonnet-5' });
		});

		it('a late entry is attributed by its own timestamp', () => {
			const ctx = getTraceContext();
			const a = startGoalTrace({ kind: 'goal', summary: 'a', session: 'dev-1' })!;
			ctx.setCurrent('dev-1', null, Date.now() + 10);
			expect(traceUsage('dev-1', { timestamp: new Date(Date.now() + 1000).toISOString(), input: 1, output: 1, model: 'm' })).toBeNull();
			expect(traceUsage('dev-1', { timestamp: new Date(Date.now() + 5).toISOString(), input: 1, output: 1, model: 'm' })).toBe(a);
		});
	});

	describe('failures are swallowed', () => {
		it('no hook throws when the store throws', () => {
			setTraceStoreForTesting({
				has: () => {
					throw new Error('boom');
				},
				traceByRef: () => {
					throw new Error('boom');
				},
				createRoot: () => {
					throw new Error('boom');
				},
				append: () => {
					throw new Error('boom');
				},
				linkRef: () => {
					throw new Error('boom');
				},
				dispose: () => undefined,
			} as unknown as TraceStore);
			setTraceContextForTesting(null);
			const r = request();
			const wi = workItem({ requestId: r.id, traceId: 'tr-20261003-00000001' });
			expect(() => assignRequestTrace(r)).not.toThrow();
			expect(() => assignWorkItemTrace(wi, 'orc')).not.toThrow();
			expect(() => traceWorkItemCreated(wi)).not.toThrow();
			expect(() => traceWorkItemStatus({ ...wi, status: 'running' }, 'queued')).not.toThrow();
			expect(noteTurnDelivery('dev-1', '[CHAT:x:abcd1234] hi')).toBeNull();
			expect(carryAgentMessageTrace('a', 'b', 'hi')).toBe('hi');
			expect(withWorkItemTraceMarker('hi', wi)).toBe('hi');
			expect(() => traceDecisionCreated(decision())).not.toThrow();
			expect(() => traceOutboundReply({ session: 'a', content: 'b' }, { ok: true })).not.toThrow();
			expect(traceUsage('a', { timestamp: new Date().toISOString(), input: 1, output: 1, model: 'm' })).toBeNull();
			const svc = TokenUsageService.getInstance();
			expect(() => svc.recordUsage('a', 'a', 1, 1, 'm')).not.toThrow();
			TokenUsageService.resetInstance();
		});
	});
});
