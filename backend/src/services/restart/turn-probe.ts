/**
 * Turn probe for PTY agent sessions.
 *
 * First asks the runtime (specs/2026-10-02-restart-busy-and-resume.md): a
 * Claude Code turn, tool call or background subagent reported through hooks
 * or the transcript is busy however silent the screen is — a long tool call
 * prints nothing (2026-10-02, Eve). A delivery the runtime has not yet
 * acknowledged (no hook event since it) is busy for up to
 * TURN_STATE_CONSTANTS.DELIVERY_START_MS.
 *
 * Then falls back to two screen signals the codebase already trusts:
 * - the "esc to interrupt" status bar (`containsBusyStatusBar`), which Claude
 *   Code and Codex show for the whole of a turn — thinking, streaming, and
 *   while a tool runs — and remove when the turn ends;
 * - the PtyActivityTracker's last meaningful output time, which catches
 *   runtimes without that bar (Gemini) and the gap between two tool calls.
 *
 * A session is resting only when both agree: no status bar and a quiet PTY.
 * A missing session or an exited runtime is 'gone' — there is nothing left to
 * wait for.
 *
 * @module services/restart/turn-probe
 */

import { containsBusyStatusBar, stripAnsiCodes } from '../../utils/terminal-string-ops.js';
import { SAFE_RESTART, TURN_STATE_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import type { TurnProbe } from './in-flight-turn-tracker.service.js';
import type { TurnVerdict } from '../monitoring/agent-turn-state.js';

/** The session-backend calls the probe needs. */
export interface ProbeSessionBackend {
	sessionExists(name: string): boolean;
	captureOutput(name: string, lines?: number): string;
	isChildProcessAlive?(name: string): boolean;
}

/** Dependencies of the PTY turn probe. */
export interface PtyTurnProbeDeps {
	/** Current session backend, or null when none is running */
	getBackend: () => ProbeSessionBackend | null;
	/** Ms since the session last produced meaningful output, or null if never */
	getIdleTimeMs: (sessionName: string) => number | null;
	/** Quiet period that counts as "resting" (defaults to SAFE_RESTART.TURN_QUIET_MS) */
	quietMs?: number;
	/** Trailing lines to inspect (defaults to SAFE_RESTART.PROBE_TAIL_LINES) */
	tailLines?: number;
	/** The runtime's own turn state (hooks / transcript); omitted = screen only */
	getRuntimeVerdict?: (sessionName: string) => TurnVerdict;
	/** Epoch ms of the session's last runtime hook event, or null when it never sent one */
	getLastHookEventAt?: (sessionName: string) => number | null;
	/** Runtime type of the session (enables runtime-specific busy markers) */
	getRuntimeType?: (sessionName: string) => string | null | undefined;
	/** Clock (tests) */
	now?: () => number;
}

/**
 * Create a probe that inspects a PTY session.
 *
 * @param deps - Backend and activity accessors
 * @returns A TurnProbe
 *
 * @example
 * ```typescript
 * const probe = createPtyTurnProbe({
 *   getBackend: () => getSessionBackendSync(),
 *   getIdleTimeMs: (s) => tracker.hasActivity(s) ? tracker.getIdleTimeMs(s) : null,
 * });
 * probe('ella-1234'); // 'busy' | 'idle' | 'gone'
 * ```
 */
export function createPtyTurnProbe(deps: PtyTurnProbeDeps): TurnProbe {
	const quietMs = deps.quietMs ?? SAFE_RESTART.TURN_QUIET_MS;
	const tailLines = deps.tailLines ?? SAFE_RESTART.PROBE_TAIL_LINES;

	const now = deps.now ?? Date.now;

	return (sessionName: string, context?: { since?: number }) => {
		const backend = deps.getBackend();
		if (!backend || !backend.sessionExists(sessionName)) return 'gone';
		if (backend.isChildProcessAlive?.(sessionName) === false) return 'gone';

		// The runtime's own word beats a silent screen.
		const verdict = deps.getRuntimeVerdict?.(sessionName);
		if (verdict && (verdict.state === 'turn' || verdict.state === 'background')) return 'busy';
		// Mid-turn from delivery until the runtime reports the turn: a hook
		// runtime that has not said anything since the delivery has not
		// started (or not yet acknowledged) it.
		const since = context?.since;
		if (typeof since === 'number' && deps.getLastHookEventAt) {
			const lastHook = deps.getLastHookEventAt(sessionName);
			if (lastHook !== null && lastHook < since && now() - since < TURN_STATE_CONSTANTS.DELIVERY_START_MS) return 'busy';
		}

		// Capture generously, then look only at the last non-empty lines: the
		// status bar sits at the bottom of the TUI, and older screens in the
		// scrollback must not count.
		const raw = backend.captureOutput(sessionName, tailLines * 4) ?? '';
		const tail = stripAnsiCodes(raw)
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.slice(-tailLines)
			.join('\n');
		if (containsBusyStatusBar(tail)) return 'busy';
		// Gemini CLI says "esc to cancel" while it works. Claude Code dialogs
		// say it too, so it only counts for Gemini sessions.
		if (deps.getRuntimeType?.(sessionName) === RUNTIME_TYPES.GEMINI_CLI && tail.toLowerCase().includes(TURN_STATE_CONSTANTS.GEMINI_BUSY_MARKER)) {
			return 'busy';
		}

		const idleMs = deps.getIdleTimeMs(sessionName);
		if (idleMs !== null && idleMs < quietMs) return 'busy';
		return 'idle';
	};
}
