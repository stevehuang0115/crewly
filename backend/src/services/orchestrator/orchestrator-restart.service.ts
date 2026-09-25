/**
 * Orchestrator Restart Service
 *
 * Automatically restarts the orchestrator when it becomes unresponsive
 * (child process dies inside the PTY shell). Enforces a cooldown window
 * to prevent restart loops.
 *
 * @module orchestrator-restart.service
 */

import {
	ORCHESTRATOR_SESSION_NAME,
	ORCHESTRATOR_ROLE,
	ORCHESTRATOR_WINDOW_NAME,
	ORCHESTRATOR_RESTART_CONSTANTS,
	CLAUDE_STARTUP_CONSTANTS,
	RUNTIME_TYPES,
	type RuntimeType,
} from '../../constants.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { formatError } from '../../utils/format-error.js';
import { StorageService } from '../core/storage.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import type { AgentRegistrationService } from '../agent/agent-registration.service.js';
import type { ISessionBackend } from '../session/session-backend.interface.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';
import { delay } from '../../utils/async.utils.js';

/**
 * Restart statistics for monitoring
 */
export interface RestartStats {
	/** Total number of restarts since service creation */
	totalRestarts: number;
	/** Restarts within the current cooldown window */
	restartsInWindow: number;
	/** Whether a restart is currently in progress */
	isRestarting: boolean;
	/** Timestamp of the last successful restart */
	lastRestartAt: string | null;
	/** Whether further restarts are allowed under cooldown */
	restartAllowed: boolean;
	/** Failed restarts in a row since the orchestrator last ran */
	consecutiveFailures: number;
	/** Set once auto-restart has stopped trying; null while it still tries */
	gaveUp: RestartGiveUp | null;
}

/** Why auto-restart stopped trying, surfaced to the user. */
export interface RestartGiveUp {
	/** The last failure's user-facing reason */
	reason: string;
	/** Failed attempts that led here */
	attempts: number;
	/** ISO time auto-restart stopped */
	at: string;
	/** True when the failure needs the user (e.g. runtime not installed / not signed in) */
	blocked: boolean;
}

/**
 * OrchestratorRestartService manages automatic restart of the orchestrator
 * when the child process (Claude Code) dies inside the PTY shell.
 *
 * Features:
 * - Kills the old PTY session before creating a new one
 * - Initializes memory and starts chat monitoring
 * - Notifies via Slack (if configured)
 * - Broadcasts WebSocket event for UI updates
 * - Enforces max 3 restarts per hour cooldown (failed attempts count too)
 * - Stops after MAX_CONSECUTIVE_FAILURES failures in a row, or at once when
 *   start-up is blocked on the user, and surfaces the reason (getGiveUp)
 *
 * @example
 * ```typescript
 * const service = OrchestratorRestartService.getInstance();
 * service.setDependencies(agentRegistrationService, sessionBackend, io);
 * await service.attemptRestart();
 * ```
 */
export class OrchestratorRestartService {
	private static instance: OrchestratorRestartService | null = null;
	private logger: ComponentLogger;

	/** Timestamps of recent restarts for cooldown tracking */
	private restartTimestamps: number[] = [];
	/** Total restart count since service creation */
	private totalRestarts = 0;
	/** Flag to prevent concurrent restart attempts */
	private isRestarting = false;
	/** Failed restarts in a row since the orchestrator last ran */
	private consecutiveFailures = 0;
	/** Set when auto-restart has stopped trying (see {@link markGaveUp}) */
	private gaveUp: RestartGiveUp | null = null;

	/** External dependencies (injected via setDependencies) */
	private agentRegistrationService: AgentRegistrationService | null = null;
	private sessionBackend: ISessionBackend | null = null;
	private socketIO: { emit: (event: string, data: unknown) => void } | null = null;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('OrchestratorRestart');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The OrchestratorRestartService instance
	 */
	static getInstance(): OrchestratorRestartService {
		if (!OrchestratorRestartService.instance) {
			OrchestratorRestartService.instance = new OrchestratorRestartService();
		}
		return OrchestratorRestartService.instance;
	}

