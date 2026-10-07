/**
 * Stale dispatch notices after a restart (#836).
 *
 * A `[CREWLY-DISPATCH] WorkItem X queued for you` notice written while the
 * agent was not ready waits in the persisted agent message queue. After a
 * restart the queue is restored from disk and replayed — and the notice was
 * delivered even though X had been verified hours earlier (WIs 1921b8b4 and
 * a2ffa8e6, re-announced one per notification on 2026-09-27).
 *
 * These tests build the notices with the real dispatcher, persist them in a
 * real SubAgentMessageQueue, simulate the restart by re-reading the queue file,
 * and check that only the notice for still-queued work is delivered.
 *
 * @module services/v3/stale-dispatch-notice.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { WorkItemDispatchSubscriber, dispatchNoticeWorkItemIds, isStaleDispatchNotice, refreshBatchDispatchNotice } from './workitem-dispatch.subscriber.js';
import { SubAgentMessageQueue } from '../messaging/sub-agent-message-queue.service.js';
import { createWorkItem } from '../../types/v2/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
		}),
	},
}));

const TARGET = 'crewly-product-team-sam-9487fefe';

/**
 * Builds a WorkItem fixture for the target session.
 *
 * @param id - WorkItem id
 * @param status - Current status
 * @returns The WorkItem
 */
function makeWorkItem(id: string, status: WorkItem['status']): WorkItem {
	return { ...createWorkItem({ type: 'delegate', owner: 'agent', title: 'Check whether #820 merged', target: TARGET }), id, status };
}

/**
 * Captures the single-item notice the dispatcher writes for a WorkItem.
 *
 * @param wi - WorkItem to announce
 * @returns The notice text
 */
async function noticeFor(wi: WorkItem): Promise<string> {
	mockedAxios.post.mockClear();
	expect(await WorkItemDispatchSubscriber.getInstance().dispatchTo(wi)).toBe(true);
	return (mockedAxios.post.mock.calls[0][1] as { data: string }).data;
}

/**
 * Captures the batch reminder the dispatcher writes for several WorkItems.
 *
 * @param items - WorkItems sharing the target
 * @returns The reminder text
 */
async function batchNoticeFor(items: WorkItem[]): Promise<string> {
	mockedAxios.post.mockClear();
	expect(await WorkItemDispatchSubscriber.getInstance().redispatchMany(items)).toBe(true);
	return (mockedAxios.post.mock.calls[0][1] as { data: string }).data;
}

