import * as fs from 'fs/promises';
import * as http from 'http';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import {
	SessionCommandHelper,
	getSessionBackendSync,
	createSessionCommandHelper,
	type ISessionBackend,
} from '../session/index.js';
import { getSessionStatePersistence } from '../session/session-state-persistence.js';
import { RuntimeServiceFactory } from './runtime-service.factory.js';
import { SessionMemoryService } from '../memory/session-memory.service.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import { SHELL_PROMPT_PATTERNS } from '../continuation/patterns/idle-patterns.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { OrchestratorRestartService } from '../orchestrator/orchestrator-restart.service.js';
import type { AgentRegistrationService } from './agent-registration.service.js';
import type { InProgressTask } from '../../types/task-tracking.types.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';
import * as crypto from 'crypto';
import {
	CREWLY_CONSTANTS,
	ORCHESTRATOR_SESSION_NAME,
	ORCHESTRATOR_ROLE,
	RUNTIME_EXIT_CONSTANTS,
	AGENT_SUSPEND_CONSTANTS,
	SESSION_COMMAND_DELAYS,
	RUNTIME_TYPES,
	GEMINI_FAILURE_PATTERNS,
	GEMINI_FORCE_RESTART_PATTERNS,
	GEMINI_DELIBERATION_PATTERN,
	GEMINI_DELIBERATION_THRESHOLD,
	GEMINI_TOOL_CHECK_LOOP_PATTERN,
	GEMINI_TOOL_CHECK_LOOP_THRESHOLD,
	GEMINI_TOOL_CHECK_LOOP_WINDOW_MS,
	CLAUDE_FATAL_PATTERNS,
	GEMINI_FAILURE_RETRY_CONSTANTS,
	GEMINI_READY_PATTERNS,
	WEB_CONSTANTS,
	AGENT_HEARTBEAT_MONITOR_CONSTANTS,
	type RuntimeType,
} from '../../constants.js';
import { delay } from '../../utils/async.utils.js';

/**
 * Internal state tracked per monitored session.
 */
interface MonitoredSession {
	sessionName: string;
	runtimeType: RuntimeType;
	role: string;
	memberId?: string;
	teamId?: string;
	unsubscribe: () => void;
	buffer: string;
	startedAt: number;
	exitDetected: boolean;
	/** Guard flag to prevent concurrent confirmAndReact invocations */
	confirmationInFlight: boolean;
	debounceTimer?: ReturnType<typeof setTimeout>;
	/** Interval handle for periodic process-alive polling */
	processPollingInterval?: ReturnType<typeof setInterval>;
	/** Number of Gemini failure retry attempts so far */
	geminiFailureRetries: number;
	/** #251: Timestamps of tool-check loop pattern matches for time-windowed detection */
	toolCheckLoopTimestamps: number[];
}

/**
 * Service that monitors PTY sessions for runtime exit patterns.
 *
 * When an agent CLI (Claude Code, Gemini CLI, Codex CLI) exits inside a PTY
 * session, the PTY shell itself stays alive. This service watches terminal
 * output for runtime-specific exit patterns and reacts by:
 *
 * 1. Updating the agent status to `inactive`
 * 2. Capturing session memory
 * 3. Broadcasting WebSocket events to the frontend
 * 4. Cancelling pending registration operations
 *
 * For Gemini CLI, the service also detects failure patterns (API errors,
 * quota exhaustion, network issues) that indicate the CLI is stuck and
 * needs recovery. These failure patterns bypass the shell prompt verification
 * since the CLI may still be running but non-functional.
 *
 * For Claude Code, the service detects fatal API errors (e.g. thinking
 * block corruption) that make the CLI permanently non-functional within
 * the current session. These trigger immediate recovery without retry.
 *
 * @example
 * ```typescript
 * const monitor = RuntimeExitMonitorService.getInstance();
 * monitor.startMonitoring('agent-dev-001', 'claude-code', 'developer');
 * // ... later ...
 * monitor.stopMonitoring('agent-dev-001');
 * ```
 */
export class RuntimeExitMonitorService {
	private static instance: RuntimeExitMonitorService | null = null;
	private logger: ComponentLogger;
	private sessions = new Map<string, MonitoredSession>();
	private onExitDetectedCallback?: (sessionName: string) => void;
	private agentRegistrationService: AgentRegistrationService | null = null;
	private eventBusService: EventBusService | null = null;

