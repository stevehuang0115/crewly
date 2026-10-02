/**
 * Messages for a configured agent whose session is down (#929).
 *
 * A restart leaves idle agents down on purpose ("idle agents stay down until
 * work or a message wakes them"). But a message to such an agent was answered
 * with 404 "session not found": nothing queued it and nothing woke the agent,
 * so the orchestrator's message to Dana failed twice on 2026-10-01 and it had
 * to restart her by hand.
 *
 * {@link queueForOfflineAgent} makes the message itself the wake-up: it is
 * put on the agent's persisted message queue (delivered when the agent
 * registers) and the agent is started. A team with nobody running is not
 * cold-launched for a message — that is a launch, which needs the owner — so
 * there the message only waits on the queue.
 *
 * @module services/messaging/offline-agent-message
 */

import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { isDormantTeam, type GuardTeam } from '../orchestrator/commitment-approval-guard.js';
import { LoggerService } from '../core/logger.service.js';

/** Starts a configured agent by its session name. */
export type OfflineAgentWaker = (sessionName: string) => Promise<{ success: boolean; error?: string }>;

/** What {@link queueForOfflineAgent} needs. */
export interface OfflineAgentMessageDeps {
	/** The team and member bound to a session, or null for an unknown session. */
	findMember: (sessionName: string) => Promise<{ team: GuardTeam; member: { name?: string } } | null>;
	/** Puts the message on the agent's queue. */
	enqueue: (sessionName: string, data: string) => void;
	/** Starts the agent; null when no waker is wired (the message only waits). */
	wake: OfflineAgentWaker | null;
}

/** Outcome for a message to a session that is down. */
export interface OfflineAgentMessageResult {
	queued: true;
	/** Whether a start was requested (or one is already under way). */
	waking: boolean;
	/** Why no start was requested. */
	reason?: string;
}

const logger = LoggerService.getInstance().createComponentLogger('OfflineAgentMessage');

let registeredWaker: OfflineAgentWaker | null = null;
/** Sessions with a start in flight, so a burst of messages starts the agent once. */
const wakesInFlight = new Set<string>();

/**
 * Wire the function that starts an agent (set once at boot).
 *
 * @param waker - Starts an agent by session name, or null to unwire
 */
export function setOfflineAgentWaker(waker: OfflineAgentWaker | null): void {
	registeredWaker = waker;
}

/**
 * The waker wired at boot, if any.
 *
 * @returns The waker or null
 */
export function getOfflineAgentWaker(): OfflineAgentWaker | null {
	return registeredWaker;
}

/** Forget in-flight starts (tests). */
export function resetOfflineAgentWakes(): void {
	wakesInFlight.clear();
}

/**
 * Queue a message for an agent whose session is down, and start the agent.
 *
 * @param sessionName - Target session (has no live session)
 * @param data - Message text
 * @param deps - Lookup, queue and waker
 * @returns The outcome, or null when the session belongs to no team member
 *   (or is the orchestrator) — the caller then answers 404 as before
 */
export async function queueForOfflineAgent(
	sessionName: string,
	data: string,
	deps: OfflineAgentMessageDeps,
): Promise<OfflineAgentMessageResult | null> {
	if (sessionName === ORCHESTRATOR_SESSION_NAME) return null;
	const found = await deps.findMember(sessionName).catch(() => null);
	if (!found) return null;

	deps.enqueue(sessionName, data);

	if (isDormantTeam(found.team)) {
		logger.info('Message queued for an agent whose team is not running (not starting the team)', { sessionName });
		return {
			queued: true,
			waking: false,
			reason: 'Nobody in this team is running; starting the team needs the owner. The message is delivered when the agent starts.',
		};
	}
	if (!deps.wake) {
		return { queued: true, waking: false, reason: 'No agent starter is available; the message is delivered when the agent starts.' };
	}
	if (wakesInFlight.has(sessionName)) return { queued: true, waking: true };

	wakesInFlight.add(sessionName);
	logger.info('Message queued for an agent that is down — starting it', { sessionName });
	void deps
		.wake(sessionName)
		.then((res) => {
			if (!res.success) {
				logger.warn('Could not start the agent a message is queued for', { sessionName, error: res.error });
			}
		})
		.catch((err: unknown) => {
			logger.warn('Could not start the agent a message is queued for', {
				sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
		})
		.finally(() => wakesInFlight.delete(sessionName));
	return { queued: true, waking: true };
}
