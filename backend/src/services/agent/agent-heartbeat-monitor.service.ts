/**
 * Agent Heartbeat Monitor Service
 *
 * Monitors all non-orchestrator agents for responsiveness using a
 * non-intrusive, server-side approach:
 *
 * 1. Dual idle detection: Checks BOTH PTY activity (via PtyActivityTrackerService)
 *    AND API activity (via AgentHeartbeatService lastActiveTime). An agent is only
 *    considered truly idle when both signals are stale.
 *
 * 2. Process liveness check: Instead of injecting heartbeat requests into the
 *    agent's PTY input (which corrupts the input buffer and conflicts with
 *    orchestrator task delivery), this service checks isChildProcessAlive()
 *    on the session backend to determine if the agent process is still running.
 *
 * 3. Progressive restart: After MAX_DEAD_CHECKS_BEFORE_RESTART consecutive
 *    checks finding the process dead, triggers agent restart with session ID
 *    preservation and task re-delivery.
 *
 * Interaction with other services:
 * - IdleDetectionService (configurable timeout): Suspends idle but responsive agents
 * - AgentHeartbeatMonitorService: Restarts crashed/unresponsive agents
 * - RuntimeExitMonitorService: Detects exit patterns in PTY output (complementary)
 *
 * Key design principle: NEVER write to an agent's PTY input. All checks are
 * performed server-side via process inspection and API activity timestamps.
 *
 * @module agent-heartbeat-monitor.service
 */

import * as fs from 'fs/promises';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { AGENT_HEARTBEAT_MONITOR_CONSTANTS, AGENT_SUSPEND_CONSTANTS, ORCHESTRATOR_ROLE, SESSION_COMMAND_DELAYS, CREWLY_CONSTANTS } from '../../constants.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { AgentHeartbeatService } from './agent-heartbeat.service.js';
import { AgentSuspendService } from './agent-suspend.service.js';
import { RuntimeExitMonitorService } from './runtime-exit-monitor.service.js';
import { getSessionStatePersistence } from '../session/session-state-persistence.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import { TaskTrackingService } from '../project/task-tracking.service.js';
import type { AgentRegistrationService } from './agent-registration.service.js';
import type { ISessionBackend } from '../session/session-backend.interface.js';

/**
 * Number of consecutive dead-process checks before triggering a restart.
 * This prevents premature restarts from transient pgrep failures.
 */
const MAX_DEAD_CHECKS_BEFORE_RESTART = 3;

/**
 * Number of consecutive idle-but-alive checks before suspending heartbeat
 * monitoring for an agent. Once suspended, heartbeat is only resumed when
 * new API activity is detected. (#191)
 */
const IDLE_CHECKS_BEFORE_SUSPEND = 5;

/**
 * Per-agent monitoring state tracked by the heartbeat monitor.
 */
export interface AgentMonitorState {
	/** PTY session name */
	sessionName: string;
	/** Team member ID */
	memberId: string;
	/** Team ID */
	teamId: string;
	/** Agent role */
	role: string;
	/** Number of consecutive checks where the child process was found dead */
	consecutiveDeadChecks: number;
	/** Timestamps of recent restarts for cooldown tracking */
	restartTimestamps: number[];
	/** Total restart count */
	restartCount: number;
	/** Cached timestamp of last API activity (ms since epoch) for on-demand skip (#191) */
	lastApiCallTime: number;
	/** Number of consecutive checks where agent was idle but alive (#191) */
	consecutiveIdleChecks: number;
	/** Whether heartbeat monitoring is suspended for this idle agent (#191) */
	heartbeatSuspended: boolean;
}

/**
 * Monitors all non-orchestrator agents for responsiveness.
 *
 * Uses dual-signal idle detection (PTY activity + API heartbeat) and
 * server-side process liveness checks to detect crashed agents without
 * injecting into the agent's PTY input buffer.
 *
 * @example
 * ```typescript
 * const monitor = AgentHeartbeatMonitorService.getInstance();
 * monitor.setDependencies(sessionBackend, agentRegistrationService, storageService, taskTrackingService);
 * monitor.start();
 * ```
 */
