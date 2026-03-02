/**
 * Orchestrator Heartbeat Monitor Service
 *
 * Monitors the orchestrator's heartbeat and takes progressive action
 * when the orchestrator becomes unresponsive:
 *
 * 1. Implicit heartbeat: Every API call with X-Agent-Session header
 *    automatically updates the orchestrator's heartbeat timestamp
 *    (handled by agentHeartbeatMiddleware — not this service).
 *
 * 2. Active heartbeat request: After HEARTBEAT_REQUEST_THRESHOLD_MS
 *    without any API activity, this service sends a heartbeat request
 *    message directly into the orchestrator's PTY session.
 *
 * 3. Auto-restart + resume: After an additional RESTART_THRESHOLD_MS
 *    with no response, this service triggers OrchestratorRestartService
 *    to kill and recreate the orchestrator PTY session.
 *
 * @module orchestrator-heartbeat-monitor.service
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import {
	ORCHESTRATOR_SESSION_NAME,
	ORCHESTRATOR_HEARTBEAT_CONSTANTS,
	SESSION_COMMAND_DELAYS,
} from '../../constants.js';
import { delay } from '../../utils/async.utils.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';
import { OrchestratorRestartService } from './orchestrator-restart.service.js';
import type { ISessionBackend } from '../session/session-backend.interface.js';

/**
 * Internal state for the heartbeat monitor.
 */
export interface HeartbeatMonitorState {
	/** Whether the monitor is currently running */
	isRunning: boolean;
	/** Timestamp when the heartbeat request was sent (null if none pending) */
	heartbeatRequestSentAt: number | null;
	/** Number of heartbeat requests sent since last successful heartbeat */
	heartbeatRequestCount: number;
	/** Number of auto-restarts triggered by this monitor */
	autoRestartCount: number;
	/** Timestamp when the service started monitoring */
	startedAt: number | null;
	/** Timestamp when the orchestrator was first seen in_progress (null if idle) */
	inProgressSince: number | null;
}

/**
 * Monitors the orchestrator's heartbeat and takes progressive action
 * when it becomes unresponsive.
 *
 * The monitor uses PtyActivityTrackerService as the single source of truth
 * for orchestrator activity. The agentHeartbeatMiddleware calls
 * PtyActivityTrackerService.recordActivity() on every API call with
 * X-Agent-Session header, so any skill call counts as a heartbeat.
 *
 * @example
 * ```typescript
 * const monitor = OrchestratorHeartbeatMonitorService.getInstance();
 * monitor.setDependencies(sessionBackend);
 * monitor.start();
 * // ... later
 * monitor.stop();
 * ```
 */
export class OrchestratorHeartbeatMonitorService {
	private static instance: OrchestratorHeartbeatMonitorService | null = null;
	private logger: ComponentLogger;

	/** Interval timer handle */
	private checkTimer: ReturnType<typeof setInterval> | null = null;

	/** When the heartbeat request was sent to the orchestrator PTY */
	private heartbeatRequestSentAt: number | null = null;

	/** Counter for heartbeat requests sent */
	private heartbeatRequestCount = 0;

	/** Counter for auto-restarts triggered */
	private autoRestartCount = 0;

	/** When monitoring started */
	private startedAt: number | null = null;

	/** When the orchestrator was first seen with recent activity but no idle period.
	 *  Used to detect stuck in_progress state where spinner animation prevents
	 *  idle detection from ever exceeding the heartbeat threshold. */
	private inProgressSince: number | null = null;

	/** Session backend for writing to orchestrator PTY */
	private sessionBackend: ISessionBackend | null = null;
	/** Optional callback used to suppress idle heartbeats when no work is pending. */
	private hasPendingWork: (() => boolean) | null = null;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('OrchestratorHeartbeatMonitor');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The OrchestratorHeartbeatMonitorService singleton
	 */
	static getInstance(): OrchestratorHeartbeatMonitorService {
		if (!OrchestratorHeartbeatMonitorService.instance) {
			OrchestratorHeartbeatMonitorService.instance = new OrchestratorHeartbeatMonitorService();
		}
		return OrchestratorHeartbeatMonitorService.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		if (OrchestratorHeartbeatMonitorService.instance) {
			OrchestratorHeartbeatMonitorService.instance.stop();
		}
		OrchestratorHeartbeatMonitorService.instance = null;
	}

	/**
	 * Inject the session backend dependency.
	 *
	 * @param sessionBackend - Session backend for accessing the orchestrator PTY
	 */
	setDependencies(sessionBackend: ISessionBackend, hasPendingWork?: () => boolean): void {
		this.sessionBackend = sessionBackend;
		this.hasPendingWork = hasPendingWork ?? null;
	}

