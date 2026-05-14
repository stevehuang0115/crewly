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
import type { AgentRegistrationService } from './agent-registration.service.js';

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
	private agentRegistrationService: AgentRegistrationService | null = null;

	// Observability: surfaces silent hangs that previously caused the
	// loop to "stop" for hours with no log evidence (2026-05-14 incident).
	private isChecking = false;
	private lastTickStartedAt: number | null = null;
	private lastTickCompletedAt: number | null = null;
	private lastTickDurationMs: number | null = null;
	private consecutiveSkippedTicks = 0;
	private forcedResetCount = 0;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('IdleDetection');
	}

	/**
	 * Inject AgentRegistrationService for auto-stop capability.
	 *
	 * @param service - AgentRegistrationService instance
	 */
	setAgentRegistrationService(service: AgentRegistrationService): void {
		this.agentRegistrationService = service;
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
			this.runTick();
		}, AGENT_SUSPEND_CONSTANTS.IDLE_CHECK_INTERVAL_MS);
	}

	/**
	 * Wrapper around `performCheck` that adds re-entrancy guard, heartbeat
	 * logging, and duration tracking. Defensive against silent hangs — if
	 * `performCheck` ever stops resolving (e.g., dependency hangs), the
	 * `isChecking` guard prevents overlapping invocations from piling up,
	 * and `consecutiveSkippedTicks` makes the stuck state observable.
	 *
	 * Why: on 2026-05-14 the loop stopped producing logs for 21 hours while
	 * the timer was still scheduled. Without a per-tick heartbeat the
	 * regression was invisible.
	 */
	private runTick(): void {
		if (this.isChecking) {
			this.consecutiveSkippedTicks++;
			const elapsedMs = this.lastTickStartedAt ? Date.now() - this.lastTickStartedAt : 0;

			// Self-heal watchdog: if a tick has been "in flight" for
			// significantly longer than the configured tick interval, the
			// previous `performCheck` is almost certainly hung on an
			// upstream dependency that never resolves (e.g., a
			// `getWorkingStatusForSession` that silently never settles —
			// the 2026-05-14 incident shape). Re-entrancy guard alone is
			// insufficient: every subsequent tick is just dropped while
			// the system makes zero progress.
			//
			// Threshold = 3 × IDLE_CHECK_INTERVAL_MS. Tight enough that a
			// genuinely slow but eventual completion (e.g., 1.5×
			// interval) is not falsely flagged; loose enough that a real
			// hang surfaces within ~6 minutes at the 2-minute default.
			//
			// Recovery action: force-reset `isChecking` and log at error
			// level. We accept the small risk that the still-running
			// previous tick later resolves into stale stats — that's
			// strictly better than wedging the loop indefinitely.
			const stuckThresholdMs = AGENT_SUSPEND_CONSTANTS.IDLE_CHECK_INTERVAL_MS * 3;
			if (elapsedMs > stuckThresholdMs) {
				this.forcedResetCount++;
				this.logger.error('Idle check tick appears hung — force-resetting guard', {
					elapsedMs,
					stuckThresholdMs,
					consecutiveSkippedTicks: this.consecutiveSkippedTicks,
					forcedResetCount: this.forcedResetCount,
					lastTickStartedAt: this.lastTickStartedAt
						? new Date(this.lastTickStartedAt).toISOString()
						: null,
				});
				this.isChecking = false;
				// Fall through to start a fresh tick this cycle.
			} else {
				this.logger.warn('Idle check skipped — previous tick still running', {
					consecutiveSkippedTicks: this.consecutiveSkippedTicks,
					lastTickStartedAt: this.lastTickStartedAt
						? new Date(this.lastTickStartedAt).toISOString()
						: null,
					elapsedMs,
				});
				return;
			}
		}

		this.isChecking = true;
		this.consecutiveSkippedTicks = 0;
		this.lastTickStartedAt = Date.now();
		this.logger.debug('Idle check tick started');

		this.performCheck()
			.then(() => {
				this.lastTickCompletedAt = Date.now();
				this.lastTickDurationMs = this.lastTickCompletedAt - (this.lastTickStartedAt ?? this.lastTickCompletedAt);
				this.logger.debug('Idle check tick completed', {
					durationMs: this.lastTickDurationMs,
				});
			})
			.catch((err: unknown) => {
				this.lastTickCompletedAt = Date.now();
				this.lastTickDurationMs = this.lastTickCompletedAt - (this.lastTickStartedAt ?? this.lastTickCompletedAt);
				this.logger.error('Idle check cycle failed', {
					error: err instanceof Error ? err.message : String(err),
					durationMs: this.lastTickDurationMs,
				});
			})
			.finally(() => {
				this.isChecking = false;
			});
	}

	/**
	 * Snapshot of recent tick activity. Used by health/status endpoints
	 * to detect a silently stuck loop without parsing logs.
	 *
	 * @returns Tick observability stats. All timestamps in epoch ms.
	 */
	getStats(): {
		isRunning: boolean;
		isChecking: boolean;
		lastTickStartedAt: number | null;
		lastTickCompletedAt: number | null;
		lastTickDurationMs: number | null;
		consecutiveSkippedTicks: number;
		forcedResetCount: number;
	} {
		return {
			isRunning: this.isRunning(),
			isChecking: this.isChecking,
			lastTickStartedAt: this.lastTickStartedAt,
			lastTickCompletedAt: this.lastTickCompletedAt,
			lastTickDurationMs: this.lastTickDurationMs,
			consecutiveSkippedTicks: this.consecutiveSkippedTicks,
			forcedResetCount: this.forcedResetCount,
		};
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

				// Skip always-on roles (orchestrator, auditor)
				if (AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES.includes(
					member.role as typeof AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES[number]
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

				// Check if idle — dual detection:
				// PTY-based runtimes: use PtyActivityTracker
				// In-process runtimes (crewly-agent): use member.updatedAt timestamp
				const isCrewlyAgent = member.runtimeType === 'crewly-agent';
				let isIdle = false;
				if (isCrewlyAgent) {
					// crewly-agent has no PTY — check last updatedAt or readyAt timestamp
					const lastActive = member.readyAt || member.updatedAt || member.createdAt;
					if (lastActive) {
						const idleMs = Date.now() - new Date(lastActive).getTime();
						isIdle = idleMs > effectiveTimeoutMs;
					}
				} else {
					isIdle = activityTracker.isIdleFor(member.sessionName, effectiveTimeoutMs);
				}

				if (isIdle) {
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
						// Auto-stop: terminate idle agents to free resources
						if (this.agentRegistrationService) {
							this.logger.info('Agent idle timeout reached, stopping', {
								sessionName: member.sessionName,
								role: member.role,
								idleMinutes: effectiveTimeoutMs / 60000,
								agentStatus: member.agentStatus,
							});

							try {
								await this.agentRegistrationService.terminateAgentSession(
									member.sessionName,
									member.role
								);
								await StorageService.getInstance().updateAgentStatus(
									member.sessionName,
									CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE as any,
									'idle_exit'
								);
							} catch (err) {
								this.logger.error('Failed to stop idle agent', {
									sessionName: member.sessionName,
									error: err instanceof Error ? err.message : String(err),
								});
							}
						} else {
							// Fallback: suspend if registration service not available
							this.logger.info('Agent idle timeout reached, suspending (no registration service)', {
								sessionName: member.sessionName,
								role: member.role,
								idleMinutes: effectiveTimeoutMs / 60000,
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

	/**
	 * Emergency stop of idle agents during memory pressure.
	 * Stops all non-orchestrator agents with workingStatus 'idle',
	 * regardless of the configured idle timeout.
	 *
	 * Called by SystemResourceAlertService when memory usage is critical.
	 *
	 * @returns Number of agents stopped
	 */
	async forceStopIdleAgents(): Promise<number> {
		let stoppedCount = 0;

		let teams;
		try {
			teams = await StorageService.getInstance().getTeams();
		} catch {
			return 0;
		}

		const backend = getSessionBackendSync();

		for (const team of teams) {
			for (const member of team.members || []) {
				if (member.agentStatus !== CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE &&
					member.agentStatus !== CREWLY_CONSTANTS.AGENT_STATUSES.STARTED) {
					continue;
				}

				// Skip members with no session
				if (!member.sessionName) {
					continue;
				}

				// Never stop orchestrator
				if (AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES.includes(
					member.role as typeof AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES[number]
				)) {
					continue;
				}

				// Only stop agents that are idle.
				// NOTE: Intentionally checks member.workingStatus directly instead of
				// ActivityMonitorService. This is the emergency OOM path — ActivityMonitorService
				// may not be available or its state may lag behind reality. The raw
				// workingStatus field from StorageService is the most reliable signal here.
				if (member.workingStatus === 'in_progress') {
					continue;
				}

				this.logger.warn('Force-stopping idle agent due to memory pressure', {
					sessionName: member.sessionName,
					role: member.role,
				});

				try {
					if (backend && member.sessionName && backend.sessionExists(member.sessionName)) {
						await backend.killSession(member.sessionName);
					}
					PtyActivityTrackerService.getInstance().clearSession(member.sessionName);
					await StorageService.getInstance().updateAgentStatus(
						member.sessionName,
						CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE as any,
						'idle_exit'
					);
					stoppedCount++;
				} catch (err) {
					this.logger.error('Failed to force-stop agent', {
						sessionName: member.sessionName,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		return stoppedCount;
	}
}
