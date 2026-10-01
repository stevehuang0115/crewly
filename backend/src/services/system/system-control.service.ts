/**
 * System Control Service — the owner's Upgrade and Restart buttons.
 *
 * Jenkins-style "safe restart" for Crewly
 * (specs/2026-10-01-upgrade-restart-controls.md):
 *
 * - **Status.** Running version, latest on npm, install kind, who relaunches
 *   the backend, agents mid-turn, and the current / last action.
 * - **Upgrade** (`when: idle | now`). npm global installs only. It reuses the
 *   AutoUpdateService install path (same prefix, same npm, same verify), then
 *   restarts. A source checkout is refused: it is updated with git.
 * - **Restart** (`when: idle | now`). The graceful drained shutdown, exiting
 *   with RESTART_REQUESTED. When nothing is known to relaunch the backend, a
 *   detached launcher is started first so the machine never stays down.
 * - **When idle** waits until no agent is mid-turn, capped (30 min), then
 *   goes ahead. Asking again with `now` cuts the wait short.
 * - **One at a time.** A second request while one is running is refused,
 *   as is any request while a shutdown is already under way.
 * - **Survives the restart.** Progress and outcome are kept in
 *   `<crewlyHome>/system-action.json`; the next boot settles the record
 *   ("Restarted at …", "Upgraded to x.y.z", or what went wrong), so the
 *   dashboard can show it after it reconnects.
 *
 * All I/O goes through {@link SystemControlDeps}.
 *
 * @module services/system/system-control.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PROCESS_EXIT_CODES, SYSTEM_CONTROL_CONSTANTS } from '../../constants.js';
import type { InstallAttempt } from './auto-update.service.js';
import type { InstallInfo } from './auto-update.utils.js';
import { isNewerVersion } from './auto-update.utils.js';
import type { SupervisorInfo } from './supervisor-detect.js';

/** `when` choice of the buttons. */
export type SystemActionWhen = (typeof SYSTEM_CONTROL_CONSTANTS.WHEN_VALUES)[number];

/** Which button was pressed. */
export type SystemActionKind = 'upgrade' | 'restart';

/** Where an action is. */
export type SystemActionStatus =
	| 'waiting-idle'
	| 'installing'
	| 'restarting'
	| 'completed'
	| 'failed'
	| 'interrupted';

/** Install kind as the dashboard sees it. */
export type PublicInstallKind = 'npm-global' | 'dev-checkout' | 'other';

/** How the backend comes back after it exits. */
export type RelaunchMethod = 'supervisor' | 'replacement';

/** One upgrade or restart, persisted across the restart. */
export interface SystemActionRecord {
	id: string;
	kind: SystemActionKind;
	when: SystemActionWhen;
	status: SystemActionStatus;
	/** Who pressed it (e.g. `dashboard from 192.168.1.20`) */
	requestedBy: string;
	requestedAt: string;
	updatedAt: string;
	/** Version running when requested */
	fromVersion: string | null;
	/** Upgrade target */
	toVersion: string | null;
	/** Process that accepted the request */
	pid: number;
	/** How the backend is brought back */
	relaunch: RelaunchMethod | null;
	/** Owner-readable progress / outcome */
	message: string;
	/** Agents mid-turn the last time the idle wait looked */
	waitingFor?: string[];
	/** When the idle wait ended and why */
	idleWaitEndedBy?: 'idle' | 'cap' | 'now';
	/** Settled at (completed / failed / interrupted) */
	completedAt?: string;
	/** Version running when settled */
	resultVersion?: string | null;
}

/** An agent mid-turn. */
export interface BusyAgentInfo {
	session: string;
	since?: string;
	messagePreview?: string;
}

/** `GET /api/system/update-status` body. */
export interface UpdateStatus {
	currentVersion: string | null;
	latestVersion: string | null;
	updateAvailable: boolean;
	installKind: PublicInstallKind;
	packageRoot: string | null;
	/** Upgrade possible right now */
	canUpgrade: boolean;
	/** Why the Upgrade button is disabled (null when enabled) */
	upgradeBlockedReason: string | null;
	/** Restart possible right now */
	canRestart: boolean;
	/** Why the Restart button is disabled (null when enabled) */
	restartBlockedReason: string | null;
	supervisor: SupervisorInfo;
	relaunch: RelaunchMethod;
	/** Agents mid-turn now */
	busyAgents: BusyAgentInfo[];
	/** Some upgrade / restart / shutdown is under way */
	inProgress: boolean;
	/** Current or last action */
	action: SystemActionRecord | null;
	/** Changes on every boot; the dashboard uses it to see the backend came back */
	bootId: string;
	startedAt: string;
}

