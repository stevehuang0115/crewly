/**
 * Agent Hook State
 *
 * Latest "waiting on the user" signal per agent session, as reported by the
 * Claude Code agent-status hook (`config/hooks/agent-status/report.sh`,
 * POST /api/agent-hooks). #815, specs/2026-09-26-agent-status-hooks.md.
 *
 * This is the hook half of the waiting_on_human verdict: the activity
 * monitor combines it with screen and title detection. Only identifiers are
 * ever stored (event name, notification type) — never hook payload content.
 *
 * @module services/monitoring/agent-hook-state
 */

import { AGENT_STATUS_HOOK_CONSTANTS } from '../../constants.js';

/** What a hook event says about waiting. */
export type HookSignalState = 'waiting' | 'cleared';

/** What the agent waits on, from the hook's point of view. */
export type HookWaitingKind = 'permission' | 'menu';

/** The latest signal for one session. */
export interface HookSignal {
	/** Session that reported it. */
	sessionName: string;
	/** Waiting or cleared. */
	state: HookSignalState;
	/** Set when `state` is `waiting`. */
	kind?: HookWaitingKind;
	/** The hook event that produced it. */
	event: string;
	/** The notification type, for Notification events. */
	notificationType?: string;
	/** ISO time it was received. */
	at: string;
}

/**
 * Map a hook event to a signal.
 *
 * - `PermissionRequest`, or `Notification` of type `permission_prompt` → waiting (permission)
 * - `Notification` of type `elicitation_dialog` → waiting (menu: a question for the user)
 * - `Stop`, `UserPromptSubmit`, `PostToolUse` → cleared (the prompt was answered or the turn ended)
 * - anything else (e.g. `idle_prompt`: the agent is idle at its input box) → no signal
 *
 * @param event - Hook event name
 * @param notificationType - Notification type, for Notification events
 * @returns The signal state and kind, or null when the event says nothing about waiting
 */
export function hookEventToSignal(
	event: string,
	notificationType?: string,
): { state: HookSignalState; kind?: HookWaitingKind } | null {
	if (event === 'PermissionRequest') return { state: 'waiting', kind: 'permission' };
	if (event === 'Notification') {
		if (notificationType === 'permission_prompt') return { state: 'waiting', kind: 'permission' };
		if (notificationType === 'elicitation_dialog') return { state: 'waiting', kind: 'menu' };
		return null;
	}
	if (event === 'Stop' || event === 'UserPromptSubmit' || event === 'PostToolUse') return { state: 'cleared' };
	return null;
}

const signals = new Map<string, HookSignal>();

/**
 * Record a hook event for a session.
 *
 * @param sessionName - Reporting session
 * @param event - Hook event name (already validated by the caller)
 * @param notificationType - Notification type, if any
 * @param now - Clock (injectable for tests)
 * @returns The stored signal, or null when the event carries no waiting information
 */
export function recordHookEvent(
	sessionName: string,
	event: string,
	notificationType?: string,
	now: Date = new Date(),
): HookSignal | null {
	const mapped = hookEventToSignal(event, notificationType);
	if (!mapped) return null;
	if (!signals.has(sessionName) && signals.size >= AGENT_STATUS_HOOK_CONSTANTS.MAX_TRACKED_SESSIONS) {
		// Bounded memory: drop the oldest entry (Map keeps insertion order).
		const oldest = signals.keys().next().value;
		if (oldest !== undefined) signals.delete(oldest);
	}
	const signal: HookSignal = {
		sessionName,
		state: mapped.state,
		...(mapped.kind ? { kind: mapped.kind } : {}),
		event,
		...(notificationType ? { notificationType } : {}),
		at: now.toISOString(),
	};
	signals.delete(sessionName);
	signals.set(sessionName, signal);
	return signal;
}

/**
 * Latest hook signal for a session.
 *
 * @param sessionName - Session
 * @returns The signal, or undefined when the session never reported one
 */
export function getHookSignal(sessionName: string): HookSignal | undefined {
	return signals.get(sessionName);
}

/**
 * Forget a session's signal (e.g. when its session ends).
 *
 * @param sessionName - Session
 */
export function clearHookSignal(sessionName: string): void {
	signals.delete(sessionName);
}

/**
 * Forget everything (tests only).
 */
export function resetHookState(): void {
	signals.clear();
}
