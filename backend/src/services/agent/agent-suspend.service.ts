/**
 * Agent Suspend Service
 *
 * Central coordinator for the agent suspend/rehydrate lifecycle.
 * Suspends idle agents to free resources (RAM/disk) and transparently
 * rehydrates them when the orchestrator sends a message, using
 * Claude Code's `--resume` flag to restore conversation context.
 *
 * @module agent-suspend-service
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { CREWLY_CONSTANTS, AGENT_SUSPEND_CONSTANTS } from '../../constants.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { DiskCleanupService } from './disk-cleanup.service.js';
import { RuntimeExitMonitorService } from './runtime-exit-monitor.service.js';
import { getSessionBackendSync, getSessionStatePersistence } from '../session/index.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import type { AgentRegistrationService } from './agent-registration.service.js';

/**
 * Information stored for each suspended agent.
 */
export interface SuspendedAgentInfo {
	/** PTY session name */
	sessionName: string;
	/** Team ID the agent belongs to */
	teamId: string;
	/** Member ID within the team */
	memberId: string;
	/** Agent role (developer, qa, etc.) */
	role: string;
	/** Claude conversation session ID for --resume */
	claudeSessionId?: string;
	/** ISO timestamp when the agent was suspended */
	suspendedAt: string;
}

/**
 * Manages suspension and rehydration of idle agents.
 *
 * Lifecycle:
 * - `active → suspended`: Idle timeout triggers suspendAgent()
 * - `suspended → starting → active`: Message triggers rehydrateAgent()
 * - `suspended → inactive`: Manual stop by user
 */
export class AgentSuspendService {
	private static instance: AgentSuspendService | null = null;
	private logger: ComponentLogger;

	/** Map of sessionName → suspended agent metadata */
	private suspendedAgents: Map<string, SuspendedAgentInfo> = new Map();

	/** Set of sessionNames currently being rehydrated (dedup guard) */
	private rehydratingSet: Set<string> = new Set();

	/** Injected AgentRegistrationService (set via setDependencies) */
	private agentRegistrationService: AgentRegistrationService | null = null;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('AgentSuspend');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The AgentSuspendService singleton
	 */
	static getInstance(): AgentSuspendService {
		if (!AgentSuspendService.instance) {
			AgentSuspendService.instance = new AgentSuspendService();
		}
		return AgentSuspendService.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		AgentSuspendService.instance = null;
	}

	/**
	 * Inject the AgentRegistrationService dependency.
	 * Must be called during server startup before rehydration can work.
	 *
	 * @param registrationService - The AgentRegistrationService instance
	 */
	setDependencies(registrationService: AgentRegistrationService): void {
		this.agentRegistrationService = registrationService;
		this.logger.info('AgentSuspendService dependencies set');
	}

