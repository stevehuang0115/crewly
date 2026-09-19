/**
 * Utilities for cleaning up zombie/stale Crewly backend processes.
 *
 * @module cli/utils/process-cleanup
 */

import { execSync } from 'child_process';

/**
 * Kill any zombie backend processes from previous runs that are still holding
 * the port or consuming resources. Uses lsof to find processes on the port
 * and also searches for any stale crewly backend node processes.
 *
 * @param port - The port to check for zombie processes.
 * @param logFn - Logging function for status messages.
 */
export function killZombieProcesses(port: number, logFn: (msg: string) => void = console.log): void {
	const myPid = process.pid;

	// Find processes holding the port
	try {
		const portPids = execSync(`lsof -ti :${port}`, { encoding: 'utf8', timeout: 5000 })
			.trim()
			.split('\n')
			.filter(p => p && parseInt(p) !== myPid);

		if (portPids.length > 0) {
			logFn(`Found ${portPids.length} zombie process(es) on port ${port}, killing...`);
			for (const pid of portPids) {
				try {
					process.kill(parseInt(pid), 'SIGTERM');
				} catch {
					// Already dead
				}
			}
			// Give SIGTERM a moment, then SIGKILL stragglers
			try {
				execSync('sleep 1', { timeout: 3000 });
			} catch { /* ignore */ }
			for (const pid of portPids) {
				try {
					process.kill(parseInt(pid), 'SIGKILL');
				} catch {
					// Already dead
				}
			}
		}
	} catch {
		// lsof returns exit code 1 if no processes found — that's fine
	}

	// Also kill any stale crewly backend node processes
	try {
		const result = execSync(
			'ps -eo pid,command | grep "dist/backend/backend/src/index.js" | grep -v grep',
			{ encoding: 'utf8', timeout: 5000 }
		).trim();

		if (result) {
			const stalePids = result
				.split('\n')
				.map(line => parseInt(line.trim()))
				.filter(pid => !isNaN(pid) && pid !== myPid);

			if (stalePids.length > 0) {
				logFn(`Found ${stalePids.length} stale backend process(es), killing...`);
				for (const pid of stalePids) {
					try {
						process.kill(pid, 'SIGKILL');
					} catch {
						// Already dead
					}
				}
			}
		}
	} catch {
		// No stale processes found
	}

	// Kill orphaned vitest/test runner processes from previous agent sessions
	killOrphanedTestProcesses(myPid, logFn);
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
