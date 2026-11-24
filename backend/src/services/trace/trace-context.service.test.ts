/**
 * Tests for the per-session trace context: resolution from delivered text,
 * pending owner-message roots, and lookups by time.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceStore } from './trace-store.js';
import { TraceContext, classifyDelivery, defaultIdleClearMs, isSessionContextSummary, dispatchedWorkItem, dispatchedWorkItemId } from './trace-context.service.js';
import { parseInboundOrigin } from '../orc/orc-reply-route.service.js';
import { appendTraceMarker } from './trace-markers.js';
import { getTurnTriggerTracker } from './turn-trigger.js';

const WI = '2c2a1c55-1111-4111-8111-111111111111';
const REQ = '9b1f0d1e-0000-4000-8000-000000000001';

describe('classifyDelivery', () => {
	it.each([
		['[CHAT:conv:abcd1234] can you build the page?', 'owner_message'],
		['[CHAT:c1] <UG94JLNGK@#ce> ship it', 'owner_message'],
		['[CHAT:c1] <Owen (agent)@#ce> [Slack thread so far — oldest→newest, 8 messages]', 'agent_message'],
		['[CHAT:c1] <Ella (Personal Assistant Team) (agent)@#C0C6P921QSD> [Context only — not for you to answer] Messages', 'agent_message'],
		['\n[CREWLY-DISPATCH] WorkItem x queued for you (type=delegate).', 'dispatch'],
		['[CREWLY-DISPATCH] 3 WorkItems are still queued for you — this one message covers all of them.', 'redelivery'],
		['[TASK RE-DELIVERY] You were working on this task', 'redelivery'],
		['[CHAT:orc-status] Agent status: [DONE] shipped', 'status'],
		['Status from dev-1 (reports to you): done', 'status'],
		['[DECISION D-4] The owner chose Approve', 'decision'],
		['[FOLLOW-UP TKT-0187] still owed', 'follow_up'],
		['[SYSTEM] scheduled check', 'system'],
		['plain text from another agent', 'system'],
	])('%s → %s', (text, kind) => {
		expect(classifyDelivery(text)).toBe(kind);
	});
});

describe('start-anchored parsers still work on marked messages', () => {
	const marker = 'tr-20261003-0123abcd';
	it('parseInboundOrigin', () => {
		expect(parseInboundOrigin(appendTraceMarker('[CHAT:a721f48d:abcd1234] <owner@Orchestrator>\n\nhi', marker))).toEqual({ conversationId: 'a721f48d' });
	});
	it('classifyDelivery', () => {
		expect(classifyDelivery(appendTraceMarker('[TASK] build the page', marker))).toBe('dispatch');
		expect(classifyDelivery(appendTraceMarker('[SYSTEM] check', marker))).toBe('system');
		expect(classifyDelivery(appendTraceMarker('[CHAT:c1:abcd1234] hi', marker))).toBe('owner_message');
	});
});

describe('TraceContext', () => {
	let dir: string;
	let store: TraceStore;
	let clock: number;
	let ctx: TraceContext;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ctx-'));
		clock = Date.parse('2026-10-03T10:00:00Z');
		store = new TraceStore({ dir, now: () => new Date(clock), indexFlushDelayMs: 5 });
		ctx = new TraceContext(() => store, () => clock);
	});

	afterEach(async () => {
		await store.idle();
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('turn activity (#984)', () => {
		it('records one turn.ended with the busy time in the trace the turn started on', async () => {
			const id = ctx.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' }, session: 'dev-1' })!;
			expect(ctx.noteTurnActivity('dev-1', true)).toBe(false);
			clock += 5_000;
			// A second busy report (another source) does not restart the period.
			ctx.noteTurnActivity('dev-1', true);
			clock += 40_000;
			expect(ctx.noteTurnActivity('dev-1', false, 'in-process')).toBe(true);
			// Idle again without a busy start: nothing.
			expect(ctx.noteTurnActivity('dev-1', false)).toBe(false);
			const ended = (await store.read(id))!.events.filter((e) => e.type === 'turn.ended');
			expect(ended).toHaveLength(1);
			expect(ended[0]).toMatchObject({ actor: { kind: 'agent', session: 'dev-1' }, data: { busyMs: 45_000, runtime: 'in-process' } });
		});

		it('also records it in the trace a delivery moved the turn to', async () => {
			const a = ctx.startTrace({ kind: 'goal', summary: 'a', actor: { kind: 'owner' }, session: 'dev-1' })!;
			const b = ctx.startTrace({ kind: 'goal', summary: 'b', actor: { kind: 'owner' } })!;
			ctx.noteTurnActivity('dev-1', true);
			clock += 20_000;
			ctx.noteTurnDelivery('dev-1', `[TASK] next\n[TRACE:${b}]`);
			clock += 20_000;
			ctx.noteTurnActivity('dev-1', false);
			for (const id of [a, b]) {
				expect((await store.read(id))!.events.filter((e) => e.type === 'turn.ended')).toHaveLength(1);
			}
		});

		it('skips flapping (shorter than the busy minimum) and sessions with no trace', async () => {
			const id = ctx.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' }, session: 'dev-1' })!;
			ctx.noteTurnActivity('dev-1', true);
			clock += 3_000;
			expect(ctx.noteTurnActivity('dev-1', false)).toBe(false);
			expect((await store.read(id))!.events.some((e) => e.type === 'turn.ended')).toBe(false);
			ctx.noteTurnActivity('nobody', true);
			clock += 60_000;
			expect(ctx.noteTurnActivity('nobody', false)).toBe(false);
			expect(ctx.noteTurnActivity('', true)).toBe(false);
		});
	});

	it('a [TRACE] marker makes the trace current and records the delivery', async () => {
		const id = ctx.startTrace({ kind: 'request', summary: 'TKT-0001', actor: { kind: 'owner' } })!;
		expect(ctx.noteTurnDelivery('dev-1', `[CREWLY-DISPATCH] WorkItem x queued\n  Trace: [TRACE:${id}]`)).toBe(id);
		expect(ctx.currentTrace('dev-1')).toBe(id);
		const page = await store.read(id);
		const delivered = page!.events.find((e) => e.type === 'turn.delivered');
		expect(delivered?.data).toMatchObject({ kind: 'dispatch', subkind: 'dispatch', runtime: 'pty' });
		expect(delivered?.refs.session).toBe('dev-1');
	});

	it('turn.delivered carries the fine trigger kind and the sending agent (audit 2026-10-14)', async () => {
		const { getTurnTriggerTracker } = await import('./turn-trigger.js');
		getTurnTriggerTracker().reset();
		const id = ctx.startTrace({ kind: 'request', summary: 'TKT-0002', actor: { kind: 'owner' } })!;
		getTurnTriggerTracker().noteSender('dev-1', 'Can you re-check the footer before I ship?', 'lead-1');
		ctx.noteTurnDelivery('dev-1', `Can you re-check the footer before I ship?\n[TRACE:${id}]`);
		ctx.noteTurnDelivery('dev-2', `[FOLLOW-UP TKT-0002] due\n[TRACE:${id}]`);
		const events = (await store.read(id))!.events.filter((e) => e.type === 'turn.delivered');
		expect(events[0]).toMatchObject({ actor: { kind: 'agent', session: 'lead-1' }, data: { kind: 'system', subkind: 'agent_message', sender: 'lead-1' } });
		expect(events[1].data).toMatchObject({ kind: 'follow_up', subkind: 'follow_up' });
		expect(getTurnTriggerTracker().trigger('dev-1', clock)).toMatchObject({ triggerKind: 'agent_message', traceId: id });
		getTurnTriggerTracker().reset();
	});

	it('resolves ticket markers and work item ids through the index', () => {
		const a = ctx.startTrace({ kind: 'request', summary: 'a', actor: { kind: 'owner' } })!;
		const b = ctx.startTrace({ kind: 'request', summary: 'b', actor: { kind: 'owner' } })!;
		store.linkRef('request', REQ, a);
		store.linkRef('workItem', WI, b);
		expect(ctx.noteTurnDelivery('orc', `[CHAT:c1:abcd1234] [TICKET:TKT-0001 ${REQ}] please build it`)).toBe(a);
		expect(ctx.noteTurnDelivery('dev-1', `Reminder: WorkItem ${WI} is still open`)).toBe(b);
		expect(ctx.resolveTracesFromText('nothing here')).toEqual([]);
	});

	it('an unknown marker is ignored', () => {
		expect(ctx.resolveTracesFromText('[TRACE:tr-20261003-deadbeef]')).toEqual([]);
	});

	describe('what a delivery is about (CREW-1258)', () => {
		const OTHER_WI = '7d7d7d7d-2222-4222-8222-222222222222';
		const status = (traceId: string, type: 'ticket.status' | 'workitem.status', refs: Record<string, string>, to: string, from = 'in_progress'): void => {
			ctx.record({ traceId, type, actor: { kind: 'system' }, summary: `${from} → ${to}`, refs, data: { from, to } });
		};
		const events = async (traceId: string, type = 'turn.delivered') => (await store.read(traceId))!.events.filter((e) => e.type === type);

		afterEach(() => getTurnTriggerTracker().reset());

		it('a delivery whose only refs are a cancelled ticket and a verified work item does not set the current trace', async () => {
			const work = ctx.startTrace({ kind: 'request', summary: 'real work', actor: { kind: 'owner' }, session: 'orc' })!;
			const oldTicket = ctx.startTrace({ kind: 'ticket', summary: 'CE-345', actor: { kind: 'system' } })!;
			const oldItem = ctx.startTrace({ kind: 'ticket', summary: 'old item', actor: { kind: 'system' } })!;
			store.linkRef('ticket', 'CE-345', oldTicket);
			store.linkRef('workItem', OTHER_WI, oldItem);
			status(oldTicket, 'ticket.status', { ticketId: 'CE-345' }, 'cancelled');
			status(oldItem, 'workitem.status', { workItemId: OTHER_WI }, 'verified', 'done_by_worker');
			expect(ctx.currentTrace('orc')).toBe(work);

			expect(ctx.noteTurnDelivery('orc', `[CHAT:c1:abcd1234] <lead (agent)@#ce> verify CE-345 and WorkItem ${OTHER_WI}, evidence below`)).toBeNull();
			expect(ctx.currentTrace('orc')).toBeNull();
			await store.idle();
			expect(await events(oldTicket)).toHaveLength(0);
			expect(await events(oldItem)).toHaveLength(0);
		});

		it('a ticket that is still open, or was reopened after it was cancelled, still moves the session', () => {
			const live = ctx.startTrace({ kind: 'ticket', summary: 'CE-7', actor: { kind: 'system' } })!;
			const reopened = ctx.startTrace({ kind: 'ticket', summary: 'CE-8', actor: { kind: 'system' } })!;
			store.linkRef('ticket', 'CE-7', live);
			store.linkRef('ticket', 'CE-8', reopened);
			status(live, 'ticket.status', { ticketId: 'CE-7' }, 'in_progress', 'ready');
			status(reopened, 'ticket.status', { ticketId: 'CE-8' }, 'cancelled');
			status(reopened, 'ticket.status', { ticketId: 'CE-8' }, 'ready', 'cancelled');
			expect(ctx.noteTurnDelivery('dev-1', '[SYSTEM] please pick up CE-7')).toBe(live);
			expect(ctx.noteTurnDelivery('dev-2', '[SYSTEM] please pick up CE-8')).toBe(reopened);
		});

		it('a restart SESSION_CONTEXT summary names no trace, whatever ids and markers it recaps', async () => {
			const live = ctx.startTrace({ kind: 'ticket', summary: 'CE-7', actor: { kind: 'system' } })!;
			store.linkRef('ticket', 'CE-7', live);
			const work = ctx.startTrace({ kind: 'request', summary: 'work', actor: { kind: 'owner' }, session: 'orc' })!;
			expect(ctx.currentTrace('orc')).toBe(work);
			const summary = `[SESSION_CONTEXT] Crewly restarted. Background from the previous session, for continuity only:\n- CE-7 was reviewed, WorkItem ${WI} done\n[TRACE:${live}]`;
			expect(isSessionContextSummary(summary)).toBe(true);
			expect(ctx.noteTurnDelivery('orc', summary)).toBeNull();
			expect(ctx.currentTrace('orc')).toBeNull();
			await store.idle();
			expect(await events(live)).toHaveLength(0);
		});

		it('the dispatched work item wins over ids the dispatch only cites', async () => {
			const dispatched = ctx.startTrace({ kind: 'ticket', summary: 'dispatched', actor: { kind: 'system' } })!;
			const cited = ctx.startTrace({ kind: 'ticket', summary: 'cited', actor: { kind: 'system' } })!;
			store.linkRef('workItem', WI, dispatched);
			store.linkRef('ticket', 'CE-281', cited);
			status(cited, 'ticket.status', { ticketId: 'CE-281' }, 'in_progress', 'ready');
			const text = `[CREWLY-DISPATCH] WorkItem ${WI} queued for you (type=delegate).\n  Evidence: CE-281 description cites this\n`;
			expect(dispatchedWorkItemId(text, classifyDelivery(text))).toBe(WI);
			expect(ctx.noteTurnDelivery('dev-1', text)).toBe(dispatched);
			expect(ctx.tracesAt('dev-1')).toEqual([dispatched]);
			await store.idle();
			expect(await events(cited)).toHaveLength(0);
			expect(await events(dispatched)).toHaveLength(1);
		});

		it('a verify dispatch of an item that waits for its verdict lands on the item\'s run, and so do rework and retry deliveries', async () => {
			const run = ctx.startTrace({ kind: 'ticket', summary: 'CREW-1', actor: { kind: 'system' } })!;
			store.linkRef('workItem', WI, run);
			store.linkRef('ticket', 'CREW-1', run);
			status(run, 'ticket.status', { ticketId: 'CREW-1' }, 'in_progress', 'ready');
			status(run, 'workitem.status', { workItemId: WI }, 'done_by_worker', 'running');
			const verify = `[CREWLY-DISPATCH] WorkItem ${WI}:verify:${WI} queued for you (type=review).\n  Evidence: CREW-1 shipped\n`;
			expect(dispatchedWorkItem(verify, 'dispatch')).toEqual({ id: WI, derived: true });
			expect(ctx.noteTurnDelivery('lead', verify)).toBe(run);
			expect(ctx.currentTrace('lead')).toBe(run);
			// Rejected: back for rework. The redelivery names the item and is still the run's.
			status(run, 'workitem.status', { workItemId: WI }, 'rejected', 'done_by_worker');
			expect(ctx.noteTurnDelivery('dev-1', `[TASK RE-DELIVERY] WorkItem ${WI} needs rework`)).toBe(run);
			status(run, 'workitem.status', { workItemId: WI }, 'queued', 'rejected');
			expect(ctx.noteTurnDelivery('dev-2', `[CREWLY-DISPATCH] WorkItem ${WI} queued for you (type=delegate).`)).toBe(run);
			// A failed item is retried: the retry item is the run's.
			status(run, 'workitem.status', { workItemId: WI }, 'failed', 'running');
			expect(ctx.noteTurnDelivery('dev-3', `[CREWLY-DISPATCH] WorkItem ${WI}:retry:1 queued for you (type=delegate).`)).toBe(run);
			await store.idle();
			expect((await events(run)).length).toBe(4);
		});

		it('a derived item (verify, retry) follows its parent\'s run even when the parent is already verified, a plain dispatch of it does not', () => {
			const run = ctx.startTrace({ kind: 'ticket', summary: 'x', actor: { kind: 'system' } })!;
			store.linkRef('workItem', WI, run);
			status(run, 'workitem.status', { workItemId: WI }, 'verified', 'done_by_worker');
			expect(ctx.noteTurnDelivery('lead', `[CREWLY-DISPATCH] WorkItem ${WI}:verify:${WI} queued for you (type=review).`)).toBe(run);
			expect(ctx.noteTurnDelivery('dev-1', `[CREWLY-DISPATCH] WorkItem ${WI}:retry:2 queued for you (type=delegate).`)).toBe(run);
			expect(ctx.noteTurnDelivery('dev-2', `[CREWLY-DISPATCH] WorkItem ${WI} queued for you (type=delegate).`)).toBeNull();
		});

		it('only a verified, done or cancelled work item is finished; done_by_worker, rejected and failed are not', () => {
			const run = ctx.startTrace({ kind: 'ticket', summary: 'x', actor: { kind: 'system' } })!;
			store.linkRef('workItem', WI, run);
			for (const to of ['done_by_worker', 'rejected', 'failed']) {
				status(run, 'workitem.status', { workItemId: WI }, to, 'running');
				expect(ctx.noteTurnDelivery('dev-1', `Reminder: WorkItem ${WI} is still open`)).toBe(run);
			}
			for (const to of ['verified', 'done', 'cancelled']) {
				status(run, 'workitem.status', { workItemId: WI }, to, 'running');
				expect(ctx.noteTurnDelivery('dev-1', `Reminder: WorkItem ${WI} is still open`)).toBeNull();
			}
		});

		it('a redelivery follows the work item it names too', () => {
			const dispatched = ctx.startTrace({ kind: 'ticket', summary: 'dispatched', actor: { kind: 'system' } })!;
			const cited = ctx.startTrace({ kind: 'ticket', summary: 'cited', actor: { kind: 'system' } })!;
			store.linkRef('workItem', WI, dispatched);
			store.linkRef('workItem', OTHER_WI, cited);
			expect(ctx.noteTurnDelivery('dev-1', `[TASK RE-DELIVERY] WorkItem ${WI} is still open; see also ${OTHER_WI}`)).toBe(dispatched);
		});

		it('a [TRACE:] marker wins over the ids cited next to it', () => {
			const marked = ctx.startTrace({ kind: 'goal', summary: 'marked', actor: { kind: 'owner' } })!;
			const cited = ctx.startTrace({ kind: 'ticket', summary: 'cited', actor: { kind: 'system' } })!;
			store.linkRef('ticket', 'CE-9', cited);
			status(cited, 'ticket.status', { ticketId: 'CE-9' }, 'in_progress', 'ready');
			expect(ctx.noteTurnDelivery('dev-1', `[CREWLY-DISPATCH] WorkItem ${OTHER_WI} queued; CE-9 is related\n[TRACE:${marked}]`)).toBe(marked);
			expect(ctx.tracesAt('dev-1')).toEqual([marked]);
		});

		it('a finished dispatched work item is not followed; a live cited ticket then decides', () => {
			const dispatched = ctx.startTrace({ kind: 'ticket', summary: 'dispatched', actor: { kind: 'system' } })!;
			const cited = ctx.startTrace({ kind: 'ticket', summary: 'cited', actor: { kind: 'system' } })!;
			store.linkRef('workItem', WI, dispatched);
			store.linkRef('ticket', 'CE-10', cited);
			status(dispatched, 'workitem.status', { workItemId: WI }, 'cancelled', 'queued');
			// A plain dispatch of a cancelled item is stale; a verify or retry of one would be followed (see above).
			expect(ctx.noteTurnDelivery('dev-1', `[CREWLY-DISPATCH] WorkItem ${WI} queued for you; CE-10`)).toBe(cited);
		});

		it('statuses of a trace written before the index kept them are read from its file once', async () => {
			const old = ctx.startTrace({ kind: 'ticket', summary: 'CE-345', actor: { kind: 'system' } })!;
			store.linkRef('ticket', 'CE-345', old);
			status(old, 'ticket.status', { ticketId: 'CE-345' }, 'cancelled');
			await store.idle();
			store.dispose();
			const indexFile = path.join(dir, 'index.json');
			const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
			delete index.traces[old].refStatus;
			fs.writeFileSync(indexFile, JSON.stringify(index));
			store = new TraceStore({ dir, now: () => new Date(clock), indexFlushDelayMs: 5 });
			ctx = new TraceContext(() => store, () => clock);
			expect(store.getEntry(old)?.refStatus).toBeUndefined();
			expect(store.isRefEnded('ticket', 'CE-345')).toBe(true);
			expect(ctx.noteTurnDelivery('orc', '[SYSTEM] evidence mentions CE-345')).toBeNull();
		});
	});

	it('an untraced owner message waits as a pending root until the turn starts work', async () => {
		const prev = ctx.startTrace({ kind: 'request', summary: 'old', actor: { kind: 'owner' }, session: 'orc' })!;
		expect(ctx.currentTrace('orc')).toBe(prev);

		expect(ctx.noteTurnDelivery('orc', '[CHAT:c1:abcd1234] how are you?')).toBeNull();
		expect(ctx.currentTrace('orc')).toBeNull();
		expect(store.list()).toHaveLength(1);

		clock += 1000;
		const id = ctx.ensureTraceForSession('orc')!;
		expect(id).not.toBe(prev);
		expect(ctx.ensureTraceForSession('orc')).toBe(id);
		const entry = store.getEntry(id)!;
		expect(entry.root.kind).toBe('owner_message');
		expect(entry.root.summary).toBe('how are you?');
		expect(entry.root.actor).toEqual({ kind: 'owner' });
		const page = await store.read(id);
		expect(page!.events.map((e) => e.type)).toEqual(['trace.root', 'turn.delivered']);
	});

	it('a pending root expires', () => {
		ctx.noteTurnDelivery('orc', '[CHAT:c1:abcd1234] hello');
		clock += 7 * 60 * 60 * 1000;
		expect(ctx.ensureTraceForSession('orc')).toBeNull();
	});

	it.each([
		['[SYSTEM] are you still working?'],
		['[SCHEDULED CHECK-IN - Please continue] hourly check'],
		['[SIGNAL DIGEST] 3 actions for visa.careerengine.us'],
		['[CREWLY-DISPATCH] WorkItem 2c2a1c55-9999-4111-8111-111111111111 queued for you (type=delegate).'],
	])('an untraced delivery (%s) ends the current trace', (text) => {
		ctx.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' }, session: 'dev-1' });
		clock += 1000;
		expect(ctx.noteTurnDelivery('dev-1', text)).toBeNull();
		expect(ctx.currentTrace('dev-1')).toBeNull();
		expect(ctx.traceAt('dev-1', clock + 10)).toBeNull();
		expect(ctx.ensureTraceForSession('dev-1')).toBeNull();
	});

	it('an untraced owner message after a run ends it and waits as a pending root', () => {
		const old = ctx.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' }, session: 'orc' })!;
		ctx.noteTurnDelivery('orc', '[CHAT:c1:abcd1234] new topic: fix the footer');
		expect(ctx.currentTrace('orc')).toBeNull();
		const next = ctx.ensureTraceForSession('orc');
		expect(next).not.toBe(old);
		expect(store.getEntry(next!)?.root.kind).toBe('owner_message');
	});

	it('the current trace ends after the idle gap unless the session keeps working', () => {
		const idle = new TraceContext(() => store, () => clock, 30 * 60_000);
		const id = idle.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' }, session: 'dev-1' })!;
		const t0 = clock;
		clock += 20 * 60_000;
		idle.touch('dev-1');
		clock += 20 * 60_000;
		expect(idle.currentTrace('dev-1')).toBe(id);
		clock += 31 * 60_000;
		expect(idle.currentTrace('dev-1')).toBeNull();
		// A call after the gap does not revive it.
		idle.touch('dev-1');
		expect(idle.currentTrace('dev-1')).toBeNull();
		// Usage is attributed by time: inside the active stretch yes, after the gap no.
		expect(idle.traceAt('dev-1', t0 + 39 * 60_000)).toBe(id);
		expect(idle.traceAt('dev-1', t0 + 75 * 60_000)).toBeNull();
	});

	it('reads the idle gap from CREWLY_TRACE_IDLE_CLEAR_MINUTES', () => {
		const before = process.env.CREWLY_TRACE_IDLE_CLEAR_MINUTES;
		process.env.CREWLY_TRACE_IDLE_CLEAR_MINUTES = '5';
		try {
			expect(defaultIdleClearMs()).toBe(5 * 60_000);
		} finally {
			if (before === undefined) delete process.env.CREWLY_TRACE_IDLE_CLEAR_MINUTES;
			else process.env.CREWLY_TRACE_IDLE_CLEAR_MINUTES = before;
		}
		expect(defaultIdleClearMs()).toBe(30 * 60_000);
	});

	it('clearIfCurrent ends only the named trace', () => {
		const a = ctx.startTrace({ kind: 'goal', summary: 'a', actor: { kind: 'owner' }, session: 'dev-1' })!;
		expect(ctx.clearIfCurrent('dev-1', 'tr-20261003-00000000')).toBe(false);
		expect(ctx.currentTrace('dev-1')).toBe(a);
		expect(ctx.clearIfCurrent('dev-1', a)).toBe(true);
		expect(ctx.currentTrace('dev-1')).toBeNull();
	});

	it('with several traces in one delivery the current one is kept and each records it', async () => {
		const a = ctx.startTrace({ kind: 'goal', summary: 'a', actor: { kind: 'owner' }, session: 'dev-1' })!;
		const b = ctx.startTrace({ kind: 'goal', summary: 'b', actor: { kind: 'owner' } })!;
		expect(ctx.noteTurnDelivery('dev-1', `batch [TRACE:${b}] [TRACE:${a}]`)).toBe(a);
		expect((await store.read(b))!.events.some((e) => e.type === 'turn.delivered')).toBe(true);
	});

	it('looks up the trace a session was on at a given time', () => {
		const t0 = clock;
		const a = ctx.startTrace({ kind: 'goal', summary: 'a', actor: { kind: 'owner' }, session: 'dev-1' })!;
		clock += 60_000;
		const b = ctx.startTrace({ kind: 'goal', summary: 'b', actor: { kind: 'owner' }, session: 'dev-1' })!;
		expect(ctx.traceAt('dev-1', t0 + 30_000)).toBe(a);
		expect(ctx.traceAt('dev-1', clock + 1)).toBe(b);
		expect(ctx.traceAt('dev-1', t0 - 1)).toBeNull();
		expect(ctx.traceAt('nobody')).toBeNull();
	});

	it('shares a span between the traces one delivery names (tracesAt)', () => {
		const a = ctx.startTrace({ kind: 'goal', summary: 'a', actor: { kind: 'owner' } })!;
		const b = ctx.startTrace({ kind: 'goal', summary: 'b', actor: { kind: 'owner' } })!;
		ctx.noteTurnDelivery('dev-1', `batch [TRACE:${a}] [TRACE:${b}]`);
		expect(ctx.tracesAt('dev-1')).toEqual([a, b]);
		// A later delivery about one trace ends the sharing.
		clock += 1_000;
		ctx.noteTurnDelivery('dev-1', `next [TRACE:${a}]`);
		expect(ctx.tracesAt('dev-1')).toEqual([a]);
		expect(ctx.tracesAt('nobody')).toEqual([]);
	});

	describe('listeners (usage ledger)', () => {
		it('tells listeners about recorded events, even when the trace file refused them', () => {
			const id = ctx.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' } })!;
			const seen: Array<[string, number]> = [];
			const off = ctx.addListener((e, meta) => seen.push([e.type, meta.share]));
			ctx.record({ traceId: id, type: 'usage', actor: { kind: 'system' }, summary: 'u' });
			ctx.record({ traceId: id, type: 'usage', actor: { kind: 'system' }, summary: 'u', share: 0.5 });
			off();
			ctx.record({ traceId: id, type: 'usage', actor: { kind: 'system' }, summary: 'u' });
			expect(seen).toEqual([['usage', 1], ['usage', 0.5]]);
		});

		it('survives a throwing listener', () => {
			const id = ctx.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' } })!;
			ctx.addListener(() => {
				throw new Error('boom');
			});
			expect(ctx.record({ traceId: id, type: 'usage', actor: { kind: 'system' }, summary: 'u' })).toBe(true);
		});

		it('splits a busy period shared by two traces between their turn.ended events', () => {
			const a = ctx.startTrace({ kind: 'goal', summary: 'a', actor: { kind: 'owner' } })!;
			const b = ctx.startTrace({ kind: 'goal', summary: 'b', actor: { kind: 'owner' } })!;
			ctx.noteTurnDelivery('dev-1', `batch [TRACE:${a}] [TRACE:${b}]`);
			const shares: Array<[string, number]> = [];
			ctx.addListener((e, meta) => {
				if (e.type === 'turn.ended') shares.push([e.traceId, meta.share]);
			});
			ctx.noteTurnActivity('dev-1', true);
			clock += 60_000;
			ctx.noteTurnActivity('dev-1', false);
			expect(shares).toEqual([[a, 0.5], [b, 0.5]]);
		});
	});

	it('never throws when the store does', () => {
		const broken = new TraceContext(() => {
			throw new Error('no store');
		});
		expect(broken.noteTurnDelivery('dev-1', 'hello')).toBeNull();
		expect(broken.startTrace({ kind: 'goal', summary: 'x', actor: { kind: 'owner' } })).toBeNull();
		expect(broken.record({ traceId: 'tr-20261003-00000001', type: 'usage', actor: { kind: 'system' }, summary: 'x' })).toBe(false);
	});
});
