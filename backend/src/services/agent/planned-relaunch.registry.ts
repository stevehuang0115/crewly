/**
 * Planned relaunches — sessions Crewly is stopping and starting again on
 * purpose (the runtime fallback moving an agent to another runtime, or back).
 *
 * A planned relaunch is not a crash or a hang. While a session is marked here
 * the orchestrator restart service, the orchestrator / agent heartbeat
 * monitors and hung-session detection leave it alone: no "Orchestrator
 * Restarted … unresponsive" alarm, no restart attempt counted, no ghost
 * downgrade. The service that relaunches sends its own single owner message.
 *
 * Module-level and dependency-free so every monitor can import it without
 * import cycles.
 *
 * @module services/agent/planned-relaunch.registry
 */

import { PLANNED_RELAUNCH_CONSTANTS } from '../../constants.js';

/** One planned relaunch. */
export interface PlannedRelaunch {
	/** Who asked for it (e.g. `runtime_fallback`) */
	reason: string;
	/** Epoch ms the window ends */
	until: number;
}

const planned = new Map<string, PlannedRelaunch>();

/**
 * Mark a session as being relaunched on purpose (or extend its window).
 *
 * @param sessionName - Session
 * @param reason - Who relaunches it
 * @param windowMs - How long it counts as planned
 * @param now - Current time (ms)
 *
 * @example
 * ```ts
 * markPlannedRelaunch('crewly-orc', 'runtime_fallback');
 * ```
 */
export function markPlannedRelaunch(
	sessionName: string,
	reason: string,
	windowMs: number = PLANNED_RELAUNCH_CONSTANTS.WINDOW_MS,
	now: number = Date.now(),
): void {
	planned.set(sessionName, { reason, until: now + windowMs });
}

/**
 * The planned relaunch of a session, while its window lasts.
 *
 * @param sessionName - Session
 * @param now - Current time (ms)
 * @returns The record, or null
 */
export function getPlannedRelaunch(sessionName: string, now: number = Date.now()): PlannedRelaunch | null {
	const entry = planned.get(sessionName);
	if (!entry) return null;
	if (entry.until <= now) {
		planned.delete(sessionName);
		return null;
	}
	return entry;
}

/**
 * Whether a session is being relaunched on purpose right now.
 *
 * @param sessionName - Session
 * @param now - Current time (ms)
 * @returns True inside the window
 */
export function isPlannedRelaunch(sessionName: string, now: number = Date.now()): boolean {
	return getPlannedRelaunch(sessionName, now) !== null;
}

/**
 * End a session's planned-relaunch window.
 *
 * @param sessionName - Session
 */
export function clearPlannedRelaunch(sessionName: string): void {
	planned.delete(sessionName);
}

/** Forget every planned relaunch (tests). */
export function resetPlannedRelaunches(): void {
	planned.clear();
}
