/**
 * Safe-shutdown helpers for the CLI.
 *
 * The backend drains in-flight agent turns on SIGTERM/SIGINT for up to
 * CREWLY_RESTART_DRAIN_MS (default 120s). Every CLI path that stops it —
 * the `start` parent's signal forwarding, `crewly stop`, `crewly service
 * stop|restart|upgrade` — must wait at least that long (plus a margin for the
 * rest of shutdown) before escalating to SIGKILL or starting a new instance,
 * or it cuts off the very turns the drain is protecting.
 *
 * @module cli/utils/safe-shutdown
 */

import axios from 'axios';
import { SAFE_RESTART_CONSTANTS, WEB_CONSTANTS } from '../../../config/index.js';

/** Poll interval while waiting for a process to exit (ms). */
const EXIT_POLL_MS = 500;
/** Interval between "still waiting" progress lines (ms). */
const PROGRESS_INTERVAL_MS = 10_000;
/** Timeout for the readiness request (ms). */
const READINESS_TIMEOUT_MS = 3_000;
/** Pause between the two signals of a "skip the drain" request (ms), beyond the backend's dedup window. */
export const SKIP_DRAIN_SIGNAL_GAP_MS = SAFE_RESTART_CONSTANTS.SIGNAL_DEDUP_WINDOW_MS + 500;

/** One busy agent as reported by the backend. */
export interface ReadinessBusyAgent {
	session: string;
	since: string;
	messagePreview: string;
}

/** Body of GET /api/system/restart-readiness. */
export interface RestartReadiness {
	safe: boolean;
	busyAgents: ReadinessBusyAgent[];
	queued: number;
	draining?: boolean;
}

/**
 * Resolve the backend's drain timeout from the environment.
 *
 * @param env - Environment
 * @returns Drain timeout in ms (0 = drain disabled)
 */
export function resolveRestartDrainMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[SAFE_RESTART_CONSTANTS.DRAIN_ENV_VAR];
	if (raw === undefined || raw.trim() === '') return SAFE_RESTART_CONSTANTS.DRAIN_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return SAFE_RESTART_CONSTANTS.DRAIN_TIMEOUT_MS;
	return Math.floor(parsed);
}

/**
 * How long a supervisor must wait after SIGTERM before it may SIGKILL.
 *
 * @param env - Environment
 * @returns Drain timeout plus the shutdown margin (ms)
 *
 * @example
 * ```typescript
 * resolveShutdownBudgetMs({}); // 150000
 * ```
 */
export function resolveShutdownBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
	return resolveRestartDrainMs(env) + SAFE_RESTART_CONSTANTS.SHUTDOWN_MARGIN_MS;
}

/**
 * Validate an unknown JSON body as restart readiness.
 *
 * @param body - Parsed response body
 * @returns The readiness, or null if the shape does not match
 */
export function parseReadiness(body: unknown): RestartReadiness | null {
	if (!body || typeof body !== 'object') return null;
	const b = body as Record<string, unknown>;
	if (typeof b.safe !== 'boolean' || !Array.isArray(b.busyAgents)) return null;
	return {
		safe: b.safe,
		busyAgents: b.busyAgents.filter(
			(a): a is ReadinessBusyAgent => !!a && typeof (a as ReadinessBusyAgent).session === 'string',
		),
		queued: typeof b.queued === 'number' ? b.queued : 0,
		draining: b.draining === true,
	};
}

/**
 * Ask the running backend whether a restart would cut an agent off.
 *
 * @param port - Backend web port
 * @returns Readiness, or null when the backend does not answer (not running, older version)
 */
export async function fetchRestartReadiness(port: number | string = process.env.WEB_PORT || WEB_CONSTANTS.PORTS.BACKEND): Promise<RestartReadiness | null> {
	try {
		const response = await axios.get(`http://localhost:${port}${SAFE_RESTART_CONSTANTS.READINESS_ENDPOINT}`, {
			timeout: READINESS_TIMEOUT_MS,
		});
		return parseReadiness(response?.data);
	} catch {
		return null;
	}
}

/**
 * Human-readable lines describing readiness, for printing before a stop.
 *
 * @param readiness - Readiness from the backend
 * @param drainMs - Drain timeout in effect
 * @returns Lines to print
 */
export function describeReadiness(readiness: RestartReadiness, drainMs: number): string[] {
	if (readiness.safe) {
		return [`No agent is mid-turn; ${readiness.queued} queued message(s) will be delivered after the restart.`];
	}
	const lines = [
		`${readiness.busyAgents.length} agent(s) are mid-turn; the backend waits up to ${Math.round(drainMs / 1000)}s for them to finish:`,
	];
	for (const agent of readiness.busyAgents) {
		lines.push(`  - ${agent.session} (since ${agent.since}): ${agent.messagePreview}`);
	}
	lines.push('Turns still running when the wait ends are resumed after the restart.');
	return lines;
}

