/**
 * Agent Attention Registry
 *
 * In-process record of which agent sessions are currently blocked on a human
 * (waiting_on_human, #815). The ActivityMonitor writes it on every poll; the
 * reconciler reads it to build AgentHealth.waitingOnHumanSince.
 *
 * Kept separate from both services so neither has to import the other's
 * singleton. State is in memory on purpose: after a backend restart the
 * first monitor poll (≤30s) re-detects a prompt that is still on screen.
 *
 * @module services/monitoring/agent-attention-registry
 */

import type { WaitingKind } from './agent-attention.js';

/** One agent's current waiting state. */
export interface WaitingEntry {
	/** Session that is waiting. */
	sessionName: string;
	/** What it is waiting on. */
	kind: WaitingKind;
	/** ISO time the wait was first observed. */
	since: string;
	/** Rule evidence from the verdict. */
	evidence: string[];
	/** Task label from the terminal title, if any. */
	titleLabel?: string;
}

const entries = new Map<string, WaitingEntry>();

/**
 * Record that a session is waiting. Keeps the original `since` (and kind)
 * when the session was already waiting, so the wait duration is not reset by
 * each poll.
 *
 * @param entry - The waiting state; `since` is used only for a new wait
 * @returns True when this starts a new wait, false when it continues one
 */
export function markWaiting(entry: WaitingEntry): boolean {
	const existing = entries.get(entry.sessionName);
	if (existing) {
		entries.set(entry.sessionName, { ...entry, since: existing.since });
		return false;
	}
	entries.set(entry.sessionName, entry);
	return true;
}

/**
 * Record that a session is no longer waiting.
 *
 * @param sessionName - The session
 * @returns The entry that was cleared, or undefined when it was not waiting
 */
export function clearWaiting(sessionName: string): WaitingEntry | undefined {
	const existing = entries.get(sessionName);
	entries.delete(sessionName);
	return existing;
}

/**
 * Get a session's current waiting state.
 *
 * @param sessionName - The session
 * @returns The entry, or undefined when the session is not waiting
 */
export function getWaiting(sessionName: string): WaitingEntry | undefined {
	return entries.get(sessionName);
}

/**
 * List every session currently waiting.
 *
 * @returns Snapshot of all waiting entries
 */
export function listWaiting(): WaitingEntry[] {
	return [...entries.values()];
}

/**
 * Forget all state (tests only).
 */
export function resetWaitingRegistry(): void {
	entries.clear();
}
