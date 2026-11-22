/**
 * Owner-stopped agents — sessions someone stopped on purpose (the Stop
 * button, stop-team, the stop-member API).
 *
 * Messages can still be queued for such an agent. The queued-message wake-up
 * (crewly#1014) must hold them rather than start the agent again: a stop is a
 * decision, and an agent relaunched behind the owner's back is exactly the
 * kind of unasked-for action this work removes. The mark is cleared when the
 * agent is started again (by anyone, deliberately), which then drains the
 * queue as usual.
 *
 * Module-level and dependency-free so the team controller and the server
 * wiring can share it without import cycles. Kept in memory: after a restart
 * nothing is relaunched for queued messages until something starts the agent.
 *
 * A member of a team the owner paused counts as owner-stopped for as long as
 * the pause lasts (specs/2026-10-04-team-pause.md). That part is persisted —
 * the pause is stored on the team — so it holds across restarts too.
 *
 * @module services/agent/owner-stopped.registry
 */

import { isSessionPaused } from '../team/team-pause.registry.js';
import { clearStartupBlock } from './startup-block.registry.js';

/** Who asked for a stop: the owner (dashboard, phone, owner token) or an agent (a stop-agent skill). */
export type StopSource = 'owner' | 'agent';

/** How long after an agent-made stop a start by an agent counts as the second half of a restart. */
export const AGENT_RESTART_WINDOW_MS = 10 * 60_000;

const stopped = new Map<string, { by: StopSource; at: number }>();

/**
 * Remember that a session was stopped on purpose. Also drops a start-up
 * block on it (startup-block.registry.ts): a stopped agent is not waiting.
 *
 * @param sessionName - Session that was stopped
 * @param by - Who asked for the stop (defaults to the owner)
 *
 * @example
 * ```ts
 * markOwnerStopped('dev-1');
 * markOwnerStopped('dev-1', 'agent'); // the lead's stop-agent skill
 * ```
 */
export function markOwnerStopped(sessionName: string, by: StopSource = 'owner'): void {
	if (!sessionName) return;
	stopped.set(sessionName, { by, at: Date.now() });
	// Stopped by the user: it no longer waits on them to start.
	clearStartupBlock(sessionName);
}

/**
 * Forget the stop mark (the agent is being started again).
 *
 * @param sessionName - Session being started
 */
export function clearOwnerStopped(sessionName: string): void {
	stopped.delete(sessionName);
}

/**
 * Whether a session was stopped on purpose and not started since, or
 * belongs to a team the owner paused.
 *
 * @param sessionName - Session
 * @returns True while the stop mark or the team's pause stands
 */
export function isOwnerStopped(sessionName: string): boolean {
	return stopped.has(sessionName) || isSessionPaused(sessionName);
}

/**
 * Who stopped a session, when a stop mark stands. A stop an agent asked for
 * holds ordinary traffic like any other, but it is not the owner's decision:
 * the owner is never told "you stopped it", and a reminder for the owner's
 * own unanswered message may start the agent again.
 *
 * @param sessionName - Session
 * @returns The source of the standing stop mark, or undefined without one
 */
export function stopSource(sessionName: string): StopSource | undefined {
	return stopped.get(sessionName)?.by;
}

/**
 * Whether an agent stopped this session moments ago, so a start now is the
 * second half of a restart (stop, then start) rather than a wake of a
 * sleeping agent. Without this an agent restarting the only running member
 * of a team is refused the start (the team now looks dormant) and the
 * member stays down (2026-11-22).
 *
 * @param sessionName - Session being started
 * @param now - Clock (tests)
 * @returns True within {@link AGENT_RESTART_WINDOW_MS} of an agent-made stop
 */
export function isRestartAfterAgentStop(sessionName: string, now: number = Date.now()): boolean {
	const mark = stopped.get(sessionName);
	return mark?.by === 'agent' && now - mark.at <= AGENT_RESTART_WINDOW_MS;
}

/** Clear every mark (tests only). */
export function resetOwnerStoppedForTesting(): void {
	stopped.clear();
}
