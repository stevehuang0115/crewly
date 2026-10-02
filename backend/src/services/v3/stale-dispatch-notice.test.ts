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
import { WorkItemDispatchSubscriber, dispatchNoticeWorkItemIds, isStaleDispatchNotice } from './workitem-dispatch.subscriber.js';
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