/** Refusal from a request. */
export interface SystemActionRefusal {
	ok: false;
	httpStatus: number;
	code: string;
	error: string;
}

/** Accepted request. */
export interface SystemActionAccepted {
	ok: true;
	action: SystemActionRecord;
	/** True when an "idle" wait was cut short by a later "now" */
	escalated?: boolean;
}

/** The install half the service borrows from AutoUpdateService. */
export interface UpgradeInstaller {
	installVersion(version: string): Promise<InstallAttempt>;
	writeUpgradeMarker(fromVersion: string, toVersion: string): void;
	clearUpgradeMarker(): void;
	isBusy(): boolean;
	appendLogLine(line: string): void;
}

/** Minimal logger. */
export interface SystemControlLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

/** Everything the service touches outside itself. */
export interface SystemControlDeps {
	crewlyHome: string;
	install: InstallInfo;
	currentVersion: string | null;
	pid: number;
	bootId: string;
	startedAt: string;
	/** Who relaunches the backend (evaluated when needed) */
	getSupervisor: () => SupervisorInfo;
	/** Latest version on npm, accepting a cached answer younger than maxAgeMs */
	fetchLatestVersion: (maxAgeMs: number) => Promise<string | null>;
	/** Agents mid-turn */
	getBusyAgents: () => BusyAgentInfo[];
	/** A shutdown / drain is already under way */
	isShutdownInProgress: () => boolean;
	/** The AutoUpdateService install path (null when it did not start) */
	getInstaller: () => UpgradeInstaller | null;
	/** Run the graceful drained shutdown with RESTART_REQUESTED; false when no handler */
	requestGracefulRestart: (reason: string) => boolean;
	/** Last resort when no graceful handler exists */
	exit: (code: number) => void;
	/** Start the detached launcher that brings the backend back */
	spawnReplacement: (supervisorUnknown: boolean) => void;
	logger: SystemControlLogger;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

/** Options for the two requests. */
export interface SystemActionRequest {
	when: SystemActionWhen;
	actor: string;
}

/** Statuses that mean "still running". */
const ACTIVE_STATUSES: ReadonlySet<SystemActionStatus> = new Set(['waiting-idle', 'installing', 'restarting']);

/**
 * Map the AutoUpdate install kind onto the public one.
 *
 * @param install - Install info
 * @returns Public kind
 */
export function toPublicInstallKind(install: InstallInfo): PublicInstallKind {
	if (install.kind === 'npm-global') return 'npm-global';
	if (install.kind === 'dev-checkout') return 'dev-checkout';
	return 'other';
}

/**
 * Read the persisted action record.
 *
 * @param file - State file
 * @returns The record, or null when missing / malformed
 */
export function readActionRecord(file: string): SystemActionRecord | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as SystemActionRecord;
		return parsed && typeof parsed.id === 'string' && typeof parsed.status === 'string' ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Write the action record atomically.
 *
 * @param file - State file
 * @param record - Record
 */
export function writeActionRecord(file: string, record: SystemActionRecord): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
	fs.renameSync(tmp, file);
}

/**
 * Upgrade / restart controller for the running backend.
 */
export class SystemControlService {
	private static instance: SystemControlService | null = null;
	private action: SystemActionRecord | null = null;
	private readonly stateFile: string;
	/** Resolves the current idle wait early ("now" pressed while waiting) */
	private cutIdleWaitShort: (() => void) | null = null;

	/**
	 * @param deps - Injected I/O
	 */
	constructor(private readonly deps: SystemControlDeps) {
		this.stateFile = path.join(deps.crewlyHome, SYSTEM_CONTROL_CONSTANTS.STATE_FILE);
	}

	/**
	 * Register the process-wide instance.
	 *
	 * @param service - Instance, or null to clear
	 */
	static setInstance(service: SystemControlService | null): void {
		SystemControlService.instance = service;
	}

	/**
	 * The process-wide instance, when the server registered one.
	 *
	 * @returns The instance or null
	 */
	static getInstance(): SystemControlService | null {
		return SystemControlService.instance;
	}

