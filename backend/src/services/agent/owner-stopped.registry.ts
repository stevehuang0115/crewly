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
 * @module services/agent/owner-stopped.registry
 */

const stopped = new Set<string>();

/**
 * Remember that a session was stopped on purpose.
 *
 * @param sessionName - Session that was stopped
 *
 * @example
 * ```ts
 * markOwnerStopped('dev-1');
 * ```
 */
export function markOwnerStopped(sessionName: string): void {
	if (sessionName) stopped.add(sessionName);
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
 * Whether a session was stopped on purpose and not started since.
 *
 * @param sessionName - Session
 * @returns True while the stop mark stands
 */
export function isOwnerStopped(sessionName: string): boolean {
	return stopped.has(sessionName);
}

/** Clear every mark (tests only). */
export function resetOwnerStoppedForTesting(): void {
	stopped.clear();
}
