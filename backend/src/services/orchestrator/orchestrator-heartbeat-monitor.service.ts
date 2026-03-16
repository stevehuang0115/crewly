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
	AUDITOR_SCHEDULER_CONSTANTS,
	SESSION_COMMAND_DELAYS,
} from '../../constants.js';
import { delay } from '../../utils/async.utils.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';
import { OrchestratorRestartService } from './orchestrator-restart.service.js';
import { isAgentActive } from './orchestrator-status.service.js';
import type { ISessionBackend } from '../session/session-backend.interface.js';

/**
 * Per-agent API activity record for on-demand heartbeat optimization.
 */
export interface AgentActivityRecord {
	/** Last time this agent made an API call (unix ms) */
	lastApiCallTime: number;
	/** Agent's role (orchestrator gets unconditional heartbeat) */
	role: string;
	/** Whether heartbeat is currently suspended for this agent */
	suspended: boolean;
}

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
	/** Per-agent activity tracking */
	agentActivity: Map<string, AgentActivityRecord>;
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

	/** Per-agent API activity tracking for on-demand heartbeat optimization */
	private agentActivity: Map<string, AgentActivityRecord> = new Map();

	/** Threshold for considering an agent "recently active" (skip heartbeat) — 2 minutes */
	private static readonly RECENT_ACTIVITY_THRESHOLD_MS = 2 * 60 * 1000;

	/** Threshold for suspending heartbeat for idle agents — 10 minutes */
	private static readonly IDLE_SUSPEND_THRESHOLD_MS = 10 * 60 * 1000;

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
		this.agentActivity.clear();
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
			agentActivity: new Map(this.agentActivity),
		};
	}

	/**
	 * Record an API call for an agent. Updates lastApiCallTime and
	 * un-suspends the agent if it was previously suspended.
	 *
	 * Called by the heartbeat middleware on every API request with
	 * an X-Agent-Session header.
	 *
	 * @param sessionName - The agent's session name
	 * @param role - The agent's role
	 */
	recordAgentApiCall(sessionName: string, role: string): void {
		const existing = this.agentActivity.get(sessionName);
		this.agentActivity.set(sessionName, {
			lastApiCallTime: Date.now(),
			role: existing?.role || role,
			suspended: false,
		});
	}

	/**
	 * Check whether heartbeat should be skipped for a given agent.
	 *
	 * Rules:
	 * - Orchestrator role: NEVER skip (unconditional heartbeat)
	 * - Agent with recent API activity: skip (already known alive)
	 * - Agent suspended due to prolonged idle: skip
	 *
	 * @param sessionName - The agent's session name
	 * @returns True if heartbeat should be skipped
	 */
	shouldSkipHeartbeat(sessionName: string): boolean {
		const record = this.agentActivity.get(sessionName);

		// No record → unknown agent, don't skip
		if (!record) {
			return false;
		}

		// Orchestrator always gets heartbeat (never skip)
		if (record.role === 'orchestrator') {
			return false;
		}

		// Suspended agents: skip heartbeat
		if (record.suspended) {
			return true;
		}

		// Recent API activity: skip heartbeat (agent is alive)
		const timeSinceLastApi = Date.now() - record.lastApiCallTime;
		if (timeSinceLastApi < OrchestratorHeartbeatMonitorService.RECENT_ACTIVITY_THRESHOLD_MS) {
			this.logger.debug('Skipping heartbeat for recently active agent', {
				sessionName,
				timeSinceLastApiMs: timeSinceLastApi,
			});
			return true;
		}

		return false;
	}

	/**
	 * Suspend heartbeat for agents that have been idle beyond the
	 * idle suspension threshold. Called periodically to clean up
	 * agents that are no longer active.
	 *
	 * @returns Number of agents newly suspended
	 */
	suspendIdleAgents(): number {
		const now = Date.now();
		let suspended = 0;

		for (const [sessionName, record] of this.agentActivity) {
			// Never suspend orchestrator
			if (record.role === 'orchestrator') {
				continue;
			}

			// Already suspended
			if (record.suspended) {
				continue;
			}

			const idleMs = now - record.lastApiCallTime;
			if (idleMs >= OrchestratorHeartbeatMonitorService.IDLE_SUSPEND_THRESHOLD_MS) {
				record.suspended = true;
				suspended++;
				this.logger.info('Suspended heartbeat for idle agent', {
					sessionName,
					idleMs,
					role: record.role,
				});
			}
		}

		return suspended;
	}

	/**
	 * Get the activity record for a specific agent.
	 *
	 * @param sessionName - The agent's session name
	 * @returns The agent's activity record, or undefined
	 */
	getAgentActivity(sessionName: string): AgentActivityRecord | undefined {
		return this.agentActivity.get(sessionName);
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
				const lastOutput = this.sessionBackend.captureOutput(ORCHESTRATOR_SESSION_NAME, 50);
				this.logger.warn('Orchestrator child process is dead, triggering immediate restart', {
					sessionName: ORCHESTRATOR_SESSION_NAME,
					lastOutput: lastOutput?.slice(-500),
				});
				this.heartbeatRequestSentAt = null;
				await this.triggerAutoRestart();
				return;
			}
		}

		const activityTracker = PtyActivityTrackerService.getInstance();
		const idleTimeMs = activityTracker.getIdleTimeMs(ORCHESTRATOR_SESSION_NAME);
		// Use API-specific idle time for heartbeat response detection.
		// PTY activity alone is unreliable because heartbeat messages written
		// to the PTY echo back and reset the general activity timer.
		const apiIdleTimeMs = activityTracker.getApiIdleTimeMs(ORCHESTRATOR_SESSION_NAME);

		// Adaptive threshold: if the orchestrator's PTY is producing output
		// (e.g. running a build, tests, long bash commands), use a longer
		// threshold since the orchestrator is clearly alive — just not making
		// API calls. When PTY is idle, use the shorter default threshold.
		const isPtyActive = idleTimeMs < ORCHESTRATOR_HEARTBEAT_CONSTANTS.PTY_ACTIVE_WINDOW_MS;
		const heartbeatThreshold = isPtyActive
			? ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_PTY_ACTIVE_MS
			: ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS;

		// If recent API activity detected, clear any pending heartbeat request.
		// Only API calls count as proof that the orchestrator is responsive —
		// PTY output alone may just be echoed heartbeat messages.
		if (apiIdleTimeMs < heartbeatThreshold) {
			if (this.heartbeatRequestSentAt !== null) {
				this.logger.info('Orchestrator responded to heartbeat request (API activity detected), clearing pending state');
				this.heartbeatRequestSentAt = null;
				this.heartbeatRequestCount = 0;
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
					apiIdleTimeMs,
					heartbeatRequestCount: this.heartbeatRequestCount,
				});

				this.heartbeatRequestSentAt = null;
				this.heartbeatRequestCount = 0;
				await this.triggerAutoRestart();
			}
			return;
		}

		// Cap consecutive heartbeat requests to prevent spam when the
		// orchestrator is stuck (e.g., ENOSPC). After MAX attempts without
		// a real API response, trigger auto-restart instead.
		const MAX_HEARTBEAT_REQUESTS = 3;
		if (this.heartbeatRequestCount >= MAX_HEARTBEAT_REQUESTS) {
			this.logger.warn('Max heartbeat requests reached without API response, triggering auto-restart', {
				heartbeatRequestCount: this.heartbeatRequestCount,
				apiIdleTimeMs,
			});
			this.heartbeatRequestCount = 0;
			await this.triggerAutoRestart();
			return;
		}

		// No API activity for HEARTBEAT_REQUEST_THRESHOLD_MS. If there's no queued
		// work, skip synthetic heartbeat pings to avoid idle token burn.
		const pendingWork = this.hasPendingWork ? this.hasPendingWork() : true;
		if (!pendingWork) {
			this.logger.debug('Skipping heartbeat request: no pending orchestrator work');
			return;
		}

		// Otherwise, send a heartbeat request.
		this.logger.info('Orchestrator idle (no API activity), sending heartbeat request', {
			idleTimeMs,
			apiIdleTimeMs,
			isPtyActive,
			heartbeatThresholdMs: heartbeatThreshold,
			heartbeatRequestCount: this.heartbeatRequestCount,
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
	 * Also notifies the Auditor agent so it can log the incident and handle
	 * any user messages that arrive during the restart window.
	 */
	private async triggerAutoRestart(): Promise<void> {
		// Notify auditor concurrently — don't block restart on notification
		this.notifyAuditorOfOrchestratorDown().catch((err) => {
			this.logger.warn('Failed to notify auditor of orchestrator restart', {
				error: err instanceof Error ? err.message : String(err),
			});
		});

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

	/**
	 * Notify the Auditor agent that the orchestrator is down / being restarted.
	 * The Auditor can log the incident and handle any user messages that arrive
	 * during the restart window.
	 */
	private async notifyAuditorOfOrchestratorDown(): Promise<void> {
		const auditorSession = AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME;

		// Only notify if auditor is actually running
		const auditorActive = await isAgentActive(auditorSession);
		if (!auditorActive) {
			this.logger.debug('Auditor not active, skipping orchestrator-down notification');
			return;
		}

		try {
			const { AuditorSchedulerService } = await import('../agent/auditor-scheduler.service.js');
			const scheduler = AuditorSchedulerService.getInstance();
			await scheduler.handleUserMessage(
				`[SYSTEM] Orchestrator heartbeat timeout detected. Auto-restart triggered. ` +
				`Restart count: ${this.autoRestartCount + 1}. ` +
				`Please monitor system health and log any user messages received during downtime.`,
				{ channelId: '', threadTs: '' },
			);
			this.logger.info('Auditor notified of orchestrator restart');
		} catch (err) {
			this.logger.warn('Could not notify auditor via scheduler', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