	/**
	 * Boot: settle the record a previous process left behind, so the
	 * dashboard can say "Restarted at …" / "Upgraded to x.y.z" after it
	 * reconnects.
	 */
	handleBoot(): void {
		const record = readActionRecord(this.stateFile);
		if (!record || !ACTIVE_STATUSES.has(record.status) || record.pid === this.deps.pid) return;
		const now = new Date(this.deps.now()).toISOString();
		const running = this.deps.currentVersion;
		let settled: SystemActionRecord;
		if (record.status === 'restarting') {
			if (record.kind === 'upgrade' && record.toVersion && running !== record.toVersion) {
				settled = {
					...record,
					status: 'failed',
					message: `Crewly came back on ${running ?? 'an unknown version'} instead of ${record.toVersion}.`,
				};
			} else {
				settled = {
					...record,
					status: 'completed',
					message: record.kind === 'upgrade' ? `Upgraded to ${running} and restarted at ${now}.` : `Restarted at ${now}.`,
				};
			}
		} else {
			settled = {
				...record,
				status: 'interrupted',
				message:
					record.kind === 'upgrade'
						? 'Crewly stopped before the upgrade finished. Nothing was installed or the install was not confirmed; try again.'
						: 'Crewly stopped before the restart started.',
			};
		}
		settled = { ...settled, completedAt: now, updatedAt: now, resultVersion: running };
		this.action = settled;
		this.persist();
		this.deps.logger.info('Previous upgrade/restart settled at boot', {
			id: settled.id,
			kind: settled.kind,
			status: settled.status,
			requestedBy: settled.requestedBy,
			message: settled.message,
		});
	}

	/**
	 * Whether an upgrade or restart from this process is still running.
	 *
	 * @returns True while one is
	 */
	isActionInProgress(): boolean {
		return !!this.action && ACTIVE_STATUSES.has(this.action.status) && this.action.pid === this.deps.pid;
	}

	/**
	 * The current or last action (this boot, or the one settled at boot).
	 *
	 * @returns The record or null
	 */
	getAction(): SystemActionRecord | null {
		if (this.action) return this.action;
		return readActionRecord(this.stateFile);
	}

	/**
	 * How the backend comes back after an exit.
	 *
	 * @param supervisor - Supervisor info
	 * @returns supervisor or replacement
	 */
	private relaunchMethod(supervisor: SupervisorInfo): RelaunchMethod {
		return supervisor.willRelaunch === 'yes' ? 'supervisor' : 'replacement';
	}

	/**
	 * Status for the dashboard.
	 *
	 * @param options - `refresh` re-asks the registry when the cached answer is over a minute old
	 * @returns Status
	 */
	async getStatus(options: { refresh?: boolean } = {}): Promise<UpdateStatus> {
		const { install, currentVersion } = this.deps;
		let latest: string | null = null;
		try {
			latest = await this.deps.fetchLatestVersion(
				options.refresh ? SYSTEM_CONTROL_CONSTANTS.REGISTRY_MAX_AGE_MS : SYSTEM_CONTROL_CONSTANTS.STATUS_REGISTRY_MAX_AGE_MS,
			);
		} catch {
			latest = null;
		}
		const updateAvailable = !!latest && !!currentVersion && isNewerVersion(latest, currentVersion);
		const installKind = toPublicInstallKind(install);
		const busy = this.inProgressReason();
		const supervisor = this.deps.getSupervisor();

		let upgradeBlockedReason: string | null = null;
		if (installKind === 'dev-checkout') upgradeBlockedReason = SYSTEM_CONTROL_CONSTANTS.MESSAGES.DEV_CHECKOUT;
		else if (installKind === 'other') upgradeBlockedReason = SYSTEM_CONTROL_CONSTANTS.MESSAGES.NOT_NPM_GLOBAL;
		else if (busy) upgradeBlockedReason = busy;
		else if (!latest) upgradeBlockedReason = SYSTEM_CONTROL_CONSTANTS.MESSAGES.REGISTRY_UNREACHABLE;
		else if (!updateAvailable) upgradeBlockedReason = `Crewly is up to date (${currentVersion}).`;
		else if (!this.deps.getInstaller()) upgradeBlockedReason = SYSTEM_CONTROL_CONSTANTS.MESSAGES.UNAVAILABLE;

		return {
			currentVersion,
			latestVersion: latest,
			updateAvailable,
			installKind,
			packageRoot: install.packageRoot,
			canUpgrade: upgradeBlockedReason === null,
			upgradeBlockedReason,
			canRestart: busy === null,
			restartBlockedReason: busy,
			supervisor,
			relaunch: this.relaunchMethod(supervisor),
			busyAgents: this.safeBusyAgents(),
			inProgress: busy !== null,
			action: this.getAction(),
			bootId: this.deps.bootId,
			startedAt: this.deps.startedAt,
		};
	}

