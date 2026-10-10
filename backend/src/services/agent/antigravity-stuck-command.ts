/**
 * Detects an antigravity-cli (agy) session whose TUI keeps a "Running
 * command..." spinner although the command is long finished: the agy process
 * has no child process left. The agent then looks busy forever, so queued
 * owner messages are never delivered and a runtime switch (which waits for a
 * safe point) never happens. The fix that worked by hand is one Escape.
 *
 * Pure logic with injected inputs; the activity monitor feeds it one screen
 * per poll.
 *
 * @module services/agent/antigravity-stuck-command
 */

import { execFileSync } from 'child_process';
import { ANTIGRAVITY_STUCK_COMMAND_CONSTANTS as C } from '../../constants.js';

/** Inputs of one observation. */
export interface StuckCommandProbe {
	/** Bottom lines of the session's screen */
	screen: string;
	/** PID of the PTY shell that launched agy (null when unknown) */
	shellPid: number | null;
	/** Send Escape to the session */
	sendEscape: () => void;
}

/** Injected behaviour (tests replace it). */
export interface StuckCommandDeps {
	now?: () => number;
	/** Child PIDs of a process (empty when none or when the check fails) */
	childPids?: (pid: number) => number[];
	logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

/**
 * Direct children of a process, via `pgrep -P`.
 *
 * @param pid - Parent PID
 * @returns Child PIDs (empty when none, or when pgrep fails)
 */
export function pgrepChildren(pid: number): number[] {
	try {
		const out = execFileSync('pgrep', ['-P', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString();
		return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
	} catch {
		return [];
	}
}

/** Tracks "Running command" spinners per session. */
export class AntigravityStuckCommandDetector {
	private readonly now: () => number;
	private readonly childPids: (pid: number) => number[];
	private readonly logger?: StuckCommandDeps['logger'];
	/** When the spinner was first seen in an unbroken run of observations */
	private readonly firstSeen = new Map<string, number>();
	/** When Escape was last sent */
	private readonly lastEscape = new Map<string, number>();

	/**
	 * @param deps - Injected behaviour
	 */
	constructor(deps: StuckCommandDeps = {}) {
		this.now = deps.now ?? (() => Date.now());
		this.childPids = deps.childPids ?? pgrepChildren;
		this.logger = deps.logger;
	}

	/**
	 * Look at one screen of an antigravity-cli session.
	 *
	 * @param sessionName - Session
	 * @param probe - Screen and hooks
	 * @returns True when Escape was sent
	 */
	observe(sessionName: string, probe: StuckCommandProbe): boolean {
		if (!C.SPINNER_PATTERN.test(probe.screen)) {
			this.firstSeen.delete(sessionName);
			return false;
		}
		const now = this.now();
		const since = this.firstSeen.get(sessionName) ?? now;
		this.firstSeen.set(sessionName, since);
		if (now - since < C.STUCK_AFTER_MS) return false;
		const last = this.lastEscape.get(sessionName);
		if (last !== undefined && now - last < C.REPEAT_COOLDOWN_MS) return false;
		if (probe.shellPid === null || this.hasRunningCommand(probe.shellPid)) return false;

		this.lastEscape.set(sessionName, now);
		this.firstSeen.set(sessionName, now);
		this.logger?.warn('Antigravity shows "Running command..." but has no child process — sending Escape', {
			sessionName,
			spinnerMs: now - since,
		});
		probe.sendEscape();
		return true;
	}

	/**
	 * Is agy running a command? False when agy is not found under the shell
	 * (not agy's hang to fix) or has no child process.
	 *
	 * @param shellPid - PTY shell PID
	 * @returns True when the command may still be running (or agy cannot be found)
	 */
	private hasRunningCommand(shellPid: number): boolean {
		const agyPids = this.childPids(shellPid);
		if (agyPids.length === 0) return true;
		return agyPids.some((pid) => this.childPids(pid).length > 0);
	}

	/**
	 * Forget a session (it ended).
	 *
	 * @param sessionName - Session
	 */
	clear(sessionName: string): void {
		this.firstSeen.delete(sessionName);
		this.lastEscape.delete(sessionName);
	}
}
