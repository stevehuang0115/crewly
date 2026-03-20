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
	},
}));

import { SubAgentMessageQueue } from './sub-agent-message-queue.service.js';

describe('SubAgentMessageQueue', () => {
	let queue: SubAgentMessageQueue;

	beforeEach(() => {
		SubAgentMessageQueue.resetInstance();
		queue = SubAgentMessageQueue.getInstance();
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