	/**
	 * Reset the singleton instance (for testing).
	 */
	static resetInstance(): void {
		if (OrchestratorRestartService.instance) {
			// Clear internal state to prevent stale references
			OrchestratorRestartService.instance.agentRegistrationService = null;
			OrchestratorRestartService.instance.sessionBackend = null;
			OrchestratorRestartService.instance.socketIO = null;
			OrchestratorRestartService.instance.restartTimestamps = [];
			OrchestratorRestartService.instance.isRestarting = false;
			OrchestratorRestartService.instance.consecutiveFailures = 0;
			OrchestratorRestartService.instance.gaveUp = null;
		}
		OrchestratorRestartService.instance = null;
	}
	/**
	 * Inject external dependencies.
	 *
	 * @param agentRegistrationService - Service for creating agent sessions
	 * @param sessionBackend - Session backend for killing old sessions
	 * @param socketIO - Socket.IO server for broadcasting events
	 */
	setDependencies(
		agentRegistrationService: AgentRegistrationService,
		sessionBackend: ISessionBackend,
		socketIO?: { emit: (event: string, data: unknown) => void }
	): void {
		this.agentRegistrationService = agentRegistrationService;
		this.sessionBackend = sessionBackend;
		this.socketIO = socketIO ?? null;
	}

	/**
	 * Check if a restart is currently allowed under the cooldown window.
	 *
	 * @returns true if restart is allowed
	 */
	isRestartAllowed(): boolean {
		const now = Date.now();
		const windowStart = now - ORCHESTRATOR_RESTART_CONSTANTS.COOLDOWN_WINDOW_MS;

		// Prune timestamps outside the window
		this.restartTimestamps = this.restartTimestamps.filter((ts) => ts > windowStart);

		return this.restartTimestamps.length < ORCHESTRATOR_RESTART_CONSTANTS.MAX_RESTARTS_PER_WINDOW;
	}