	/**
	 * Why nothing new can start right now (null when it can).
	 *
	 * @returns Owner-readable reason or null
	 */
	private inProgressReason(): string | null {
		if (this.isActionInProgress() && this.action) {
			return this.action.kind === 'upgrade'
				? `An upgrade to ${this.action.toVersion} is already in progress.`
				: 'A restart is already in progress.';
		}
		if (this.deps.isShutdownInProgress()) return SYSTEM_CONTROL_CONSTANTS.MESSAGES.RESTART_IN_PROGRESS;
		if (this.deps.getInstaller()?.isBusy()) return 'An automatic update is running right now. Try again in a few minutes.';
		return null;
	}

	/**
	 * Busy agents, never throwing.
	 *
	 * @returns Agents mid-turn
	 */
	private safeBusyAgents(): BusyAgentInfo[] {
		try {
			return this.deps.getBusyAgents();
		} catch {
			return [];
		}
	}

	/**
	 * Escalate a running "when idle" wait of the same kind to "now".
	 *
	 * @param kind - Requested kind
	 * @param request - Request
	 * @returns Accepted answer, or null when this is not an escalation
	 */
	private tryEscalate(kind: SystemActionKind, request: SystemActionRequest): SystemActionAccepted | null {
		const action = this.action;
		if (
			request.when !== 'now' ||
			!action ||
			!this.isActionInProgress() ||
			action.kind !== kind ||
			action.status !== 'waiting-idle' ||
			!this.cutIdleWaitShort
		) {
			return null;
		}
		this.deps.logger.info(`${kind === 'upgrade' ? 'Upgrade' : 'Restart'}: "now" requested while waiting for idle`, {
			id: action.id,
			requestedBy: request.actor,
		});
		this.update({ when: 'now', message: `${request.actor} asked to go ahead now.` });
		this.cutIdleWaitShort();
		return { ok: true, action: this.action as SystemActionRecord, escalated: true };
	}

	/**
	 * Refusal for "something is already running", or null.
	 *
	 * @returns Refusal or null
	 */
	private busyRefusal(): SystemActionRefusal | null {
		if (this.isActionInProgress()) {
			return { ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.IN_PROGRESS, error: this.inProgressReason() as string };
		}
		const reason = this.inProgressReason();
		if (reason) {
			return { ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.RESTART_IN_PROGRESS, error: reason };
		}
		return null;
	}

	/**
	 * Owner pressed "Upgrade".
	 *
	 * @param request - When, and who
	 * @returns Accepted (work continues in the background) or a refusal
	 */
	async requestUpgrade(request: SystemActionRequest): Promise<SystemActionAccepted | SystemActionRefusal> {
		const { install, currentVersion } = this.deps;
		if (install.kind === 'dev-checkout') {
			this.deps.logger.info('Upgrade refused: source checkout', { requestedBy: request.actor, packageRoot: install.packageRoot });
			return { ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.DEV_CHECKOUT, error: SYSTEM_CONTROL_CONSTANTS.MESSAGES.DEV_CHECKOUT };
		}
		if (install.kind !== 'npm-global') {
			this.deps.logger.info('Upgrade refused: not an npm global install', { requestedBy: request.actor, detail: install.detail });
			return { ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.NOT_NPM_GLOBAL, error: SYSTEM_CONTROL_CONSTANTS.MESSAGES.NOT_NPM_GLOBAL };
		}
		const escalated = this.tryEscalate('upgrade', request);
		if (escalated) return escalated;
		const busy = this.busyRefusal();
		if (busy) return busy;
		const installer = this.deps.getInstaller();
		if (!installer) {
			return { ok: false, httpStatus: 503, code: SYSTEM_CONTROL_CONSTANTS.CODES.UNAVAILABLE, error: SYSTEM_CONTROL_CONSTANTS.MESSAGES.UNAVAILABLE };
		}
		let latest: string | null = null;
		try {
			latest = await this.deps.fetchLatestVersion(SYSTEM_CONTROL_CONSTANTS.REGISTRY_MAX_AGE_MS);
		} catch {
			latest = null;
		}
		if (!latest) {
			return { ok: false, httpStatus: 502, code: SYSTEM_CONTROL_CONSTANTS.CODES.REGISTRY_UNREACHABLE, error: SYSTEM_CONTROL_CONSTANTS.MESSAGES.REGISTRY_UNREACHABLE };
		}
		if (!currentVersion || !isNewerVersion(latest, currentVersion)) {
			return { ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.UP_TO_DATE, error: `Crewly is already up to date (${currentVersion ?? latest}).` };
		}
		// The registry await gave another request a chance to start.
		const raced = this.busyRefusal();
		if (raced) return raced;

		const action = this.begin('upgrade', request, latest);
		installer.appendLogLine(`${new Date(this.deps.now()).toISOString()} Manual upgrade to ${latest} requested by ${request.actor} (${request.when})`);
		void this.runUpgrade(installer, latest).catch((error) => this.fail(`Upgrade crashed: ${errorText(error)}`));
		return { ok: true, action };
	}