export class AgentHeartbeatMonitorService {
	private static instance: AgentHeartbeatMonitorService | null = null;
	private logger: ComponentLogger;

	/** Interval timer handle */
	private checkTimer: ReturnType<typeof setInterval> | null = null;

	/** When monitoring started */
	private startedAt: number | null = null;

	/** Per-agent monitoring state */
	private agentStates: Map<string, AgentMonitorState> = new Map();

	/** Dependencies (injected via setDependencies) */
	private sessionBackend: ISessionBackend | null = null;
	private agentRegistrationService: AgentRegistrationService | null = null;
	private storageService: StorageService | null = null;
	private taskTrackingService: TaskTrackingService | null = null;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('AgentHeartbeatMonitor');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The AgentHeartbeatMonitorService singleton
	 */
	static getInstance(): AgentHeartbeatMonitorService {
		if (!AgentHeartbeatMonitorService.instance) {
			AgentHeartbeatMonitorService.instance = new AgentHeartbeatMonitorService();
		}
		return AgentHeartbeatMonitorService.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		if (AgentHeartbeatMonitorService.instance) {
			AgentHeartbeatMonitorService.instance.stop();
		}
		AgentHeartbeatMonitorService.instance = null;
	}

	/**
	 * Inject required dependencies.
	 *
	 * @param sessionBackend - Session backend for accessing agent PTY sessions
	 * @param agentRegistrationService - For recreating agent sessions on restart
	 * @param storageService - For querying teams and agent statuses
	 * @param taskTrackingService - For querying in-progress tasks for re-delivery
	 */
	setDependencies(
		sessionBackend: ISessionBackend,
		agentRegistrationService: AgentRegistrationService,
		storageService: StorageService,
		taskTrackingService: TaskTrackingService
	): void {
		this.sessionBackend = sessionBackend;
		this.agentRegistrationService = agentRegistrationService;
		this.storageService = storageService;
		this.taskTrackingService = taskTrackingService;
	}

