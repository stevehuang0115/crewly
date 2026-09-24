/**
 * Utilities for cleaning up zombie/stale Crewly backend processes.
 *
 * @module cli/utils/process-cleanup
 */

import { execSync } from 'child_process';

/**
 * A process is treated as a Crewly backend only when its command line runs
 * the backend entrypoint: the compiled `dist/backend/backend/src/index.js`
 * (what `crewly start` spawns) or `backend/src/index.ts` (dev via tsx).
 */
export const CREWLY_BACKEND_COMMAND_PATTERN = /backend\/src\/index\.(js|ts)\b/;

/**
 * Command that lists the pids LISTENING on a TCP port.
 *
 * `-sTCP:LISTEN` matters: a plain `lsof -ti :<port>` also returns every
 * client connected to the port (browsers, agents, curl), which must never be
 * signalled.
 *
 * @param port - TCP port
 * @returns Shell command
 */
export function listListenersCommand(port: number): string {
	return `lsof -nP -ti tcp:${port} -sTCP:LISTEN`;
}

/**
 * Replace a stale Crewly backend that still holds THIS start's port, and
 * nothing else.
 *
 * `crewly start` calls this only after the health check on `port` failed, so
 * a listener on `port` is a dead or wedged instance of this same Crewly. Scope:
 * - only processes LISTENING on `port`, never clients connected to it;
 * - only if the listener's command line is a Crewly backend
 *   ({@link CREWLY_BACKEND_COMMAND_PATTERN}). Anything else on the port is
 *   reported and left alone;
 * - SIGTERM first, SIGKILL only for stragglers after a short grace period.
 *
 * Crewly backends of other projects run on other ports and are never touched.
 * An earlier version also SIGKILLed every process on the machine matching
 * `dist/backend/backend/src/index.js`, which took down every other project's
 * backend and its agents on each `crewly start`. That sweep is gone.
 *
 * Orphaned test runners are still cleaned up ({@link killOrphanedTestProcesses}).
 *
 * @param port - The port this `crewly start` will bind
 * @param logFn - Logging function for status messages
 * @returns The pids that were signalled
 */
export function killZombieProcesses(port: number, logFn: (msg: string) => void = console.log): number[] {
	const myPid = process.pid;
	const signalled: number[] = [];

	let listeners: number[] = [];
	try {
		listeners = execSync(listListenersCommand(port), { encoding: 'utf8', timeout: 5000 })
			.trim()
			.split('\n')
			.map((p) => parseInt(p, 10))
			.filter((pid) => !isNaN(pid) && pid !== myPid);
	} catch {
		// lsof exits 1 when nothing listens on the port: nothing to replace
	}

	const stale: number[] = [];
	for (const pid of listeners) {
		let command = '';
		try {
			command = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8', timeout: 2000 }).trim();
		} catch {
			continue; // already gone
		}
		if (CREWLY_BACKEND_COMMAND_PATTERN.test(command)) {
			stale.push(pid);
		} else {
			logFn(`Port ${port} is held by pid ${pid} (${command.slice(0, 80)}), which is not a Crewly backend; leaving it alone.`);
		}
	}

	if (stale.length > 0) {
		logFn(`Replacing ${stale.length} stale Crewly backend(s) on port ${port} (pid ${stale.join(', ')})...`);
		for (const pid of stale) {
			try {
				process.kill(pid, 'SIGTERM');
				signalled.push(pid);
			} catch {
				// Already dead
			}
		}
		// Give SIGTERM a moment, then SIGKILL stragglers
		try {
			execSync('sleep 1', { timeout: 3000 });
		} catch { /* ignore */ }
		for (const pid of stale) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// Already dead
			}
		}
	}

	// Kill orphaned vitest/test runner processes from previous agent sessions
	killOrphanedTestProcesses(myPid, logFn);
	return signalled;
}

/**
 * Whether a parent pid means "the real parent is gone": pid 1, or a
 * `systemd --user` / launchd subreaper that adopted the process.
 *
 * @param ppid - Parent pid
 * @returns True when the process has been reparented
 */
export function isOrphanParent(ppid: number): boolean {
	if (ppid <= 1) return true;
	try {
		const comm = execSync(`ps -o comm= -p ${ppid}`, { encoding: 'utf8', timeout: 2000 }).trim();
		return comm === 'systemd' || comm === 'launchd' || comm === '';
	} catch {
		return true; // parent already gone
	}
}

/**
 * Pick the test-runner pids that are truly orphaned from a `pid ppid`
 * listing: roots whose parent is gone, plus their descendants in the same
 * listing (vitest's worker pool survives its main process being killed).
 *
 * A test run with a live parent chain (`make → npm → vitest`) belongs to
 * someone else on this machine — the SteamFun release pipeline lost its
 * unit tests to every Crewly restart (TKT427) — and is left alone.
 *
 * @param rows - `[pid, ppid]` pairs of matching test processes
 * @param isOrphan - Parent-gone predicate (injectable for tests)
 * @returns Pids safe to kill
 */
export function selectOrphanedTestPids(
	rows: Array<[number, number]>,
	isOrphan: (ppid: number) => boolean = isOrphanParent,
): number[] {
	const listed = new Set(rows.map(([pid]) => pid));
	const doomed = new Set<number>();
	for (const [pid, ppid] of rows) {
		// A parent that is itself in the listing is judged by its own parent, not here.
		if (!listed.has(ppid) && isOrphan(ppid)) doomed.add(pid);
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const [pid, ppid] of rows) {
			if (!doomed.has(pid) && doomed.has(ppid)) {
				doomed.add(pid);
				grew = true;
			}
		}
	}
	return [...doomed];
}

/**
 * Kill orphaned vitest worker processes that survived agent session termination.
 * These accumulate when exec() kills only the parent shell but leaves
 * vitest's forked worker pool running. Only processes whose parent is gone
 * (see {@link selectOrphanedTestPids}) are touched.
 *
 * @param myPid - Current process PID to exclude from killing.
 * @param logFn - Logging function for status messages.
 */
export function killOrphanedTestProcesses(
	myPid: number = process.pid,
	logFn: (msg: string) => void = console.log,
): void {
	try {
		const result = execSync(
			'ps -eo pid,ppid,command | grep -E "node.*vitest|npx vitest" | grep -v grep',
			{ encoding: 'utf8', timeout: 5000 }
		).trim();

		if (!result) return;

		const rows: Array<[number, number]> = result
			.split('\n')
			.map(line => line.trim().split(/\s+/))
			.map(cols => [parseInt(cols[0]), parseInt(cols[1])] as [number, number])
			.filter(([pid, ppid]) => !isNaN(pid) && !isNaN(ppid) && pid !== myPid);
		const pids = selectOrphanedTestPids(rows);

		if (pids.length > 0) {
			logFn(`Found ${pids.length} orphaned test process(es), killing...`);
			for (const pid of pids) {
				try {
					process.kill(pid, 'SIGTERM');
				} catch {
					// Already dead
				}
			}
			// Force kill after a brief grace period
			try {
				execSync('sleep 1', { timeout: 3000 });
			} catch { /* ignore */ }
			for (const pid of pids) {
				try {
					process.kill(pid, 'SIGKILL');
				} catch {
					// Already dead
				}
			}
		}
	} catch {
		// No orphaned test processes found
	}
}