	/**
	 * Attempt to restart the orchestrator.
	 *
	 * This method:
	 * 1. Checks cooldown limits
	 * 2. Kills the old PTY session
	 * 3. Creates a new agent session
	 * 4. Initializes memory
	 * 5. Starts chat monitoring
	 * 6. Notifies Slack (if configured)
	 * 7. Broadcasts WebSocket event
	 *
	 * @returns true if restart succeeded, false otherwise
	 */
	async attemptRestart(): Promise<boolean> {
		if (this.gaveUp) {
			return false;
		}

		if (this.isRestarting) {
			this.logger.warn('Restart already in progress, skipping');
			return false;
		}

		if (!this.isRestartAllowed()) {
			this.logger.warn('Restart cooldown active, skipping', {
				restartsInWindow: this.restartTimestamps.length,
				maxAllowed: ORCHESTRATOR_RESTART_CONSTANTS.MAX_RESTARTS_PER_WINDOW,
			});
			return false;
		}

		if (!this.agentRegistrationService || !this.sessionBackend) {
			this.logger.error('Dependencies not set, cannot restart');
			return false;
		}

		this.isRestarting = true;

		try {
			this.logger.info('Attempting orchestrator restart...');

			// Step 1: Wait a brief delay for cleanup
			await delay(ORCHESTRATOR_RESTART_CONSTANTS.RESTART_DELAY_MS);

			// Step 2: Kill the old PTY session
			try {
				if (this.sessionBackend.sessionExists(ORCHESTRATOR_SESSION_NAME)) {
					await this.sessionBackend.killSession(ORCHESTRATOR_SESSION_NAME);
					this.logger.info('Killed old orchestrator session');
				}
			} catch (killErr) {
				this.logger.warn('Error killing old session (continuing with restart)', {
					error: killErr instanceof Error ? killErr.message : String(killErr),
				});
			}

			// Step 2b: Clear stale activity tracking data so the new session
			// starts fresh. Without this, the heartbeat monitor inherits the
			// old session's last API timestamp and immediately sees 50+ min
			// idle time, triggering another restart loop.
			PtyActivityTrackerService.getInstance().clearSession(ORCHESTRATOR_SESSION_NAME);

			// Step 3: Determine runtime type (preserve the orchestrator's configured runtime).
			const runtimeType = await this.resolveOrchestratorRuntimeType();

			// Step 3b: For Gemini CLI, gather existing project paths for /directory allowlist.
			let additionalAllowlistPaths: string[] | undefined;
			if (runtimeType === RUNTIME_TYPES.GEMINI_CLI) {
				try {
					const storageService = StorageService.getInstance();
					const projects = await storageService.getProjects();
					additionalAllowlistPaths = projects.map(project => project.path);
					if (additionalAllowlistPaths.length > 0) {
						this.logger.info('Will add project paths to Gemini CLI allowlist during restart', {
							projectCount: additionalAllowlistPaths.length,
						});
					}
				} catch (error) {
					this.logger.warn('Failed to get projects for Gemini CLI allowlist (continuing without)', {
						error: formatError(error),
					});
				}
			}

			// Step 4: Create new agent session
			const result = await this.agentRegistrationService.createAgentSession({
				sessionName: ORCHESTRATOR_SESSION_NAME,
				role: ORCHESTRATOR_ROLE,
				projectPath: process.cwd(),
				windowName: ORCHESTRATOR_WINDOW_NAME,
				runtimeType,
				additionalAllowlistPaths,
			});

			if (!result.success) {
				this.logger.error('Failed to create new orchestrator session', {
					error: result.error,
					errorCode: result.errorCode,
				});
				this.recordFailure(
					result.error || 'the orchestrator session could not be created',
					result.errorCode === CLAUDE_STARTUP_CONSTANTS.BLOCKED_ERROR_CODE,
				);
				return false;
			}

			// Step 5: Initialize memory
			try {
				const memoryService = MemoryService.getInstance();
				await memoryService.initializeForSession(
					ORCHESTRATOR_SESSION_NAME,
					ORCHESTRATOR_ROLE,
					process.cwd()
				);
			} catch (memoryErr) {
				this.logger.warn('Failed to initialize memory during restart', {
					error: memoryErr instanceof Error ? memoryErr.message : String(memoryErr),
				});
			}

			// Step 6: Start chat monitoring
			try {
				const terminalGateway = getTerminalGateway();
				if (terminalGateway) {
					terminalGateway.startOrchestratorChatMonitoring(ORCHESTRATOR_SESSION_NAME);
				}
			} catch (chatErr) {
				this.logger.warn('Failed to start chat monitoring during restart', {
					error: chatErr instanceof Error ? chatErr.message : String(chatErr),
				});
			}

			// Step 7: Notify via Slack (fire-and-forget)
			this.notifySlack().catch(() => {
				// Slack notification is best-effort
			});

			// Step 8: Broadcast WebSocket event
			if (this.socketIO) {
				this.socketIO.emit('orchestrator:restarted', {
					timestamp: new Date().toISOString(),
					restartCount: this.totalRestarts + 1,
				});
			}

			// Track restart
			this.restartTimestamps.push(Date.now());
			this.totalRestarts++;
			this.consecutiveFailures = 0;

			this.logger.info('Orchestrator restart successful', {
				totalRestarts: this.totalRestarts,
			});

			return true;
		} catch (error) {
			this.logger.error('Orchestrator restart failed', {
				error: formatError(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			this.recordFailure(formatError(error), false);
			return false;
		} finally {
			this.isRestarting = false;
		}
	}

	/**
	 * Count a failed restart. Failed attempts also take a slot in the cooldown
	 * window (before, only successes did, so failures were never limited). On a
	 * start-up blocked on the user, or after MAX_CONSECUTIVE_FAILURES in a row,
	 * auto-restart stops (see {@link markGaveUp}).
	 *
	 * @param reason - User-facing reason of this failure
	 * @param blocked - True when retrying cannot help (RUNTIME_STARTUP_BLOCKED)
	 */
	private recordFailure(reason: string, blocked: boolean): void {
		this.restartTimestamps.push(Date.now());
		this.consecutiveFailures++;
		if (blocked || this.consecutiveFailures >= ORCHESTRATOR_RESTART_CONSTANTS.MAX_CONSECUTIVE_FAILURES) {
			this.markGaveUp(reason, { blocked, attempts: this.consecutiveFailures });
		}
	}

	/**
	 * Stop auto-restarting the orchestrator and surface why: logged once at
	 * ERROR, broadcast as `orchestrator:restart_gave_up`, and returned by
	 * {@link getGiveUp} for the orchestrator status endpoint. Also called by the
	 * boot-time auto-start when it gives up, so the heartbeat monitor does not
	 * start a second retry loop. Cleared by {@link clearGiveUp}.
	 *
	 * @param reason - User-facing reason
	 * @param options - `blocked` when the user must act; `attempts` made
	 */
	markGaveUp(reason: string, options: { blocked: boolean; attempts: number }): void {
		if (this.gaveUp) return;
		this.gaveUp = { reason, attempts: options.attempts, at: new Date().toISOString(), blocked: options.blocked };
		this.logger.error('Orchestrator auto-restart STOPPED — the orchestrator stays down until it is started again', {
			reason,
			attempts: options.attempts,
			blocked: options.blocked,
		});
		this.socketIO?.emit('orchestrator:restart_gave_up', this.gaveUp);
	}

	/**
	 * Why auto-restart stopped, or null while it still tries.
	 *
	 * @returns The give-up record, or null
	 */
	getGiveUp(): RestartGiveUp | null {
		return this.gaveUp;
	}

	/**
	 * Re-arm auto-restart once the orchestrator runs again (it was started by
	 * hand, or the user fixed the runtime and it came back).
	 */
	clearGiveUp(): void {
		if (!this.gaveUp && this.consecutiveFailures === 0) return;
		if (this.gaveUp) this.logger.info('Orchestrator is running again; auto-restart re-armed');
		this.gaveUp = null;
		this.consecutiveFailures = 0;
	}

	/**
	 * Resolve orchestrator runtime type from persisted orchestrator status.
	 * Falls back to Claude Code if status is unavailable/invalid.
	 */
	private async resolveOrchestratorRuntimeType(): Promise<RuntimeType> {
		try {
			const orchestratorStatus = await StorageService.getInstance().getOrchestratorStatus();
			const storedRuntimeType = orchestratorStatus?.runtimeType;
			if (storedRuntimeType && Object.values(RUNTIME_TYPES).includes(storedRuntimeType as RuntimeType)) {
				return storedRuntimeType as RuntimeType;
			}
		} catch (error) {
			this.logger.warn('Failed to resolve orchestrator runtime type from storage, using default', {
				error: formatError(error),
			});
		}

		return RUNTIME_TYPES.CLAUDE_CODE;
	}

	/**
	 * Get current restart statistics.
	 *
	 * @returns Restart statistics object
	 */
	getRestartStats(): RestartStats {
		const now = Date.now();
		const windowStart = now - ORCHESTRATOR_RESTART_CONSTANTS.COOLDOWN_WINDOW_MS;
		const restartsInWindow = this.restartTimestamps.filter((ts) => ts > windowStart).length;

		return {
			totalRestarts: this.totalRestarts,
			restartsInWindow,
			isRestarting: this.isRestarting,
			lastRestartAt:
				this.restartTimestamps.length > 0
					? new Date(this.restartTimestamps[this.restartTimestamps.length - 1]).toISOString()
					: null,
			restartAllowed: this.isRestartAllowed(),
			consecutiveFailures: this.consecutiveFailures,
			gaveUp: this.gaveUp,
		};
	}

	/**
	 * Send a Slack notification about the orchestrator restart.
	 * Best-effort: silently ignores failures (Slack may not be configured).
	 */
	private async notifySlack(): Promise<void> {
		try {
			const { getSlackService } = await import('../slack/slack.service.js');
			const slackService = getSlackService();
			await slackService.sendNotification({
				title: 'Orchestrator Restarted',
				message: `The orchestrator was automatically restarted (attempt #${this.totalRestarts}). Previous process was detected as unresponsive.`,
				type: 'alert',
				urgency: 'high',
				timestamp: new Date().toISOString(),
			});
		} catch {
			// Slack may not be configured or client not initialized; ignore
		}
	}
}