	/**
	 * Start the heartbeat monitoring loop.
	 * Applies a startup grace period before the first check.
	 */
	start(): void {
		if (this.checkTimer) {
			this.logger.warn('Agent heartbeat monitor already running');
			return;
		}

		this.startedAt = Date.now();
		this.agentStates.clear();

		this.logger.info('Starting agent heartbeat monitor', {
			checkIntervalMs: AGENT_HEARTBEAT_MONITOR_CONSTANTS.CHECK_INTERVAL_MS,
			heartbeatRequestThresholdMs: AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS,
			startupGracePeriodMs: AGENT_HEARTBEAT_MONITOR_CONSTANTS.STARTUP_GRACE_PERIOD_MS,
			maxDeadChecksBeforeRestart: MAX_DEAD_CHECKS_BEFORE_RESTART,
		});

		this.checkTimer = setInterval(() => {
			this.performCheck().catch((err) => {
				this.logger.error('Agent heartbeat check failed', {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, AGENT_HEARTBEAT_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the heartbeat monitoring loop.
	 */
	stop(): void {
		if (this.checkTimer) {
			clearInterval(this.checkTimer);
			this.checkTimer = null;
			this.logger.info('Agent heartbeat monitor stopped');
		}
		this.agentStates.clear();
		this.startedAt = null;
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
	 * Get monitoring state for all tracked agents.
	 *
	 * @returns Map of session name to agent monitor state
	 */
	getAgentStates(): Map<string, AgentMonitorState> {
		return new Map(this.agentStates);
	}

	/**
	 * Resume heartbeat monitoring for a suspended agent.
	 * Called when an agent transitions from idle back to active work. (#191)
	 *
	 * @param sessionName - Session name of the agent to resume
	 */
	resumeHeartbeat(sessionName: string): void {
		const state = this.agentStates.get(sessionName);
		if (state && state.heartbeatSuspended) {
			state.heartbeatSuspended = false;
			state.consecutiveIdleChecks = 0;
			this.logger.info('Heartbeat monitoring resumed for agent', { sessionName });
		}
	}

	/**
	 * Perform a single heartbeat check cycle across all active agents.
	 *
	 * For each active non-orchestrator agent:
	 * 1. Skip if within startup grace period
	 * 2. Skip if session doesn't exist, or agent is suspended/rehydrating
	 * 3. Check dual idle signals (PTY + API). If either is recent → agent is alive → reset dead checks
	 * 4. If truly idle (both PTY and API stale for threshold), check process liveness
	 * 5. If process is alive → agent is idle but responsive → reset dead checks (let IdleDetectionService handle)
	 * 6. If process is dead → increment consecutiveDeadChecks
	 * 7. After MAX_DEAD_CHECKS_BEFORE_RESTART consecutive dead checks → restart agent
	 */
	async performCheck(): Promise<void> {
		// Guard: startup grace period
		if (this.startedAt && (Date.now() - this.startedAt) < AGENT_HEARTBEAT_MONITOR_CONSTANTS.STARTUP_GRACE_PERIOD_MS) {
			return;
		}

		// Guard: dependencies not set
		if (!this.sessionBackend || !this.storageService) {
			return;
		}

		// Get all teams and iterate over active non-orchestrator members
		const teams = await this.storageService.getTeams();
		const activityTracker = PtyActivityTrackerService.getInstance();
		const suspendService = AgentSuspendService.getInstance();

		for (const team of teams) {
			for (const member of team.members || []) {
				// Skip inactive agents
				if (member.agentStatus !== 'active') {
					continue;
				}

				// Skip suspended or rehydrating agents
				if (suspendService.isSuspended(member.sessionName) || suspendService.isRehydrating(member.sessionName)) {
					continue;
				}

				// #220: Auto-downgrade agent status when session is gone.
				// Previously this only cleaned up monitor state without marking
				// the agent inactive, causing "ghost" active statuses in the API.
				if (!this.sessionBackend.sessionExists(member.sessionName)) {
					this.agentStates.delete(member.sessionName);

					// Mark agent as inactive in storage so API reflects reality
					try {
						await this.storageService.updateAgentStatus(
							member.sessionName,
							CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
						);
						this.logger.warn('Ghost agent detected: session gone, marked inactive (#220)', {
							sessionName: member.sessionName,
							memberId: member.id,
							teamId: team.id,
						});

						// Broadcast status change to WebSocket clients
						const gateway = getTerminalGateway();
						if (gateway) {
							gateway.broadcastTeamMemberStatus({
								teamId: team.id,
								memberId: member.id,
								agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
							});
						}
					} catch (err) {
						this.logger.error('Failed to downgrade ghost agent status', {
							sessionName: member.sessionName,
							error: err instanceof Error ? err.message : String(err),
						});
					}

					continue;
				}

				// Ensure state exists for this agent
				if (!this.agentStates.has(member.sessionName)) {
					this.agentStates.set(member.sessionName, {
						sessionName: member.sessionName,
						memberId: member.id,
						teamId: team.id,
						role: member.role,
						consecutiveDeadChecks: 0,
						restartTimestamps: [],
						restartCount: 0,
						lastApiCallTime: Date.now(),
						consecutiveIdleChecks: 0,
						heartbeatSuspended: false,
					});
				}

				const state = this.agentStates.get(member.sessionName)!;

				// #191: Orchestrator gets unconditional liveness checks (no skip/suspend)
				// Non-orchestrator agents can be skipped or suspended based on activity.
				const isOrchestrator = member.role === ORCHESTRATOR_ROLE;

				// #191: Check API activity and update cached lastApiCallTime
				const apiIdleMs = await this.getApiIdleTimeMs(member.id);
				if (apiIdleMs < AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS) {
					state.lastApiCallTime = Date.now() - apiIdleMs;
				}

				// #191: For non-orchestrator agents, skip if recently active via API
				if (!isOrchestrator && apiIdleMs < AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS) {
					// Recent API activity — agent is alive, reset all counters and unsuspend
					if (state.consecutiveDeadChecks > 0 || state.heartbeatSuspended) {
						this.logger.info('Agent API activity detected, resetting counters', {
							sessionName: member.sessionName,
							apiIdleMs,
							wasSuspended: state.heartbeatSuspended,
						});
					}
					state.consecutiveDeadChecks = 0;
					state.consecutiveIdleChecks = 0;
					state.heartbeatSuspended = false;
					continue;
				}

				// #191: Skip suspended agents (non-orchestrator only).
				// Agents are unsuspended above when API activity resumes.
				if (!isOrchestrator && state.heartbeatSuspended) {
					continue;
				}

				// Check dual idle signals: PTY activity AND API heartbeat
				const ptyIdleMs = activityTracker.getIdleTimeMs(member.sessionName);

				// If either signal shows recent activity, the agent is alive
				const trulyIdle = ptyIdleMs >= AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS
					&& apiIdleMs >= AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS;

				if (!trulyIdle) {
					// Agent has recent activity — reset dead checks and idle checks
					if (state.consecutiveDeadChecks > 0) {
						this.logger.info('Agent activity detected, resetting dead check counter', {
							sessionName: member.sessionName,
							ptyIdleMs,
							apiIdleMs,
							previousDeadChecks: state.consecutiveDeadChecks,
						});
						state.consecutiveDeadChecks = 0;
					}
					state.consecutiveIdleChecks = 0;
					continue;
				}

				// Agent is truly idle — check if the child process is still alive
				const processAlive = this.isChildProcessAlive(member.sessionName);

				if (processAlive) {
					// Process is alive but idle — this is fine, IdleDetectionService handles suspension
					if (state.consecutiveDeadChecks > 0) {
						this.logger.debug('Agent process alive despite idle, resetting dead checks', {
							sessionName: member.sessionName,
						});
						state.consecutiveDeadChecks = 0;
					}

					// #191: Track consecutive idle checks for non-orchestrator agents.
					// After IDLE_CHECKS_BEFORE_SUSPEND, suspend heartbeat monitoring.
					if (!isOrchestrator) {
						state.consecutiveIdleChecks++;
						if (state.consecutiveIdleChecks >= IDLE_CHECKS_BEFORE_SUSPEND) {
							state.heartbeatSuspended = true;
							this.logger.info('Suspending heartbeat for idle agent', {
								sessionName: member.sessionName,
								consecutiveIdleChecks: state.consecutiveIdleChecks,
							});
						}
					}
					continue;
				}

				// Child process is dead — increment counter
				state.consecutiveDeadChecks++;

				this.logger.warn('Agent child process not alive', {
					sessionName: member.sessionName,
					consecutiveDeadChecks: state.consecutiveDeadChecks,
					maxBeforeRestart: MAX_DEAD_CHECKS_BEFORE_RESTART,
					ptyIdleMs,
					apiIdleMs,
				});

				// After enough consecutive dead checks, trigger restart
				if (state.consecutiveDeadChecks >= MAX_DEAD_CHECKS_BEFORE_RESTART) {
					this.logger.warn('Agent unresponsive after multiple dead checks, triggering restart', {
						sessionName: member.sessionName,
						consecutiveDeadChecks: state.consecutiveDeadChecks,
					});

					state.consecutiveDeadChecks = 0;
					await this.triggerAgentRestart(state);
				}
			}
		}
	}

	/**
	 * Get the API idle time in milliseconds for a team member.
	 *
	 * Reads the agent's lastActiveTime from AgentHeartbeatService and
	 * calculates how long ago it was. Returns 0 if no heartbeat data
	 * exists (treat as "just started").
	 *
	 * @param memberId - Team member ID to check
	 * @returns Milliseconds since last API activity, or 0 if unknown
	 */
	private async getApiIdleTimeMs(memberId: string): Promise<number> {
		try {
			const heartbeat = await AgentHeartbeatService.getInstance().getAgentHeartbeat(memberId);
			if (!heartbeat || !heartbeat.lastActiveTime) {
				return 0;
			}
			const lastActive = new Date(heartbeat.lastActiveTime).getTime();
			if (isNaN(lastActive)) {
				return 0;
			}
			return Math.max(0, Date.now() - lastActive);
		} catch {
			// If heartbeat service fails, don't treat as idle
			return 0;
		}
	}

	/**
	 * Check if the child process (e.g. Claude Code) inside an agent's
	 * PTY shell is still alive.
	 *
	 * Uses the session backend's isChildProcessAlive() method which
	 * inspects the process tree via pgrep. This is a non-intrusive
	 * server-side check that does not write to the agent's PTY.
	 *
	 * @param sessionName - Session to check
	 * @returns true if child process is alive, false if dead or check unavailable
	 */
	private isChildProcessAlive(sessionName: string): boolean {
		if (!this.sessionBackend) {
			return true; // Assume alive if we can't check
		}

		try {
			if (typeof this.sessionBackend.isChildProcessAlive === 'function') {
				return this.sessionBackend.isChildProcessAlive(sessionName);
			}
			// If backend doesn't support process liveness check, assume alive
			return true;
		} catch {
			// On error, assume alive to avoid false restarts
			return true;
		}
	}

	/**
	 * Restart a crashed/unresponsive agent.
	 *
	 * Follows the AgentSuspendService.rehydrateAgent() pattern:
	 * 1. Check cooldown (max restarts per window)
	 * 2. Save Claude session ID for resume
	 * 3. Stop exit monitoring
	 * 4. Kill old PTY session
	 * 5. Pre-set session ID for resume
	 * 6. Recreate agent session via AgentRegistrationService
	 * 7. Re-deliver in-progress tasks
	 * 8. Broadcast WebSocket event
	 *
	 * @param state - Agent monitor state
	 */
	private async triggerAgentRestart(state: AgentMonitorState): Promise<void> {
		if (!this.sessionBackend || !this.agentRegistrationService) {
			return;
		}

		// Check cooldown
		const now = Date.now();
		const windowStart = now - AGENT_HEARTBEAT_MONITOR_CONSTANTS.COOLDOWN_WINDOW_MS;
		state.restartTimestamps = state.restartTimestamps.filter(ts => ts > windowStart);

		if (state.restartTimestamps.length >= AGENT_HEARTBEAT_MONITOR_CONSTANTS.MAX_RESTARTS_PER_WINDOW) {
			this.logger.warn('Agent restart cooldown active, skipping restart', {
				sessionName: state.sessionName,
				restartsInWindow: state.restartTimestamps.length,
				maxRestartsPerWindow: AGENT_HEARTBEAT_MONITOR_CONSTANTS.MAX_RESTARTS_PER_WINDOW,
			});
			return;
		}

		try {
			// Save Claude session ID before killing
			let claudeSessionId: string | undefined;
			try {
				const persistence = getSessionStatePersistence();
				claudeSessionId = persistence.getSessionId(state.sessionName);
			} catch {
				this.logger.warn('Could not retrieve Claude session ID for restart', {
					sessionName: state.sessionName,
				});
			}

			// Stop runtime exit monitoring to avoid triggering exit callbacks
			RuntimeExitMonitorService.getInstance().stopMonitoring(state.sessionName);

			// Kill old PTY session
			if (this.sessionBackend.sessionExists(state.sessionName)) {
				await this.sessionBackend.killSession(state.sessionName);
			}

			// Clear PTY activity tracker
			PtyActivityTrackerService.getInstance().clearSession(state.sessionName);

			// Pre-set session ID for resume
			if (claudeSessionId) {
				try {
					const persistence = getSessionStatePersistence();
					const metadata = persistence.getSessionMetadata(state.sessionName);
					if (metadata) {
						persistence.updateSessionId(state.sessionName, claudeSessionId);
					}
				} catch {
					this.logger.warn('Could not pre-set session ID for resume', {
						sessionName: state.sessionName,
					});
				}
			}

			// Recreate agent session
			const result = await this.agentRegistrationService.createAgentSession({
				sessionName: state.sessionName,
				role: state.role,
				teamId: state.teamId,
				memberId: state.memberId,
			});

			if (!result.success) {
				this.logger.error('Agent restart createAgentSession failed', {
					sessionName: state.sessionName,
					error: result.error,
				});
				return;
			}

			// Track restart
			state.restartTimestamps.push(now);
			state.restartCount++;

			// Broadcast agent restarted event
			const terminalGateway = getTerminalGateway();
			if (terminalGateway) {
				terminalGateway.broadcastTeamMemberStatus({
					teamId: state.teamId,
					memberId: state.memberId,
					sessionName: state.sessionName,
					agentStatus: 'active',
				});
			}

			this.logger.info('Agent restarted successfully', {
				sessionName: state.sessionName,
				restartCount: state.restartCount,
				claudeSessionId: claudeSessionId ? '(resumed)' : '(fresh)',
			});

			// Re-deliver in-progress tasks (async, non-blocking)
			this.redeliverTasks(state).catch((err) => {
				this.logger.error('Task re-delivery failed after agent restart', {
					sessionName: state.sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		} catch (err) {
			this.logger.error('Failed to restart agent', {
				sessionName: state.sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Re-deliver in-progress tasks to a restarted agent.
	 *
	 * Waits for the agent to initialize, queries TaskTrackingService for
	 * assigned/active tasks, reads task files, and writes summaries into
	 * the agent's PTY session.
	 *
	 * @param state - Agent monitor state
	 */
	private async redeliverTasks(state: AgentMonitorState): Promise<void> {
		if (!this.taskTrackingService || !this.sessionBackend) {
			return;
		}

		// Wait for agent initialization
		await new Promise(resolve => setTimeout(resolve, AGENT_SUSPEND_CONSTANTS.REHYDRATION_TIMEOUT_MS));

		// Verify agent session exists after waiting
		if (!this.sessionBackend.sessionExists(state.sessionName)) {
			this.logger.warn('Agent session not found after restart, skipping task re-delivery', {
				sessionName: state.sessionName,
			});
			return;
		}

		// Query tasks for this team member
		const tasks = await this.taskTrackingService.getTasksForTeamMember(state.memberId);
		const activeTasks = tasks.filter(t => t.status === 'assigned' || t.status === 'active');

		if (activeTasks.length === 0) {
			this.logger.debug('No active tasks to re-deliver', { sessionName: state.sessionName });
			return;
		}

		this.logger.info('Re-delivering tasks to restarted agent', {
			sessionName: state.sessionName,
			taskCount: activeTasks.length,
		});

		const session = this.sessionBackend.getSession(state.sessionName);
		if (!session) {
			return;
		}

		for (const task of activeTasks) {
			// Read task file content
			let taskContent = '';
			try {
				taskContent = await fs.readFile(task.taskFilePath, 'utf-8');
				// Truncate to 2000 chars
				if (taskContent.length > 2000) {
					taskContent = taskContent.slice(0, 2000) + '\n... (truncated)';
				}
			} catch {
				taskContent = '(task file not found)';
			}

			const message = [
				'[TASK RE-DELIVERY] You were working on this task before your session was restarted:',
				`Task: ${task.taskName}`,
				`File: ${task.taskFilePath}`,
				'---',
				taskContent,
				'---',
				'Please continue working on this task.',
			].join('\n');

			// Write message and Enter as separate writes so that Enter is not
			// swallowed by the terminal's bracketed paste mode.
			session.write(message);

			// Delay to let the terminal finish processing the paste, then send Enter
			const pasteDelay = Math.min(
				SESSION_COMMAND_DELAYS.MESSAGE_DELAY + Math.ceil(message.length / 10),
				5000
			);
			await new Promise(resolve => setTimeout(resolve, pasteDelay));
			session.write('\r');

			// Delay between tasks to avoid flooding
			await new Promise(resolve => setTimeout(resolve, 2000));
		}

		this.logger.info('Task re-delivery complete', {
			sessionName: state.sessionName,
			tasksDelivered: activeTasks.length,
		});
	}
}
