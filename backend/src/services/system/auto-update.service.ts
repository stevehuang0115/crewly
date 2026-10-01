/**
 * Auto-Update Service
 *
 * Keeps an npm-installed Crewly on the latest release with nobody at the
 * keyboard (specs/auto-update.md):
 *
 * 1. about 10 min after boot, then every 3 h, ask the npm registry for the
 *    latest `crewly`;
 * 2. when it is newer and auto-update is on, wait for a quiet window — no
 *    agent in_progress and no turn in flight, seen twice ~60 s apart;
 * 3. `npm install -g --prefix <the running copy's prefix> crewly@<version>`,
 *    run from CREWLY_HOME — never from the package root, which every global
 *    install deletes (npm dies with `uv_cwd` ENOENT, exit 7, in a deleted cwd);
 * 4. verify the installed package.json says `<version>`;
 * 5. write a marker and ask for the graceful restart (drain, exit 120, the
 *    `crewly start` parent respawns the backend from the new files);
 * 6. on the next boot, read the marker and DM the owner once.
 *
 * Failures (install error, verify mismatch, no restart path) back off 6 h
 * and never restart onto a broken install. Dev checkouts, non-npm installs
 * and backends without a respawning parent are skipped.
 *
 * All I/O goes through {@link AutoUpdateDeps} so the rules are unit-testable
 * with a mocked registry, npm and clock; {@link createAutoUpdateService}
 * wires the real ones.
 *
 * @module services/system/auto-update.service
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { AUTO_UPDATE_CONSTANTS, PROCESS_EXIT_CODES, CREWLY_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import {
	type AutoUpdateOutcome,
	type AutoUpdateState,
	type InstallInfo,
	type PendingUpgradeMarker,
	composeFailureNotice,
	composeUpgradedNotice,
	consumePendingMarker,
	describeInstallFailure,
	detectInstall,
	hasRestartSupervisor,
	installOutputTail,
	isNewerVersion,
	isSwitchOn,
	npmInstallArgs,
	readAutoUpdateState,
	readInstalledVersion,
	resolveAutoUpdateSwitch,
	resolveInstallCwd,
	sanitizeNpmOutput,
	resolveNpmCommand,
	resolveRunningPackageRoot,
	safeProcessCwd,
	writeAutoUpdateState,
	writePendingMarker,
} from './auto-update.utils.js';

/** Result of one `npm install` run. */
export interface InstallRunResult {
	/** True when npm exited 0 */
	ok: boolean;
	/** Exit code (null when killed) */
	code: number | null;
	/** Tail of the combined output, for the failure reason */
	outputTail: string;
}

/** Result of {@link AutoUpdateService.installVersion}. */
export type InstallAttempt =
	| { ok: true }
	| { ok: false; outcome: AutoUpdateOutcome; reason: string; details: Record<string, unknown> };

/** What is keeping the machine busy right now. */
export interface BusySnapshot {
	/** Sessions with a turn in flight (InFlightTurnTracker) */
	midTurn: string[];
	/** Active agents whose workingStatus is in_progress */
	inProgress: string[];
}

/** Minimal logger. */
export interface AutoUpdateLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

/** Everything the service touches outside itself. */
export interface AutoUpdateDeps {
	/** Crewly home (state, marker and log live here) */
	crewlyHome: string;
	/** Where/how the running copy is installed */
	install: InstallInfo;
	/** Version this process is running (read at boot, before any install) */
	currentVersion: string | null;
	/** `settings.general.autoUpdate` (undefined = default on) */
	getSettingEnabled: () => Promise<boolean | undefined>;
	/** Environment (for CREWLY_AUTO_UPDATE) */
	env: NodeJS.ProcessEnv;
	/** Whether a parent will respawn the backend after exit 120 */
	hasSupervisor: () => boolean;
	/** Latest version on npm (null on failure) */
	fetchLatestVersion: (currentVersion: string) => Promise<string | null>;
	/** True when a shutdown / restart is already under way */
	isRestartInProgress: () => boolean;
	/** Busy agents and turns */
	getBusy: () => Promise<BusySnapshot>;
	/** Run npm in `cwd`; resolves when it exits */
	runInstall: (command: string, args: string[], cwd: string) => Promise<InstallRunResult>;
	/** npm executable */
	npmCommand: string;
	/**
	 * Directory npm runs in. Must outlive the install: not the package root
	 * (and not this process's cwd, which is the package root).
	 */
	getInstallCwd: () => string;
	/** Read the installed version from disk */
	readInstalledVersion: (packageRoot: string) => string | null;
	/** Ask for the graceful restart; false when nothing can restart us */
	requestRestart: (reason: string) => boolean;
	/** Whether the owner channel (Slack) is up */
	isNotifyReady: () => boolean;
	/** Send one owner notification */
	notifyOwner: (title: string, message: string) => Promise<void>;
	/** This machine's display name */
	getDeviceName: () => Promise<string>;
	/** Called after a successful install, before the restart (e.g. re-anchor the cwd) */
	afterInstall: (packageRoot: string) => void;
	/** Append a line to auto-update.log */
	appendLog: (line: string) => void;
	/** Logger */
	logger: AutoUpdateLogger;
	/** Clock */
	now: () => number;
	/** Sleep */
	sleep: (ms: number) => Promise<void>;
	/** Schedule a callback (returns a handle for cancel) */
	schedule: (fn: () => void, ms: number) => unknown;
	/** Cancel a scheduled callback */
	cancel: (handle: unknown) => void;
}

