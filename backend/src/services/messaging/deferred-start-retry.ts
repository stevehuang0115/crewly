/**
 * Retry for a start that was deferred by the running-agent cap while a message
 * waits on the agent's queue.
 *
 * The slot queue gives a start 2 minutes and then lets go ("deferred"). The
 * dispatcher holds the owner's message on the agent's persisted queue in that
 * case, but nothing else starts the agent: the reconciler only wakes agents for
 * work items and the queued-wake only fires when an agent goes down. Without a
 * retry the message sits until someone happens to message the agent again
 * (Ella, 2026-10-11).
 *
 * @module services/messaging/deferred-start-retry
 */

import { LoggerService } from '../core/logger.service.js';
import { SUB_AGENT_QUEUE_CONSTANTS } from '../../constants.js';

/** Tuning for {@link scheduleDeferredStartRetry}. */
export const DEFERRED_START_RETRY_CONSTANTS = {
	/** Pause between rounds (a round itself waits up to the slot-queue timeout) */
	ROUND_PAUSE_MS: 5_000,
	/** Rounds at the short pause before the retry slows down */
	MAX_ROUNDS: 6,
	/** Pause between later rounds, while every slot stays taken */
	SLOW_ROUND_PAUSE_MS: 2 * 60_000,
	/**
	 * How long the retry keeps going in all. Giving up after the fast rounds
	 * (about 13 minutes) left Pia down for over an hour with 8 messages and
	 * the owner's thread waiting (2026-10-16): the slots freed later, but
	 * nothing tried again.
	 */
	MAX_TOTAL_MS: 6 * 60 * 60_000,
	/** A held round is logged on the first round and then every this many rounds */
	HOLD_LOG_EVERY_ROUNDS: 10,
} as const;

/** What the retry needs. */
export interface DeferredStartRetryDeps {
	/** Starts the agent; `deferred` when it again waited for a slot and got none. */
	activate: (sessionName: string) => Promise<{ success: boolean; deferred?: boolean }>;
	/** Whether messages still wait on the agent's queue. */
	hasPending: (sessionName: string) => boolean;
	/**
	 * Why the start must wait this round without being tried (crewly#1353:
	 * memory is tight after a boot, or another boot launch just began).
	 * Null/undefined = try now. The rounds keep counting against MAX_TOTAL_MS.
	 */
	hold?: (sessionName: string) => string | null | undefined;
	/** Pause between rounds (tests inject an instant one). */
	sleep?: (ms: number) => Promise<void>;
	/** Pause before the first round (default: the usual round pause) */
	firstPauseMs?: number;
	/** Clock (tests inject one) */
	now?: () => number;
}

const logger = LoggerService.getInstance().createComponentLogger('DeferredStartRetry');
const inFlight = new Set<string>();

/** Forget retries in flight (tests). */
export function resetDeferredStartRetries(): void {
	inFlight.clear();
}

/**
 * Keep trying to start an agent whose start was deferred, until it starts, its
 * queue empties, a start fails for another reason, or MAX_TOTAL_MS passes.
 * The first MAX_ROUNDS rounds come quickly, later ones every SLOW_ROUND_PAUSE_MS.
 * One retry loop per agent.
 *
 * @param sessionName - Agent whose start was deferred
 * @param deps - Start, queue check and pause
 * @returns Resolves when the loop ends (callers normally do not await it)
 */
export async function scheduleDeferredStartRetry(sessionName: string, deps: DeferredStartRetryDeps): Promise<void> {
	if (inFlight.has(sessionName)) return;
	inFlight.add(sessionName);
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }));
	const now = deps.now ?? Date.now;
	const giveUpAt = now() + DEFERRED_START_RETRY_CONSTANTS.MAX_TOTAL_MS;
	try {
		for (let round = 1; now() < giveUpAt; round++) {
			const pause =
				round === 1 && deps.firstPauseMs !== undefined
					? deps.firstPauseMs
					: round <= DEFERRED_START_RETRY_CONSTANTS.MAX_ROUNDS
						? DEFERRED_START_RETRY_CONSTANTS.ROUND_PAUSE_MS
						: DEFERRED_START_RETRY_CONSTANTS.SLOW_ROUND_PAUSE_MS;
			await sleep(pause);
			if (!deps.hasPending(sessionName)) return;
			const held = deps.hold?.(sessionName);
			if (held) {
				if (round === 1 || round % DEFERRED_START_RETRY_CONSTANTS.HOLD_LOG_EVERY_ROUNDS === 0) logger.info('Deferred start held', { sessionName, round, reason: held });
				continue;
			}
			let res: { success: boolean; deferred?: boolean };
			try {
				res = await deps.activate(sessionName);
			} catch (err) {
				logger.warn('Deferred start retry failed', { sessionName, round, error: err instanceof Error ? err.message : String(err) });
				return;
			}
			if (res.success) {
				logger.info('Deferred start went through', { sessionName, round });
				return;
			}
			if (!res.deferred) {
				logger.warn('Deferred start retry ended: the start failed', { sessionName, round });
				return;
			}
		}
		logger.warn('Deferred start still waiting for a slot; leaving the message queued', { sessionName });
	} finally {
		inFlight.delete(sessionName);
	}
}

/**
 * Whether the periodic queued-wake sweep may wake an agent again. The gap
 * after the n-th sweep wake that did not bring the agent up is
 * QUEUED_WAKE_SWEEP_MS * 2^(n-1), capped at QUEUED_WAKE_SWEEP_MAX_BACKOFF_MS,
 * so a start that keeps failing is not relaunched four times an hour.
 *
 * @param prev - The sweep's earlier wakes of this agent since it was last up (none = never woken)
 * @param now - Epoch ms of this sweep
 * @returns True when the agent is due
 */
export function sweepWakeDue(prev: { count: number; at: number } | undefined, now: number): boolean {
	if (!prev) return true;
	const gap = Math.min(
		SUB_AGENT_QUEUE_CONSTANTS.QUEUED_WAKE_SWEEP_MS * 2 ** Math.max(0, prev.count - 1),
		SUB_AGENT_QUEUE_CONSTANTS.QUEUED_WAKE_SWEEP_MAX_BACKOFF_MS,
	);
	return now - prev.at >= gap;
}
