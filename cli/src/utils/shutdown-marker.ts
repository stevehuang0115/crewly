/**
 * Shutdown marker (`<crewlyHome>/run/shutdown-requested`) for the CLI.
 *
 * The backend writes it when the owner shuts Crewly down from the dashboard.
 * `crewly start` clears it on launch, and — when its backend exits with the
 * marker present — exits 0 instead of 1 and stops an old-style supervisor
 * script (one that relaunches on any exit and does not check the marker), so
 * Crewly stays down. The current supervisor script checks the marker itself.
 *
 * @module cli/utils/shutdown-marker
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SAFE_RESTART_CONSTANTS } from '../../../config/index.js';
import { resolveCrewlyHome } from './backend-respawn.js';

/**
 * Path of the shutdown marker.
 *
 * @param crewlyHome - Crewly home (defaults to CREWLY_HOME or ~/.crewly)
 * @returns Absolute path
 */
export function shutdownMarkerPath(crewlyHome: string = resolveCrewlyHome()): string {
	return path.join(crewlyHome, SAFE_RESTART_CONSTANTS.SHUTDOWN_MARKER_DIR, SAFE_RESTART_CONSTANTS.SHUTDOWN_MARKER_FILE);
}

/**
 * Whether a shutdown was requested and no start has cleared it.
 *
 * @param crewlyHome - Crewly home
 * @returns True when the marker exists
 */
export function hasShutdownMarker(crewlyHome?: string): boolean {
	return fs.existsSync(shutdownMarkerPath(crewlyHome));
}

/**
 * Remove the marker (a fresh start); absent is fine.
 *
 * @param crewlyHome - Crewly home
 */
export function clearShutdownMarker(crewlyHome?: string): void {
	try {
		fs.rmSync(shutdownMarkerPath(crewlyHome), { force: true });
	} catch {
		// best-effort
	}
}

/**
 * Stop an old-style supervisor script that would relaunch Crewly after a
 * shutdown: the CLI's parent, when it is the `crewly-start` wrapper.
 *
 * @param ppid - The CLI's parent pid
 * @param deps - Process lookup / signal (tests)
 * @returns True when the wrapper was signalled
 */
export function stopLegacySupervisor(
	ppid: number = process.ppid,
	deps: { commandOf?: (pid: number) => string; kill?: (pid: number, signal: NodeJS.Signals) => void } = {},
): boolean {
	if (!Number.isInteger(ppid) || ppid <= 1) return false;
	const commandOf =
		deps.commandOf ?? ((pid: number): string => String(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 3000 })));
	try {
		if (!commandOf(ppid).includes('crewly-start')) return false;
		(deps.kill ?? ((pid, signal) => process.kill(pid, signal)))(ppid, 'SIGTERM');
		return true;
	} catch {
		return false;
	}
}