/** Result of one {@link AutoUpdateService.runCycle}. */
export interface CycleResult {
	/** How it ended */
	outcome: AutoUpdateOutcome | 'backoff';
	/** Detail for logs/tests */
	detail?: string;
	/** Target version, when one was chosen */
	version?: string;
}

/**
 * Periodically upgrades the running npm install and restarts into it.
 */
export class AutoUpdateService {
	private static instance: AutoUpdateService | null = null;
	private timer: unknown = null;
	private running = false;
	private installing = false;
	private stopped = false;
	private lastLoggedMode: string | null = null;
	private busySince: number | null = null;
	private pendingNotice: PendingUpgradeMarker | null = null;
	private readonly statePath: string;
	private readonly markerPath: string;

	/**
	 * @param deps - Injected I/O
	 */
	constructor(private readonly deps: AutoUpdateDeps) {
		this.statePath = path.join(deps.crewlyHome, AUTO_UPDATE_CONSTANTS.STATE_FILE);
		this.markerPath = path.join(deps.crewlyHome, AUTO_UPDATE_CONSTANTS.MARKER_FILE);
	}

	/**
	 * Register the process-wide instance (index.ts).
	 *
	 * @param service - Instance, or null to clear
	 */
	static setInstance(service: AutoUpdateService | null): void {
		AutoUpdateService.instance = service;
	}

	/**
	 * The process-wide instance, when one was registered.
	 *
	 * @returns The instance or null
	 */
	static getInstance(): AutoUpdateService | null {
		return AutoUpdateService.instance;
	}

	/**
	 * Boot: consume the pending-upgrade marker (and report it), log the mode,
	 * and schedule the first check.
	 */
	start(): void {
		this.stopped = false;
		this.handleBootMarker();
		void this.describeMode().then((mode) => this.logModeOnce(mode));
		this.scheduleNext(AUTO_UPDATE_CONSTANTS.FIRST_CHECK_DELAY_MS);
	}

	/**
	 * Stop scheduling (shutdown).
	 */
	stop(): void {
		this.stopped = true;
		if (this.timer !== null) this.deps.cancel(this.timer);
		this.timer = null;
	}

	/**
	 * Whether this boot is the result of an auto-upgrade whose notice is still
	 * owed — the generic "back online" announcement is skipped then, so the
	 * owner gets one message per upgrade, not two.
	 *
	 * @returns True while the upgrade notice is pending or was just sent
	 */
	isUpgradeBoot(): boolean {
		return this.pendingNotice !== null;
	}

	/**
	 * Current persisted status.
	 *
	 * @returns The state
	 */
	getState(): AutoUpdateState {
		return readAutoUpdateState(this.statePath);
	}

	/**
	 * The on/off/skip mode as a short string (also what update-status shows).
	 *
	 * @returns e.g. `enabled`, `dev-checkout`, `disabled-env`
	 */
	async describeMode(): Promise<string> {
		const { install } = this.deps;
		if (install.kind === 'dev-checkout') return 'dev-checkout';
		if (install.kind === 'unmanaged') return 'unmanaged';
		let setting: boolean | undefined;
		try {
			setting = await this.deps.getSettingEnabled();
		} catch {
			setting = undefined;
		}
		const sw = resolveAutoUpdateSwitch(setting, this.deps.env);
		if (!isSwitchOn(sw)) return sw;
		if (!this.deps.hasSupervisor()) return 'no-supervisor';
		return sw;
	}

