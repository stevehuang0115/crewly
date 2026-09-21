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

import { SubAgentMessageQueue } from './sub-agent-message-queue.service.js';

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
			expect(outcome).toEqual({ delivered: 1, deferred: 1, failed: 0 });
		});

		it('counts a throwing send as failed and still tries the rest', async () => {
			queue.enqueue('ella', 'a');
			queue.enqueue('ella', 'b');

			const outcome = await queue.flush('ella', async (data) => {
				if (data === 'a') throw new Error('pty gone');
				return {};
			});

			expect(outcome).toEqual({ delivered: 1, deferred: 0, failed: 1 });
		});

		it('empties the queue, so a message re-queued during the flush survives it', async () => {
			queue.enqueue('ella', 'first');

			await queue.flush('ella', async () => {
				// What sendMessageToAgent does when it finds the agent busy.
				queue.enqueue('ella', 'second');
				return { queued: true };
			});

			// The re-queued one is still there and is the only one left —
			// that is what the next idle event must pick up.
			expect(queue.getQueueSize('ella')).toBe(1);
			expect(queue.dequeueAll('ella').map((m) => m.data)).toEqual(['second']);
		});

		it('is a no-op on an empty queue', async () => {
			expect(await queue.flush('nobody', async () => ({}))).toEqual({ delivered: 0, deferred: 0, failed: 0 });
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
});
