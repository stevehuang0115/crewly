import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
/**
 * SubAgentMessageQueue Service Tests
 *
 * Tests for the sub-agent message queue singleton that buffers messages
 * for agents that haven't completed initialization yet.
 *
 * @module sub-agent-message-queue.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock logger service
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn(() => ({
			createComponentLogger: jest.fn(() => ({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			})),
		})),
	},
}));

// Mock constants
jest.mock('../../constants.js', () => ({
	SUB_AGENT_QUEUE_CONSTANTS: {
		MAX_QUEUE_SIZE: 5, // Small size for testing overflow
		FLUSH_INTER_MESSAGE_DELAY: 2000,
		MAX_AGE_MS: 6 * 60 * 60 * 1000,
	},
}));

import { SubAgentMessageQueue, type QueuedAgentMessage } from './sub-agent-message-queue.service.js';
import { AgentPostLog, withQueueMeta } from './queue-priority.js';

describe('SubAgentMessageQueue', () => {
	let queue: SubAgentMessageQueue;

	let storePath: string;

	beforeEach(() => {
		SubAgentMessageQueue.resetInstance();
		storePath = path.join(os.tmpdir(), `saq-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
		queue = SubAgentMessageQueue.getInstance(storePath);
	});

	afterEach(() => {
		try { fs.rmSync(storePath, { force: true }); } catch { /* nothing to clean */ }
	});

	describe('getInstance', () => {
		it('should return the same instance', () => {
			const instance1 = SubAgentMessageQueue.getInstance();
			const instance2 = SubAgentMessageQueue.getInstance();
			expect(instance1).toBe(instance2);
		});

		it('should return a new instance after reset', () => {
			const instance1 = SubAgentMessageQueue.getInstance();
			SubAgentMessageQueue.resetInstance();
			const instance2 = SubAgentMessageQueue.getInstance();
			expect(instance1).not.toBe(instance2);
		});
	});

	describe('flush', () => {
		// `sendMessageToAgent` answers success:true when it only puts the
		// message back, so both callers logged "Delivered" in the same
		// millisecond as the re-queue. Reading the log then pointed at the
		// agent when the message had never reached it (2026-09-21, Ella).
		it('separates what landed from what went back on the queue', async () => {
			queue.enqueue('ella', 'first');
			queue.enqueue('ella', 'second');

			const seen: string[] = [];
			const outcome = await queue.flush('ella', async (data) => {
				seen.push(data);
				return data === 'second' ? { queued: true } : {};
			});

			expect(seen).toEqual(['first', 'second']);
			expect(outcome).toEqual({ delivered: 1, deferred: 1, failed: 0, skippedStale: 0 });
		});

		// crewly#1015 review: a /deliver brief held by the restart drain keeps
		// its WorkItem; the hand-over (dedup, fresh conversation) runs when it
		// is finally written.
		it('a queued WorkItem brief gets its hand-over when it is delivered', async () => {
			const prepared: string[] = [];
			const done: string[] = [];
			queue.setHandOverPreparer(async (session, workItemId, data) => {
				prepared.push(`${session}:${workItemId}:${data}`);
				return { message: `[fresh] ${data}`, delivered: () => done.push('delivered'), failed: () => done.push('failed') };
			});
			queue.enqueue('ella', 'brief', { workItemId: 'wi-1' });
			queue.enqueue('ella', 'plain');
			const seen: string[] = [];
			await queue.flush('ella', async (data) => {
				seen.push(data);
				return {};
			});
			queue.setHandOverPreparer(null);
			expect(prepared).toEqual(['ella:wi-1:brief']);
			expect(seen).toEqual(['[fresh] brief', 'plain']);
			expect(done).toEqual(['delivered']);
		});

		// crewly#1015 follow-up M1: the startup backfill dispatched the WorkItem
		// while its brief sat on the queue — the brief must not arrive twice.
		it('drops a held WorkItem brief the dispatcher already delivered', async () => {
			queue.setHandOverPreparer(async (_session, _workItemId, data) => ({
				message: data,
				delivered: () => undefined,
				failed: () => undefined,
				alreadyDispatched: true,
			}));
			queue.enqueue('ella', 'brief', { workItemId: 'wi-1' });
			queue.enqueue('ella', 'plain');
			const seen: string[] = [];
			const outcome = await queue.flush('ella', async (data) => {
				seen.push(data);
				return {};
			});
			queue.setHandOverPreparer(null);
			expect(seen).toEqual(['plain']);
			expect(outcome).toEqual({ delivered: 1, deferred: 0, failed: 0, skippedStale: 1 });
			expect(queue.hasPending('ella')).toBe(false);
		});

		it('a thrown send of a WorkItem brief gives the dispatcher key back (crewly#1015 follow-up)', async () => {
			const calls: string[] = [];
			queue.setHandOverPreparer(async (_s, _id, data) => ({
				message: data,
				delivered: () => calls.push('delivered'),
				failed: () => calls.push('failed'),
				alreadyDispatched: false,
			}));
			queue.enqueue('ella', 'brief', { workItemId: 'wi-1' });
			await queue.flush('ella', async () => {
				throw new Error('pty gone');
			});
			queue.setHandOverPreparer(null);
			expect(calls).toEqual(['failed']);
			expect(queue.hasPending('ella')).toBe(true);
		});

		it('tells the delivered listener about each delivered message, not held or failed ones', async () => {
			const seen: string[] = [];
			queue.setDeliveredListener((session, data) => seen.push(`${session}:${data}`));
			queue.enqueue('ella', 'ok');
			queue.enqueue('ella', 'fails');
			await queue.flush('ella', async (data) => (data === 'fails' ? { success: false, error: 'x' } : {}));
			queue.setDeliveredListener(null);
			expect(seen).toEqual(['ella:ok']);
		});

		it('counts a throwing send as failed and still tries the rest', async () => {
			queue.enqueue('ella', 'a');
			queue.enqueue('ella', 'b');

			const outcome = await queue.flush('ella', async (data) => {
				if (data === 'a') throw new Error('pty gone');
				return {};
			});

			expect(outcome).toEqual({ delivered: 1, deferred: 0, failed: 1, skippedStale: 0 });
		});

		it('empties the queue, so a message re-queued during the flush survives it', async () => {
			queue.enqueue('ella', 'first');

			await queue.flush('ella', async () => {
				// What sendMessageToAgent does when it finds the agent busy.
				queue.enqueue('ella', 'second');
				return { queued: true };
			});

			// Both are still waiting for the next idle event: the held one at
			// its place in front, then the one queued meanwhile.
			expect(queue.dequeueAll('ella').map((m) => m.data)).toEqual(['first', 'second']);
		});

		it('a message held again keeps its place: it and the ones after it stay in order, ahead of newer ones (#1022 review: M17 before M12)', async () => {
			queue.enqueue('ella', 'M12');
			queue.enqueue('ella', 'M17');
			const firstQueuedAt = (queue as unknown as { pendingMessages: Map<string, Array<{ queuedAt: number }>> }).pendingMessages.get('ella')?.[0]?.queuedAt;
			const seen: string[] = [];
			// The turn ends mid-flush: M12 is held again (sendMessageToAgent
			// re-queues it at the back), and M17 would now go straight through.
			const outcome = await queue.flush('ella', async (data) => {
				seen.push(data);
				if (data === 'M12') {
					queue.enqueue('ella', 'M12');
					queue.enqueue('ella', 'M20 (arrived during the flush)');
					return { success: true, queued: true };
				}
				return { success: true };
			});
			expect(seen).toEqual(['M12']); // M17 not sent ahead of M12
			expect(outcome).toEqual({ delivered: 0, deferred: 2, failed: 0, skippedStale: 0 });
			const left = queue.dequeueAll('ella');
			expect(left.map((m) => m.data)).toEqual(['M12', 'M17', 'M20 (arrived during the flush)']);
			expect(left[0].queuedAt).toBe(firstQueuedAt); // its original time, not the re-queue's

			// Next idle: delivered in the original order.
			for (const m of left) queue.enqueue('ella', m.data);
			const order: string[] = [];
			await queue.flush('ella', async (data) => { order.push(data); return { success: true }; });
			expect(order).toEqual(['M12', 'M17', 'M20 (arrived during the flush)']);
		});

		it('failed sends stay ahead of a later held one, all in original order', async () => {
			queue.enqueue('ella', 'A');
			queue.enqueue('ella', 'B');
			queue.enqueue('ella', 'C');
			await queue.flush('ella', async (data) => {
				if (data === 'A') return { success: false, error: 'Runtime has exited' };
				if (data === 'B') { queue.enqueue('ella', 'B'); return { success: true, queued: true }; }
				return { success: true };
			});
			expect(queue.dequeueAll('ella').map((m) => m.data)).toEqual(['A', 'B', 'C']);
		});

		it('is a no-op on an empty queue', async () => {
			expect(await queue.flush('nobody', async () => ({}))).toEqual({ delivered: 0, deferred: 0, failed: 0, skippedStale: 0 });
		});
	});

	describe('remove', () => {
		it('drops a queued copy of a message delivered from the input box, keeping the rest in order', () => {
			queue.enqueue('ella', 'A');
			queue.enqueue('ella', 'B');
			queue.enqueue('ella', 'C');
			expect(queue.remove('ella', 'B')).toBe(true);
			expect(queue.remove('ella', 'B')).toBe(false);
			expect(queue.remove('nobody', 'A')).toBe(false);
			expect(queue.dequeueAll('ella').map((m) => m.data)).toEqual(['A', 'C']);
		});
	});

	describe('enqueue', () => {
		it('should add a message to the queue', () => {
			queue.enqueue('test-session', 'hello');
			expect(queue.getQueueSize('test-session')).toBe(1);
		});

		it('should enqueue multiple messages for the same session', () => {
			queue.enqueue('test-session', 'msg1');
			queue.enqueue('test-session', 'msg2');
			queue.enqueue('test-session', 'msg3');
			expect(queue.getQueueSize('test-session')).toBe(3);
		});

		it('does not stack an identical message already waiting (reconciler redelivers)', () => {
			queue.enqueue('test-session', '[CREWLY-DISPATCH] WorkItem wi-1');
			queue.enqueue('test-session', 'other');
			queue.enqueue('test-session', '[CREWLY-DISPATCH] WorkItem wi-1');
			expect(queue.dequeueAll('test-session').map((m) => m.data)).toEqual(['[CREWLY-DISPATCH] WorkItem wi-1', 'other']);
		});

		it('the same text for another session, or after a flush, is queued again', () => {
			queue.enqueue('session-a', 'same');
			queue.enqueue('session-b', 'same');
			expect(queue.getQueueSize('session-a')).toBe(1);
			expect(queue.getQueueSize('session-b')).toBe(1);
			queue.dequeueAll('session-a');
			queue.enqueue('session-a', 'same');
			expect(queue.getQueueSize('session-a')).toBe(1);
		});

		it('should maintain separate queues per session', () => {
			queue.enqueue('session-a', 'msg-a');
			queue.enqueue('session-b', 'msg-b');
			expect(queue.getQueueSize('session-a')).toBe(1);
			expect(queue.getQueueSize('session-b')).toBe(1);
		});

		it('should drop oldest message when queue is at capacity', () => {
			// MAX_QUEUE_SIZE is mocked to 5
			for (let i = 0; i < 5; i++) {
				queue.enqueue('test-session', `msg-${i}`);
			}
			expect(queue.getQueueSize('test-session')).toBe(5);

			// This should drop msg-0
			queue.enqueue('test-session', 'msg-overflow');
			expect(queue.getQueueSize('test-session')).toBe(5);

			const messages = queue.dequeueAll('test-session');
			expect(messages[0].data).toBe('msg-1'); // msg-0 was dropped
			expect(messages[4].data).toBe('msg-overflow');
		});

		it('should record queuedAt timestamp', () => {
			const before = Date.now();
			queue.enqueue('test-session', 'hello');
			const after = Date.now();

			const messages = queue.dequeueAll('test-session');
			expect(messages[0].queuedAt).toBeGreaterThanOrEqual(before);
			expect(messages[0].queuedAt).toBeLessThanOrEqual(after);
		});

		it('should record sessionName on the message', () => {
			queue.enqueue('my-agent', 'data');
			const messages = queue.dequeueAll('my-agent');
			expect(messages[0].sessionName).toBe('my-agent');
		});
	});

	describe('never drops silently (crewly#1014 review #3)', () => {
		it('reports the oldest message dropped at capacity', () => {
			const listener = jest.fn();
			queue.setDropListener(listener);
			for (let i = 0; i < 6; i++) queue.enqueue('ella', `[CHAT:c1] message ${i}`);
			expect(listener).toHaveBeenCalledWith('ella', [expect.objectContaining({ data: '[CHAT:c1] message 0' })], 'capacity');
		});

		it('a send that fails or throws is not a delivery: re-queued, then reported after the last attempt', async () => {
			const listener = jest.fn();
			queue.setDropListener(listener);
			queue.enqueue('ella', 'first');
			queue.enqueue('ella', 'second');
			const send = jest.fn(async (data: string) => {
				if (data === 'first') return { success: false, error: 'Session does not exist' };
				throw new Error('Runtime has exited');
			});
			for (let i = 0; i < 4; i++) {
				const out = await queue.flush('ella', send);
				expect(out).toMatchObject({ delivered: 0, failed: 2 });
				expect(queue.getQueueSize('ella')).toBe(2);
			}
			await queue.flush('ella', send); // fifth failed attempt
			expect(queue.getQueueSize('ella')).toBe(0);
			expect(listener).toHaveBeenCalledWith('ella', [expect.objectContaining({ data: 'first', attempts: 5 }), expect.objectContaining({ data: 'second', attempts: 5 })], 'undeliverable');
		});

		it('reports messages aged out at load, once a listener is set', () => {
			fs.writeFileSync(storePath, JSON.stringify({ queues: { ella: [
				{ data: 'old', queuedAt: Date.now() - 7 * 60 * 60 * 1000, sessionName: 'ella' },
				{ data: 'fresh', queuedAt: Date.now(), sessionName: 'ella' },
			] } }));
			SubAgentMessageQueue.resetInstance();
			const reloaded = SubAgentMessageQueue.getInstance(storePath);
			const listener = jest.fn();
			reloaded.setDropListener(listener);
			expect(listener).toHaveBeenCalledWith('ella', [expect.objectContaining({ data: 'old' })], 'aged-out');
			expect(reloaded.getQueueSize('ella')).toBe(1);
		});
	});

	describe('dequeueAll', () => {
		it('should return all messages in FIFO order', () => {
			queue.enqueue('test-session', 'first');
			queue.enqueue('test-session', 'second');
			queue.enqueue('test-session', 'third');

			const messages = queue.dequeueAll('test-session');
			expect(messages).toHaveLength(3);
			expect(messages[0].data).toBe('first');
			expect(messages[1].data).toBe('second');
			expect(messages[2].data).toBe('third');
		});

		it('should clear the queue after dequeuing', () => {
			queue.enqueue('test-session', 'msg');
			queue.dequeueAll('test-session');
			expect(queue.getQueueSize('test-session')).toBe(0);
			expect(queue.hasPending('test-session')).toBe(false);
		});

		it('should return empty array for unknown session', () => {
			const messages = queue.dequeueAll('nonexistent');
			expect(messages).toEqual([]);
		});

		it('should return empty array for already-dequeued session', () => {
			queue.enqueue('test-session', 'msg');
			queue.dequeueAll('test-session');
			const messages = queue.dequeueAll('test-session');
			expect(messages).toEqual([]);
		});
	});

	describe('sessionsWithPending', () => {
		it('lists sessions that still have messages waiting (restart restore / wake on down)', () => {
			queue.enqueue('atlas', 'owner question');
			queue.enqueue('ella', 'x');
			queue.clear('ella');
			expect(queue.sessionsWithPending()).toEqual(['atlas']);
		});
	});

	describe('hasPending', () => {
		it('should return false for unknown session', () => {
			expect(queue.hasPending('nonexistent')).toBe(false);
		});

		it('should return true when messages are queued', () => {
			queue.enqueue('test-session', 'msg');
			expect(queue.hasPending('test-session')).toBe(true);
		});

		it('should return false after clear', () => {
			queue.enqueue('test-session', 'msg');
			queue.clear('test-session');
			expect(queue.hasPending('test-session')).toBe(false);
		});
	});

	describe('clear', () => {
		it('should remove all messages for a session', () => {
			queue.enqueue('test-session', 'msg1');
			queue.enqueue('test-session', 'msg2');
			queue.clear('test-session');
			expect(queue.getQueueSize('test-session')).toBe(0);
		});

		it('should not affect other sessions', () => {
			queue.enqueue('session-a', 'msg-a');
			queue.enqueue('session-b', 'msg-b');
			queue.clear('session-a');
			expect(queue.getQueueSize('session-a')).toBe(0);
			expect(queue.getQueueSize('session-b')).toBe(1);
		});

		it('should not throw for unknown session', () => {
			expect(() => queue.clear('nonexistent')).not.toThrow();
		});
	});

	describe('getQueueSize', () => {
		it('should return 0 for unknown session', () => {
			expect(queue.getQueueSize('nonexistent')).toBe(0);
		});

		it('should return correct count', () => {
			queue.enqueue('test-session', 'a');
			queue.enqueue('test-session', 'b');
			expect(queue.getQueueSize('test-session')).toBe(2);
		});
	});

	describe('getTotalQueued', () => {
		it('should sum messages across sessions', () => {
			expect(queue.getTotalQueued()).toBe(0);
			queue.enqueue('session-a', 'a');
			queue.enqueue('session-a', 'b');
			queue.enqueue('session-b', 'c');
			expect(queue.getTotalQueued()).toBe(3);
			queue.clear('session-a');
			expect(queue.getTotalQueued()).toBe(1);
		});
	});

	describe('#236: AGENT_BUSY queuing', () => {
		it('should accept messages queued for busy agents', () => {
			queue.enqueue('busy-agent', 'message while busy');
			expect(queue.hasPending('busy-agent')).toBe(true);
			expect(queue.getQueueSize('busy-agent')).toBe(1);
		});

		it('should deliver queued messages when agent becomes available', () => {
			queue.enqueue('busy-agent', 'queued msg 1');
			queue.enqueue('busy-agent', 'queued msg 2');

			const messages = queue.dequeueAll('busy-agent');
			expect(messages).toHaveLength(2);
			expect(messages[0].data).toBe('queued msg 1');
			expect(messages[1].data).toBe('queued msg 2');
			expect(queue.hasPending('busy-agent')).toBe(false);
		});
	});
});

