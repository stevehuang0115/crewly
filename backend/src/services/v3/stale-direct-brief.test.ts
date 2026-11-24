/**
 * Stale DIRECT briefs on wake (CREW-843).
 *
 * A team-leader `delegate-task` brief (`WorkItem <id> — New task from …`) for
 * an agent that was stopped waits in its persisted message queue. The stale
 * check only covered `[CREWLY-DISPATCH]` notices, so the brief was delivered
 * on wake even when its WorkItem had been cancelled, finished or blocked
 * meanwhile (WI 19826009 was blocked on a stopped team and later started).
 *
 * These tests use a real SubAgentMessageQueue and the real stale check.
 *
 * @module services/v3/stale-direct-brief.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isStaleDispatchNotice } from './workitem-dispatch.subscriber.js';
import { SubAgentMessageQueue } from '../messaging/sub-agent-message-queue.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
		}),
	},
}));

const TARGET = 'flopost-pia-50c4c954';

/** A direct brief as team-leader `delegate-task` writes it. */
const brief = (id: string): string => `WorkItem ${id} — New task from Team Leader (priority: normal):\n\nWrite the post.`;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-direct-brief-'));
	SubAgentMessageQueue.resetInstance();
});

afterEach(() => {
	SubAgentMessageQueue.resetInstance();
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Queues the given messages for the stopped agent, then "wakes" it: flushes the
 * queue with the real stale check against the given pool.
 *
 * @param messages - Messages queued while the agent was stopped
 * @param pool - WorkItem id to current status
 * @returns The delivered texts and the flush outcome
 */
async function wake(messages: string[], pool: Record<string, WorkItem['status']>) {
	const queue = SubAgentMessageQueue.getInstance(path.join(dir, 'queue.json'));
	for (const m of messages) queue.enqueue(TARGET, m);
	queue.setStaleMessageCheck((data) =>
		isStaleDispatchNotice(data, async (id) => (id in pool ? { status: pool[id] } : null)),
	);
	const delivered: string[] = [];
	const outcome = await queue.flush(TARGET, async (data) => {
		delivered.push(data);
		return {};
	});
	return { delivered, outcome };
}

describe('queued direct brief whose WorkItem changed while the agent was stopped (CREW-843)', () => {
	it.each(['cancelled', 'done', 'verified', 'blocked'] as const)('drops the brief when its WorkItem is %s', async (status) => {
		const { delivered, outcome } = await wake([brief('wi-1')], { 'wi-1': status });
		expect(delivered).toEqual([]);
		expect(outcome.skippedStale).toBe(1);
	});

	it.each(['queued', 'running'] as const)('still delivers the brief when its WorkItem is %s', async (status) => {
		const { delivered, outcome } = await wake([brief('wi-1')], { 'wi-1': status });
		expect(delivered).toEqual([brief('wi-1')]);
		expect(outcome.skippedStale).toBe(0);
	});

	it('delivers a brief whose WorkItem is not in the pool (cannot tell it is unwanted)', async () => {
		const { delivered } = await wake([brief('wi-unknown')], {});
		expect(delivered).toEqual([brief('wi-unknown')]);
	});

	it('leaves messages with no WorkItem alone', async () => {
		const plain = 'Lead: please look at the build when you are back';
		const { delivered } = await wake([plain], { 'wi-1': 'cancelled' });
		expect(delivered).toEqual([plain]);
	});

	it('drops only the unwanted brief out of several', async () => {
		const { delivered, outcome } = await wake([brief('wi-old'), brief('wi-live'), 'hello'], {
			'wi-old': 'blocked',
			'wi-live': 'running',
		});
		expect(delivered).toEqual([brief('wi-live'), 'hello']);
		expect(outcome.skippedStale).toBe(1);
	});
});