	/**
	 * Owner pressed "Restart".
	 *
	 * @param request - When, and who
	 * @returns Accepted (work continues in the background) or a refusal
	 */
	async requestRestart(request: SystemActionRequest): Promise<SystemActionAccepted | SystemActionRefusal> {
		const escalated = this.tryEscalate('restart', request);
		if (escalated) return escalated;
		const busy = this.busyRefusal();
		if (busy) return busy;
		const action = this.begin('restart', request, null);
		void this.runRestart().catch((error) => this.fail(`Restart crashed: ${errorText(error)}`));
		return { ok: true, action };
	}

	/**
	 * Create and persist a new action.
	 *
	 * @param kind - upgrade or restart
	 * @param request - Request
	 * @param toVersion - Upgrade target
	 * @returns The record
	 */
	private begin(kind: SystemActionKind, request: SystemActionRequest, toVersion: string | null): SystemActionRecord {
		const now = new Date(this.deps.now()).toISOString();
		const supervisor = this.deps.getSupervisor();
		const label = kind === 'upgrade' ? `Upgrade to ${toVersion}` : 'Restart';
		this.action = {
			id: randomUUID(),
			kind,
			when: request.when,
			status: request.when === 'idle' ? 'waiting-idle' : kind === 'upgrade' ? 'installing' : 'restarting',
			requestedBy: request.actor,
			requestedAt: now,
			updatedAt: now,
			fromVersion: this.deps.currentVersion,
			toVersion,
			pid: this.deps.pid,
			relaunch: this.relaunchMethod(supervisor),
			message: request.when === 'idle' ? `${label} will start when no agent is mid-turn.` : `${label} is starting.`,
		};
		this.persist();
		this.deps.logger.info(`${label} requested`, {
			id: this.action.id,
			when: request.when,
			requestedBy: request.actor,
			fromVersion: this.deps.currentVersion,
			supervisor: supervisor.kind,
			willRelaunch: supervisor.willRelaunch,
		});
		return this.action;
	}

	/**
	 * Upgrade body: (wait for idle) → install → verify → marker → restart.
	 *
	 * @param installer - AutoUpdate install path
	 * @param version - Target
	 */
	private async runUpgrade(installer: UpgradeInstaller, version: string): Promise<void> {
		if (this.action?.when === 'idle') await this.waitForIdle();
		if (this.deps.isShutdownInProgress()) {
			this.fail('Crewly started shutting down for another reason before the upgrade began.');
			return;
		}
		this.update({ status: 'installing', message: `Installing ${version}…` });
		const attempt = await installer.installVersion(version);
		if (!attempt.ok) {
			this.deps.logger.warn('Manual upgrade install failed; not restarting', { version, outcome: attempt.outcome, reason: attempt.reason, ...attempt.details });
			this.fail(`Could not install ${version}: ${attempt.reason}. Crewly keeps running ${this.deps.currentVersion}.`);
			return;
		}
		installer.writeUpgradeMarker(this.deps.currentVersion ?? 'unknown', version);
		const restarted = this.restartNow(`owner upgrade ${this.deps.currentVersion} -> ${version}`, `Installed ${version}. Restarting…`);
		if (!restarted) installer.clearUpgradeMarker();
	}

	/**
	 * Restart body: (wait for idle) → restart.
	 */
	private async runRestart(): Promise<void> {
		if (this.action?.when === 'idle') await this.waitForIdle();
		if (this.deps.isShutdownInProgress()) {
			this.fail('Crewly started shutting down for another reason before the restart began.');
			return;
		}
		await this.deps.sleep(SYSTEM_CONTROL_CONSTANTS.RESPONSE_FLUSH_MS);
		this.restartNow('owner restart', 'Restarting… agents finish their current turn first.');
	}