describe('SubAgentMessageQueue — surviving a restart', () => {
	// The queue is the only record that a person's message has not reached
	// its agent, and it lived in memory alone: a restart dropped it with no
	// trace. The owner had asked for something, seen "working on it", and
	// the request simply ceased to exist (2026-09-21).
	let storePath: string;

	beforeEach(() => {
		storePath = path.join(os.tmpdir(), `saq-restart-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
		SubAgentMessageQueue.resetInstance();
	});
	afterEach(() => {
		try { fs.rmSync(storePath, { force: true }); } catch { /* nothing to clean */ }
	});

	it('brings undelivered messages back after the process ends', () => {
		const before = SubAgentMessageQueue.getInstance(storePath);
		before.enqueue('ella', 'the request nobody answered');
		expect(before.getQueueSize('ella')).toBe(1);

		SubAgentMessageQueue.resetInstance();
		const after = SubAgentMessageQueue.getInstance(storePath);

		expect(after.getQueueSize('ella')).toBe(1);
		expect(after.dequeueAll('ella').map((m) => m.data)).toEqual(['the request nobody answered']);
	});

	it('does not bring back a message old enough that nobody is waiting for it', () => {
		fs.writeFileSync(
			storePath,
			JSON.stringify({
				queues: {
					ella: [
						{ data: 'from yesterday', queuedAt: Date.now() - 7 * 60 * 60 * 1000, sessionName: 'ella' },
						{ data: 'from a minute ago', queuedAt: Date.now() - 60_000, sessionName: 'ella' },
					],
				},
			}),
			'utf-8',
		);

		const q = SubAgentMessageQueue.getInstance(storePath);
		expect(q.dequeueAll('ella').map((m) => m.data)).toEqual(['from a minute ago']);
	});

	it('a drained queue stays drained across a restart', () => {
		const before = SubAgentMessageQueue.getInstance(storePath);
		before.enqueue('ella', 'x');
		before.dequeueAll('ella');

		SubAgentMessageQueue.resetInstance();
		expect(SubAgentMessageQueue.getInstance(storePath).hasPending('ella')).toBe(false);
	});

	it('starts empty when the file is corrupt rather than refusing to boot', () => {
		fs.writeFileSync(storePath, '{ not json', 'utf-8');
		expect(SubAgentMessageQueue.getInstance(storePath).hasPending('ella')).toBe(false);
	});

	// specs/2026-10-03-usage-ledger-durability.md
	describe('store durability', () => {
		it('copies a corrupt store aside before starting empty, so the next save cannot destroy it', () => {
			fs.writeFileSync(storePath, '{"queues":{"dev-1":[{"data":"hel');
			SubAgentMessageQueue.resetInstance();
			const q = SubAgentMessageQueue.getInstance(storePath);
			const dir = path.dirname(storePath);
			const aside = fs.readdirSync(dir).filter((f) => f.startsWith(`${path.basename(storePath)}.corrupt-`));
			try {
				expect(aside).toHaveLength(1);
				expect(fs.readFileSync(path.join(dir, aside[0]), 'utf-8')).toBe('{"queues":{"dev-1":[{"data":"hel');
				q.enqueue('dev-2', 'hello');
				expect(JSON.parse(fs.readFileSync(storePath, 'utf-8')).queues['dev-2']).toHaveLength(1);
			} finally {
				for (const f of aside) fs.rmSync(path.join(dir, f), { force: true });
			}
		});
	});
	it('a good store it could not read (EMFILE) is re-read and merged on the next save, never set aside', () => {
		fs.writeFileSync(storePath, JSON.stringify({ queues: { 'dev-1': [{ data: 'earlier', queuedAt: Date.now() - 1000 }] } }));
		// The namespace import is not spyable; spy on the real module object.
		const realFs = require('fs') as typeof import('fs');
		const spy = jest.spyOn(realFs, 'readFileSync').mockImplementationOnce((() => {
			throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
		}) as unknown as typeof realFs.readFileSync);
		SubAgentMessageQueue.resetInstance();
		const q = SubAgentMessageQueue.getInstance(storePath);
		spy.mockRestore();
		q.enqueue('dev-1', 'later');
		const saved = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
		expect(saved.queues['dev-1'].map((m: { data: string }) => m.data)).toEqual(['earlier', 'later']);
		expect(fs.readdirSync(path.dirname(storePath)).filter((f) => f.startsWith(`${path.basename(storePath)}.corrupt-`))).toEqual([]);
	});
});

describe('owner priority and stale pruning (2026-10-05, D-270)', () => {
	// The owner's answer to Atlas's card was queued 7th, behind "promised work
	// is ready" reminders, a copy of an owner message Atlas had already
	// answered and a TASK RECOVERY note; one message per idle moment, oldest
	// first, took ~18 minutes to reach it.
	let queue: SubAgentMessageQueue;
	let storePath: string;
	const OWNER = { owner: true } as const;

	beforeEach(() => {
		SubAgentMessageQueue.resetInstance();
		AgentPostLog.resetInstance();
		storePath = path.join(os.tmpdir(), `saq-prio-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
		queue = SubAgentMessageQueue.getInstance(storePath);
	});

	afterEach(() => {
		try { fs.rmSync(storePath, { force: true }); } catch { /* nothing to clean */ }
	});

	/** Deliver everything; the agent takes each message. */
	async function drain(session: string): Promise<string[]> {
		const seen: string[] = [];
		await queue.flush(session, async (data) => {
			seen.push(data);
			return { success: true };
		});
		return seen;
	}

	it('owner messages go to the front, in the order they came; system traffic keeps its order behind them', async () => {
		queue.enqueue('atlas', 'reminder TKT-270 #1');
		queue.enqueue('atlas', 'TASK RECOVERY');
		queue.enqueue('atlas', 'owner A', { queueMeta: { ...OWNER, ref: 'slack:C1:1.0' } });
		queue.enqueue('atlas', 'reminder TKT-271');
		queue.enqueue('atlas', '[DECISION D-270] owner answered', { queueMeta: { ...OWNER, ref: 'decision:D-270' } });
		expect(queue.peek('atlas').map((m) => m.data)).toEqual([
			'owner A',
			'[DECISION D-270] owner answered',
			'reminder TKT-270 #1',
			'TASK RECOVERY',
			'reminder TKT-271',
		]);
		expect(await drain('atlas')).toEqual([
			'owner A',
			'[DECISION D-270] owner answered',
			'reminder TKT-270 #1',
			'TASK RECOVERY',
			'reminder TKT-271',
		]);
	});

	it('non-owner traffic is unchanged: plain FIFO', async () => {
		for (const t of ['a', 'b', 'c']) queue.enqueue('ella', t);
		expect(await drain('ella')).toEqual(['a', 'b', 'c']);
	});

	it('picks the metadata up from the delivery running now (withQueueMeta), only for that message to that agent', () => {
		withQueueMeta('atlas', 'the owner said', { ...OWNER, ref: 'chat:c:1' }, () => {
			queue.enqueue('atlas', 'some reminder'); // a different message: no meta
			queue.enqueue('ella', 'the owner said'); // a different agent: no meta
			queue.enqueue('atlas', 'the owner said');
		});
		expect(queue.peek('atlas').map((m) => [m.data, m.meta?.owner === true])).toEqual([
			['the owner said', true],
			['some reminder', false],
		]);
		expect(queue.peek('ella')[0].meta).toBeUndefined();
	});

	it('an owner message still waiting when the agent is busy keeps its place at the front', async () => {
		queue.enqueue('atlas', 'reminder');
		queue.enqueue('atlas', 'owner A', { queueMeta: OWNER });
		// Busy: `send` re-queues (at the back, as sendMessageToAgent does) and says queued.
		await queue.flush('atlas', async (data) => {
			queue.enqueue('atlas', data);
			return { success: true, queued: true };
		});
		queue.enqueue('atlas', 'another reminder');
		queue.enqueue('atlas', 'owner B', { queueMeta: OWNER });
		expect(queue.peek('atlas').map((m) => m.data)).toEqual(['owner A', 'owner B', 'reminder', 'another reminder']);
	});

	it('at capacity the oldest non-owner message is dropped, never an owner message first', () => {
		queue.enqueue('atlas', 'owner A', { queueMeta: OWNER });
		for (const t of ['r1', 'r2', 'r3', 'r4']) queue.enqueue('atlas', t);
		queue.enqueue('atlas', 'r5'); // MAX_QUEUE_SIZE is 5 in this suite
		expect(queue.peek('atlas').map((m) => m.data)).toEqual(['owner A', 'r2', 'r3', 'r4', 'r5']);
	});

	it('drops a queued thread message once the agent has posted in that thread after it was queued', async () => {
		const where = { chatChannelId: 'room', chatThreadId: 'root-1', slackChannelId: 'C1', threadTs: '1001.0' };
		queue.enqueue('atlas', 'owner: keep both versions', { queueMeta: { ...OWNER, ref: 'slack:C1:1005.0', where } });
		queue.enqueue('atlas', 'owner: other thread', { queueMeta: { ...OWNER, where: { chatChannelId: 'room', chatThreadId: 'root-2' } } });
		const queuedAt = queue.peek('atlas')[0].queuedAt;
		// Atlas answered in the first thread (via the Slack card thread).
		AgentPostLog.getInstance().note('atlas', { slackChannelId: 'C1', threadTs: '1001.0' }, queuedAt + 1);
		// A post by someone else, or before it was queued, does not count.
		AgentPostLog.getInstance().note('ella', { chatChannelId: 'room', chatThreadId: 'root-2' }, queuedAt + 1);
		AgentPostLog.getInstance().note('atlas', { chatChannelId: 'room', chatThreadId: 'root-2' }, queuedAt - 1);
		const out = { seen: [] as string[] };
		const result = await queue.flush('atlas', async (data) => {
			out.seen.push(data);
			return { success: true };
		});
		expect(out.seen).toEqual(['owner: other thread']);
		expect(result.skippedStale).toBe(1);
	});

	it('a top-level DM message is not dropped by an unrelated post in the same DM', async () => {
		queue.enqueue('atlas', 'owner DM', { queueMeta: { ...OWNER, where: { chatChannelId: 'dm-1' } } });
		AgentPostLog.getInstance().note('atlas', { chatChannelId: 'dm-1' }, Date.now() + 5);
		expect(await drain('atlas')).toEqual(['owner DM']);
	});

	it('drops a second queued copy of the same owner message (by id, not by text)', async () => {
		// Two different texts carrying the same owner message (a re-dispatch and the watchdog's reminder).
		queue.enqueue('atlas', 'owner A (first delivery)', { queueMeta: { ...OWNER, ref: 'slack:C1:2.0' } });
		queue.enqueue('atlas', 'owner A (reminder)', { queueMeta: { ...OWNER, ref: 'slack:C1:2.0' } });
		// Restored from disk (or queued by an older build) — the flush catches it too.
		(queue as unknown as { pendingMessages: Map<string, QueuedAgentMessage[]> }).pendingMessages.get('atlas')!.push({
			data: 'owner A (restored copy)',
			queuedAt: Date.now(),
			sessionName: 'atlas',
			meta: { owner: true, ref: 'slack:C1:2.0' },
		});
		// Same text, different owner messages: both kept.
		queue.enqueue('atlas', 'ok', { queueMeta: { ...OWNER, ref: 'slack:C1:3.0' } });
		expect(await drain('atlas')).toEqual(['owner A (first delivery)', 'ok']);
	});

	it('keeps only the newest of reminders that replace each other (same ticket)', async () => {
		queue.enqueue('atlas', '[FOLLOW-UP TKT-270] ready (part 1)', { queueMeta: { supersedeKey: 'followup:r-270' } });
		queue.enqueue('atlas', '[FOLLOW-UP TKT-271] ready', { queueMeta: { supersedeKey: 'followup:r-271' } });
		await new Promise((r) => setTimeout(r, 2));
		queue.enqueue('atlas', '[FOLLOW-UP TKT-270] ready (parts 1, 2)', { queueMeta: { supersedeKey: 'followup:r-270' } });
		expect(await drain('atlas')).toEqual(['[FOLLOW-UP TKT-271] ready', '[FOLLOW-UP TKT-270] ready (parts 1, 2)']);
	});

	it('metadata and priority survive a restart', () => {
		queue.enqueue('atlas', 'reminder');
		queue.enqueue('atlas', 'owner A', { queueMeta: { ...OWNER, ref: 'slack:C1:9.0' } });
		SubAgentMessageQueue.resetInstance();
		const again = SubAgentMessageQueue.getInstance(storePath);
		expect(again.peek('atlas').map((m) => [m.data, m.meta?.ref ?? null])).toEqual([
			['owner A', 'slack:C1:9.0'],
			['reminder', null],
		]);
	});
});