	/**
	 * One check → (maybe) install → verify → restart pass.
	 *
	 * @returns How it ended
	 */
	async runCycle(): Promise<CycleResult> {
		if (this.running) return { outcome: 'skipped', detail: 'cycle already running' };
		this.running = true;
		try {
			return await this.runCycleInner();
		} finally {
			this.running = false;
		}
	}

	/**
	 * Body of {@link runCycle}.
	 *
	 * @returns How it ended
	 */
	private async runCycleInner(): Promise<CycleResult> {
		const mode = await this.describeMode();
		this.logModeOnce(mode);
		this.updateState({ mode, currentVersion: this.deps.currentVersion });
		if (mode !== 'enabled' && mode !== 'enabled-env') {
			return { outcome: 'skipped', detail: mode };
		}
		if (this.deps.isRestartInProgress()) {
			return { outcome: 'skipped', detail: 'restart already in progress' };
		}
		const current = this.deps.currentVersion;
		const packageRoot = this.deps.install.packageRoot;
		const prefix = this.deps.install.prefix;
		if (!current || !packageRoot || !prefix) {
			return { outcome: 'skipped', detail: 'running version or prefix unknown' };
		}

		const state = this.getState();
		const now = this.deps.now();
		if (state.backoffUntil && Date.parse(state.backoffUntil) > now) {
			return { outcome: 'backoff', detail: `until ${state.backoffUntil}` };
		}

		const latest = await this.deps.fetchLatestVersion(current);
		this.updateState({ lastCheckAt: new Date(now).toISOString(), ...(latest ? { latestVersion: latest } : {}) });
		if (!latest) {
			this.log('Registry check failed; will retry at the next interval');
			return { outcome: 'check-failed' };
		}
		if (!isNewerVersion(latest, current)) {
			this.busySince = null;
			return { outcome: 'up-to-date', version: latest };
		}

		// Quiet window: idle now, and still idle a minute later.
		const quiet = await this.isQuiet();
		if (!quiet.ok) return this.deferBusy(latest, quiet.reason);
		await this.deps.sleep(AUTO_UPDATE_CONSTANTS.QUIET_CONFIRM_MS);
		const stillQuiet = await this.isQuiet();
		if (!stillQuiet.ok) return this.deferBusy(latest, stillQuiet.reason);
		if (this.deps.isRestartInProgress()) {
			return { outcome: 'skipped', detail: 'restart already in progress' };
		}
		this.busySince = null;

		// Install into the prefix the running copy lives in, then verify.
		const attempt = await this.installVersion(latest);
		if (!attempt.ok) {
			if (attempt.outcome === 'skipped') return { outcome: 'skipped', detail: attempt.reason };
			return this.recordFailure(attempt.outcome, latest, attempt.reason, attempt.details);
		}

		this.writeUpgradeMarker(current, latest);
		const restarting = this.deps.requestRestart(`auto-update ${current} -> ${latest}`);
		if (!restarting) {
			this.clearUpgradeMarker();
			return this.recordFailure('restart-unavailable', latest, 'no graceful restart handler is registered');
		}
		this.log(`Restarting into ${latest}`);
		this.updateState({ lastResult: { outcome: 'installed-restarting', at: new Date(this.deps.now()).toISOString(), version: latest } });
		return { outcome: 'installed-restarting', version: latest };
	}

