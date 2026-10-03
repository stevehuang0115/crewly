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

import * as path from 'path';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SUB_AGENT_QUEUE_CONSTANTS } from '../../constants.js';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/**
 * A single queued message destined for a sub-agent.
 */
/** Why queued messages were dropped undelivered. */
export type QueueDropReason = 'aged-out' | 'capacity' | 'undeliverable';

/**
 * Told when undelivered messages are dropped, so someone hears about it.
 *
 * @param sessionName - The agent they were for
 * @param dropped - The dropped messages
 * @param reason - Why
 */
export type QueueDropListener = (sessionName: string, dropped: QueuedAgentMessage[], reason: QueueDropReason) => void;

export interface QueuedAgentMessage {
	/** The raw data string to write to the agent's terminal */
	data: string;
	/** Timestamp (ms since epoch) when the message was enqueued */
	queuedAt: number;
	/** The target session name */
	sessionName: string;
	/** Failed delivery attempts so far (a send that threw or reported failure) */
	attempts?: number;
}

/**
 * Decides whether a queued message has gone stale and must not be delivered.
 * Wired at boot (the WorkItem dispatcher's check: a `[CREWLY-DISPATCH]`
 * notice whose WorkItems are all finished). Errors count as "not stale".
 */
export type StaleMessageCheck = (data: string, sessionName: string) => Promise<boolean> | boolean;

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
	private readonly storePath: string;
	private staleCheck: StaleMessageCheck | null = null;
	/** Told when undelivered messages are dropped (never silently: crewly#1014) */
	private dropListener: QueueDropListener | null = null;
	/** Drops that happened before a listener was set (aged out at load) */
	private unreportedDrops: Array<{ sessionName: string; dropped: QueuedAgentMessage[]; reason: QueueDropReason }> = [];

	private constructor(storePath?: string) {
		this.logger = LoggerService.getInstance().createComponentLogger('SubAgentMessageQueue');
		this.storePath = storePath ?? path.join(getCrewlyHomePath(), 'sub-agent-message-queue.json');
		this.load();
	}

	/**
	 * Read back anything that was still undelivered when the process ended.
	 *
	 * This queue is the only record that a person's message has not reached
	 * its agent. Holding it in memory alone meant a restart dropped it with
	 * no trace: the owner had asked for something, seen "working on it", and
	 * the request simply ceased to exist (2026-09-21).
	 */
	private load(): void {
		type Stored = { queues?: Record<string, QueuedAgentMessage[]> };
		let stored: Stored | null = null;
		try {
			stored = JSON.parse(readFileSync(this.storePath, 'utf-8')) as Stored;
		} catch {
			// No file yet, or unreadable — start empty, which is the old behaviour.
			return;
		}
		if (!stored?.queues) return;
		let restored = 0;
		for (const [sessionName, messages] of Object.entries(stored.queues)) {
			const valid = (messages ?? []).filter((m) => m && typeof m.data === 'string' && typeof m.queuedAt === 'number');
			const usable = valid.filter((m) => Date.now() - m.queuedAt <= SUB_AGENT_QUEUE_CONSTANTS.MAX_AGE_MS);
			if (usable.length < valid.length) {
				this.unreportedDrops.push({ sessionName, dropped: valid.filter((m) => !usable.includes(m)), reason: 'aged-out' });
			}
			if (usable.length === 0) continue;
			this.pendingMessages.set(sessionName, usable);
			restored += usable.length;
		}
		if (restored > 0) {
			this.logger.info('Restored undelivered messages from the previous run', {
				messages: restored,
				sessions: this.pendingMessages.size,
			});
		}
	}

	/**
	 * Write the queue out. Best-effort: a failure must never lose the
	 * in-memory copy, which is still the live one.
	 */
	private save(): void {
		try {
			const queues: Record<string, QueuedAgentMessage[]> = {};
			for (const [k, v] of this.pendingMessages) if (v.length > 0) queues[k] = v;
			mkdirSync(path.dirname(this.storePath), { recursive: true });
			// Write-then-rename: a crash mid-write must not leave a truncated
			// file that the next boot reads as "nothing was pending".
			const tmp = `${this.storePath}.tmp`;
			writeFileSync(tmp, JSON.stringify({ queues, savedAt: new Date().toISOString() }, null, 2), 'utf-8');
			renameSync(tmp, this.storePath);
		} catch (err) {
			this.logger.warn('Could not persist the pending-message queue', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The SubAgentMessageQueue singleton
	 */
	static getInstance(storePath?: string): SubAgentMessageQueue {
		if (!SubAgentMessageQueue.instance) {
			SubAgentMessageQueue.instance = new SubAgentMessageQueue(storePath);
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
	 * Whether this exact message is already queued for the agent.
	 *
	 * @param sessionName - The agent
	 * @param data - The message
	 * @returns True when queued
	 */
	contains(sessionName: string, data: string): boolean {
		return (this.pendingMessages.get(sessionName) ?? []).some((m) => m.data === data);
	}

	/**
	 * Install the listener told about messages dropped undelivered (aged out
	 * at load, or the oldest at capacity). Drops from before it was set are
	 * reported right away.
	 *
	 * @param listener - The listener, or null
	 */
	setDropListener(listener: QueueDropListener | null): void {
		this.dropListener = listener;
		if (!listener) return;
		const pending = this.unreportedDrops;
		this.unreportedDrops = [];
		for (const d of pending) this.reportDrop(d.sessionName, d.dropped, d.reason);
	}

	/**
	 * Tell the listener about a drop (or keep it until one is set).
	 *
	 * @param sessionName - The agent
	 * @param dropped - The dropped messages
	 * @param reason - Why
	 */
	private reportDrop(sessionName: string, dropped: QueuedAgentMessage[], reason: QueueDropReason): void {
		if (!this.dropListener) {
			this.unreportedDrops.push({ sessionName, dropped, reason });
			return;
		}
		try {
			this.dropListener(sessionName, dropped, reason);
		} catch (err) {
			this.logger.warn('Queue drop listener failed', { sessionName, error: err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * Install the check that drops stale messages before delivery.
	 *
	 * The queue is persisted and replayed after a restart, so a notice queued
	 * hours earlier ("WorkItem X queued for you") reached the agent after X was
	 * already verified, and each stale notice cost a turn re-checking the pool
	 * (#836). The queue cannot judge staleness itself; the dispatcher can.
	 *
	 * @param check - The stale check, or null to deliver everything
	 */
	setStaleMessageCheck(check: StaleMessageCheck | null): void {
		this.staleCheck = check;
	}

	/**
	 * Whether a queued message is stale per the installed check.
	 *
	 * @param data - Message text
	 * @param sessionName - Target session
	 * @returns True when the message must be dropped
	 */
	private async isStale(data: string, sessionName: string): Promise<boolean> {
		if (!this.staleCheck) return false;
		try {
			return (await this.staleCheck(data, sessionName)) === true;
		} catch (err) {
			this.logger.debug('Stale-message check failed; delivering the message', {
				sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/**
	 * Drop every stale message from every queue. Run once at boot, so an agent
	 * whose only pending messages are stale notices is not restored for them.
	 *
	 * @returns How many messages were examined and how many were dropped
	 */
	async pruneStale(): Promise<{ examined: number; skippedStale: number }> {
		let examined = 0;
		let skippedStale = 0;
		if (!this.staleCheck) return { examined, skippedStale };
		for (const [sessionName, queue] of [...this.pendingMessages.entries()]) {
			const kept: QueuedAgentMessage[] = [];
			for (const message of queue) {
				examined += 1;
				if (await this.isStale(message.data, sessionName)) skippedStale += 1;
				else kept.push(message);
			}
			if (kept.length === queue.length) continue;
			// Messages may have been added while the checks ran: keep those too.
			const current = this.pendingMessages.get(sessionName) ?? [];
			const added = current.filter((m) => !queue.includes(m));
			const next = [...kept, ...added];
			if (next.length > 0) this.pendingMessages.set(sessionName, next);
			else this.pendingMessages.delete(sessionName);
		}
		if (skippedStale > 0) this.save();
		this.logger.info('Checked the restored message queue for stale notices', { examined, skippedStale });
		return { examined, skippedStale };
	}

	/**
	 * Enqueue a message for a session that is not yet active.
	 * If the queue exceeds MAX_QUEUE_SIZE, the oldest message is dropped.
	 *
	 * A message identical to one already waiting for the same session is not
	 * added again: the reconciler re-sends the same reminder while an agent
	 * is stopped (daily token cap, busy), and each copy would cost the agent
	 * a turn once delivered. The waiting copy keeps its place.
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

		if (queue.some((m) => m.data === data)) {
			this.logger.debug('Identical message already queued for sub-agent — not added again', {
				sessionName,
				queueSize: queue.length,
				dataLength: data.length,
			});
			return;
		}

		// Drop oldest if at capacity
		if (queue.length >= SUB_AGENT_QUEUE_CONSTANTS.MAX_QUEUE_SIZE) {
			const dropped = queue.shift();
			this.logger.warn('Queue at capacity, dropping oldest message', {
				sessionName,
				droppedAt: dropped?.queuedAt,
				queueSize: queue.length,
			});
			if (dropped) this.reportDrop(sessionName, [dropped], 'capacity');
		}

		queue.push({
			data,
			queuedAt: Date.now(),
			sessionName,
		});

		this.save();

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
		this.save();

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
	 * Messages the stale check rejects (see {@link setStaleMessageCheck}) are
	 * dropped instead of sent.
	 *
	 * @returns How many were delivered, deferred again, failed, and dropped as stale
	 */
	async flush(
		sessionName: string,
		send: (data: string) => Promise<{ queued?: boolean; success?: boolean; error?: string }>,
		gapMs = 0,
	): Promise<{ delivered: number; deferred: number; failed: number; skippedStale: number }> {
		const pending = this.dequeueAll(sessionName);
		const out = { delivered: 0, deferred: 0, failed: 0, skippedStale: 0 };
		// A send that failed ("Session does not exist", "Runtime has exited")
		// or threw is not a delivery: the message goes back on the queue, up
		// to MAX_DELIVERY_ATTEMPTS, then the drop is reported (crewly#1014).
		const maxAttempts = SUB_AGENT_QUEUE_CONSTANTS.MAX_DELIVERY_ATTEMPTS ?? 5;
		const failedAgain: QueuedAgentMessage[] = [];
		const undeliverable: QueuedAgentMessage[] = [];
		const noteFailure = (queued: QueuedAgentMessage, error: string): void => {
			out.failed += 1;
			const attempts = (queued.attempts ?? 0) + 1;
			if (attempts >= maxAttempts) {
				undeliverable.push({ ...queued, attempts });
				this.logger.error('Queued message could not be delivered — giving up and reporting it', { sessionName, attempts, error });
			} else {
				failedAgain.push({ ...queued, attempts });
				this.logger.warn('Queued message not delivered — kept for the next attempt', { sessionName, attempts, error });
			}
		};
		for (const [i, queued] of pending.entries()) {
			if (await this.isStale(queued.data, sessionName)) {
				out.skippedStale += 1;
				continue;
			}
			try {
				const result = await send(queued.data);
				if (result && result.success === false && !result.queued) {
					noteFailure(queued, result.error ?? 'delivery failed');
				} else if (result?.queued) {
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
				noteFailure(queued, err instanceof Error ? err.message : String(err));
			}
			if (gapMs > 0 && i < pending.length - 1) {
				await new Promise((r) => setTimeout(r, gapMs));
			}
		}
		if (failedAgain.length > 0) {
			// Back at the front, in their original order, ahead of anything
			// queued meanwhile.
			const queue = this.pendingMessages.get(sessionName) ?? [];
			this.pendingMessages.set(sessionName, [...failedAgain, ...queue]);
			this.save();
		}
		if (undeliverable.length > 0) this.reportDrop(sessionName, undeliverable, 'undeliverable');
		if (out.skippedStale > 0) {
			this.logger.info('Dropped stale queued messages instead of delivering them', {
				sessionName,
				examined: pending.length,
				skippedStale: out.skippedStale,
			});
		}
		return out;
	}

	/**
	 * Sessions that still have messages waiting for them. A restart must bring
	 * these agents back: a message queued for an agent is work in hand even
	 * when no WorkItem records it (2026-09-24: Atlas was left down after a
	 * restart with the owner's message queued, and answered four hours later
	 * only because the owner wrote again).
	 *
	 * @returns Session names with at least one queued message
	 */
	sessionsWithPending(): string[] {
		return [...this.pendingMessages.entries()].filter(([, q]) => q.length > 0).map(([name]) => name);
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
		this.save();
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

	/**
	 * Total number of messages waiting across every session. Used by restart
	 * readiness to report how much is held on this (persistent) queue.
	 *
	 * @returns Number of queued messages
	 */
	getTotalQueued(): number {
		let total = 0;
		for (const queue of this.pendingMessages.values()) total += queue.length;
		return total;
	}
}
