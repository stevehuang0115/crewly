/**
 * Respawn decision for the `crewly start` restart loop.
 *
 * The backend asks to be respawned by exiting with RESTART_REQUESTED (120).
 * An auto-update restart also writes `<crewlyHome>/auto-update-pending.json`
 * right before its graceful shutdown; when that shutdown overruns its own
 * force-exit timer the backend SIGKILLs itself, the exit code is lost, and
 * without this check a foreground `crewly start` (or the desktop app) would
 * stay down after installing the new version. A fresh marker therefore
 * also means "respawn" — once per CLI process, so a new version that dies
 * at boot cannot loop here.
 *
 * @module cli/utils/backend-respawn
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AUTO_UPDATE_CONSTANTS, CREWLY_CONSTANTS, PROCESS_EXIT_CODES } from '../../../config/index.js';

/** A marker older than this does not justify a respawn (ms). */
export const MARKER_RESPAWN_WINDOW_MS = 5 * 60 * 1000;

/** Inputs for {@link shouldRespawnBackend}. */
export interface RespawnContext {
	/** Crewly home (defaults to CREWLY_HOME or ~/.crewly) */
	crewlyHome?: string;
	/** Clock (tests) */
	now?: number;
	/** True when this CLI already respawned once because of a marker */
	markerRespawnUsed?: boolean;
}

/** Why the backend is (or is not) respawned. */
export type RespawnReason = 'restart-requested' | 'auto-update-marker' | null;

/**
 * Crewly home the backend uses (CREWLY_HOME, else ~/.crewly).
 *
 * @param env - Environment
 * @param homeDir - Home directory
 * @returns Absolute path
 */
export function resolveCrewlyHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
	const fromEnv = env.CREWLY_HOME;
	return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(homeDir, CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
}

/**
 * Decide whether the restart loop respawns the backend.
 *
 * @param exitCode - Backend exit code (null when killed by a signal)
 * @param ctx - Home, clock and the once-only flag
 * @returns The reason to respawn, or null to stop
 *
 * @example
 * ```ts
 * shouldRespawnBackend(120); // 'restart-requested'
 * shouldRespawnBackend(null, { markerRespawnUsed: false }); // 'auto-update-marker' when a fresh marker exists
 * ```
 */
export function shouldRespawnBackend(exitCode: number | null, ctx: RespawnContext = {}): RespawnReason {
	if (exitCode === PROCESS_EXIT_CODES.RESTART_REQUESTED) return 'restart-requested';
	if (ctx.markerRespawnUsed) return null;
	const marker = path.join(ctx.crewlyHome ?? resolveCrewlyHome(), AUTO_UPDATE_CONSTANTS.MARKER_FILE);
	try {
		const age = (ctx.now ?? Date.now()) - fs.statSync(marker).mtimeMs;
		return age >= 0 && age < MARKER_RESPAWN_WINDOW_MS ? 'auto-update-marker' : null;
	} catch {
		return null;
	}
}