	/**
	 * Make sure something brings the backend back, then run the graceful
	 * restart.
	 *
	 * @param reason - Shutdown reason (logs)
	 * @param message - Owner-readable progress
	 * @returns False when the restart could not be started
	 */
	private restartNow(reason: string, message: string): boolean {
		const supervisor = this.deps.getSupervisor();
		const relaunch = this.relaunchMethod(supervisor);
		if (relaunch === 'replacement') {
			try {
				this.deps.spawnReplacement(supervisor.willRelaunch === 'unknown');
				this.deps.logger.info('Started the replacement launcher; it brings Crewly back after this process exits', {
					supervisor: supervisor.kind,
				});
			} catch (error) {
				this.fail(`Could not arrange for Crewly to come back (${errorText(error)}), so it was not restarted.`);
				return false;
			}
		}
		this.update({ status: 'restarting', relaunch, message });
		this.deps.logger.info('Restarting Crewly', { reason, relaunch, requestedBy: this.action?.requestedBy });
		let started = false;
		try {
			started = this.deps.requestGracefulRestart(reason);
		} catch (error) {
			this.deps.logger.warn('Graceful restart unavailable; exiting directly', { error: errorText(error) });
		}
		if (!started) {
			this.deps.logger.warn('No graceful shutdown handler; exiting with the restart code');
			this.deps.exit(PROCESS_EXIT_CODES.RESTART_REQUESTED);
		}
		return true;
	}

	/**
	 * Wait until no agent is mid-turn, at most IDLE_WAIT_CAP_MS; a later "now"
	 * request ends the wait at once.
	 */
	private async waitForIdle(): Promise<void> {
		const deadline = this.deps.now() + SYSTEM_CONTROL_CONSTANTS.IDLE_WAIT_CAP_MS;
		let cut = false;
		const cutPromise = new Promise<void>((resolve) => {
			this.cutIdleWaitShort = () => {
				cut = true;
				resolve();
			};
		});
		let lastBusy = '';
		try {
			for (;;) {
				if (cut) {
					this.update({ idleWaitEndedBy: 'now' });
					return;
				}
				const busy = this.safeBusyAgents().map((a) => a.session);
				if (busy.length === 0) {
					this.update({ idleWaitEndedBy: 'idle', waitingFor: [] });
					this.deps.logger.info('No agent is mid-turn; going ahead', { id: this.action?.id });
					return;
				}
				if (this.deps.now() >= deadline) {
					this.update({ idleWaitEndedBy: 'cap', waitingFor: busy });
					this.deps.logger.info('Waited the maximum for agents to go idle; going ahead (the restart drain still lets turns finish)', {
						id: this.action?.id,
						busy,
					});
					return;
				}
				const key = busy.join(',');
				if (key !== lastBusy) {
					lastBusy = key;
					this.update({ waitingFor: busy, message: `Waiting for ${busy.length} agent${busy.length === 1 ? '' : 's'} to finish: ${busy.join(', ')}.` });
				}
				await Promise.race([this.deps.sleep(SYSTEM_CONTROL_CONSTANTS.IDLE_POLL_MS), cutPromise]);
			}
		} finally {
			this.cutIdleWaitShort = null;
		}
	}

	/**
	 * Mark the current action failed.
	 *
	 * @param message - Owner-readable reason
	 */
	private fail(message: string): void {
		if (!this.action) return;
		const now = new Date(this.deps.now()).toISOString();
		this.update({ status: 'failed', message, completedAt: now, resultVersion: this.deps.currentVersion });
		this.deps.logger.warn('Upgrade/restart failed', { id: this.action.id, kind: this.action.kind, message, requestedBy: this.action.requestedBy });
	}

	/**
	 * Merge a patch into the current action and persist it.
	 *
	 * @param patch - Fields to change
	 */
	private update(patch: Partial<SystemActionRecord>): void {
		if (!this.action) return;
		this.action = { ...this.action, ...patch, updatedAt: new Date(this.deps.now()).toISOString() };
		this.persist();
	}

	/**
	 * Write the current action (best-effort).
	 */
	private persist(): void {
		if (!this.action) return;
		try {
			writeActionRecord(this.stateFile, this.action);
		} catch (error) {
			this.deps.logger.warn('Could not save upgrade/restart progress', { error: errorText(error) });
		}
	}
}

/**
 * Error text.
 *
 * @param error - Anything thrown
 * @returns Message
 */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
