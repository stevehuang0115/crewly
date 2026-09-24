/**
 * Turn probe for PTY agent sessions.
 *
 * Decides whether an agent is mid-turn from two signals the codebase already
 * trusts:
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
import { SAFE_RESTART } from '../../constants.js';
import type { TurnProbe } from './in-flight-turn-tracker.service.js';

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

	return (sessionName: string) => {
		const backend = deps.getBackend();
		if (!backend || !backend.sessionExists(sessionName)) return 'gone';
		if (backend.isChildProcessAlive?.(sessionName) === false) return 'gone';

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

		const idleMs = deps.getIdleTimeMs(sessionName);
		if (idleMs !== null && idleMs < quietMs) return 'busy';
		return 'idle';
	};
}
