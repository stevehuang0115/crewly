/**
 * Restart-drain gate for the direct write paths (crewly#1015 §6).
 *
 * Once a graceful shutdown starts, `RestartDrainService` pauses delivery:
 * `AgentRegistrationService.sendMessageToAgent` and the queue processor put
 * new messages on the persistent queues instead of writing them, so the
 * drain does not wait on (or cut off) a turn it started itself. Several HTTP
 * paths write a message into a session without going through them:
 *
 * - `POST /terminal/:s/write` with `mode: "message"`, and any `/write` to an
 *   in-process runtime;
 * - `POST /terminal/:s/deliver`, forced or not, before it reaches
 *   `sendMessageToAgent` (a forced write skips it entirely);
 * - `POST /sessions/:name/write` with `mode: "message"`.
 *
 * On 2026-10-01 a message reached Owen through one of them during the drain
 * at 16:22; the drain did not know the turn and his test run was killed.
 * {@link queueIfRestartDraining} puts such a message on the same persistent
 * `SubAgentMessageQueue`, which the next boot's registration flushes.
 *
 * Raw keystroke writes (no `mode: "message"`) are not gated: they are how
 * the owner manages a session.
 *
 * @module services/messaging/drain-queued-delivery
 */

import { LoggerService } from '../core/logger.service.js';
import { RestartDrainService } from '../restart/restart-drain.service.js';
import { SubAgentMessageQueue } from './sub-agent-message-queue.service.js';

/** The response body for a message held back by the restart drain (HTTP 202). */
export interface DrainQueuedResult {
	success: true;
	queued: true;
	/** Distinguishes a drain hold from the other queued outcomes */
	restartDrain: true;
	/** `[RESTART_DRAIN] …` — the same text `sendMessageToAgent` returns */
	message: string;
}

/** Puts a message on an agent's persistent queue. */
export type DrainEnqueue = (sessionName: string, message: string) => void;

const logger = LoggerService.getInstance().createComponentLogger('DrainQueuedDelivery');

/**
 * Queue a message instead of writing it while a graceful shutdown has
 * delivery paused.
 *
 * @param sessionName - Target session
 * @param message - Message text that would start a turn
 * @param deps - Pause check and queue (defaults: the restart drain and the persistent `SubAgentMessageQueue`)
 * @returns The 202 body when the message was queued; null when delivery may go ahead
 *
 * @example
 * ```typescript
 * const held = queueIfRestartDraining(sessionName, text);
 * if (held) { res.status(202).json(held); return; }
 * ```
 */
export function queueIfRestartDraining(
	sessionName: string,
	message: string,
	deps: { isPaused?: () => boolean; enqueue?: DrainEnqueue } = {},
): DrainQueuedResult | null {
	let paused = false;
	try {
		paused = deps.isPaused ? deps.isPaused() : RestartDrainService.getInstance().isDeliveryPaused();
	} catch {
		paused = false;
	}
	if (!paused) return null;
	(deps.enqueue ?? ((s, m) => SubAgentMessageQueue.getInstance().enqueue(s, m)))(sessionName, message);
	logger.info('Shutdown in progress — message queued for delivery after restart', {
		sessionName,
		messageLength: message.length,
	});
	return {
		success: true,
		queued: true,
		restartDrain: true,
		message: '[RESTART_DRAIN] Message queued for delivery after the restart',
	};
}
