/**
 * `crewly update-status` — what the automatic self-update is doing on this
 * machine (specs/auto-update.md): installed and running version, latest on
 * npm, whether auto-update is on (and why not), last check, last result.
 *
 * Reads the backend's status file (`<crewlyHome>/auto-update-state.json`)
 * and `/health`, so it works whether or not the backend is running.
 *
 * @module cli/commands/update-status
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { AUTO_UPDATE_CONSTANTS, CREWLY_CONSTANTS, WEB_CONSTANTS } from '../../../config/index.js';
import {
	type AutoUpdateState,
	detectInstall,
	readAutoUpdateState,
	resolveAutoUpdateSwitch,
} from '../../../backend/src/services/system/auto-update.utils.js';
import { resolvePackageRoot } from '../utils/package-root.js';
import { getLocalVersion } from '../utils/version-check.js';
import { resolveCrewlyHome } from '../utils/backend-respawn.js';

/** Timeout for the `/health` probe (ms). */
const HEALTH_TIMEOUT_MS = 2_000;

/** Subset of `/health` this command reads. */
interface HealthBody {
	version?: string;
	latestVersion?: string | null;
	updateAvailable?: boolean;
}

/** Everything the report is built from. */
export interface UpdateStatusInput {
	/** Version of the installed package this CLI belongs to */
	installedVersion: string | null;
	/** Version the running backend reports (null when it is not running) */
	runningVersion: string | null;
	/** Latest version the running backend knows of */
	healthLatest: string | null;
	/** Backend status file */
	state: AutoUpdateState;
	/** Live on/off/skip decision for this machine */
	mode: string;
	/** Log file path */
	logFile: string;
}

/** Injectable I/O for {@link collectUpdateStatus}. */
export interface UpdateStatusDeps {
	/** Environment */
	env: NodeJS.ProcessEnv;
	/** Home directory (settings.json lives in `<home>/.crewly`) */
	homeDir: string;
	/** Fetch (for /health) */
	fetchImpl: typeof fetch;
	/** Installed CLI version */
	getInstalledVersion: () => string | null;
	/** Package root of this CLI */
	getPackageRoot: () => string | null;
}

/**
 * The live on/off decision, the same order the backend applies: install
 * kind first, then the env override, then the setting.
 *
 * @param packageRoot - Package root
 * @param settingValue - `settings.general.autoUpdate`
 * @param env - Environment
 * @returns Mode string
 */
export function resolveLiveMode(packageRoot: string | null, settingValue: boolean | undefined, env: NodeJS.ProcessEnv): string {
	const install = detectInstall(packageRoot);
	if (install.kind !== 'npm-global') return install.kind;
	return resolveAutoUpdateSwitch(settingValue, env);
}

/**
 * Read `settings.general.autoUpdate` from the settings file.
 *
 * @param homeDir - Home directory
 * @returns The value, or undefined when unset/unreadable
 */
export function readAutoUpdateSetting(homeDir: string): boolean | undefined {
	try {
		const file = path.join(homeDir, CREWLY_CONSTANTS.PATHS.CREWLY_HOME, 'settings.json');
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { general?: { autoUpdate?: unknown } };
		const value = parsed.general?.autoUpdate;
		return typeof value === 'boolean' ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Gather the report inputs.
 *
 * @param deps - I/O
 * @returns Report input
 */
export async function collectUpdateStatus(deps: UpdateStatusDeps): Promise<UpdateStatusInput> {
	const crewlyHome = resolveCrewlyHome(deps.env, deps.homeDir);
	const port = deps.env.WEB_PORT || String(WEB_CONSTANTS.PORTS.BACKEND);
	let health: HealthBody | null = null;
	try {
		const res = await deps.fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		if (res.ok) health = (await res.json()) as HealthBody;
	} catch {
		health = null;
	}
	return {
		installedVersion: deps.getInstalledVersion(),
		runningVersion: health?.version ?? null,
		healthLatest: health?.latestVersion ?? null,
		state: readAutoUpdateState(path.join(crewlyHome, AUTO_UPDATE_CONSTANTS.STATE_FILE)),
		mode: resolveLiveMode(deps.getPackageRoot(), readAutoUpdateSetting(deps.homeDir), deps.env),
		logFile: path.join(crewlyHome, CREWLY_CONSTANTS.PATHS.LOGS_DIR, AUTO_UPDATE_CONSTANTS.LOG_FILE),
	};
}

/**
 * Human wording for a mode.
 *
 * @param mode - Mode
 * @returns Description
 */
export function describeMode(mode: string): string {
	switch (mode) {
		case 'enabled':
			return 'on';
		case 'enabled-env':
			return `on (${AUTO_UPDATE_CONSTANTS.ENV_VAR})`;
		case 'disabled-setting':
			return 'off (Settings → General → Automatic Updates)';
		case 'disabled-env':
			return `off (${AUTO_UPDATE_CONSTANTS.ENV_VAR})`;
		case 'dev-checkout':
			return 'off (dev checkout — never updates itself)';
		case 'unmanaged':
			return 'off (not an npm global install)';
		case 'no-supervisor':
			return 'off (backend not started by crewly start; nothing would restart it)';
		default:
			return mode;
	}
}

/**
 * Render the report as lines.
 *
 * @param input - Report input
 * @returns Lines (uncoloured)
 */
export function formatUpdateStatus(input: UpdateStatusInput): string[] {
	const { state } = input;
	const latest = input.healthLatest ?? state.latestVersion;
	const lines = [
		`Installed version: ${input.installedVersion ?? 'unknown'}`,
		`Running version:   ${input.runningVersion ?? 'backend not running'}`,
		`Latest on npm:     ${latest ?? 'unknown'}`,
		`Auto-update:       ${describeMode(input.mode)}`,
	];
	if (state.mode && state.mode !== 'unknown' && state.mode !== input.mode) {
		lines.push(`  (backend last saw: ${describeMode(state.mode)} — settings changes apply at its next check)`);
	}
	lines.push(`Last check:        ${state.lastCheckAt ?? 'never'}`);
	const r = state.lastResult;
	lines.push(
		`Last result:       ${r ? `${r.outcome}${r.version ? ` ${r.version}` : ''} at ${r.at}${r.message ? ` — ${r.message}` : ''}` : 'none'}`,
	);
	if (state.consecutiveFailures > 0) lines.push(`Failures in a row: ${state.consecutiveFailures}`);
	if (state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()) lines.push(`Next attempt after: ${state.backoffUntil}`);
	lines.push(`Log:               ${input.logFile}`);
	return lines;
}

/**
 * Run `crewly update-status`.
 *
 * @param deps - I/O overrides (tests)
 * @returns Exit code
 */
export async function updateStatusCommand(deps: Partial<UpdateStatusDeps> = {}): Promise<number> {
	const input = await collectUpdateStatus({
		env: process.env,
		homeDir: os.homedir(),
		fetchImpl: fetch,
		getInstalledVersion: () => {
			try {
				return getLocalVersion();
			} catch {
				return null;
			}
		},
		getPackageRoot: () => resolvePackageRoot(),
		...deps,
	});
	console.log(chalk.bold('Crewly update status'));
	for (const line of formatUpdateStatus(input)) console.log(line);
	return 0;
}