	/**
	 * Install `crewly@<version>` into the prefix the running copy lives in
	 * and verify the installed package.json. This is the one install path:
	 * the timer cycle uses it, and so does the owner's "Upgrade" button
	 * (SystemControlService). It does not restart and does not touch the
	 * failure/backoff state — callers decide what a failure means.
	 *
	 * @param version - Exact target version
	 * @returns ok, or the failure kind, reason and log-only details
	 */
	async installVersion(version: string): Promise<InstallAttempt> {
		const current = this.deps.currentVersion;
		const packageRoot = this.deps.install.packageRoot;
		const prefix = this.deps.install.prefix;
		if (this.deps.install.kind !== 'npm-global' || !packageRoot || !prefix) {
			return { ok: false, outcome: 'skipped', reason: `not an npm global install (${this.deps.install.detail})`, details: {} };
		}
		if (this.installing) {
			return { ok: false, outcome: 'skipped', reason: 'another install is already running', details: {} };
		}
		this.installing = true;
		try {
			const args = npmInstallArgs(prefix, version);
			const cwd = this.deps.getInstallCwd();
			this.log(`Installing ${AUTO_UPDATE_CONSTANTS.PACKAGE_NAME}@${version} (running ${current ?? 'unknown'}): ${this.deps.npmCommand} ${args.join(' ')} (cwd ${cwd})`);
			let result: InstallRunResult;
			try {
				result = await this.deps.runInstall(this.deps.npmCommand, args, cwd);
			} catch (error) {
				result = { ok: false, code: null, outputTail: error instanceof Error ? error.message : String(error) };
			}
			if (!result.ok) {
				return {
					ok: false,
					outcome: 'install-failed',
					reason: describeInstallFailure(result.code, result.outputTail),
					details: {
						command: `${this.deps.npmCommand} ${args.join(' ')}`,
						cwd,
						exitCode: result.code,
						outputTail: installOutputTail(result.outputTail),
					},
				};
			}
			const installed = this.deps.readInstalledVersion(packageRoot);
			if (installed !== version) {
				return { ok: false, outcome: 'verify-failed', reason: `installed package.json says ${installed ?? 'nothing'}, expected ${version}`, details: {} };
			}
			this.log(`Installed and verified ${version} at ${packageRoot}`);
			try {
				this.deps.afterInstall(packageRoot);
			} catch {
				// Best-effort
			}
			return { ok: true };
		} finally {
			this.installing = false;
		}
	}

