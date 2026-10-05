/**
 * Types for the Upgrade / Restart controls. Mirrors the backend's
 * `services/system/system-control.service.ts` response shapes.
 *
 * @module types/system-control.types
 */

/** `when` choice. */
export type SystemActionWhen = 'idle' | 'now';

/** Which button. */
export type SystemActionKind = 'upgrade' | 'restart' | 'shutdown';

/** Where an action is. */
export type SystemActionStatus =
	| 'waiting-idle'
	| 'winding-down'
	| 'installing'
	| 'restarting'
	| 'stopping'
	| 'completed'
	| 'failed'
	| 'interrupted';

/** Progress of the "agents, please wrap up" step before a shutdown / restart. */
export interface WindDownProgress {
	kind: 'restart' | 'shutdown';
	phase: 'notifying' | 'waiting' | 'done';
	startedAt: string;
	/** ISO time the grace period ends */
	deadlineAt: string;
	graceSeconds: number;
	/** Running agents when it started */
	total: number;
	/** Agents told so far */
	notified: string[];
	/** Agents still mid-turn */
	busy: string[];
	endedBy?: 'idle' | 'grace' | 'skipped' | 'no-agents';
}

/** One upgrade or restart. */
export interface SystemActionRecord {
	id: string;
	kind: SystemActionKind;
	when: SystemActionWhen;
	status: SystemActionStatus;
	requestedBy: string;
	requestedAt: string;
	updatedAt: string;
	fromVersion: string | null;
	toVersion: string | null;
	pid: number;
	relaunch: 'supervisor' | 'replacement' | null;
	message: string;
	waitingFor?: string[];
	idleWaitEndedBy?: 'idle' | 'cap' | 'now';
	completedAt?: string;
	resultVersion?: string | null;
}

/** Who relaunches the backend. */
export interface SupervisorInfo {
	kind: 'crewly-start' | 'pm2' | 'systemd' | 'launchd' | 'none' | 'unknown';
	outer: 'systemd' | 'login-wrapper' | 'launchd' | null;
	willRelaunch: 'yes' | 'no' | 'unknown';
	detail: string;
}

/** `GET /api/system/update-status` data. */
export interface UpdateStatus {
	currentVersion: string | null;
	latestVersion: string | null;
	updateAvailable: boolean;
	installKind: 'npm-global' | 'dev-checkout' | 'other';
	packageRoot: string | null;
	canUpgrade: boolean;
	upgradeBlockedReason: string | null;
	canRestart: boolean;
	restartBlockedReason: string | null;
	supervisor: SupervisorInfo;
	relaunch: 'supervisor' | 'replacement';
	busyAgents: Array<{ session: string; since?: string; messagePreview?: string }>;
	inProgress: boolean;
	/** Wind-down progress (absent on an older backend) */
	windDown?: WindDownProgress | null;
	action: SystemActionRecord | null;
	bootId: string;
	startedAt: string;
}

/** Error from the system-control API, carrying the HTTP status and refusal code. */
export class SystemControlApiError extends Error {
	/**
	 * @param message - Server message
	 * @param status - HTTP status (0 = network failure)
	 * @param code - Refusal code
	 */
	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: string,
	) {
		super(message);
		this.name = 'SystemControlApiError';
	}
}