	/**
	 * Suspend an active agent, killing its process but preserving
	 * the Claude session ID so it can be rehydrated later.
	 *
	 * @param sessionName - PTY session name
	 * @param teamId - Team ID
	 * @param memberId - Member ID within the team
	 * @param role - Agent role
	 * @returns True if suspension was successful
	 */
	async suspendAgent(
		sessionName: string,
		teamId: string,
		memberId: string,
		role: string
	): Promise<boolean> {
		// Guard: exempt roles
		if (AGENT_SUSPEND_CONSTANTS.EXEMPT_ROLES.includes(role as typeof AGENT_SUSPEND_CONSTANTS.EXEMPT_ROLES[number])) {
			this.logger.warn('Cannot suspend exempt role', { sessionName, role });
			return false;
		}

		// Guard: already suspended
		if (this.suspendedAgents.has(sessionName)) {
			this.logger.warn('Agent is already suspended', { sessionName });
			return false;
		}

		try {
			// Get Claude session ID from persistence before killing
			let claudeSessionId: string | undefined;
			try {
				const persistence = getSessionStatePersistence();
				claudeSessionId = persistence.getSessionId(sessionName);
			} catch {
				this.logger.warn('Could not retrieve Claude session ID for suspend', { sessionName });
			}

			// Save suspend info
			const info: SuspendedAgentInfo = {
				sessionName,
				teamId,
				memberId,
				role,
				claudeSessionId,
				suspendedAt: new Date().toISOString(),
			};
			this.suspendedAgents.set(sessionName, info);

			// Stop runtime exit monitoring (don't trigger exit callbacks)
			RuntimeExitMonitorService.getInstance().stopMonitoring(sessionName);

			// Kill the PTY session
			const backend = getSessionBackendSync();
			if (backend && backend.sessionExists(sessionName)) {
				await backend.killSession(sessionName);
			}

			// Clear PTY activity tracker
			PtyActivityTrackerService.getInstance().clearSession(sessionName);

			// Run disk cleanup
			DiskCleanupService.getInstance().runSuspendCleanup();

			// Update status to suspended
			await StorageService.getInstance().updateAgentStatus(
				sessionName,
				CREWLY_CONSTANTS.AGENT_STATUSES.SUSPENDED as any
			);

			// Broadcast status change to frontend
			const terminalGateway = getTerminalGateway();
			if (terminalGateway) {
				terminalGateway.broadcastTeamMemberStatus({
					teamId,
					memberId,
					sessionName,
					agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.SUSPENDED,
				});
			}

			this.logger.info('Agent suspended successfully', {
				sessionName,
				role,
				claudeSessionId: claudeSessionId ? '(saved)' : '(none)',
			});

			return true;
		} catch (error) {
			// Rollback: remove from suspended map on failure
			this.suspendedAgents.delete(sessionName);
			this.logger.error('Failed to suspend agent', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Rehydrate a suspended agent by recreating its session.
	 * Uses the saved Claude session ID for `--resume` to restore context.
	 *
	 * @param sessionName - PTY session name of the suspended agent
	 * @returns True if rehydration was initiated (not necessarily complete)
	 */
	async rehydrateAgent(sessionName: string): Promise<boolean> {
		// Guard: deduplicate concurrent calls
		if (this.rehydratingSet.has(sessionName)) {
			this.logger.debug('Rehydration already in progress', { sessionName });
			return true;
		}

		const info = this.suspendedAgents.get(sessionName);
		if (!info) {
			this.logger.warn('Cannot rehydrate: agent not in suspended map', { sessionName });
			return false;
		}

		this.rehydratingSet.add(sessionName);

		try {
			// Update status to starting
			await StorageService.getInstance().updateAgentStatus(
				sessionName,
				CREWLY_CONSTANTS.AGENT_STATUSES.STARTING as any
			);

			// Broadcast starting status
			const terminalGateway = getTerminalGateway();
			if (terminalGateway) {
				terminalGateway.broadcastTeamMemberStatus({
					teamId: info.teamId,
					memberId: info.memberId,
					sessionName,
					agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.STARTING,
				});
			}

			// Ensure session persistence has the saved claudeSessionId
			// so createAgentSession's resume logic picks it up
			if (info.claudeSessionId) {
				try {
					const persistence = getSessionStatePersistence();
					const metadata = persistence.getSessionMetadata(sessionName);
					if (metadata) {
						persistence.updateSessionId(sessionName, info.claudeSessionId);
					}
				} catch {
					this.logger.warn('Could not pre-set session ID for resume', { sessionName });
				}
			}

			if (!this.agentRegistrationService) {
				this.logger.error('Cannot rehydrate: AgentRegistrationService not set (call setDependencies first)');
				return false;
			}

			// Recreate the agent session (this triggers the resume flow internally)
			const result = await this.agentRegistrationService.createAgentSession({
				sessionName,
				role: info.role,
				teamId: info.teamId,
				memberId: info.memberId,
				// Nobody asked for this start: leave a start-up blocked on the user alone.
				automatic: true,
			});

			if (!result.success) {
				this.logger.error('Rehydration createAgentSession failed', {
					sessionName,
					error: result.error,
				});
				// Revert to suspended status
				await StorageService.getInstance().updateAgentStatus(
					sessionName,
					CREWLY_CONSTANTS.AGENT_STATUSES.SUSPENDED as any
				);
				return false;
			}

			// Wait for agent to become active (poll with timeout)
			const timeoutMs = AGENT_SUSPEND_CONSTANTS.REHYDRATION_TIMEOUT_MS;
			const pollInterval = 2000;
			const startTime = Date.now();
			let active = false;

			while (Date.now() - startTime < timeoutMs) {
				const memberResult = await StorageService.getInstance().findMemberBySessionName(sessionName);
				if (memberResult?.member.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE) {
					active = true;
					break;
				}
				await new Promise(resolve => setTimeout(resolve, pollInterval));
			}

			if (active) {
				// Success — remove from suspended map
				this.suspendedAgents.delete(sessionName);
				this.logger.info('Agent rehydrated successfully', { sessionName });
				return true;
			} else {
				this.logger.warn('Rehydration timed out waiting for active status', {
					sessionName,
					timeoutMs,
				});
				// Leave in suspended map — messages remain queued
				return false;
			}
		} catch (error) {
			this.logger.error('Rehydration failed', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			// Revert to suspended status
			try {
				await StorageService.getInstance().updateAgentStatus(
					sessionName,
					CREWLY_CONSTANTS.AGENT_STATUSES.SUSPENDED as any
				);
			} catch {
				// Best effort
			}
			return false;
		} finally {
			this.rehydratingSet.delete(sessionName);
		}
	}

	/**
	 * Check if a session is currently suspended.
	 *
	 * @param sessionName - PTY session name
	 * @returns True if the agent is suspended
	 */
	isSuspended(sessionName: string): boolean {
		return this.suspendedAgents.has(sessionName);
	}

	/**
	 * Check if a session is currently being rehydrated.
	 *
	 * @param sessionName - PTY session name
	 * @returns True if rehydration is in progress
	 */
	isRehydrating(sessionName: string): boolean {
		return this.rehydratingSet.has(sessionName);
	}

	/**
	 * Get suspend information for a session.
	 *
	 * @param sessionName - PTY session name
	 * @returns Suspend info or null if not suspended
	 */
	getSuspendInfo(sessionName: string): SuspendedAgentInfo | null {
		return this.suspendedAgents.get(sessionName) ?? null;
	}

	/**
	 * Remove an agent from the suspended map without rehydrating.
	 * Used when a suspended agent is manually stopped by the user.
	 *
	 * @param sessionName - PTY session name
	 */
	removeSuspended(sessionName: string): void {
		this.suspendedAgents.delete(sessionName);
	}

	/**
	 * Get the count of currently suspended agents.
	 *
	 * @returns Number of suspended agents
	 */
	getSuspendedCount(): number {
		return this.suspendedAgents.size;
	}
}
