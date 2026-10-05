/**
 * Shutdown marker: `<crewlyHome>/run/shutdown-requested`.
 *
 * Written when the owner shuts Crewly down (as opposed to restarting it). A
 * supervisor that relaunches Crewly whenever it exits — the macOS
 * `crewly-start.command` loop — checks the file first and stays down.
 * `crewly start`, a fresh supervisor launch and the backend's own boot clear
 * it, so the next manual launch always works.
 *
 * @module services/system/shutdown-marker
 */

import * as fs from 'fs';
import * as path from 'path';
import { SAFE_RESTART } from '../../constants.js';

/**
 * Path of the marker.
 *
 * @param crewlyHome - Crewly home directory
 * @returns Absolute path
 */
export function shutdownMarkerPath(crewlyHome: string): string {
	return path.join(crewlyHome, SAFE_RESTART.SHUTDOWN_MARKER_DIR, SAFE_RESTART.SHUTDOWN_MARKER_FILE);
}

/**
 * Write the marker (who and when, for whoever finds it).
 *
 * @param crewlyHome - Crewly home directory
 * @param pid - Backend pid that requested the shutdown
 * @param now - Clock
 * @throws When the file cannot be written
 */
export function writeShutdownMarker(crewlyHome: string, pid: number = process.pid, now: () => number = Date.now): void {
	const file = shutdownMarkerPath(crewlyHome);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ requestedAt: new Date(now()).toISOString(), pid })}\n`, 'utf-8');
}

/**
 * Remove the marker; absent is fine.
 *
 * @param crewlyHome - Crewly home directory
 */
export function clearShutdownMarker(crewlyHome: string): void {
	try {
		fs.rmSync(shutdownMarkerPath(crewlyHome), { force: true });
	} catch {
		// best-effort
	}
}

/**
 * Whether the marker exists.
 *
 * @param crewlyHome - Crewly home directory
 * @returns True when a shutdown was requested and no start has cleared it
 */
export function hasShutdownMarker(crewlyHome: string): boolean {
	return fs.existsSync(shutdownMarkerPath(crewlyHome));
}
