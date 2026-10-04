/**
 * Credential guard alerts — layer 4 of
 * specs/2026-10-04-agent-credential-isolation.md.
 *
 * The credential guard's hook reports every block to `POST /api/agent-hooks`
 * (event `CredentialAccessBlocked`, a rule id and the runtime; never the
 * command). Each block is logged as a WARN. The owner is told at most once
 * per agent per day, so an agent that keeps trying cannot flood Slack, and a
 * forged report (the hook endpoint takes a session header) costs at most one
 * notice per session name per day.
 *
 * @module services/monitoring/credential-guard-alerts
 */

import { CREDENTIAL_GUARD_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

/** Owner notice sink (the Slack owner-alert notifier at boot). */
export type CredentialGuardNotifier = (notice: { title: string; message: string; urgent: boolean }) => Promise<boolean>;

/** One reported block. */
export interface CredentialBlockReport {
	/** Agent session. */
	sessionName: string;
	/** Rule id (which credential). */
	rule: string;
	/** Runtime label (claude, codex, gemini, antigravity). */
	runtime?: string;
}

/** Result of recording a block. */
export interface CredentialBlockOutcome {
	/** Whether the owner notice was attempted for this report. */
	notified: boolean;
}

/**
 * Logs credential-guard blocks and tells the owner once per agent per day.
 */
export class CredentialGuardAlertService {
	private static instance: CredentialGuardAlertService | null = null;
	private readonly logger: ComponentLogger;
	private notifier: CredentialGuardNotifier | null = null;
	/** Last owner notice per session (ms since epoch). */
	private readonly lastNotified = new Map<string, number>();
	/** Blocks seen per session since the last notice (for the notice text). */
	private readonly countSinceNotice = new Map<string, number>();

	/**
	 * @param now - Clock (tests)
	 */
	constructor(private readonly now: () => number = Date.now) {
		this.logger = LoggerService.getInstance().createComponentLogger('CredentialGuard');
	}

	/** @returns The process-wide instance */
	static getInstance(): CredentialGuardAlertService {
		if (!CredentialGuardAlertService.instance) CredentialGuardAlertService.instance = new CredentialGuardAlertService();
		return CredentialGuardAlertService.instance;
	}

	/** Drop the instance (tests). */
	static resetInstance(): void {
		CredentialGuardAlertService.instance = null;
	}

	/**
	 * Set where owner notices go.
	 *
	 * @param notifier - Notifier, or null
	 */
	setOwnerNotifier(notifier: CredentialGuardNotifier | null): void {
		this.notifier = notifier;
	}

	/**
	 * Record one block: WARN always; owner notice at most once per agent per day.
	 *
	 * @param report - What was blocked
	 * @returns Whether the owner notice was attempted
	 */
	record(report: CredentialBlockReport): CredentialBlockOutcome {
		const C = CREDENTIAL_GUARD_CONSTANTS;
		this.logger.warn('Blocked an agent from reading Crewly credentials', {
			sessionName: report.sessionName,
			rule: report.rule,
			runtime: report.runtime ?? 'unknown',
		});
		const count = (this.countSinceNotice.get(report.sessionName) ?? 0) + 1;
		this.countSinceNotice.set(report.sessionName, count);

		const last = this.lastNotified.get(report.sessionName);
		const t = this.now();
		if (last !== undefined && t - last < C.NOTIFY_WINDOW_MS) return { notified: false };
		if (!this.notifier) return { notified: false };

		this.lastNotified.set(report.sessionName, t);
		this.countSinceNotice.set(report.sessionName, 0);
		if (this.lastNotified.size > C.MAX_TRACKED_SESSIONS) {
			const oldest = this.lastNotified.keys().next().value;
			if (oldest !== undefined) {
				this.lastNotified.delete(oldest);
				this.countSinceNotice.delete(oldest);
			}
		}
		const message =
			`Agent ${report.sessionName} tried to read Crewly's own credentials (${report.rule}) and was blocked` +
			`${count > 1 ? ` (${count} attempts)` : ''}. ` +
			'This usually means a connector skill could not do what it needed. Ask the agent what it was trying to do. ' +
			'You will not hear about this agent again for 24 hours; every attempt is in the backend log.';
		void this.notifier({ title: 'Agent blocked from Crewly credentials', message, urgent: false }).catch((error: unknown) => {
			this.logger.warn('Could not send the credential-guard notice', {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return { notified: true };
	}
}
