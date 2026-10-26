/**
 * Hold on restarting an agent the machine itself stopped for memory.
 *
 * In resource pressure mode the idle stop (and the emergency stop) put an
 * idle agent's work back in the queue and kill it to free memory. Three paths
 * then brought it straight back: the queued-message wake 5 s after it went
 * down, the reconciler's start wake for the very item it had just released,
 * and the follow-through restart. The stop freed nothing and cost a cold
 * start and a rebuilt context each time (Ella 01:02, Vera 03:07 and 03:40,
 * 2026-10-26); the reconciler also wrote the released brief into the dying
 * session and logged a 500.
 *
 * The stop paths note the session here before the kill. The wake paths ask
 * {@link memoryStopHold} and leave the agent down while the machine is still
 * in pressure mode. The note lapses when pressure clears, after MAX_HOLD_MS
 * (a wedge guard: a machine that never leaves pressure still makes progress
 * through the reconciler's own concurrency floor), or when the agent starts
 * anyway — an owner start is never held, it simply clears the note.
 *
 * @module services/agent/memory-stop-hold
 */

import type { ResourceMode } from './resource-mode.service.js';

/** Tuning for {@link memoryStopHold}. */
export const MEMORY_STOP_HOLD_CONSTANTS = {
	/** Longest an agent stopped for memory stays held while pressure lasts (ms) */
	MAX_HOLD_MS: 30 * 60_000,
} as const;

const stoppedAt = new Map<string, number>();

/**
 * Whether a stop reason is one of the memory-pressure stops.
 *
 * @param why - Reason text handed to the work releaser
 * @returns True for the idle stop and the emergency stop under memory pressure
 */
export function isMemoryPressureStop(why: string): boolean {
	return /memory pressure/i.test(why);
}

/**
 * Remember that the machine stopped this agent for memory. Called by the stop
 * paths before the kill, so a wake that races the kill is held too.
 *
 * @param session - Agent being stopped
 * @param now - Clock (tests inject one)
 */
export function noteMemoryStop(session: string, now: number = Date.now()): void {
	stoppedAt.set(session, now);
}

/**
 * Forget the note: the agent is being started (by whatever path).
 *
 * @param session - Agent starting
 */
export function clearMemoryStop(session: string): void {
	stoppedAt.delete(session);
}

/**
 * Why an agent must not be started yet, or null when it may.
 *
 * Non-null only for an agent the machine stopped for memory, while the mode
 * is still `pressure` and less than MAX_HOLD_MS has passed. A lapsed note is
 * dropped on the way out, so a later stop of the same agent for another
 * reason is not held by it.
 *
 * @param session - Agent a wake path wants to start
 * @param mode - Current resource mode
 * @param now - Clock (tests inject one)
 * @returns Reason text while held, null otherwise
 */
export function memoryStopHold(session: string, mode: ResourceMode, now: number = Date.now()): string | null {
	const at = stoppedAt.get(session);
	if (at === undefined) return null;
	if (mode !== 'pressure' || now - at >= MEMORY_STOP_HOLD_CONSTANTS.MAX_HOLD_MS) {
		stoppedAt.delete(session);
		return null;
	}
	return `stopped for memory ${Math.round((now - at) / 60_000)} min ago and the machine is still under pressure`;
}

/** Forget every note (tests). */
export function resetMemoryStops(): void {
	stoppedAt.clear();
}