	/**
	 * Write the pending-upgrade marker the next boot reads (owner notice,
	 * version check, and the CLI's respawn fallback). Best-effort.
	 *
	 * @param fromVersion - Version running now
	 * @param toVersion - Version just installed
	 */
	writeUpgradeMarker(fromVersion: string, toVersion: string): void {
		const marker: PendingUpgradeMarker = { fromVersion, toVersion, at: new Date(this.deps.now()).toISOString() };
		try {
			writePendingMarker(this.markerPath, marker);
		} catch (error) {
			this.log(`Could not write the upgrade marker (the owner notice will be missing): ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Remove the pending-upgrade marker (the restart did not happen).
	 */
	clearUpgradeMarker(): void {
		try {
			fs.unlinkSync(this.markerPath);
		} catch {
			// Not written
		}
	}

	/**
	 * Whether a timer cycle or an install is running right now.
	 *
	 * @returns True while busy
	 */
	isBusy(): boolean {
		return this.running || this.installing;
	}

	/**
	 * Where and how the running copy is installed.
	 *
	 * @returns Install info
	 */
	getInstallInfo(): InstallInfo {
		return this.deps.install;
	}

	/**
	 * The version this process runs (read at boot).
	 *
	 * @returns The version, or null when unknown
	 */
	getCurrentVersion(): string | null {
		return this.deps.currentVersion;
	}

	/**
	 * Append a line to auto-update.log (manual upgrades log here too, so the
	 * install history stays in one file).
	 *
	 * @param line - Text
	 */
	appendLogLine(line: string): void {
		this.log(line);
	}

	/**
	 * Whether nothing is busy. A stale in_progress flag stops blocking after
	 * MAX_BUSY_DEFER_MS; a turn in flight always blocks.
	 *
	 * @returns ok, or the reason it is not
	 */
	private async isQuiet(): Promise<{ ok: boolean; reason: string }> {
		let busy: BusySnapshot;
		try {
			busy = await this.deps.getBusy();
		} catch (error) {
			return { ok: false, reason: `busy check failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (busy.midTurn.length > 0) return { ok: false, reason: `turns in flight: ${busy.midTurn.join(', ')}` };
		if (busy.inProgress.length > 0) {
			const deferredFor = this.busySince === null ? 0 : this.deps.now() - this.busySince;
			if (deferredFor < AUTO_UPDATE_CONSTANTS.MAX_BUSY_DEFER_MS) {
				return { ok: false, reason: `agents in_progress: ${busy.inProgress.join(', ')}` };
			}
			this.log(`Agents still marked in_progress after ${Math.round(deferredFor / 3_600_000)} h with no turn in flight; not waiting for them any longer: ${busy.inProgress.join(', ')}`);
		}
		return { ok: true, reason: '' };
	}

	/**
	 * Record a busy deferral.
	 *
	 * @param version - Target version
	 * @param reason - What is busy
	 * @returns Cycle result
	 */
	private deferBusy(version: string, reason: string): CycleResult {
		if (this.busySince === null) this.busySince = this.deps.now();
		this.log(`Update to ${version} deferred: ${reason}`);
		this.updateState({ lastResult: { outcome: 'deferred-busy', at: new Date(this.deps.now()).toISOString(), version, message: reason } });
		return { outcome: 'deferred-busy', version, detail: reason };
	}

	/**
	 * Record a failure, back off, and tell the owner once per target version
	 * after repeated failures.
	 *
	 * @param outcome - Failure kind
	 * @param version - Target version
	 * @param reason - Why
	 * @param details - Extra context for the backend log only (e.g. the sanitised npm output tail)
	 * @returns Cycle result
	 */
	private recordFailure(outcome: AutoUpdateOutcome, version: string, reason: string, details: Record<string, unknown> = {}): CycleResult {
		const state = this.getState();
		const failures = state.consecutiveFailures + 1;
		const now = this.deps.now();
		const backoffUntil = new Date(now + AUTO_UPDATE_CONSTANTS.FAILURE_BACKOFF_MS).toISOString();
		this.log(`Auto-update to ${version} failed (${outcome}, ${failures} in a row): ${reason}. Next attempt after ${backoffUntil}; not restarting.`);
		this.deps.logger.warn('Auto-update failed; backing off', { outcome, version, failures, reason, ...details });
		const notify = failures >= AUTO_UPDATE_CONSTANTS.FAILURE_NOTIFY_THRESHOLD && state.failureNotifiedVersion !== version;
		this.updateState({
			consecutiveFailures: failures,
			backoffUntil,
			lastResult: { outcome, at: new Date(now).toISOString(), version, message: reason },
			...(notify ? { failureNotifiedVersion: version } : {}),
		});
		if (notify) {
			void this.notify(async (device) => ({
				title: `Crewly auto-upgrade failed (machine: ${device})`,
				message: composeFailureNotice(version, device, failures, reason),
			}));
		}
		return { outcome, version, detail: reason };
	}

	/**
	 * Boot half of the upgrade: consume the marker; when this process runs the
	 * version it names, record success and DM the owner.
	 */
	private handleBootMarker(): void {
		let marker: PendingUpgradeMarker | null = null;
		try {
			marker = consumePendingMarker(this.markerPath);
		} catch {
			marker = null;
		}
		if (!marker) return;
		const age = this.deps.now() - Date.parse(marker.at);
		if (!(age >= 0 && age < AUTO_UPDATE_CONSTANTS.MARKER_MAX_AGE_MS)) {
			this.log(`Ignoring a stale upgrade marker (${marker.fromVersion} -> ${marker.toVersion}, written ${marker.at})`);
			return;
		}
		const running = this.deps.currentVersion;
		if (running !== marker.toVersion) {
			this.log(`Restarted after installing ${marker.toVersion} but running ${running ?? 'unknown'}`);
			this.recordFailure('verify-failed', marker.toVersion, `restarted onto ${running ?? 'an unknown version'} instead of ${marker.toVersion}`);
			return;
		}
		this.pendingNotice = marker;
		this.log(`Now running ${marker.toVersion} (upgraded from ${marker.fromVersion})`);
		this.updateState({
			consecutiveFailures: 0,
			backoffUntil: null,
			failureNotifiedVersion: null,
			currentVersion: running,
			lastResult: { outcome: 'upgraded', at: new Date(this.deps.now()).toISOString(), version: running, message: `from ${marker.fromVersion}` },
		});
		const { toVersion, fromVersion } = marker;
		void this.notify(async (device) => ({ title: composeUpgradedNotice(toVersion, device), message: `Previous version: ${fromVersion}` }));
	}

	/**
	 * Send an owner notice once the channel is up (waits up to NOTIFY_WAIT_MS).
	 *
	 * @param compose - Builds the notice from the device name
	 * @returns True when sent
	 */
	private async notify(compose: (deviceName: string) => Promise<{ title: string; message: string }>): Promise<boolean> {
		try {
			const deadline = this.deps.now() + AUTO_UPDATE_CONSTANTS.NOTIFY_WAIT_MS;
			while (!this.deps.isNotifyReady()) {
				if (this.stopped || this.deps.now() >= deadline) {
					this.log('Owner channel not connected; notice not sent');
					return false;
				}
				await this.deps.sleep(AUTO_UPDATE_CONSTANTS.NOTIFY_POLL_MS);
			}
			let device: string;
			try {
				device = await this.deps.getDeviceName();
			} catch {
				device = os.hostname();
			}
			const { title, message } = await compose(device);
			await this.deps.notifyOwner(title, message);
			this.log(`Owner notified: ${title}`);
			return true;
		} catch (error) {
			this.log(`Owner notice failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	/**
	 * Schedule the next cycle.
	 *
	 * @param ms - Delay
	 */
	private scheduleNext(ms: number): void {
		if (this.stopped) return;
		if (this.timer !== null) this.deps.cancel(this.timer);
		this.timer = this.deps.schedule(() => {
			this.timer = null;
			void this.tick();
		}, ms);
	}

	/**
	 * Timer body: run a cycle and pick the next delay from its outcome.
	 */
	private async tick(): Promise<void> {
		let result: CycleResult;
		try {
			result = await this.runCycle();
		} catch (error) {
			this.deps.logger.error('Auto-update cycle crashed', { error: error instanceof Error ? error.message : String(error) });
			result = { outcome: 'check-failed' };
		}
		if (result.outcome === 'installed-restarting') return;
		this.scheduleNext(
			result.outcome === 'deferred-busy' ? AUTO_UPDATE_CONSTANTS.BUSY_RETRY_MS : AUTO_UPDATE_CONSTANTS.CHECK_INTERVAL_MS,
		);
	}

	/**
	 * Log the mode when it changes (so "dev checkout — auto-update off" is
	 * said once, not every 3 hours).
	 *
	 * @param mode - Current mode
	 */
	private logModeOnce(mode: string): void {
		if (mode === this.lastLoggedMode) return;
		this.lastLoggedMode = mode;
		const line = describeModeLine(mode, this.deps.install);
		this.deps.logger.info(line, { mode });
		this.log(line);
	}

	/**
	 * Merge a patch into the status file (best-effort).
	 *
	 * @param patch - Fields to change
	 */
	private updateState(patch: Partial<AutoUpdateState>): void {
		try {
			writeAutoUpdateState(this.statePath, { ...this.getState(), ...patch });
		} catch (error) {
			this.deps.logger.warn('Could not write auto-update state', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Append a timestamped line to auto-update.log.
	 *
	 * @param line - Text
	 */
	private log(line: string): void {
		try {
			this.deps.appendLog(`${new Date(this.deps.now()).toISOString()} ${line}`);
		} catch {
			// Logging must never break the updater
		}
	}
}

/**
 * Human-readable line for a mode.
 *
 * @param mode - Mode from {@link AutoUpdateService.describeMode}
 * @param install - Install info
 * @returns Log line
 */
export function describeModeLine(mode: string, install: InstallInfo): string {
	switch (mode) {
		case 'dev-checkout':
			return `dev checkout — auto-update off (${install.packageRoot})`;
		case 'unmanaged':
			return `not an npm global install — auto-update off (${install.detail})`;
		case 'disabled-setting':
			return 'auto-update off (Settings → General)';
		case 'disabled-env':
			return `auto-update off (${AUTO_UPDATE_CONSTANTS.ENV_VAR})`;
		case 'no-supervisor':
			return 'auto-update off: no crewly start parent to bring the backend back after a restart';
		default:
			return `auto-update on (${install.detail})`;
	}
}

/**
 * Run npm, appending its (sanitised) output to the log, killing it after
 * the timeout.
 *
 * @param command - npm executable
 * @param args - Arguments
 * @param appendLog - Log sink
 * @param timeoutMs - Kill after this long
 * @param cwd - Directory to run in (never the package being replaced)
 * @returns Exit status and output tail
 */
export function runNpmInstall(
	command: string,
	args: string[],
	appendLog: (line: string) => void,
	timeoutMs: number = AUTO_UPDATE_CONSTANTS.INSTALL_TIMEOUT_MS,
	cwd?: string,
): Promise<InstallRunResult> {
	return new Promise((resolve) => {
		let output = '';
		const child = spawn(command, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			// npm is npm.cmd on Windows; elsewhere no shell so paths with spaces stay one argument.
			shell: process.platform === 'win32',
			env: process.env,
			...(cwd ? { cwd } : {}),
		});
		const onData = (chunk: Buffer): void => {
			const text = chunk.toString();
			output = (output + text).slice(-8_000);
			for (const line of sanitizeNpmOutput(text).split('\n')) if (line.trim()) appendLog(`  npm: ${line.trimEnd()}`);
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		const timer = setTimeout(() => {
			appendLog(`  npm: timed out after ${timeoutMs} ms; killing`);
			child.kill('SIGKILL');
		}, timeoutMs);
		child.on('error', (error) => {
			clearTimeout(timer);
			resolve({ ok: false, code: null, outputTail: error.message });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0, code, outputTail: output });
		});
	});
}

/** Live hooks the server provides to {@link createAutoUpdateService}. */
export interface AutoUpdateWiring {
	/** Crewly home */
	crewlyHome: string;
	/** `settings.general.autoUpdate` */
	getSettingEnabled: () => Promise<boolean | undefined>;
	/** Latest version on npm */
	fetchLatestVersion: (currentVersion: string) => Promise<string | null>;
	/** Restart already under way */
	isRestartInProgress: () => boolean;
	/** Busy snapshot */
	getBusy: () => Promise<BusySnapshot>;
	/** Graceful restart with RESTART_REQUESTED */
	requestRestart: (reason: string, exitCode: number) => boolean;
	/** Owner channel up */
	isNotifyReady: () => boolean;
	/** Owner notification */
	notifyOwner: (title: string, message: string) => Promise<void>;
	/** Device name */
	getDeviceName: () => Promise<string>;
}

/**
 * Build the service with the real filesystem, npm, clock and timers.
 *
 * @param wiring - Server hooks
 * @returns The service (not started)
 */
export function createAutoUpdateService(wiring: AutoUpdateWiring): AutoUpdateService {
	const packageRoot = resolveRunningPackageRoot(process.argv[1], safeProcessCwd());
	const install = detectInstall(packageRoot);
	const logDir = path.join(wiring.crewlyHome, CREWLY_CONSTANTS.PATHS.LOGS_DIR);
	const logFile = path.join(logDir, AUTO_UPDATE_CONSTANTS.LOG_FILE);
	const appendLog = (line: string): void => {
		fs.mkdirSync(logDir, { recursive: true });
		fs.appendFileSync(logFile, `${line}\n`, 'utf-8');
	};
	const logger = LoggerService.getInstance().createComponentLogger('AutoUpdate');
	return new AutoUpdateService({
		crewlyHome: wiring.crewlyHome,
		install,
		currentVersion: packageRoot ? readInstalledVersion(packageRoot) : null,
		getSettingEnabled: wiring.getSettingEnabled,
		env: process.env,
		hasSupervisor: () => hasRestartSupervisor(process.env),
		fetchLatestVersion: wiring.fetchLatestVersion,
		isRestartInProgress: wiring.isRestartInProgress,
		getBusy: wiring.getBusy,
		runInstall: (command, args, cwd) => runNpmInstall(command, args, appendLog, AUTO_UPDATE_CONSTANTS.INSTALL_TIMEOUT_MS, cwd),
		npmCommand: resolveNpmCommand(),
		// Not the inherited cwd: that is the package root npm is about to replace
		// (after one upgrade it is already a deleted directory).
		getInstallCwd: () => resolveInstallCwd([wiring.crewlyHome, os.homedir(), os.tmpdir()]),
		readInstalledVersion,
		requestRestart: (reason) => wiring.requestRestart(reason, PROCESS_EXIT_CODES.RESTART_REQUESTED),
		isNotifyReady: wiring.isNotifyReady,
		notifyOwner: wiring.notifyOwner,
		getDeviceName: wiring.getDeviceName,
		// npm replaced the package directory (new inode): the old cwd is gone,
		// and anything calling process.cwd() during shutdown would throw ENOENT.
		afterInstall: (root) => process.chdir(root),
		appendLog,
		logger,
		now: Date.now,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		schedule: (fn, ms) => {
			const t = setTimeout(fn, ms);
			t.unref?.();
			return t;
		},
		cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	});
}