/** Dependencies of {@link waitForPidExit}. */
export interface WaitForExitDeps {
	/** Whether the pid is alive */
	isAlive: (pid: number) => boolean | Promise<boolean>;
	/** Sleep */
	sleep?: (ms: number) => Promise<void>;
	/** Clock */
	now?: () => number;
	/** Progress callback, called about every PROGRESS_INTERVAL_MS */
	onProgress?: (waitedMs: number) => void;
	/** Poll interval (ms) */
	pollMs?: number;
}

/**
 * Wait for a process to exit.
 *
 * @param pid - Process id
 * @param timeoutMs - Maximum wait
 * @param deps - Liveness check and test hooks
 * @returns True if the process exited within the timeout
 */
export async function waitForPidExit(pid: number, timeoutMs: number, deps: WaitForExitDeps): Promise<boolean> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const pollMs = deps.pollMs ?? EXIT_POLL_MS;
	const start = now();
	let lastProgress = start;
	for (;;) {
		if (!(await deps.isAlive(pid))) return true;
		const t = now();
		if (t - start >= timeoutMs) return false;
		if (deps.onProgress && t - lastProgress >= PROGRESS_INTERVAL_MS) {
			deps.onProgress(t - start);
			lastProgress = t;
		}
		await sleep(pollMs);
	}
}

/**
 * Liveness check via signal 0.
 *
 * @param pid - Process id
 * @returns True if the process exists
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists but belongs to someone else.
		return (error as NodeJS.ErrnoException)?.code === 'EPERM';
	}
}

/** Extra time after the SIGKILL escalation before the parent gives up waiting (ms). */
const HARD_EXIT_EXTRA_MS = 3_000;

/** The part of a ChildProcess the shutdown handler uses. */
export interface ShutdownChild {
	/** True once any signal was sent (Node sets it after a successful kill()) — not "dead" */
	killed: boolean;
	exitCode: number | null;
	signalCode?: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals | number): boolean;
	once(event: 'exit', listener: (...args: unknown[]) => void): unknown;
}

/** Options for {@link createChildShutdownHandler}. */
export interface ChildShutdownOptions {
	/** Wait after SIGTERM before SIGKILL (ms) — the backend's drain plus margin */
	budgetMs: number;
	/** Progress / status output */
	log: (message: string) => void;
	/** Called once every child is gone (or the hard cap passed) */
	exit: () => void;
}

/**
 * Build the signal handler for a parent process (the `crewly start` CLI)
 * supervising backend children.
 *
 * First signal: SIGTERM each live child, SIGKILL only after `budgetMs`, and
 * exit once all children are gone. Later signals are forwarded as another
 * SIGTERM, which the backend reads as "stop draining now" — so a second
 * `kill -TERM <cli pid>` or Ctrl+C still skips the drain rather than being
 * swallowed here.
 *
 * @param getChildren - Returns the children to stop (the restart loop swaps them)
 * @param options - Budget, logger, exit hook
 * @returns Signal handler
 *
 * @example
 * ```typescript
 * const onSignal = createChildShutdownHandler(() => active, { budgetMs: resolveShutdownBudgetMs(), log, exit: () => process.exit(0) });
 * process.on('SIGTERM', onSignal);
 * ```
 */
export function createChildShutdownHandler(
	getChildren: () => readonly (ShutdownChild | null | undefined)[],
	options: ChildShutdownOptions,
): () => void {
	let cleaningUp = false;
	// `killed` only means "a signal was sent", so it cannot tell a draining
	// backend from a dead one; exitCode / signalCode can.
	const live = (): ShutdownChild[] =>
		getChildren().filter((c): c is ShutdownChild => !!c && c.exitCode === null && (c.signalCode ?? null) === null);

	return () => {
		if (cleaningUp) {
			const children = live();
			if (children.length > 0) {
				options.log('Signal received again — asking the backend to stop waiting for agents.');
				for (const child of children) {
					try {
						child.kill('SIGTERM');
					} catch {
						// Already gone.
					}
				}
			}
			return;
		}
		cleaningUp = true;

		const waits = live().map(
			(proc) =>
				new Promise<void>((resolve) => {
					let settled = false;
					let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
					let hardTimer: ReturnType<typeof setTimeout> | null = null;
					const done = (): void => {
						if (settled) return;
						settled = true;
						if (sigkillTimer) clearTimeout(sigkillTimer);
						if (hardTimer) clearTimeout(hardTimer);
						resolve();
					};
					proc.once('exit', done);
					try {
						proc.kill('SIGTERM');
					} catch {
						done();
						return;
					}
					sigkillTimer = setTimeout(() => {
						if (proc.exitCode === null && (proc.signalCode ?? null) === null) {
							options.log(`Backend did not exit within ${Math.round(options.budgetMs / 1000)}s of SIGTERM; sending SIGKILL`);
							try {
								proc.kill('SIGKILL');
							} catch {
								// Already gone.
							}
						}
					}, options.budgetMs);
					hardTimer = setTimeout(done, options.budgetMs + HARD_EXIT_EXTRA_MS);
				}),
		);

		if (waits.length > 0) {
			options.log(
				`Stopping backend — it finishes in-flight agent turns first (up to ${Math.round(options.budgetMs / 1000)}s). Send the signal again to stop waiting.`,
			);
		}
		void Promise.all(waits).finally(options.exit);
	};
}
