/**
 * Idle Detection Service
 *
 * Periodically checks for idle agents and suspends them to free resources.
 * Uses PtyActivityTrackerService for PTY idle time and AgentHeartbeatService
 * for heartbeat staleness as dual signals.
 *
 * @module idle-detection-service
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { CREWLY_CONSTANTS, AGENT_SUSPEND_CONSTANTS } from '../../constants.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { AgentSuspendService } from './agent-suspend.service.js';
import { ActivityMonitorService } from '../monitoring/activity-monitor.service.js';
import { getSettingsService } from '../settings/index.js';
import { getSessionBackendSync } from '../session/index.js';

/**
 * Periodically scans active agents and suspends those that have been
 * idle longer than the configured `agentIdleTimeoutMinutes`.
 *
 * An agent is considered idle when BOTH:
 * 1. PTY has had no output for the timeout period
 * 2. Agent is not the orchestrator (exempt)
 */
export class IdleDetectionService {
	private static instance: IdleDetectionService | null = null;
	private logger: ComponentLogger;
	private timer: ReturnType<typeof setInterval> | null = null;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('IdleDetection');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The IdleDetectionService singleton
	 */
	static getInstance(): IdleDetectionService {
		if (!IdleDetectionService.instance) {
			IdleDetectionService.instance = new IdleDetectionService();
		}
		return IdleDetectionService.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		if (IdleDetectionService.instance) {
			IdleDetectionService.instance.stop();
		}
		IdleDetectionService.instance = null;
	}

	/**
	 * Start the periodic idle check cycle.
	 */
	start(): void {
		if (this.timer) {
			this.logger.warn('Idle detection already running');
			return;
		}

		this.logger.info('Starting idle detection service', {
			checkIntervalMs: AGENT_SUSPEND_CONSTANTS.IDLE_CHECK_INTERVAL_MS,
		});

		this.timer = setInterval(() => {
			this.performCheck().catch(err => {
				this.logger.error('Idle check cycle failed', {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, AGENT_SUSPEND_CONSTANTS.IDLE_CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the periodic idle check cycle.
	 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			this.logger.info('Idle detection service stopped');
		}
	}

	/**
	 * Check if the service is currently running.
	 *
	 * @returns True if the check cycle is active
	 */
	isRunning(): boolean {
		return this.timer !== null;
	}

	/**
	 * Perform a single idle check across all active agents.
	 * Reads the timeout setting, iterates active members, and
	 * suspends any that exceed the idle threshold.
	 */
	async performCheck(): Promise<void> {
		// Read current idle timeout from settings
		let timeoutMinutes: number;
		try {
			const settings = await getSettingsService().getSettings();
			timeoutMinutes = settings.general.agentIdleTimeoutMinutes;
		} catch {
			timeoutMinutes = AGENT_SUSPEND_CONSTANTS.DEFAULT_IDLE_TIMEOUT_MINUTES;
		}

		// 0 = disabled
		if (timeoutMinutes <= 0) {
			return;
		}

		const timeoutMs = timeoutMinutes * 60 * 1000;
		const activityTracker = PtyActivityTrackerService.getInstance();
		const suspendService = AgentSuspendService.getInstance();

		// Get all teams and their members
		let teams;
		try {
			teams = await StorageService.getInstance().getTeams();
		} catch (err) {
			this.logger.error('Failed to get teams for idle check', {
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		for (const team of teams) {
			for (const member of team.members || []) {
				// Check active and started agents (started agents may be stuck)
				const isActive = member.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE;
				const isStarted = member.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.STARTED;
				if (!isActive && !isStarted) {
					continue;
				}

				// Skip exempt roles
				if (AGENT_SUSPEND_CONSTANTS.EXEMPT_ROLES.includes(
					member.role as typeof AGENT_SUSPEND_CONSTANTS.EXEMPT_ROLES[number]
				)) {
					continue;
				}

				// Skip agents already being suspended or rehydrated
				if (suspendService.isSuspended(member.sessionName) || suspendService.isRehydrating(member.sessionName)) {
					continue;
				}

				// Use longer timeout for 'started' agents to allow initialization to complete
				const effectiveTimeoutMs = isStarted
					? AGENT_SUSPEND_CONSTANTS.STARTED_AGENT_IDLE_TIMEOUT_MINUTES * 60 * 1000
					: timeoutMs;

				// Check if idle
				if (activityTracker.isIdleFor(member.sessionName, effectiveTimeoutMs)) {
					// Skip agents that are actively working (workingStatus: in_progress)
					// This prevents suspending agents that are mid-task but happen to
					// have stale PTY output (e.g., waiting for a long API call)
					try {
						const workingStatus = await ActivityMonitorService.getInstance()
							.getWorkingStatusForSession(member.sessionName);
						if (workingStatus === 'in_progress') {
							this.logger.debug('Agent PTY idle but workingStatus is in_progress, skipping suspend', {
								sessionName: member.sessionName,
								role: member.role,
							});
							continue;
						}
					} catch {
						// If we can't check workingStatus, proceed with normal idle check
					}

					// #201: Agents stuck in 'started' state should be marked inactive,
					// not suspended, since they never completed initialization
					// and have no session to rehydrate.
					if (isStarted) {
						this.logger.warn('Agent stuck in started state, marking inactive', {
							sessionName: member.sessionName,
							role: member.role,
							idleMinutes: effectiveTimeoutMs / 60000,
						});

						try {
							// Kill PTY session if it exists
							const backend = getSessionBackendSync();
							if (backend && backend.sessionExists(member.sessionName)) {
								await backend.killSession(member.sessionName);
							}

							// Clear activity tracker
							PtyActivityTrackerService.getInstance().clearSession(member.sessionName);

							// Mark as inactive
							await StorageService.getInstance().updateAgentStatus(
								member.sessionName,
								CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE as any
							);
						} catch (err) {
							this.logger.error('Failed to mark stuck started agent as inactive', {
								sessionName: member.sessionName,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					} else {
						this.logger.info('Agent idle timeout reached, suspending', {
							sessionName: member.sessionName,
							role: member.role,
							idleMinutes: effectiveTimeoutMs / 60000,
							agentStatus: member.agentStatus,
						});

						try {
							await suspendService.suspendAgent(
								member.sessionName,
								team.id,
								member.id,
								member.role
							);
						} catch (err) {
							this.logger.error('Failed to suspend idle agent', {
								sessionName: member.sessionName,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}
				}
			}
		}
	}
}
