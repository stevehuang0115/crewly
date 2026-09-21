/**
 * Sub-Agent Message Queue Service
 *
 * Buffers messages destined for sub-agents that have not yet completed
 * initialization (agentStatus !== 'active'). Messages are flushed once
 * the agent registers via the MCP `register_agent_status` tool.
 *
 * The orchestrator is excluded from this queue because it already has
 * its own deferral mechanism via QueueProcessorService.
 *
 * @module sub-agent-message-queue
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SUB_AGENT_QUEUE_CONSTANTS } from '../../constants.js';

/**
 * A single queued message destined for a sub-agent.
 */
export interface QueuedAgentMessage {
	/** The raw data string to write to the agent's terminal */
	data: string;
	/** Timestamp (ms since epoch) when the message was enqueued */
	queuedAt: number;
	/** The target session name */
	sessionName: string;
}

/**
 * Singleton service that holds pending messages per agent session.
 *
 * Messages are enqueued when a `mode: 'message'` write arrives at
 * the terminal controller for an agent that is not yet active.
 * They are dequeued and delivered sequentially when the agent
 * registers (status becomes 'active').
 */
export class SubAgentMessageQueue {
	private static instance: SubAgentMessageQueue | null = null;
	private pendingMessages = new Map<string, QueuedAgentMessage[]>();
	private logger: ComponentLogger;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('SubAgentMessageQueue');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The SubAgentMessageQueue singleton
	 */
	static getInstance(): SubAgentMessageQueue {
		if (!SubAgentMessageQueue.instance) {
			SubAgentMessageQueue.instance = new SubAgentMessageQueue();
		}
		return SubAgentMessageQueue.instance;
	}

	/**
	 * Reset the singleton instance (for testing only).
	 */
	static resetInstance(): void {
		SubAgentMessageQueue.instance = null;
	}

	/**
	 * Enqueue a message for a session that is not yet active.
	 * If the queue exceeds MAX_QUEUE_SIZE, the oldest message is dropped.
	 *
	 * @param sessionName - The target agent session name
	 * @param data - The raw data string to deliver later
	 */
	enqueue(sessionName: string, data: string): void {
		let queue = this.pendingMessages.get(sessionName);
		if (!queue) {
			queue = [];
			this.pendingMessages.set(sessionName, queue);
		}

		// Drop oldest if at capacity
		if (queue.length >= SUB_AGENT_QUEUE_CONSTANTS.MAX_QUEUE_SIZE) {
			const dropped = queue.shift();
			this.logger.warn('Queue at capacity, dropping oldest message', {
				sessionName,
				droppedAt: dropped?.queuedAt,
				queueSize: queue.length,
			});
		}

		queue.push({
			data,
			queuedAt: Date.now(),
			sessionName,
		});

		this.logger.info('Message queued for sub-agent', {
			sessionName,
			queueSize: queue.length,
			dataLength: data.length,
		});
	}

	/**
	 * Dequeue all pending messages for a session (FIFO order).
	 * The queue is cleared after dequeuing.
	 *
	 * @param sessionName - The agent session name
	 * @returns Array of queued messages in insertion order, or empty array
	 */
	dequeueAll(sessionName: string): QueuedAgentMessage[] {
		const queue = this.pendingMessages.get(sessionName);
		if (!queue || queue.length === 0) {
			return [];
		}

		const messages = [...queue];
		this.pendingMessages.delete(sessionName);

		this.logger.info('Dequeued all messages for sub-agent', {
			sessionName,
			count: messages.length,
		});

		return messages;
	}

	/**
	 * Hand every queued message to `send`, one at a time.
	 *
	 * `sendMessageToAgent` answers `{ success: true, queued: true }` when it
	 * finds the agent busy and puts the message back — so a caller that only
	 * checked for a thrown error logged "Delivered" in the same millisecond
	 * as the re-queue, and reading the log pointed at the agent when the
	 * message had never reached it. Both call sites had their own copy of
	 * this loop; this is the shared one, and it distinguishes the two
	 * outcomes (2026-09-21, Ella).
	 *
	 * @param sessionName - The agent session name
	 * @param send - Delivers one message; `queued` means it went back on the queue
	 * @param gapMs - Pause between messages so the agent can process each
	 * @returns How many were delivered, deferred again, and failed
	 */
	async flush(
		sessionName: string,
		send: (data: string) => Promise<{ queued?: boolean }>,
		gapMs = 0,
	): Promise<{ delivered: number; deferred: number; failed: number }> {
		const pending = this.dequeueAll(sessionName);
		const out = { delivered: 0, deferred: 0, failed: 0 };
		for (const [i, queued] of pending.entries()) {
			try {
				const result = await send(queued.data);
				if (result?.queued) {
					out.deferred += 1;
					this.logger.info('Queued message deferred again — agent still busy', {
						sessionName,
						queuedAt: new Date(queued.queuedAt).toISOString(),
					});
				} else {
					out.delivered += 1;
					this.logger.info('Queued message delivered', {
						sessionName,
						queuedAt: new Date(queued.queuedAt).toISOString(),
					});
				}
			} catch (err) {
				out.failed += 1;
				this.logger.error('Failed to deliver a queued message', {
					sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			if (gapMs > 0 && i < pending.length - 1) {
				await new Promise((r) => setTimeout(r, gapMs));
			}
		}
		return out;
	}

	/**
	 * Check if there are pending messages for a session.
	 *
	 * @param sessionName - The agent session name
	 * @returns True if there are pending messages
	 */
	hasPending(sessionName: string): boolean {
		const queue = this.pendingMessages.get(sessionName);
		return !!queue && queue.length > 0;
	}

	/**
	 * Clear all pending messages for a session (e.g. on agent stop/exit).
	 *
	 * @param sessionName - The agent session name
	 */
	clear(sessionName: string): void {
		const queue = this.pendingMessages.get(sessionName);
		if (queue && queue.length > 0) {
			this.logger.info('Clearing queued messages for session', {
				sessionName,
				droppedCount: queue.length,
			});
		}
		this.pendingMessages.delete(sessionName);
	}

	/**
	 * Get the number of pending messages for a session.
	 *
	 * @param sessionName - The agent session name
	 * @returns Number of pending messages
	 */
	getQueueSize(sessionName: string): number {
		const queue = this.pendingMessages.get(sessionName);
		return queue ? queue.length : 0;
	}
}
