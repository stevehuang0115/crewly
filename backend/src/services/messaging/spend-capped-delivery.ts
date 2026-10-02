/**
 * Daily token cap gate for the direct write paths (issue #937).
 *
 * `AgentRegistrationService.sendMessageToAgent` gates `/terminal/:s/deliver`
 * (specs/2026-10-02-spend-cap.md). Several HTTP paths write a message into a
 * session without going through it:
 *
 * - `POST /terminal/:s/write` with `mode: "message"` (the agent
 *   `send-message` skill, the WorkItem dispatcher, TL auto-verify, the
 *   worktree notifier) and any `/write` to an in-process runtime;
 * - `POST /terminal/:s/deliver` with `force: true`;
 * - `POST /sessions/:name/write` with `mode: "message"`.
 *
 * A capped agent that received a message on one of them started a new turn
 * and spent past its cap. {@link queueIfSpendCapped} puts such a message on
 * the same persistent `SubAgentMessageQueue` that `sendMessageToAgent` uses,
 * so the spend-cap service releases it (boost, raised cap, midnight) exactly
 * like a message queued by `/deliver`.
 *
 * Raw keystroke writes (`/write` without `mode: "message"`, `/key`, `/input`,
 * the UI terminal socket) are deliberately NOT gated: they carry the control
 * keys (Enter, Ctrl-C, Escape) the owner needs to manage a stopped session.
 *
 * @module services/messaging/spend-capped-delivery
 */

import { SPEND_CAP_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { spendCapReason, spendCapStopOf } from '../spend/spend-cap.gate.js';
import { SubAgentMessageQueue } from './sub-agent-message-queue.service.js';

/** The response body for a message held back by the daily token cap (HTTP 202). */
export interface SpendCappedQueueResult {
	success: true;
	queued: true;
	/** Distinguishes a cap hold from the other queued outcomes */
	spendCapped: true;
	/** `[SPEND_CAP] <reason>; message queued` — the same text `sendMessageToAgent` returns */
	message: string;
}

/** Puts a message on an agent's persistent queue. */
export type SpendCapEnqueue = (sessionName: string, message: string) => void;

const logger = LoggerService.getInstance().createComponentLogger('SpendCappedDelivery');

/**
 * Queue a message instead of writing it when the target is over its daily
 * token cap.
 *
 * @param sessionName - Target session
 * @param message - Message text that would start a turn
 * @param enqueue - Queue to hold it on (default: the persistent `SubAgentMessageQueue`)
 * @returns The 202 body when the message was queued; null when the agent may
 *   take a new turn (no cap in force, or the gate is not wired)
 *
 * @example
 * ```typescript
 * const capped = queueIfSpendCapped(sessionName, text);
 * if (capped) { res.status(202).json(capped); return; }
 * ```
 */
export function queueIfSpendCapped(
	sessionName: string,
	message: string,
	enqueue: SpendCapEnqueue = (s, m) => SubAgentMessageQueue.getInstance().enqueue(s, m),
): SpendCappedQueueResult | null {
	const stop = spendCapStopOf(sessionName);
	if (!stop) return null;
	enqueue(sessionName, message);
	logger.info('Daily token cap reached — message queued, no new turn', {
		sessionName,
		capTokens: stop.capTokens,
		scope: stop.scope,
		messageLength: message.length,
	});
	return {
		success: true,
		queued: true,
		spendCapped: true,
		message: `${SPEND_CAP_CONSTANTS.QUEUED_MARKER} ${spendCapReason(stop)}; message queued`,
	};
}