	/**
	 * Start the heartbeat monitoring loop.
	 * Applies a startup grace period before the first check.
	 */
	start(): void {
		if (this.checkTimer) {
			this.logger.warn('Heartbeat monitor already running');
			return;
		}

		this.startedAt = Date.now();
		this.heartbeatRequestSentAt = null;
		this.heartbeatRequestCount = 0;
		this.inProgressSince = null;

		this.logger.info('Starting orchestrator heartbeat monitor', {
			checkIntervalMs: ORCHESTRATOR_HEARTBEAT_CONSTANTS.CHECK_INTERVAL_MS,
			heartbeatRequestThresholdMs: ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS,
			restartThresholdMs: ORCHESTRATOR_HEARTBEAT_CONSTANTS.RESTART_THRESHOLD_MS,
			startupGracePeriodMs: ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS,
		});

		this.checkTimer = setInterval(() => {
			this.performCheck().catch((err) => {
				this.logger.error('Heartbeat check failed', {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, ORCHESTRATOR_HEARTBEAT_CONSTANTS.CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the heartbeat monitoring loop.
	 */
	stop(): void {
		if (this.checkTimer) {
			clearInterval(this.checkTimer);
			this.checkTimer = null;
			this.logger.info('Orchestrator heartbeat monitor stopped');
		}
		this.heartbeatRequestSentAt = null;
		this.inProgressSince = null;
	}

	/**
	 * Check if the monitor is currently running.
	 *
	 * @returns True if the check loop is active
	 */
	isRunning(): boolean {
		return this.checkTimer !== null;
	}

	/**
	 * Get the current state of the heartbeat monitor.
	 *
	 * @returns Current monitor state for diagnostics
	 */
	getState(): HeartbeatMonitorState {
		return {
			isRunning: this.isRunning(),
			heartbeatRequestSentAt: this.heartbeatRequestSentAt,
			heartbeatRequestCount: this.heartbeatRequestCount,
			autoRestartCount: this.autoRestartCount,
			startedAt: this.startedAt,
			inProgressSince: this.inProgressSince,
		};
	}

	/**
	 * Perform a single heartbeat check cycle.
	 *
	 * Decision tree:
	 * 1. If within startup grace period → skip
	 * 2. If orchestrator session doesn't exist → skip (not started yet)
	 * 3. If recent API activity → clear any pending heartbeat request
	 * 4. If heartbeat request pending and RESTART_THRESHOLD_MS exceeded → auto-restart
	 * 5. If no activity for HEARTBEAT_REQUEST_THRESHOLD_MS → send heartbeat request
	 */
	async performCheck(): Promise<void> {
		// Guard: startup grace period
		if (this.startedAt && (Date.now() - this.startedAt) < ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS) {
			return;
		}

		// Guard: session backend not set
		if (!this.sessionBackend) {
			return;
		}

		// Guard: orchestrator session doesn't exist (not started yet)
		if (!this.sessionBackend.sessionExists(ORCHESTRATOR_SESSION_NAME)) {
			this.heartbeatRequestSentAt = null;
			return;
		}

		// Fast path: if the child process is dead, skip heartbeat messaging
		// and trigger restart immediately. This prevents sending heartbeat
		// messages to a bare shell, which would produce error output that
		// resets the PTY activity tracker and block restart indefinitely.
		if (this.sessionBackend.isChildProcessAlive) {
			const isAlive = this.sessionBackend.isChildProcessAlive(ORCHESTRATOR_SESSION_NAME);
			if (!isAlive) {
				this.logger.warn('Orchestrator child process is dead, triggering immediate restart', {
					sessionName: ORCHESTRATOR_SESSION_NAME,
				});
				this.heartbeatRequestSentAt = null;
				await this.triggerAutoRestart();
				return;
			}
		}

		const activityTracker = PtyActivityTrackerService.getInstance();
		const idleTimeMs = activityTracker.getIdleTimeMs(ORCHESTRATOR_SESSION_NAME);

		// If recent activity detected, clear any pending heartbeat request
		if (idleTimeMs < ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS) {
			if (this.heartbeatRequestSentAt !== null) {
				this.logger.info('Orchestrator responded to heartbeat request, clearing pending state');
				this.heartbeatRequestSentAt = null;
			}

			// Track continuous in_progress duration. Spinner animation counts as
			// "activity" so idleTime stays low, but the orchestrator may be stuck
			// in a processing loop without making real progress.
			if (this.inProgressSince === null) {
				this.inProgressSince = Date.now();
			} else if (
				ORCHESTRATOR_HEARTBEAT_CONSTANTS.IN_PROGRESS_TIMEOUT_MS &&
				Date.now() - this.inProgressSince > ORCHESTRATOR_HEARTBEAT_CONSTANTS.IN_PROGRESS_TIMEOUT_MS
			) {
				const stuckDurationMs = Date.now() - this.inProgressSince;
				this.logger.warn('Orchestrator stuck in_progress for extended period, sending heartbeat', {
					stuckDurationMs,
					thresholdMs: ORCHESTRATOR_HEARTBEAT_CONSTANTS.IN_PROGRESS_TIMEOUT_MS,
				});
				this.inProgressSince = null;
				await this.sendHeartbeatRequest();
			}

			return;
		}

		// Orchestrator is idle — reset in_progress tracker
		this.inProgressSince = null;

		// If we already sent a heartbeat request, check if it's time to restart
		if (this.heartbeatRequestSentAt !== null) {
			const timeSinceRequest = Date.now() - this.heartbeatRequestSentAt;

			if (timeSinceRequest >= ORCHESTRATOR_HEARTBEAT_CONSTANTS.RESTART_THRESHOLD_MS) {
				this.logger.warn('Orchestrator did not respond to heartbeat request, triggering auto-restart', {
					timeSinceRequestMs: timeSinceRequest,
					idleTimeMs,
					heartbeatRequestCount: this.heartbeatRequestCount,
				});

				this.heartbeatRequestSentAt = null;
				await this.triggerAutoRestart();
			}
			return;
		}

		// No activity for HEARTBEAT_REQUEST_THRESHOLD_MS. If there's no queued
		// work, skip synthetic heartbeat pings to avoid idle token burn.
		const pendingWork = this.hasPendingWork ? this.hasPendingWork() : true;
		if (!pendingWork) {
			if (this.heartbeatRequestSentAt !== null) {
				this.heartbeatRequestSentAt = null;
			}
			this.logger.debug('Skipping heartbeat request: no pending orchestrator work');
			return;
		}

		// Otherwise, send a heartbeat request.
		this.logger.info('Orchestrator idle, sending heartbeat request', {
			idleTimeMs,
		});

		await this.sendHeartbeatRequest();
	}

	/**
	 * Send a heartbeat request message to the orchestrator PTY.
	 * This writes the heartbeat request directly into the orchestrator's terminal.
	 */
	private async sendHeartbeatRequest(): Promise<void> {
		if (!this.sessionBackend) {
			return;
		}

		try {
			const session = this.sessionBackend.getSession(ORCHESTRATOR_SESSION_NAME);
			if (!session) {
				this.logger.warn('Orchestrator session not found, cannot send heartbeat request');
				return;
			}

			// Mark as sent BEFORE the async delay to prevent concurrent calls
			// from sending duplicate heartbeat requests.
			this.heartbeatRequestSentAt = Date.now();
			this.heartbeatRequestCount++;

			// Write message and Enter as separate writes so that Enter is not
			// swallowed by the terminal's bracketed paste mode.
			const message = ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_MESSAGE;
			session.write(message);

			// Delay to let the terminal finish processing the paste, then send Enter
			const pasteDelay = Math.min(
				SESSION_COMMAND_DELAYS.MESSAGE_DELAY + Math.ceil(message.length / 10),
				5000
			);
			await delay(pasteDelay);
			session.write('\r');

			this.logger.info('Heartbeat request sent to orchestrator PTY', {
				heartbeatRequestCount: this.heartbeatRequestCount,
			});
		} catch (err) {
			// Reset heartbeat state so a failed delivery doesn't trigger a false restart
			this.heartbeatRequestSentAt = null;
			this.heartbeatRequestCount = Math.max(0, this.heartbeatRequestCount - 1);
			this.logger.error('Failed to send heartbeat request to orchestrator', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Trigger an auto-restart of the orchestrator via OrchestratorRestartService.
	 */
	private async triggerAutoRestart(): Promise<void> {
		try {
			const restartService = OrchestratorRestartService.getInstance();
			const success = await restartService.attemptRestart();

			if (success) {
				this.autoRestartCount++;
				this.logger.info('Orchestrator auto-restart triggered successfully', {
					autoRestartCount: this.autoRestartCount,
				});
			} else {
				this.logger.warn('Orchestrator auto-restart was not allowed (cooldown or concurrent restart)');
			}
		} catch (err) {
			this.logger.error('Failed to trigger orchestrator auto-restart', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
