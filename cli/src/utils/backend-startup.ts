/**
 * Startup wait for the backend child of `crewly start`.
 *
 * The CLI spawns the backend and polls its /health endpoint. It used to give
 * up after a fixed 30 probes and exit, without stopping the child. On a
 * loaded machine the backend was still initialising at that point
 * (2026-11-13): the CLI reported "Server failed to start within timeout",
 * the supervisor relaunched it, and every abandoned attempt left a
 * half-started backend behind holding files and, eventually, the port.
 *
 * Here the wait lasts as long as the child is alive (up to a generous cap),
 * ends at once when the child exits, and a give-up stops the child.
 *
 * @module cli/utils/backend-startup
 */

import type { ChildProcess } from 'child_process';
import { SERVER_CONSTANTS } from '../../../config/index.js';

/** Collaborators and limits for {@link waitForBackendReady} (tests inject). */
export interface BackendReadyOptions {
	/** Resolves true when the backend answers /health */
	probe: () => Promise<boolean>;
	/** Longest total wait (ms) */
	maxWaitMs?: number;
	/** Pause between probes (ms) */
	pollIntervalMs?: number;
	/** Clock (ms) */
	now?: () => number;
	/** Pause implementation */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Whether a child process has ended (exited or was killed by a signal).
 *
 * @param proc - The child process
 * @returns True once the process is gone
 */
export function hasExited(proc: ChildProcess): boolean {
	return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * Wait until the backend answers /health.
 *
 * Keeps waiting while the backend child is alive, however slow the machine
 * is, up to `maxWaitMs`. Stops at once when the child exits, since a dead
 * backend will never answer.
 *
 * @param proc - The backend child process
 * @param options - Probe, limits and (for tests) clock and sleep
 * @returns Resolves when the backend is healthy
 * @throws Error when the child exits first, or the cap is reached
 *
 * @example
 * ```typescript
 * await waitForBackendReady(child, { probe: () => isHealthy(8787) });
 * ```
 */
export async function waitForBackendReady(proc: ChildProcess, options: BackendReadyOptions): Promise<void> {
	const maxWaitMs = options.maxWaitMs ?? SERVER_CONSTANTS.STARTUP_MAX_WAIT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? SERVER_CONSTANTS.STARTUP_POLL_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const startedAt = now();

	for (;;) {
		if (hasExited(proc)) {
			throw new Error(`Backend exited before it was ready (code: ${proc.exitCode}, signal: ${proc.signalCode})`);
		}
		if (await options.probe().catch(() => false)) return;
		if (now() - startedAt >= maxWaitMs) {
			throw new Error(`Server failed to start within timeout (${Math.round(maxWaitMs / 1000)}s)`);
		}
		await sleep(pollIntervalMs);
	}
}

/**
 * Stop a backend child that is being given up on, so it does not stay
 * behind holding the port and open files: SIGTERM, then SIGKILL if it is
 * still there after the grace period.
 *
 * @param proc - The backend child process
 * @param graceMs - How long to wait after SIGTERM before SIGKILL (ms)
 * @returns Resolves once the child has exited (or SIGKILL was sent and it exited)
 *
 * @example
 * ```typescript
 * await terminateBackendChild(child);
 * process.exit(1);
 * ```
 */
export function terminateBackendChild(proc: ChildProcess, graceMs: number = SERVER_CONSTANTS.STARTUP_ABORT_KILL_GRACE_MS): Promise<void> {
	return new Promise<void>((resolve) => {
		if (hasExited(proc) || proc.pid === undefined) {
			resolve();
			return;
		}
		const killTimer = setTimeout(() => {
			try {
				proc.kill('SIGKILL');
			} catch {
				// Already gone.
			}
		}, graceMs);
		proc.once('exit', () => {
			clearTimeout(killTimer);
			resolve();
		});
		try {
			proc.kill('SIGTERM');
		} catch {
			clearTimeout(killTimer);
			resolve();
		}
	});
}