describe('stale dispatch notices (#836)', () => {
	let storePath: string;

	beforeEach(() => {
		WorkItemDispatchSubscriber.resetInstance();
		SubAgentMessageQueue.resetInstance();
		mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });
		storePath = path.join(os.tmpdir(), `stale-dispatch-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
	});

	afterEach(() => {
		SubAgentMessageQueue.resetInstance();
		WorkItemDispatchSubscriber.resetInstance();
		fs.rmSync(storePath, { force: true });
	});

	it('reads the announced ids from single and batch notices', async () => {
		const a = makeWorkItem('1921b8b4-0b48-4f06-933a-7dd56d76dcc8', 'queued');
		const b = makeWorkItem('a2ffa8e6-7643-4204-bf03-dfabf19d5a55', 'queued');
		expect(dispatchNoticeWorkItemIds(await noticeFor(a))).toEqual([a.id]);
		expect(dispatchNoticeWorkItemIds(await batchNoticeFor([a, b]))).toEqual([a.id, b.id]);
		expect(dispatchNoticeWorkItemIds('Hello from the orchestrator')).toBeNull();
	});

	it('after a restart, delivers the notice for queued work and drops the ones for finished work', async () => {
		const verified = makeWorkItem('1921b8b4-0b48-4f06-933a-7dd56d76dcc8', 'queued');
		const done = makeWorkItem('a2ffa8e6-7643-4204-bf03-dfabf19d5a55', 'queued');
		const stillQueued = makeWorkItem('0fc8ba3d-fa75-4b20-89a1-731d44b1db6e', 'queued');

		// Before the restart: the notices are queued because the agent is not ready.
		const before = SubAgentMessageQueue.getInstance(storePath);
		before.enqueue(TARGET, await noticeFor(verified));
		before.enqueue(TARGET, await noticeFor(done));
		before.enqueue(TARGET, await noticeFor(stillQueued));
		before.enqueue(TARGET, 'A plain message from the team lead');

		// The work moves on: two items finish.
		const pool = new Map<string, WorkItem>([
			[verified.id, { ...verified, status: 'verified' }],
			[done.id, { ...done, status: 'done' }],
			[stillQueued.id, stillQueued],
		]);

		// Restart: the queue is read back from disk, the dispatcher's check is wired.
		SubAgentMessageQueue.resetInstance();
		const after = SubAgentMessageQueue.getInstance(storePath);
		after.setStaleMessageCheck((data) => isStaleDispatchNotice(data, async (id) => pool.get(id) ?? null));

		const delivered: string[] = [];
		const outcome = await after.flush(TARGET, async (data) => {
			delivered.push(data);
			return {};
		});

		expect(outcome).toEqual({ delivered: 2, deferred: 0, failed: 0, skippedStale: 2 });
		expect(delivered).toHaveLength(2);
		expect(delivered[0]).toContain(stillQueued.id);
		expect(delivered[1]).toBe('A plain message from the team lead');
		expect(delivered.join('\n')).not.toContain(verified.id);
		expect(delivered.join('\n')).not.toContain(done.id);
	});

	it('keeps a batch reminder while any item in it is still queued', async () => {
		const finished = makeWorkItem('wi-finished', 'queued');
		const open = makeWorkItem('wi-open', 'queued');
		const notice = await batchNoticeFor([finished, open]);
		const lookup = async (id: string) => (id === finished.id ? { status: 'cancelled' as const } : { status: 'queued' as const });
		expect(await isStaleDispatchNotice(notice, lookup)).toBe(false);
		expect(await isStaleDispatchNotice(notice, async () => ({ status: 'failed' as const }))).toBe(true);
	});

	it('treats a notice for a WorkItem that is gone from the pool as stale', async () => {
		const notice = await noticeFor(makeWorkItem('wi-gone', 'queued'));
		expect(await isStaleDispatchNotice(notice, async () => null)).toBe(true);
	});

	it('prunes stale notices at boot so the agent is not restored for them alone', async () => {
		const verified = makeWorkItem('wi-verified', 'queued');
		const before = SubAgentMessageQueue.getInstance(storePath);
		before.enqueue(TARGET, await noticeFor(verified));
		before.enqueue('crewly-marketing-dana-45506487', 'Please run the nightly metrics');

		SubAgentMessageQueue.resetInstance();
		const after = SubAgentMessageQueue.getInstance(storePath);
		expect(after.sessionsWithPending().sort()).toEqual(['crewly-marketing-dana-45506487', TARGET]);
		after.setStaleMessageCheck((data) => isStaleDispatchNotice(data, async () => ({ status: 'verified' })));

		expect(await after.pruneStale()).toEqual({ examined: 2, skippedStale: 1 });
		expect(after.sessionsWithPending()).toEqual(['crewly-marketing-dana-45506487']);

		// The pruned state is persisted.
		SubAgentMessageQueue.resetInstance();
		expect(SubAgentMessageQueue.getInstance(storePath).sessionsWithPending()).toEqual(['crewly-marketing-dana-45506487']);
	});
});

// crewly#1015 follow-up: a drain longer than the grace period queued both the
// held brief and the dispatcher's own notice for one WorkItem.
describe('isStaleDispatchNotice and already-delivered WorkItems', () => {
	const ID = '7d1e2f3a-0000-4000-8000-000000001015';
	const notice = `[CREWLY-DISPATCH] WorkItem ${ID} queued for you (type=delegate).`;
	const open = async () => ({ status: 'queued' }) as Pick<WorkItem, 'status'>;

	it('drops a notice whose WorkItem was already delivered to the target', async () => {
		expect(await isStaleDispatchNotice(notice, open, (id) => id === ID)).toBe(true);
	});

	it('keeps it when the WorkItem was not delivered yet', async () => {
		expect(await isStaleDispatchNotice(notice, open, () => false)).toBe(false);
		expect(await isStaleDispatchNotice(notice, open)).toBe(false);
	});
});

// crewly#1015 follow-up re-review: a notice the terminal QUEUED (202, agent
// not active) is not a delivery — the stale check must not drop it.
describe('queued dispatch notices and held briefs (crewly#1015 follow-up)', () => {
	let storePath: string;
	const WI = '5c1d2e3f-0000-4000-8000-000000001031';

	beforeEach(() => {
		WorkItemDispatchSubscriber.resetInstance();
		SubAgentMessageQueue.resetInstance();
		storePath = path.join(os.tmpdir(), `queued-notice-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
	});

	afterEach(() => {
		SubAgentMessageQueue.resetInstance();
		WorkItemDispatchSubscriber.resetInstance();
		fs.rmSync(storePath, { force: true });
	});

	/** Wire the queue like the server does (stale check, delivered listener, hand-over). */
	function wire(queue: SubAgentMessageQueue, pool: Map<string, WorkItem>): void {
		const d = WorkItemDispatchSubscriber.getInstance();
		queue.setStaleMessageCheck((data, session) =>
			isStaleDispatchNotice(data, async (id) => pool.get(id) ?? null, (id) => d.isDelivered(id, session)),
		);
		queue.setDeliveredListener((session, data) => {
			for (const id of dispatchNoticeWorkItemIds(data) ?? []) d.noteDeliveredFromQueue(id, session);
		});
		queue.setHandOverPreparer(async (session, id, data) => {
			const took = d.claimDirectDelivery(id, session);
			return { message: data, delivered: () => undefined, failed: () => (took ? d.releaseDirectDelivery(id, session) : undefined), alreadyDispatched: !took };
		});
	}

	/** The dispatcher writes to an agent that is not active: the terminal queues it (202). */
	async function queuedNotice(queue: SubAgentMessageQueue, wi: WorkItem): Promise<string> {
		mockedAxios.post.mockClear();
		mockedAxios.post.mockResolvedValue({ status: 202, data: { success: true, queued: true, message: 'Message queued until agent is ready' } });
		expect(await WorkItemDispatchSubscriber.getInstance().dispatchTo(wi)).toBe(true);
		const notice = (mockedAxios.post.mock.calls[0][1] as { data: string }).data;
		queue.enqueue(TARGET, notice); // what /terminal/write did with it
		return notice;
	}

	it('a notice queued for an agent that is not active is delivered on flush (not dropped as stale)', async () => {
		const wi = makeWorkItem(WI, 'queued');
		const queue = SubAgentMessageQueue.getInstance(storePath);
		wire(queue, new Map([[wi.id, wi]]));
		await queuedNotice(queue, wi);
		const d = WorkItemDispatchSubscriber.getInstance();
		expect(d.isDelivered(wi.id, TARGET)).toBe(false);
		expect(d.isPendingQueued(wi.id, TARGET)).toBe(true);

		const delivered: string[] = [];
		const outcome = await queue.flush(TARGET, async (data) => (delivered.push(data), {}));
		expect(outcome).toEqual({ delivered: 1, deferred: 0, failed: 0, skippedStale: 0 });
		expect(delivered[0]).toContain(wi.id);
		expect(d.isDelivered(wi.id, TARGET)).toBe(true);
	});

	it('redispatch while the notice waits on the queue writes nothing more', async () => {
		const wi = makeWorkItem(WI, 'queued');
		const queue = SubAgentMessageQueue.getInstance(storePath);
		wire(queue, new Map([[wi.id, wi]]));
		await queuedNotice(queue, wi);
		const d = WorkItemDispatchSubscriber.getInstance();
		expect(await d.dispatchTo(wi)).toBe(false);
		expect(await d.redispatch(wi)).toBe(false);
		expect(mockedAxios.post).toHaveBeenCalledTimes(1);
		expect(queue.getQueueSize(TARGET)).toBe(1);
		// Once the queued notice is gone (dropped elsewhere), a redispatch writes again.
		queue.clear(TARGET);
		mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });
		expect(await d.redispatch(wi)).toBe(true);
		expect(mockedAxios.post).toHaveBeenCalledTimes(2);
	});

	it.each([
		['the held brief first', true],
		['the notice first', false],
	])('a held brief plus the queued notice brief the agent exactly once (%s, same process)', async (_n, briefFirst) => {
		const wi = makeWorkItem(WI, 'queued');
		const queue = SubAgentMessageQueue.getInstance(storePath);
		wire(queue, new Map([[wi.id, wi]]));
		const brief = `WorkItem ${wi.id} — the brief the team lead handed over`;
		if (briefFirst) queue.enqueue(TARGET, brief, { workItemId: wi.id });
		await queuedNotice(queue, wi);
		if (!briefFirst) queue.enqueue(TARGET, brief, { workItemId: wi.id });

		const delivered: string[] = [];
		await queue.flush(TARGET, async (data) => (delivered.push(data), {}));
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain(wi.id);
	});

	it.each([
		['the held brief first', true],
		['the notice first', false],
	])('after a restart (drain outlasted the grace period) they still brief once (%s)', async (_n, briefFirst) => {
		const wi = makeWorkItem(WI, 'queued');
		const before = SubAgentMessageQueue.getInstance(storePath);
		const brief = `WorkItem ${wi.id} — the brief the team lead handed over`;
		if (briefFirst) before.enqueue(TARGET, brief, { workItemId: wi.id });
		await queuedNotice(before, wi);
		if (!briefFirst) before.enqueue(TARGET, brief, { workItemId: wi.id });

		// Restart: a new process — the dispatcher remembers nothing, the queue is read back.
		SubAgentMessageQueue.resetInstance();
		WorkItemDispatchSubscriber.resetInstance();
		const after = SubAgentMessageQueue.getInstance(storePath);
		wire(after, new Map([[wi.id, wi]]));
		const delivered: string[] = [];
		await after.flush(TARGET, async (data) => (delivered.push(data), {}));
		expect(delivered).toHaveLength(1);
		expect(after.hasPending(TARGET)).toBe(false);
	});
});

