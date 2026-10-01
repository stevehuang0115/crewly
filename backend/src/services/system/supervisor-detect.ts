/**
 * Who brings the backend back after it exits?
 *
 * The owner's Restart / Upgrade buttons must never leave a machine down, so
 * before exiting the backend needs to know whether something will relaunch
 * it (specs/2026-10-01-upgrade-restart-controls.md):
 *
 * - `crewly start` (the CLI restart loop) respawns the backend when it exits
 *   with RESTART_REQUESTED (120). That is the parent in every supported run
 *   mode: foreground, the macOS login item (`~/.crewly/crewly-start.command`),
 *   the systemd user unit (`crewly.service`) and the desktop app. The outer
 *   layer is reported too, because it decides what happens if the CLI itself
 *   dies.
 * - PM2 restarts the app on exit by default.
 * - A backend started some other way (directly under systemd or launchd,
 *   a bare `node dist/...`) may or may not come back; that is "unknown", and
 *   "none" when there is clearly no supervisor at all.
 *
 * Pure: the environment and process lookups are injected.
 *
 * @module services/system/supervisor-detect
 */

import { execFileSync } from 'child_process';
import { SYSTEM_CONTROL_CONSTANTS } from '../../constants.js';
import { hasRestartSupervisor, readProcessCommandLine } from './auto-update.utils.js';

/** The process that relaunches the backend, as far as we can tell. */
export type SupervisorKind = 'crewly-start' | 'pm2' | 'systemd' | 'launchd' | 'none' | 'unknown';

/** What keeps the `crewly start` chain itself alive. */
export type OuterSupervisor = 'systemd' | 'login-wrapper' | 'launchd' | null;

/** Whether the backend will come back after it exits. */
export type RelaunchAnswer = 'yes' | 'no' | 'unknown';

/** Result of {@link detectSupervisor}. */
export interface SupervisorInfo {
	/** Direct relauncher of the backend */
	kind: SupervisorKind;
	/** What keeps the chain above it alive, when known */
	outer: OuterSupervisor;
	/** Whether exiting brings the backend back without our help */
	willRelaunch: RelaunchAnswer;
	/** One owner-readable sentence */
	detail: string;
}

/** Inputs for {@link detectSupervisor}. */
export interface SupervisorProbe {
	/** Backend environment */
	env: NodeJS.ProcessEnv;
	/** Platform */
	platform: NodeJS.Platform;
	/** Command line of the parent process (null when unreadable) */
	parentCommandLine: () => string | null;
	/** Command line of the grandparent process (null when unreadable) */
	grandparentCommandLine: () => string | null;
}

/**
 * Whether the environment says we run inside a systemd unit.
 *
 * @param env - Environment
 * @param commandLines - Parent / grandparent command lines
 * @returns True under systemd
 */
function isUnderSystemd(env: NodeJS.ProcessEnv, commandLines: Array<string | null>): boolean {
	if (env.INVOCATION_ID) return true;
	return commandLines.some((c) => !!c && c.includes(SYSTEM_CONTROL_CONSTANTS.SYSTEMD_UNIT));
}

/**
 * Whether launchd started us as a job (not via Terminal). launchd sets
 * XPC_SERVICE_NAME to the job label; shells in Terminal get `0` or an
 * `application.*` name.
 *
 * @param env - Environment
 * @param platform - Platform
 * @returns True for a launchd job
 */
function isLaunchdJob(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
	if (platform !== 'darwin') return false;
	const label = env.XPC_SERVICE_NAME;
	return !!label && label !== '0' && !label.startsWith('application.');
}

/**
 * Work out what relaunches the backend.
 *
 * @param probe - Environment and process lookups
 * @returns Supervisor info
 *
 * @example
 * ```ts
 * detectSupervisor({ env: { CREWLY_RESTART_SUPERVISOR: 'cli-start', INVOCATION_ID: 'x' }, platform: 'linux',
 *   parentCommandLine: () => null, grandparentCommandLine: () => null });
 * // { kind: 'crewly-start', outer: 'systemd', willRelaunch: 'yes', ... }
 * ```
 */
export function detectSupervisor(probe: SupervisorProbe): SupervisorInfo {
	const { env, platform } = probe;
	let parent: string | null | undefined;
	let grandparent: string | null | undefined;
	const readParent = (): string | null => (parent === undefined ? (parent = probe.parentCommandLine()) : parent);
	const readGrandparent = (): string | null =>
		grandparent === undefined ? (grandparent = probe.grandparentCommandLine()) : grandparent;

	const cliStart = hasRestartSupervisor(env, readParent);
	if (cliStart) {
		const gp = readGrandparent();
		let outer: OuterSupervisor = null;
		if (isUnderSystemd(env, [gp])) outer = 'systemd';
		else if (gp && gp.includes(SYSTEM_CONTROL_CONSTANTS.LOGIN_WRAPPER_SCRIPT)) outer = 'login-wrapper';
		else if (isLaunchdJob(env, platform)) outer = 'launchd';
		const outerText =
			outer === 'systemd'
				? ' systemd keeps crewly start itself running.'
				: outer === 'login-wrapper'
					? ` The ${SYSTEM_CONTROL_CONSTANTS.LOGIN_WRAPPER_SCRIPT} login item keeps crewly start itself running.`
					: outer === 'launchd'
						? ' launchd keeps crewly start itself running.'
						: '';
		return {
			kind: 'crewly-start',
			outer,
			willRelaunch: 'yes',
			detail: `crewly start restarts the backend when it exits.${outerText}`,
		};
	}

	// PM2 (the legacy ecosystem.config.js) restarts the app on exit by default.
	if (env.pm_id !== undefined || env.PM2_HOME !== undefined) {
		return {
			kind: 'pm2',
			outer: null,
			willRelaunch: 'yes',
			detail: 'PM2 restarts the backend when it exits.',
		};
	}

	const p = readParent();
	if (isUnderSystemd(env, [p])) {
		return {
			kind: 'systemd',
			outer: null,
			willRelaunch: 'unknown',
			detail: 'Runs directly under systemd; it comes back only if the unit has Restart= set.',
		};
	}
	if (isLaunchdJob(env, platform)) {
		return {
			kind: 'launchd',
			outer: null,
			willRelaunch: 'unknown',
			detail: 'Runs directly under launchd; it comes back only if the job has KeepAlive set.',
		};
	}
	if (p === null) {
		return {
			kind: 'unknown',
			outer: null,
			willRelaunch: 'unknown',
			detail: 'Could not tell what started Crewly.',
		};
	}
	return {
		kind: 'none',
		outer: null,
		willRelaunch: 'no',
		detail: 'Nothing will relaunch Crewly on its own; a restart starts a new copy before this one exits.',
	};
}

/**
 * Parent pid of a process (POSIX, via `ps`).
 *
 * @param pid - Process id
 * @returns The parent pid, or null
 */
export function readParentPid(pid: number): number | null {
	if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return null;
	try {
		const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2000 }).trim();
		const ppid = Number.parseInt(out, 10);
		return Number.isInteger(ppid) && ppid > 1 ? ppid : null;
	} catch {
		return null;
	}
}

/**
 * Detect the supervisor of the running process.
 *
 * @returns Supervisor info
 */
export function detectRunningSupervisor(): SupervisorInfo {
	return detectSupervisor({
		env: process.env,
		platform: process.platform,
		parentCommandLine: () => readProcessCommandLine(process.ppid),
		grandparentCommandLine: () => {
			const gp = readParentPid(process.ppid);
			return gp ? readProcessCommandLine(gp) : null;
		},
	});
}