	/**
	 * Restart timestamps per session, persisted across monitoring cycles.
	 * Unlike MonitoredSession (which is recreated on each startMonitoring call),
	 * this map survives agent restarts to prevent infinite restart loops
	 * when agents keep crashing (e.g. during network outages).
	 */
	private restartHistory = new Map<string, number[]>();

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('RuntimeExitMonitorService');
	}

	/**
	 * Get the singleton instance.
	 */
	static getInstance(): RuntimeExitMonitorService {
		if (!RuntimeExitMonitorService.instance) {
			RuntimeExitMonitorService.instance = new RuntimeExitMonitorService();
		}
		return RuntimeExitMonitorService.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		if (RuntimeExitMonitorService.instance) {
			RuntimeExitMonitorService.instance.destroy();
		}
		RuntimeExitMonitorService.instance = null;
	}

	/**
	 * Register a callback invoked when a runtime exit is detected.
	 * Used by AgentRegistrationService to cancel pending registrations.
	 *
	 * @param callback - Called with the sessionName on exit detection
	 */
	setOnExitDetectedCallback(callback: (sessionName: string) => void): void {
		this.onExitDetectedCallback = callback;
	}

	/**
	 * Set the AgentRegistrationService dependency for agent restart.
	 *
	 * @param service - The AgentRegistrationService instance
	 */
	setAgentRegistrationService(service: AgentRegistrationService): void {
		this.agentRegistrationService = service;
	}

	/**
	 * Backwards-compatible no-op. Kept so `index.ts` compiles during the
	 * TaskTrackingService deletion window. In-progress task queries now
	 * read directly from TaskPoolService.
	 *
	 * @deprecated Will be removed in a follow-up. Do not call from new code.
	 */
	setTaskTrackingService(_service: unknown): void {
		// intentionally empty
	}

	/**
	 * Set the EventBusService dependency for publishing agent lifecycle events.
	 *
	 * @param service - The EventBusService instance
	 */
	setEventBusService(service: EventBusService): void {
		this.eventBusService = service;
	}

	/**
	 * Start monitoring a PTY session for runtime exit patterns.
	 *
	 * @param sessionName - PTY session name
	 * @param runtimeType - Agent runtime type (claude-code, gemini-cli, codex-cli)
	 * @param role - Agent role name
	 * @param teamId - Optional team identifier
	 * @param memberId - Optional member identifier
	 */
	startMonitoring(
		sessionName: string,
		runtimeType: RuntimeType,
		role: string,
		teamId?: string,
		memberId?: string
	): void {
		// Stop any existing monitoring for this session
		if (this.sessions.has(sessionName)) {
			this.stopMonitoring(sessionName);
		}

		const backend = getSessionBackendSync();
		if (!backend) {
			this.logger.warn('Cannot start monitoring: session backend not initialized', { sessionName });
			return;
		}

		const helper = createSessionCommandHelper(backend);
		const session = helper.getSession(sessionName);
		if (!session) {
			this.logger.warn('Cannot start monitoring: session not found', { sessionName });
			return;
		}

		const monitored: MonitoredSession = {
			sessionName,
			runtimeType,
			role,
			memberId,
			teamId,
			buffer: '',
			startedAt: Date.now(),
			exitDetected: false,
			confirmationInFlight: false,
			unsubscribe: () => {},
			geminiFailureRetries: 0,
			toolCheckLoopTimestamps: [],
		};

		// Get exit patterns for this runtime type
		let exitPatterns: RegExp[];
		try {
			const runtimeService = RuntimeServiceFactory.create(runtimeType, null, process.cwd());
			exitPatterns = runtimeService.getExitPatterns();
		} catch {
			this.logger.warn('Failed to get exit patterns, using empty set', { sessionName, runtimeType });
			exitPatterns = [];
		}

		if (exitPatterns.length === 0) {
			this.logger.debug('No exit patterns for runtime, skipping monitoring', { sessionName, runtimeType });
			return;
		}

		// Subscribe to PTY output
		const unsubscribe = session.onData((data: string) => {
			this.handleData(sessionName, data, exitPatterns, helper);
		});

		monitored.unsubscribe = unsubscribe;

		// Start periodic process-alive polling as a fallback.
		// This catches exits that don't produce recognizable text patterns
		// (e.g. context window exhaustion, SIGKILL, unexpected crashes).
		monitored.processPollingInterval = setInterval(() => {
			this.checkProcessAlive(sessionName, backend, helper);
		}, RUNTIME_EXIT_CONSTANTS.PROCESS_POLL_INTERVAL_MS);

		this.sessions.set(sessionName, monitored);

		this.logger.info('Started runtime exit monitoring', {
			sessionName,
			runtimeType,
			role,
			patternCount: exitPatterns.length,
		});
	}

	/**
	 * Stop monitoring a PTY session.
	 *
	 * Also prunes the restartHistory entry for this session if it has no
	 * recent timestamps within the cooldown window, preventing slow memory
	 * leak for terminated sessions.
	 *
	 * @param sessionName - PTY session name
	 */
	stopMonitoring(sessionName: string): void {
		const monitored = this.sessions.get(sessionName);
		if (!monitored) {
			return;
		}

		if (monitored.debounceTimer) {
			clearTimeout(monitored.debounceTimer);
		}
		if (monitored.processPollingInterval) {
			clearInterval(monitored.processPollingInterval);
		}

		monitored.unsubscribe();
		this.sessions.delete(sessionName);

		// Fix 3: Clean up restartHistory for terminated sessions to prevent
		// unbounded Map growth. Keep the entry only if it has recent timestamps
		// within the cooldown window (they may still be needed if the session
		// is restarted soon). Delete the entry entirely otherwise.
		const timestamps = this.restartHistory.get(sessionName);
		if (timestamps) {
			const windowStart = Date.now() - AGENT_HEARTBEAT_MONITOR_CONSTANTS.COOLDOWN_WINDOW_MS;
			const recent = timestamps.filter(ts => ts > windowStart);
			if (recent.length === 0) {
				this.restartHistory.delete(sessionName);
			} else {
				this.restartHistory.set(sessionName, recent);
			}
		}

		this.logger.debug('Stopped runtime exit monitoring', { sessionName });
	}

	/**
	 * Check if a session is being monitored.
	 */
	isMonitoring(sessionName: string): boolean {
		return this.sessions.has(sessionName);
	}

	/**
	 * Destroy all monitoring subscriptions.
	 */
	destroy(): void {
		const sessionNames = [...this.sessions.keys()];
		for (const sessionName of sessionNames) {
			this.stopMonitoring(sessionName);
		}
		this.restartHistory.clear();
		this.logger.debug('All runtime exit monitors destroyed');
	}

	/**
	 * Handle incoming PTY data for a monitored session.
	 */
	private handleData(
		sessionName: string,
		data: string,
		exitPatterns: RegExp[],
		helper: SessionCommandHelper
	): void {
		const monitored = this.sessions.get(sessionName);
		if (!monitored || monitored.exitDetected) {
			return;
		}

		// Append to rolling buffer, cap at MAX_BUFFER_SIZE
		monitored.buffer += data;
		if (monitored.buffer.length > RUNTIME_EXIT_CONSTANTS.MAX_BUFFER_SIZE) {
			monitored.buffer = monitored.buffer.slice(-RUNTIME_EXIT_CONSTANTS.MAX_BUFFER_SIZE);
		}

		// Skip pattern matching during startup grace period
		if (Date.now() - monitored.startedAt < RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS) {
			return;
		}

		// Test buffer against exit patterns
		let matched = exitPatterns.some((pattern) => pattern.test(monitored.buffer));

		// #188: Deliberation loop detection for Gemini CLI agents.
		// Count occurrences of "Wait, I'll..." / "Actually, I'll..." in the buffer.
		// A single occurrence is normal; 5+ in the visible buffer means the agent
		// is stuck planning without executing tool calls and needs a restart.
		if (!matched && monitored.runtimeType === RUNTIME_TYPES.GEMINI_CLI) {
			const deliberationCount = monitored.buffer.split(GEMINI_DELIBERATION_PATTERN).length - 1;
			if (deliberationCount >= GEMINI_DELIBERATION_THRESHOLD) {
				this.logger.warn('Gemini deliberation loop detected, triggering recovery', {
					sessionName,
					deliberationCount,
					threshold: GEMINI_DELIBERATION_THRESHOLD,
				});
				matched = true;
			}
		}

		// #251: Tool-check loop detection for Gemini CLI agents.
		// Detects "Ready. Final response." / "Wait, I will check if I should use mcp_"
		// cycling through Chrome DevTools MCP tools without completing.
		// Time-windowed: THRESHOLD matches within WINDOW_MS triggers force-stop.
		if (!matched && monitored.runtimeType === RUNTIME_TYPES.GEMINI_CLI) {
			if (GEMINI_TOOL_CHECK_LOOP_PATTERN.test(data)) {
				const now = Date.now();
				monitored.toolCheckLoopTimestamps.push(now);

				// Prune timestamps outside the time window
				const windowStart = now - GEMINI_TOOL_CHECK_LOOP_WINDOW_MS;
				monitored.toolCheckLoopTimestamps = monitored.toolCheckLoopTimestamps.filter(
					(ts) => ts >= windowStart
				);

				if (monitored.toolCheckLoopTimestamps.length >= GEMINI_TOOL_CHECK_LOOP_THRESHOLD) {
					this.logger.warn('Gemini tool-check loop detected (#251), force-stopping agent', {
						sessionName,
						matchCount: monitored.toolCheckLoopTimestamps.length,
						threshold: GEMINI_TOOL_CHECK_LOOP_THRESHOLD,
						windowMs: GEMINI_TOOL_CHECK_LOOP_WINDOW_MS,
					});
					matched = true;
				}
			}
		}

		if (!matched) {
			return;
		}

		// Pattern matched — start debounce timer to confirm
		if (monitored.debounceTimer) {
			clearTimeout(monitored.debounceTimer);
		}

		monitored.debounceTimer = setTimeout(() => {
			this.confirmAndReact(sessionName, helper);
		}, RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS);
	}

	/**
	 * Confirm exit by checking for a shell prompt, then react.
	 *
	 * Runtime-specific failure checks are gated by runtimeType so that
	 * patterns for one runtime cannot accidentally match another (e.g. a
	 * Codex exit matching Claude or Gemini patterns).
	 *
	 * For Gemini CLI failure patterns (API errors, quota exhaustion, etc.),
	 * the system retries with exponential backoff before declaring the agent
	 * dead. Gemini CLI often recovers automatically from transient API errors
	 * (RESOURCE_EXHAUSTED, UNAVAILABLE, Connection error). Only after
	 * MAX_RETRIES does the system proceed with the exit/restart flow.
	 *
	 * For Claude Code fatal patterns (thinking block corruption, etc.),
	 * the system skips retry and forces immediate recovery since these
	 * errors are permanently unrecoverable within the same session.
	 */
	private async confirmAndReact(
		sessionName: string,
		helper: SessionCommandHelper
	): Promise<void> {
		const monitored = this.sessions.get(sessionName);
		if (!monitored || monitored.exitDetected || monitored.confirmationInFlight) {
			return;
		}

		monitored.confirmationInFlight = true;

		try {
			// Verify shell prompt is visible (avoids false positives)
			const shellPromptConfirmed = this.verifyExitWithShellPrompt(sessionName, helper);

			if (!shellPromptConfirmed) {
				const runtimeSpecificMatch = await this.checkRuntimeSpecificFailure(sessionName, monitored, helper);
				if (!runtimeSpecificMatch) {
					this.logger.debug('Exit pattern matched but shell prompt not confirmed, ignoring', { sessionName });
					return;
				}
			}

			// Mark as detected to prevent double-processing
			monitored.exitDetected = true;

			// Identify which exit pattern triggered detection for diagnostics
			let matchedPatternSource: string | undefined;
			try {
				const runtimeService = RuntimeServiceFactory.create(monitored.runtimeType, null, process.cwd());
				const patterns = runtimeService.getExitPatterns();
				const matched = patterns.find((p) => p.test(monitored.buffer));
				matchedPatternSource = matched?.source;
			} catch {
				// Non-critical — pattern name is best-effort diagnostics
			}

			this.logger.info('Runtime exit detected and confirmed', {
				sessionName,
				runtimeType: monitored.runtimeType,
				role: monitored.role,
				matchedPattern: matchedPatternSource,
				bufferTail: monitored.buffer.slice(-500),
			});

			// Fire the exit-detected callback (used to cancel pending registrations)
			this.fireExitDetectedCallback(sessionName);

			// Try agent restart if it has in-progress tasks (non-orchestrator only).
			// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md:
			// active tasks are read from TaskPoolService inside `tryAgentRestartWithTasks`.
			if (monitored.role !== ORCHESTRATOR_ROLE && this.agentRegistrationService) {
				const restarted = await this.tryAgentRestartWithTasks(sessionName, monitored);
				if (restarted) return;
			}

			// #228/#234: Auto-restart agents that exit idle (Claude Code + Codex CLI).
			// These runtimes exit after task completion or idle timeout. Restart to keep available.
			if ((monitored.runtimeType === 'claude-code' || monitored.runtimeType === 'codex-cli')
				&& monitored.role !== ORCHESTRATOR_ROLE
				&& this.agentRegistrationService && this.isAgentRestartAllowed(sessionName)) {
				try {
					this.logger.info('Agent idle/clean exit — auto-restarting to maintain availability', { sessionName, runtimeType: monitored.runtimeType });
					await this.restartAgentWithTasks(sessionName, monitored, []);
					this.recordAgentRestart(sessionName);
					this.stopMonitoring(sessionName);
					return;
				} catch (restartError) {
					this.logger.warn('Agent idle restart failed, transitioning to inactive', {
						sessionName,
						error: restartError instanceof Error ? restartError.message : String(restartError),
					});
				}
			}

			// Orchestrator-specific restart
			if (sessionName === ORCHESTRATOR_SESSION_NAME) {
				const restarted = await this.tryOrchestratorRestart(sessionName, monitored);
				if (restarted) return;
			}

			// Normal inactive flow: update status, capture memory, broadcast
			await this.transitionToInactive(sessionName, monitored);

			// Cleanup this subscription
			this.stopMonitoring(sessionName);
		} finally {
			monitored.confirmationInFlight = false;
		}
	}

	/**
	 * Check for runtime-specific failure patterns when shell prompt is not confirmed.
	 *
	 * Gated by runtimeType so patterns for one runtime cannot accidentally
	 * match another. Returns true if a runtime-specific failure was detected,
	 * or 'deferred' handling occurred (Gemini retry).
	 *
	 * @param sessionName - PTY session name
	 * @param monitored - Monitored session state
	 * @param helper - Session command helper
	 * @returns True if a runtime-specific failure was confirmed
	 */
	private async checkRuntimeSpecificFailure(
		sessionName: string,
		monitored: MonitoredSession,
		helper: SessionCommandHelper
	): Promise<boolean> {
		if (monitored.runtimeType === RUNTIME_TYPES.CODEX_CLI) {
			const isCodexInterrupted = /Conversation interrupted/i.test(monitored.buffer);
			if (isCodexInterrupted) {
				this.logger.warn('Codex interruption detected, proceeding with recovery flow', { sessionName });
				return true;
			}
		} else if (monitored.runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
			const isClaudeFatal = CLAUDE_FATAL_PATTERNS.some((pattern) => pattern.test(monitored.buffer));
			if (isClaudeFatal) {
				const detectedPattern = CLAUDE_FATAL_PATTERNS.find((p) => p.test(monitored.buffer))?.source;
				this.logger.warn('Claude Code fatal error detected, forcing immediate recovery', {
					sessionName,
					detectedPattern,
				});
				return true;
			}
		} else if (monitored.runtimeType === RUNTIME_TYPES.GEMINI_CLI) {
			// #251: Tool-check loop is a confirmed failure — agent is alive but stuck
			if (monitored.toolCheckLoopTimestamps.length >= GEMINI_TOOL_CHECK_LOOP_THRESHOLD) {
				this.logger.warn('Gemini tool-check loop confirmed (#251), forcing recovery', { sessionName });
				return true;
			}

			// #188: Deliberation loop is also a confirmed failure
			const deliberationCount = monitored.buffer.split(GEMINI_DELIBERATION_PATTERN).length - 1;
			if (deliberationCount >= GEMINI_DELIBERATION_THRESHOLD) {
				this.logger.warn('Gemini deliberation loop confirmed (#188), forcing recovery', { sessionName });
				return true;
			}

			const isGeminiFailure = GEMINI_FAILURE_PATTERNS.some((pattern) => pattern.test(monitored.buffer));
			const isGeminiForceRestart = GEMINI_FORCE_RESTART_PATTERNS.some((pattern) => pattern.test(monitored.buffer));

			if (isGeminiFailure || isGeminiForceRestart) {
				if (isGeminiForceRestart) {
					this.logger.warn('Gemini auto-update interruption detected, forcing recovery flow', { sessionName });
				} else {
					const retryResult = await this.handleGeminiFailureWithRetry(sessionName, monitored, helper);
					if (retryResult === 'recovered' || retryResult === 'deferred') {
						return false; // Not a confirmed exit — caller should return early
					}
				}
				return true;
			}
		}

		return false;
	}

	/**
	 * Fire the onExitDetected callback safely.
	 *
	 * @param sessionName - PTY session name
	 */
	private fireExitDetectedCallback(sessionName: string): void {
		if (!this.onExitDetectedCallback) return;
		try {
			this.onExitDetectedCallback(sessionName);
		} catch (error) {
			this.logger.warn('onExitDetected callback error', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Try to restart an agent that has in-progress tasks.
	 *
	 * @param sessionName - PTY session name
	 * @param monitored - Monitored session state
	 * @returns True if the agent was successfully restarted (caller should return)
	 */
	private async tryAgentRestartWithTasks(
		sessionName: string,
		monitored: MonitoredSession
	): Promise<boolean> {
		try {
			// V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
			// Replaces TaskTrackingService.getTasksForTeamMember with V3 pool
			// query filtered by `target` (session name) and projected to
			// the legacy InProgressTask shape so the rest of this method
			// (notifyOrchestratorOfFailure, restartAgentWithTasks) works
			// unchanged.
			const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
			const { projectWorkItemToInProgressTask } = await import('../v3/work-item-projection.js');
			const items = await TaskPoolService.getInstance().getAllItems();
			const tasks = items
				.filter((wi) => wi.target === sessionName)
				.map(projectWorkItemToInProgressTask);
			const activeTasks = tasks.filter(
				t => t.status === 'assigned' || t.status === 'active' || t.status === 'pending_assignment'
			);

			if (activeTasks.length === 0) return false;

			if (!this.isAgentRestartAllowed(sessionName)) {
				this.logger.warn('Agent restart cooldown active, skipping restart', {
					sessionName,
					activeTaskCount: activeTasks.length,
					maxRestartsPerWindow: AGENT_HEARTBEAT_MONITOR_CONSTANTS.MAX_RESTARTS_PER_WINDOW,
					cooldownWindowMs: AGENT_HEARTBEAT_MONITOR_CONSTANTS.COOLDOWN_WINDOW_MS,
				});
				this.notifyOrchestratorOfFailure(sessionName, 'runtime_exited_cooldown', activeTasks, false);
				return false;
			}

			this.logger.info('Runtime exit with in-progress tasks, attempting restart', {
				sessionName,
				activeTaskCount: activeTasks.length,
			});

			try {
				await this.restartAgentWithTasks(sessionName, monitored, activeTasks);
				this.recordAgentRestart(sessionName);
				this.notifyOrchestratorOfFailure(sessionName, 'runtime_exited', activeTasks, true);
				this.stopMonitoring(sessionName);
				return true;
			} catch (restartError) {
				this.logger.warn('Agent restart after runtime exit failed, falling back to inactive', {
					sessionName,
					error: restartError instanceof Error ? restartError.message : String(restartError),
				});
				this.recordAgentRestart(sessionName);
				this.notifyOrchestratorOfFailure(sessionName, 'runtime_exited', activeTasks, false);
				return false;
			}
		} catch (error) {
			this.logger.warn('Failed to check in-progress tasks after runtime exit', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Try to restart the orchestrator after runtime exit.
	 *
	 * Sets status to inactive before restart to prevent queue processor
	 * from delivering messages during postInitialize, captures session
	 * memory, and broadcasts restart status.
	 *
	 * @param sessionName - PTY session name (should be ORCHESTRATOR_SESSION_NAME)
	 * @param monitored - Monitored session state
	 * @returns True if orchestrator was successfully restarted (caller should return)
	 */
	private async tryOrchestratorRestart(
		sessionName: string,
		monitored: MonitoredSession
	): Promise<boolean> {
		// Set status to inactive BEFORE restart so the queue processor
		// doesn't deliver messages during postInitialize.
		try {
			const storageService = StorageService.getInstance();
			await storageService.updateAgentStatus(sessionName, CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE);
		} catch {
			// Best-effort — continue with restart
		}

		// Capture session memory before restart
		try {
			const sessionMemoryService = SessionMemoryService.getInstance();
			await sessionMemoryService.onSessionEnd(sessionName, monitored.role, process.cwd());
		} catch (error) {
			this.logger.warn('Failed to capture session memory before orchestrator restart', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		try {
			const restartService = OrchestratorRestartService.getInstance();
			const success = await restartService.attemptRestart();

			if (success) {
				this.logger.info('Orchestrator restarted after runtime exit', { sessionName });

				// Broadcast STARTED (not ACTIVE) — agent becomes ACTIVE only
				// after registration prompt is processed and MCP call completes.
				try {
					const terminalGateway = getTerminalGateway();
					if (terminalGateway) {
						terminalGateway.broadcastOrchestratorStatus({
							sessionName,
							agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.STARTED,
							reason: 'runtime_exit_restart',
						});
					}
				} catch {
					// Best-effort broadcast
				}

				this.stopMonitoring(sessionName);
				return true;
			}

			this.logger.warn('Orchestrator restart after runtime exit failed or not allowed, falling back to inactive', {
				sessionName,
			});
		} catch (error) {
			this.logger.warn('Orchestrator restart attempt threw error, falling back to inactive', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return false;
	}

	/**
	 * Transition agent to inactive state: update storage, capture memory,
	 * publish events, and broadcast WebSocket status.
	 *
	 * @param sessionName - PTY session name
	 * @param monitored - Monitored session state
	 */
	private async transitionToInactive(
		sessionName: string,
		monitored: MonitoredSession,
		dropoutReason?: 'idle_exit' | 'update_exit' | 'crash' | 'manual' | 'task_complete' | 'loop_detected'
	): Promise<void> {
		// #235: Determine dropout reason from exit patterns if not provided
		const reason = dropoutReason || this.inferDropoutReason(monitored);

		// Update agent status to inactive
		try {
			const storageService = StorageService.getInstance();
			await storageService.updateAgentStatus(
				sessionName,
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				reason
			);
			this.logger.info('Agent status updated to inactive after runtime exit', { sessionName, dropoutReason: reason });

			// Publish agent:inactive event to EventBus so orchestrator is notified
			if (this.eventBusService) {
				try {
					await this.publishInactiveEvent(sessionName, monitored, storageService);
				} catch (eventError) {
					this.logger.warn('Failed to publish agent:inactive event to EventBus', {
						sessionName,
						error: eventError instanceof Error ? eventError.message : String(eventError),
					});
				}
			}
		} catch (error) {
			this.logger.warn('Failed to update agent status after runtime exit', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		// Capture session memory (skip for orchestrator — already captured above)
		if (sessionName !== ORCHESTRATOR_SESSION_NAME) {
			try {
				const sessionMemoryService = SessionMemoryService.getInstance();
				await sessionMemoryService.onSessionEnd(sessionName, monitored.role, process.cwd());
			} catch (error) {
				this.logger.warn('Failed to capture session memory after runtime exit', {
					sessionName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Broadcast WebSocket event
		try {
			const terminalGateway = getTerminalGateway();
			if (terminalGateway) {
				const statusPayload = {
					sessionName,
					agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
					reason: 'runtime_exited',
				};

				if (sessionName === ORCHESTRATOR_SESSION_NAME) {
					terminalGateway.broadcastOrchestratorStatus(statusPayload);
				} else {
					terminalGateway.broadcastTeamMemberStatus(statusPayload);
				}
			}
		} catch (error) {
			this.logger.warn('Failed to broadcast runtime exit event', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Handle a Gemini CLI failure with exponential backoff retry.
	 *
	 * Waits with increasing delays and checks if the CLI recovers (returns
	 * to a ready prompt). Returns 'recovered' if the CLI is back,
	 * 'deferred' if retries remain (skip exit flow, re-check on next
	 * failure detection), or 'exhausted' if max retries have been reached.
	 *
	 * @param sessionName - PTY session name
	 * @param monitored - Monitored session state (retry counter is mutated)
	 * @param helper - Session command helper for terminal output capture
	 * @returns 'recovered' | 'deferred' | 'exhausted'
	 */
	private async handleGeminiFailureWithRetry(
		sessionName: string,
		monitored: MonitoredSession,
		helper: SessionCommandHelper
	): Promise<'recovered' | 'deferred' | 'exhausted'> {
		const detectedPattern = GEMINI_FAILURE_PATTERNS.find((p) => p.test(monitored.buffer))?.source;
		monitored.geminiFailureRetries++;

		const {
			MAX_RETRIES,
			INITIAL_BACKOFF_MS,
			MAX_BACKOFF_MS,
			BACKOFF_MULTIPLIER,
			RECOVERY_CHECK_LINES,
		} = GEMINI_FAILURE_RETRY_CONSTANTS;

		if (monitored.geminiFailureRetries > MAX_RETRIES) {
			this.logger.warn('Gemini CLI failure retries exhausted, proceeding with exit flow', {
				sessionName,
				retries: monitored.geminiFailureRetries,
				maxRetries: MAX_RETRIES,
				detectedPattern,
			});
			return 'exhausted';
		}

		// Exponential backoff: INITIAL * MULTIPLIER^(retry-1), capped at MAX
		const backoffMs = Math.min(
			INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, monitored.geminiFailureRetries - 1),
			MAX_BACKOFF_MS
		);

		this.logger.info('Gemini CLI failure detected, waiting for recovery', {
			sessionName,
			retry: monitored.geminiFailureRetries,
			maxRetries: MAX_RETRIES,
			backoffMs,
			detectedPattern,
		});

		// Clear the buffer so the same error text doesn't immediately re-trigger
		monitored.buffer = '';

		await delay(backoffMs);

		// Check if the CLI has recovered by looking for ready prompt patterns
		try {
			const output = helper.capturePane(sessionName, RECOVERY_CHECK_LINES);
			const hasRecovered = GEMINI_READY_PATTERNS.some((pattern) => output.includes(pattern));

			if (hasRecovered) {
				this.logger.info('Gemini CLI recovered after transient failure', {
					sessionName,
					retry: monitored.geminiFailureRetries,
					detectedPattern,
				});
				monitored.geminiFailureRetries = 0;
				return 'recovered';
			}

			this.logger.debug('Gemini CLI has not recovered yet after backoff', {
				sessionName,
				retry: monitored.geminiFailureRetries,
				maxRetries: MAX_RETRIES,
			});
		} catch (error) {
			this.logger.warn('Error checking Gemini CLI recovery', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		// Not recovered but retries remain — defer to the next failure detection cycle.
		// The buffer was cleared above, so a new failure must appear in terminal
		// output to re-trigger this method.
		if (monitored.geminiFailureRetries < MAX_RETRIES) {
			return 'deferred';
		}

		return 'exhausted';
	}

	/**
	 * Restart an agent that exited while it had in-progress tasks.
	 *
	 * Mirrors the restart pattern from AgentHeartbeatMonitorService:
	 * 1. Save Claude session ID for resume
	 * 2. Kill old PTY session + clear PTY activity tracker
	 * 3. Pre-set session ID for resume
	 * 4. Recreate agent session via AgentRegistrationService
	 * 5. Broadcast restarted status via WebSocket
	 * 6. Re-deliver tasks asynchronously
	 *
	 * @param sessionName - PTY session name
	 * @param monitored - Monitored session state
	 * @param activeTasks - In-progress tasks to re-deliver
	 */
	private async restartAgentWithTasks(
		sessionName: string,
		monitored: MonitoredSession,
		activeTasks: InProgressTask[]
	): Promise<void> {
		const backend = getSessionBackendSync();
		if (!backend || !this.agentRegistrationService) {
			throw new Error('Missing dependencies for agent restart');
		}

		// Save Claude session ID before killing
		let claudeSessionId: string | undefined;
		try {
			const persistence = getSessionStatePersistence();
			claudeSessionId = persistence.getSessionId(sessionName);
		} catch {
			this.logger.warn('Could not retrieve Claude session ID for restart', { sessionName });
		}

		// Kill old PTY session
		if (backend.sessionExists(sessionName)) {
			await backend.killSession(sessionName);
		}

		// Clear PTY activity tracker
		PtyActivityTrackerService.getInstance().clearSession(sessionName);

		// Pre-set session ID for resume
		if (claudeSessionId) {
			try {
				const persistence = getSessionStatePersistence();
				const metadata = persistence.getSessionMetadata(sessionName);
				if (metadata) {
					persistence.updateSessionId(sessionName, claudeSessionId);
				}
			} catch {
				this.logger.warn('Could not pre-set session ID for resume', { sessionName });
			}
		}

		// Recreate agent session
		const result = await this.agentRegistrationService.createAgentSession({
			sessionName,
			role: monitored.role,
			teamId: monitored.teamId,
			memberId: monitored.memberId,
		});

		if (!result.success) {
			throw new Error(result.error || 'createAgentSession failed');
		}

		// Broadcast agent restarted event
		const terminalGateway = getTerminalGateway();
		if (terminalGateway) {
			terminalGateway.broadcastTeamMemberStatus({
				teamId: monitored.teamId,
				memberId: monitored.memberId,
				sessionName,
				agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
			});
		}

		this.logger.info('Agent restarted after runtime exit with in-progress tasks', {
			sessionName,
			activeTaskCount: activeTasks.length,
			claudeSessionId: claudeSessionId ? '(resumed)' : '(fresh)',
		});

		// Re-deliver in-progress tasks (async, non-blocking)
		this.redeliverTasks(sessionName, activeTasks).catch((err) => {
			this.logger.error('Task re-delivery failed after runtime exit restart', {
				sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/**
	 * Re-deliver in-progress tasks to a restarted agent.
	 *
	 * Waits for the agent to initialize, reads task files, and writes
	 * summaries into the agent's PTY session.
	 *
	 * @param sessionName - PTY session name
	 * @param activeTasks - Tasks to re-deliver
	 */
	private async redeliverTasks(
		sessionName: string,
		activeTasks: InProgressTask[]
	): Promise<void> {
		// Wait for agent initialization
		await delay(AGENT_SUSPEND_CONSTANTS.REHYDRATION_TIMEOUT_MS);

		const backend = getSessionBackendSync();
		if (!backend || !backend.sessionExists(sessionName)) {
			this.logger.warn('Agent session not found after restart, skipping task re-delivery', { sessionName });
			return;
		}

		const session = backend.getSession(sessionName);
		if (!session) {
			return;
		}

		this.logger.info('Re-delivering tasks to restarted agent', {
			sessionName,
			taskCount: activeTasks.length,
		});

		for (const task of activeTasks) {
			let taskContent = '';
			try {
				taskContent = await fs.readFile(task.taskFilePath, 'utf-8');
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
			await delay(pasteDelay);
			session.write('\r');

			// Delay between tasks to avoid flooding
			await delay(2000);
		}

		this.logger.info('Task re-delivery complete', {
			sessionName,
			tasksDelivered: activeTasks.length,
		});
	}

	/**
	 * Periodic check: is the runtime child process still alive?
	 *
	 * Uses the session backend's isChildProcessAlive() (pgrep -P <pid>)
	 * to determine if the CLI process has exited. This is a version-agnostic
	 * fallback that doesn't depend on any text the CLI prints.
	 *
	 * @param sessionName - PTY session name
	 * @param backend - Session backend for process checks
	 * @param helper - Session command helper for shell prompt verification
	 */
	private checkProcessAlive(
		sessionName: string,
		backend: ISessionBackend,
		helper: SessionCommandHelper
	): void {
		const monitored = this.sessions.get(sessionName);
		if (!monitored || monitored.exitDetected) {
			return;
		}

		// Skip during startup grace period (CLI may not have spawned yet)
		if (Date.now() - monitored.startedAt < RUNTIME_EXIT_CONSTANTS.PROCESS_POLL_GRACE_PERIOD_MS) {
			return;
		}

		// Check if the backend supports process-alive checks
		if (!backend.isChildProcessAlive) {
			return;
		}

		const isAlive = backend.isChildProcessAlive(sessionName);
		if (isAlive) {
			return;
		}

		// Process is not alive — verify with shell prompt before confirming
		if (!this.verifyExitWithShellPrompt(sessionName, helper)) {
			this.logger.debug('Process not alive but shell prompt not confirmed, skipping', { sessionName });
			return;
		}

		this.logger.info('Runtime exit detected via process check (no child process)', {
			sessionName,
			runtimeType: monitored.runtimeType,
		});

		// Trigger the same exit flow as pattern-based detection
		this.confirmAndReact(sessionName, helper).catch((error) => {
			this.logger.warn('confirmAndReact error from process check', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	/**
	 * Verify that a shell prompt is visible in the terminal, confirming
	 * that the agent CLI has actually exited and returned to the shell.
	 */
	private verifyExitWithShellPrompt(sessionName: string, helper: SessionCommandHelper): boolean {
		try {
			const output = helper.capturePane(sessionName);
			return SHELL_PROMPT_PATTERNS.some((pattern) => pattern.test(output));
		} catch {
			return false;
		}
	}

	/**
	 * Check if an agent restart is allowed based on cooldown window.
	 * Prevents infinite restart loops when agents keep crashing (e.g. during
	 * network outages). Uses the same limits as AgentHeartbeatMonitorService.
	 *
	 * @param sessionName - PTY session name
	 * @returns True if restart is allowed, false if cooldown is active
	 */
	private isAgentRestartAllowed(sessionName: string): boolean {
		const now = Date.now();
		const windowStart = now - AGENT_HEARTBEAT_MONITOR_CONSTANTS.COOLDOWN_WINDOW_MS;
		const timestamps = this.restartHistory.get(sessionName) || [];

		// Prune old timestamps outside the cooldown window
		const recent = timestamps.filter(ts => ts > windowStart);
		this.restartHistory.set(sessionName, recent);

		return recent.length < AGENT_HEARTBEAT_MONITOR_CONSTANTS.MAX_RESTARTS_PER_WINDOW;
	}

	/**
	 * Record a restart attempt for cooldown tracking.
	 *
	 * @param sessionName - PTY session name
	 */
	private recordAgentRestart(sessionName: string): void {
		const timestamps = this.restartHistory.get(sessionName) || [];
		timestamps.push(Date.now());
		this.restartHistory.set(sessionName, timestamps);
	}

	/**
	 * Classify an error reason as transient or persistent.
	 *
	 * Transient errors (connectivity, timeout, quota) may resolve on retry.
	 * Persistent errors (auth, config, crash loop) require manual intervention.
	 *
	 * @param reason - The failure reason string
	 * @returns 'TRANSIENT' | 'PERSISTENT' | 'UNKNOWN'
	 */
	private classifyError(reason: string): 'TRANSIENT' | 'PERSISTENT' | 'UNKNOWN' {
		const transientPatterns = [
			'timeout', 'connectivity', 'connection', 'quota', 'RESOURCE_EXHAUSTED',
			'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'network', 'INTERNAL',
		];
		const persistentPatterns = [
			'auth', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'config',
			'crash', 'cooldown', 'corruption', 'thinking.*blocks',
		];

		const lowerReason = reason.toLowerCase();
		if (transientPatterns.some(p => lowerReason.includes(p.toLowerCase()))) {
			return 'TRANSIENT';
		}
		if (persistentPatterns.some(p => new RegExp(p, 'i').test(reason))) {
			return 'PERSISTENT';
		}
		return 'UNKNOWN';
	}

	/**
	 * Notify the orchestrator about an agent failure via the chat API (#129).
	 *
	 * Sends a structured failure notification with error classification so the
	 * orchestrator can decide whether to restart the agent, reassign tasks,
	 * or inform the user. This is fire-and-forget — failures are logged but
	 * do not block the exit flow.
	 *
	 * @param sessionName - Failed agent's PTY session name
	 * @param reason - Failure reason (runtime_exited, api_failure, etc.)
	 * @param activeTasks - In-progress tasks the agent had, if any
	 * @param restartSucceeded - Whether automatic restart succeeded
	 */
	private notifyOrchestratorOfFailure(
		sessionName: string,
		reason: string,
		activeTasks: InProgressTask[],
		restartSucceeded: boolean
	): void {
		const errorClass = this.classifyError(reason);
		const taskSummary = activeTasks.length > 0
			? activeTasks.map(t => `${t.taskName} (${t.status})`).join(', ')
			: '';

		const message = [
			`Agent failure notification: ${sessionName} became inactive.`,
			`Reason: ${reason}`,
			`Error classification: ${errorClass}`,
			activeTasks.length > 0 ? `Active tasks: ${taskSummary}` : 'No active tasks.',
			restartSucceeded
				? 'Automatic restart succeeded — agent is recovering.'
				: 'Automatic restart FAILED — please restart the agent or reassign its tasks.',
		].join('\n');

		// Send via chat API (fire-and-forget)
		const backend = getSessionBackendSync();
		if (!backend) return;

		const helper = createSessionCommandHelper(backend);
		const orchestratorSession = helper.getSession(ORCHESTRATOR_SESSION_NAME);
		if (!orchestratorSession) {
			this.logger.debug('Orchestrator session not found, skipping failure notification', { sessionName });
			return;
		}

		// Use the deliver endpoint for reliable delivery to the orchestrator
		const baseUrl = process.env.CREWLY_API_URL || `http://localhost:${WEB_CONSTANTS.PORTS.BACKEND}`;
		const body = JSON.stringify({
			message,
			force: true,
		});

		// Fire-and-forget HTTP call
		try {
			const url = new URL(`${baseUrl}/api/terminal/${ORCHESTRATOR_SESSION_NAME}/deliver`);
			const req = http.request(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body).toString(),
				},
			});
			req.on('response', (res) => res.resume()); // Consume response to free socket
			req.on('error', (err) => {
				this.logger.debug('Failed to deliver failure notification to orchestrator (non-fatal)', {
					sessionName,
					error: err.message,
				});
			});
			req.write(body);
			req.end();
		} catch {
			// Non-fatal — notification delivery is best-effort
		}

		this.logger.info('Sent agent failure notification to orchestrator (#129)', {
			sessionName,
			reason,
			activeTaskCount: activeTasks.length,
			restartSucceeded,
		});
	}

	/**
	 * #235: Infer dropout reason from the monitored session's buffer.
	 *
	 * @param monitored - Monitored session state
	 * @returns Inferred dropout reason
	 */
	private inferDropoutReason(monitored: MonitoredSession): 'idle_exit' | 'update_exit' | 'crash' | 'manual' | 'task_complete' | 'loop_detected' {
		const buffer = monitored.buffer.toLowerCase();

		// #251: Check for tool-check loop (time-windowed timestamps)
		if (monitored.toolCheckLoopTimestamps.length >= GEMINI_TOOL_CHECK_LOOP_THRESHOLD) {
			return 'loop_detected';
		}

		// #188: Check for deliberation loop
		const deliberationCount = buffer.split(GEMINI_DELIBERATION_PATTERN).length - 1;
		if (deliberationCount >= GEMINI_DELIBERATION_THRESHOLD) {
			return 'loop_detected';
		}

		if (buffer.includes('update') && (buffer.includes('restart') || buffer.includes('upgrade'))) {
			return 'update_exit';
		}
		if (buffer.includes('fatal') || buffer.includes('panic') || buffer.includes('segfault') || buffer.includes('killed')) {
			return 'crash';
		}
		if (buffer.includes('task') && (buffer.includes('complete') || buffer.includes('done') || buffer.includes('finished'))) {
			return 'task_complete';
		}
		return 'idle_exit';
	}

	/**
	 * Publish agent:status_changed and agent:inactive events to the EventBus.
	 *
	 * Looks up team/member names from StorageService to build the full
	 * AgentEvent. This mirrors the pattern used in TeamsJsonWatcherService.
	 *
	 * @param sessionName - PTY session name
	 * @param monitored - Monitored session state with teamId/memberId
	 * @param storageService - StorageService instance for team/member lookup
	 */
	private async publishInactiveEvent(
		sessionName: string,
		monitored: MonitoredSession,
		storageService: StorageService
	): Promise<void> {
		if (!this.eventBusService) {
			return;
		}

		// Look up team and member names
		let teamName = '';
		let memberName = '';
		try {
			const result = await storageService.findMemberBySessionName(sessionName);
			if (result) {
				teamName = result.team.name;
				memberName = result.member.name;
			}
		} catch {
			// Best-effort — use empty names if lookup fails
		}

		const baseEvent: AgentEvent = {
			id: crypto.randomUUID(),
			type: 'agent:status_changed',
			timestamp: new Date().toISOString(),
			teamId: monitored.teamId || '',
			teamName,
			memberId: monitored.memberId || '',
			memberName,
			sessionName,
			previousValue: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
			newValue: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
			changedField: 'agentStatus',
		};

		// Publish generic status_changed event
		this.eventBusService.publish(baseEvent);

		// Publish specific agent:inactive event
		this.eventBusService.publish({
			...baseEvent,
			id: crypto.randomUUID(),
			type: 'agent:inactive',
		});

		this.logger.info('Published agent:inactive event to EventBus', {
			sessionName,
			teamId: monitored.teamId,
			memberId: monitored.memberId,
		});
	}
}