// CREW-266: a batch reminder that waited on the queue while the agent worked
// named items it had finished meanwhile (2026-10-06 17:47Z: 15 listed, 12 done
// by delivery at 17:51Z; the lead then tried to claim finished items).
describe('batch reminders drop items finished while they waited (CREW-266)', () => {
	let storePath: string;

	beforeEach(() => {
		WorkItemDispatchSubscriber.resetInstance();
		SubAgentMessageQueue.resetInstance();
		mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });
		storePath = path.join(os.tmpdir(), `refresh-batch-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
	});

	afterEach(() => {
		SubAgentMessageQueue.resetInstance();
		WorkItemDispatchSubscriber.resetInstance();
		fs.rmSync(storePath, { force: true });
	});

	it('rewrites the list to the items still queued, renumbered, with the count updated', async () => {
		const items = ['wi-a', 'wi-b', 'wi-c'].map((id) => makeWorkItem(id, 'queued'));
		const notice = await batchNoticeFor(items);
		const status: Record<string, WorkItem['status']> = { 'wi-a': 'done', 'wi-b': 'queued', 'wi-c': 'done_by_worker' };
		const fresh = await refreshBatchDispatchNotice(notice, async (id) => ({ status: status[id] }));
		expect(fresh).not.toBeNull();
		expect(dispatchNoticeWorkItemIds(fresh!)).toEqual(['wi-b']);
		expect(fresh).toContain('[CREWLY-DISPATCH] 1 WorkItem is still queued for you');
		expect(fresh).toMatch(/^\s+1\. wi-b \(type=/m);
		expect(fresh).not.toContain('wi-a');
		expect(fresh).not.toContain('wi-c');
		// Running it again on the rewritten text is stable.
		expect(await refreshBatchDispatchNotice(fresh!, async (id) => ({ status: status[id] }))).toBe(fresh);
	});

	it('leaves an up-to-date reminder, a single notice and plain text unchanged; drops an all-finished reminder', async () => {
		const items = ['wi-a', 'wi-b'].map((id) => makeWorkItem(id, 'queued'));
		const notice = await batchNoticeFor(items);
		expect(await refreshBatchDispatchNotice(notice, async () => ({ status: 'queued' }))).toBe(notice);
		expect(await refreshBatchDispatchNotice(notice, async () => ({ status: 'verified' }))).toBeNull();
		expect(await refreshBatchDispatchNotice(notice, async () => null)).toBeNull();
		const single = await noticeFor(makeWorkItem('wi-one', 'queued'));
		expect(await refreshBatchDispatchNotice(single, async () => ({ status: 'done' }))).toBe(single);
		expect(await refreshBatchDispatchNotice('Hello from the lead', async () => null)).toBe('Hello from the lead');
	});

	it('the queue delivers the refreshed text and drops a reminder with nothing left', async () => {
		const items = ['wi-a', 'wi-b', 'wi-c'].map((id) => makeWorkItem(id, 'queued'));
		const queue = SubAgentMessageQueue.getInstance(storePath);
		queue.enqueue(TARGET, await batchNoticeFor(items));
		queue.enqueue(TARGET, await batchNoticeFor(items.slice(0, 2)));
		const status: Record<string, WorkItem['status']> = { 'wi-a': 'done', 'wi-b': 'verified', 'wi-c': 'queued' };
		queue.setMessageRefresher((data) => refreshBatchDispatchNotice(data, async (id) => ({ status: status[id] })));

		const delivered: string[] = [];
		const outcome = await queue.flush(TARGET, async (data) => {
			delivered.push(data);
			return {};
		});
		expect(outcome).toEqual({ delivered: 1, deferred: 0, failed: 0, skippedStale: 1 });
		expect(dispatchNoticeWorkItemIds(delivered[0])).toEqual(['wi-c']);
	});

	it('a refresher that throws delivers the message as queued', async () => {
		const queue = SubAgentMessageQueue.getInstance(storePath);
		queue.enqueue(TARGET, 'Plain text');
		queue.setMessageRefresher(() => { throw new Error('pool down'); });
		const delivered: string[] = [];
		await queue.flush(TARGET, async (data) => {
			delivered.push(data);
			return {};
		});
		expect(delivered).toEqual(['Plain text']);
	});
});
