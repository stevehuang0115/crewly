/**
 * Context Window Monitor Service
 *
 * Monitors PTY session output for context window usage percentages and triggers
 * proactive warnings and runtime-native compaction when thresholds are exceeded.
 *
 * When an agent's session reports context usage (e.g., "85% context"),
 * this service detects the percentage, evaluates it against configured thresholds,
 * and takes action:
 * - Yellow (70%): Publishes a warning event
 * - Red (85%): Publishes a warning + triggers runtime compact (/compact or /compress)
 * - Critical (95%): Retries compact with cooldown; auto-recovery disabled by default
 *
 * Strategy: prefer runtime-native compact/compress commands which preserve session
 * state over session kill + restart which loses all context. Auto-recovery is
 * available as a last resort via AUTO_RECOVERY_ENABLED constant.
 *
 * Follows the PTY subscription pattern from RuntimeExitMonitorService and the
 * lifecycle/restart pattern from AgentHeartbeatMonitorService.
 *
 * @module services/agent/context-window-monitor
 */

import * as fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import {
	getSessionBackendSync,
	createSessionCommandHelper,
} from '../session/index.js';
import { getSessionStatePersistence } from '../session/session-state-persistence.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { RuntimeExitMonitorService } from './runtime-exit-monitor.service.js';
import { TaskTrackingService } from '../project/task-tracking.service.js';
import { stripAnsiCodes } from '../../utils/terminal-output.utils.js';
import { getSettingsService } from '../settings/settings.service.js';
import {
	CONTEXT_WINDOW_MONITOR_CONSTANTS,
	RUNTIME_COMPACT_COMMANDS,
	RUNTIME_TYPES,
	ORCHESTRATOR_SESSION_NAME,
	CREWLY_CONSTANTS,
	AGENT_SUSPEND_CONSTANTS,
	SESSION_COMMAND_DELAYS,
} from '../../constants.js';
import type { RuntimeType } from '../../constants.js';
import type { AgentRegistrationService } from './agent-registration.service.js';
import type { ISessionBackend } from '../session/session-backend.interface.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Context usage severity level.
 */
export type ContextLevel = 'normal' | 'yellow' | 'red' | 'critical';

/**
 * Per-session context window monitoring state.
 */
export interface ContextWindowState {
	/** PTY session name */
	sessionName: string;
	/** Team member ID */
	memberId: string;
	/** Team ID */
	teamId: string;
	/** Agent role */
	role: string;
	/** Runtime type for this session (determines compact command) */
	runtimeType: RuntimeType;
	/** Last detected context usage percentage (0-100) */
	contextPercent: number;
	/** Current severity level */
	level: ContextLevel;
	/** Timestamp of last context % detection */
	lastDetectedAt: number;
	/** Whether auto-recovery has been triggered for this session */
	recoveryTriggered: boolean;
	/** Total recovery count for this session */
	recoveryCount: number;
	/** Timestamps of recent recoveries for cooldown tracking */
	recoveryTimestamps: number[];
	/** Number of compact attempts for current high-usage episode */
	compactAttempts: number;
	/** Whether a compact is currently in progress */
	compactInProgress: boolean;
	/** Timestamp of the last compact attempt */
	lastCompactAt: number;
	/** Context percent recorded when compact was triggered (for post-compact verification) */
	preCompactPercent: number;
	/** Handle for the compact wait timeout (cleared on session stop) */
	compactWaitTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Internal PTY subscription state per session.
 */
interface SessionSubscription {
	/** Function to unsubscribe from PTY data events */
	unsubscribe: () => void;
	/** Rolling buffer for terminal output */
	buffer: string;
}

// =============================================================================
// Regex patterns for detecting context usage percentages in PTY output
// =============================================================================

/**
 * Patterns to match context window usage percentages from PTY output.
 * Each pattern captures the percentage as group 1.
 *
 * Covers:
 * - Claude Code: "85% context", "context: 85%", "85% ctx"
 * - Gemini CLI: "85% context used", "context 85%"
 * - Generic: "XX% of context"
 */
const CONTEXT_PERCENT_PATTERNS: RegExp[] = [
	/(\d{1,3})%\s*(?:of\s+)?context/i,
	/context[:\s]+(\d{1,3})%/i,
	/(\d{1,3})%\s*ctx/i,
];

/**
 * Patterns to detect Gemini CLI token-count context display.
 * Gemini CLI shows remaining context as token counts (e.g., "1M context left)",
 * "500K context left)") rather than percentages.
 *
 * These patterns extract the numeric token count and unit suffix.
 * Group 1: numeric value, Group 2: unit (K, M, or empty = raw number).
 */
const GEMINI_CONTEXT_TOKEN_PATTERNS: RegExp[] = [
	/(\d+(?:\.\d+)?)\s*(K|M|k|m)?\s*(?:tokens?\s+)?context\s+left/i,
	/(\d+(?:\.\d+)?)\s*(K|M|k|m)?\s*context\s+(?:tokens?\s+)?(?:left|remaining)/i,
];

/**
 * Known max context sizes for Gemini models (in tokens).
 * Used to estimate context usage percentage from token counts.
 * Conservative estimate: assume 1M tokens max (Gemini 2.0 Flash/Pro).
 */
const GEMINI_DEFAULT_MAX_CONTEXT_TOKENS = 1_000_000;

// =============================================================================
// Service
// =============================================================================

/**
 * Monitors agent PTY sessions for context window usage and triggers
 * threshold-based warnings and auto-recovery.
 *
 * @example
 * ```typescript
 * const monitor = ContextWindowMonitorService.getInstance();
 * monitor.setDependencies(backend, regService, storageService, taskService, eventBus);
 * monitor.start();
 * monitor.startSessionMonitoring('agent-dev', 'member-1', 'team-1', 'developer');
 * ```
 */
export class ContextWindowMonitorService {
	private static instance: ContextWindowMonitorService | null = null;
	private logger: ComponentLogger;

	/** Per-session context window state */
	private contextStates: Map<string, ContextWindowState> = new Map();

	/** Per-session PTY data subscriptions + rolling buffers */
	private sessionSubscriptions: Map<string, SessionSubscription> = new Map();

	/** Periodic check interval timer */
	private checkTimer: ReturnType<typeof setInterval> | null = null;

	/** Dependencies (injected via setDependencies) */
	private sessionBackend: ISessionBackend | null = null;
	private agentRegistrationService: AgentRegistrationService | null = null;
	private storageService: StorageService | null = null;
	private taskTrackingService: TaskTrackingService | null = null;
	private eventBusService: EventBusService | null = null;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('ContextWindowMonitor');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The ContextWindowMonitorService singleton
	 */
	static getInstance(): ContextWindowMonitorService {
		if (!ContextWindowMonitorService.instance) {
			ContextWindowMonitorService.instance = new ContextWindowMonitorService();
		}
		return ContextWindowMonitorService.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		if (ContextWindowMonitorService.instance) {
			ContextWindowMonitorService.instance.stop();
			ContextWindowMonitorService.instance.destroyAllSubscriptions();
		}
		ContextWindowMonitorService.instance = null;
	}

	/**
	 * Inject required dependencies.
	 *
	 * @param sessionBackend - Session backend for PTY access
	 * @param agentRegistrationService - For recreating agent sessions on recovery
	 * @param storageService - For querying agent status
	 * @param taskTrackingService - For querying in-progress tasks for re-delivery
	 * @param eventBusService - For publishing context warning/critical events
	 */
	setDependencies(
		sessionBackend: ISessionBackend,
		agentRegistrationService: AgentRegistrationService,
		storageService: StorageService,
		taskTrackingService: TaskTrackingService,
		eventBusService: EventBusService
	): void {
		this.sessionBackend = sessionBackend;
		this.agentRegistrationService = agentRegistrationService;
		this.storageService = storageService;
		this.taskTrackingService = taskTrackingService;
		this.eventBusService = eventBusService;
	}

	/**
	 * Start the periodic check loop for stale detection and cleanup.
	 */
	start(): void {
		if (this.checkTimer) {
			this.logger.warn('Context window monitor already running');
			return;
		}

		this.logger.info('Starting context window monitor', {
			checkIntervalMs: CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS,
			yellowThreshold: CONTEXT_WINDOW_MONITOR_CONSTANTS.YELLOW_THRESHOLD_PERCENT,
			redThreshold: CONTEXT_WINDOW_MONITOR_CONSTANTS.RED_THRESHOLD_PERCENT,
			criticalThreshold: CONTEXT_WINDOW_MONITOR_CONSTANTS.CRITICAL_THRESHOLD_PERCENT,
		});
		void this.refreshProactiveCompactSetting();
		void this.refreshThresholdCompactSetting();

		this.checkTimer = setInterval(() => {
			this.performCheck();
		}, CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the periodic check loop.
	 */
	stop(): void {
		if (this.checkTimer) {
			clearInterval(this.checkTimer);
			this.checkTimer = null;
			this.logger.info('Context window monitor stopped');
		}
	}

	/**
	 * Check if the monitor is currently running.
	 *
	 * @returns True if the periodic check loop is active
	 */
	isRunning(): boolean {
		return this.checkTimer !== null;
	}

	/**
	 * Start monitoring a specific session for context window usage.
	 *
	 * Subscribes to the session's PTY onData events and parses output
	 * for context usage percentages.
	 *
	 * @param sessionName - PTY session name
	 * @param memberId - Team member ID
	 * @param teamId - Team ID
	 * @param role - Agent role
	 * @param runtimeType - Runtime type (defaults to 'claude-code')
	 */
	startSessionMonitoring(
		sessionName: string,
		memberId: string,
		teamId: string,
		role: string,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE
	): void {
		// Stop any existing monitoring for this session
		if (this.sessionSubscriptions.has(sessionName)) {
			this.stopSessionMonitoring(sessionName);
		}

		const backend = this.sessionBackend || getSessionBackendSync();
		if (!backend) {
			this.logger.warn('Cannot start context monitoring: session backend not available', { sessionName });
			return;
		}

		const session = backend.getSession(sessionName);
		if (!session) {
			this.logger.warn('Cannot start context monitoring: session not found', { sessionName });
			return;
		}

		// Initialize state
		const state: ContextWindowState = {
			sessionName,
			memberId,
			teamId,
			role,
			runtimeType,
			contextPercent: 0,
			level: 'normal',
			lastDetectedAt: Date.now(),
			recoveryTriggered: false,
			recoveryCount: 0,
			recoveryTimestamps: [],
			compactAttempts: 0,
			compactInProgress: false,
			lastCompactAt: 0,
			preCompactPercent: 0,
			compactWaitTimer: null,
		};
		this.contextStates.set(sessionName, state);

		// Subscribe to PTY data
		const unsubscribe = session.onData((data: string) => {
			this.handleData(sessionName, data);
		});

		this.sessionSubscriptions.set(sessionName, {
			unsubscribe,
			buffer: '',
		});

		this.logger.info('Started context window monitoring', {
			sessionName,
			memberId,
			teamId,
			role,
		});
	}

	/**
	 * Stop monitoring a specific session.
	 *
	 * @param sessionName - PTY session name
	 */
	stopSessionMonitoring(sessionName: string): void {
		const sub = this.sessionSubscriptions.get(sessionName);
		if (sub) {
			sub.unsubscribe();
			this.sessionSubscriptions.delete(sessionName);
		}

		// Clear any dangling compact wait timer to prevent stale callbacks
		const state = this.contextStates.get(sessionName);
		if (state?.compactWaitTimer) {
			clearTimeout(state.compactWaitTimer);
			state.compactWaitTimer = null;
		}

		this.contextStates.delete(sessionName);
		this.proactiveCompactLastTriggered.delete(sessionName);

		this.logger.debug('Stopped context window monitoring', { sessionName });
	}

	/**
	 * Get the context window state for a specific session.
	 *
	 * @param sessionName - PTY session name
	 * @returns The context window state or undefined if not monitored
	 */
	getContextState(sessionName: string): ContextWindowState | undefined {
		return this.contextStates.get(sessionName);
	}

	/**
	 * Get all monitored context window states.
	 *
	 * @returns Map of session name to context window state
	 */
	getAllContextStates(): Map<string, ContextWindowState> {
		return new Map(this.contextStates);
	}

	/**
	 * Handle incoming PTY data for a monitored session.
	 * Strips ANSI codes, appends to rolling buffer, and checks for context % patterns.
	 *
	 * @param sessionName - PTY session name
	 * @param data - Raw PTY output data
	 */
	private handleData(sessionName: string, data: string): void {
		const sub = this.sessionSubscriptions.get(sessionName);
		const state = this.contextStates.get(sessionName);
		if (!sub || !state) {
			return;
		}

		// Strip ANSI and append to rolling buffer
		const clean = stripAnsiCodes(data);
		sub.buffer += clean;

		// Cap buffer size
		if (sub.buffer.length > CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_BUFFER_SIZE) {
			sub.buffer = sub.buffer.slice(-CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_BUFFER_SIZE);
		}

		// Try to extract context percentage from buffer
		const percent = this.extractContextPercent(sub.buffer, state.runtimeType);
		if (percent !== null) {
			this.updateContextUsage(sessionName, percent);
			// Clear buffer after successful extraction to avoid re-matching
			sub.buffer = '';
		}
	}

	/**
	 * Extract context usage percentage from terminal output.
	 *
	 * Tries percentage-based patterns first (Claude Code, generic), then
	 * Gemini CLI token-count patterns. Token counts are converted to an
	 * estimated usage percentage using GEMINI_DEFAULT_MAX_CONTEXT_TOKENS.
	 *
	 * @param text - Cleaned terminal output text
	 * @param runtimeType - Optional runtime type for runtime-specific parsing
	 * @returns The extracted percentage (0-100) or null if not found
	 */
	private extractContextPercent(text: string, runtimeType?: RuntimeType): number | null {
		// Try standard percentage patterns first (works for all runtimes)
		for (const pattern of CONTEXT_PERCENT_PATTERNS) {
			const match = pattern.exec(text);
			if (match) {
				const percent = parseInt(match[1], 10);
				if (percent >= 0 && percent <= 100) {
					return percent;
				}
			}
		}

		// Try Gemini token-count patterns ("500K context left", "1M context left")
		for (const pattern of GEMINI_CONTEXT_TOKEN_PATTERNS) {
			const match = pattern.exec(text);
			if (match) {
				const value = parseFloat(match[1]);
				const unit = (match[2] || '').toUpperCase();
				let tokensRemaining = value;
				if (unit === 'K') tokensRemaining = value * 1_000;
				else if (unit === 'M') tokensRemaining = value * 1_000_000;

				if (tokensRemaining >= 0 && tokensRemaining <= GEMINI_DEFAULT_MAX_CONTEXT_TOKENS * 2) {
					const usedPercent = Math.round(
						((GEMINI_DEFAULT_MAX_CONTEXT_TOKENS - tokensRemaining) / GEMINI_DEFAULT_MAX_CONTEXT_TOKENS) * 100
					);
					return Math.max(0, Math.min(100, usedPercent));
				}
			}
		}

		return null;
	}

	/**
	 * Update context usage for a session and evaluate thresholds.
	 *
	 * @param sessionName - PTY session name
	 * @param percent - New context usage percentage
	 */
	updateContextUsage(sessionName: string, percent: number): void {
		const state = this.contextStates.get(sessionName);
		if (!state) {
			return;
		}

		const previousLevel = state.level;
		state.contextPercent = percent;
		state.lastDetectedAt = Date.now();

		// Determine new level
		if (percent >= CONTEXT_WINDOW_MONITOR_CONSTANTS.CRITICAL_THRESHOLD_PERCENT) {
			state.level = 'critical';
		} else if (percent >= CONTEXT_WINDOW_MONITOR_CONSTANTS.RED_THRESHOLD_PERCENT) {
			state.level = 'red';
		} else if (percent >= CONTEXT_WINDOW_MONITOR_CONSTANTS.YELLOW_THRESHOLD_PERCENT) {
			state.level = 'yellow';
		} else {
			state.level = 'normal';
			// Reset compact tracking when context drops back to normal
			if (previousLevel !== 'normal') {
				state.compactAttempts = 0;
				state.compactInProgress = false;
			}
		}

		// Only fire events on level transitions (not repeated at same level)
		if (state.level !== previousLevel && state.level !== 'normal') {
			this.evaluateThresholds(state, previousLevel);
		}
	}

	/**
	 * Evaluate threshold transitions and take appropriate actions.
	 *
	 * Strategy (compact-first):
	 * 1. Yellow (70%): Publish warning event only
	 * 2. Red (85%): Publish warning + trigger runtime-native compact/compress
	 * 3. Critical (95%): Retry compact; periodic checks will continue retrying
	 *    with cooldown. Auto-recovery (kill + restart) only if enabled.
	 *
	 * @param state - Current context window state
	 * @param previousLevel - The level before this update
	 */
	private evaluateThresholds(state: ContextWindowState, previousLevel: ContextLevel): void {
		this.logger.warn('Context window threshold crossed', {
			sessionName: state.sessionName,
			previousLevel,
			newLevel: state.level,
			contextPercent: state.contextPercent,
		});

		// Publish event for warning levels
		if (state.level === 'yellow' || state.level === 'red') {
			this.publishContextEvent(state, 'agent:context_warning');
		}

		// At red level: flush memory before compacting (#166)
		// Gated by enableThresholdCompact (default false per spec
		// 2026-05-05-compact-fix-AB-followup §B). When disabled, the wrapper
		// does NOT trigger /compact at the red threshold; the runtime handles
		// its own compaction internally.
		if (this.thresholdCompactEnabled && state.level === 'red' && !state.compactInProgress) {
			if (state.compactAttempts < CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS) {
				// #166: Pre-compaction memory flush — send a silent message asking the agent
				// to save critical context before compaction clears conversation history.
				// Only on the first compact attempt to avoid spam.
				if (state.compactAttempts === 0) {
					this.triggerPreCompactionFlush(state).catch((err) => {
						this.logger.warn('Pre-compaction memory flush failed (non-blocking)', {
							sessionName: state.sessionName,
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
				this.triggerCompact(state).catch((err) => {
					this.logger.error('Compact failed', {
						sessionName: state.sessionName,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		}

		// Critical level: try compact, or fall back to recovery if enabled
		if (state.level === 'critical') {
			this.publishContextEvent(state, 'agent:context_critical');

			// Try compact if we haven't hit the limit yet — gated by
			// enableThresholdCompact (default false per spec
			// 2026-05-05-compact-fix-AB-followup §B). When the gate is closed,
			// auto-recovery still runs as the safety net for runaway sessions.
			if (
				this.thresholdCompactEnabled &&
				!state.compactInProgress &&
				state.compactAttempts < CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS
			) {
				this.triggerCompact(state).catch((err) => {
					this.logger.error('Compact at critical failed', {
						sessionName: state.sessionName,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			} else if (
				CONTEXT_WINDOW_MONITOR_CONSTANTS.AUTO_RECOVERY_ENABLED &&
				!state.recoveryTriggered
			) {
				// Auto-recovery enabled and compact exhausted — kill + restart
				state.recoveryTriggered = true;
				this.triggerAutoRecovery(state).catch((err) => {
					this.logger.error('Auto-recovery failed', {
						sessionName: state.sessionName,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			} else if (!CONTEXT_WINDOW_MONITOR_CONSTANTS.AUTO_RECOVERY_ENABLED) {
				// Auto-recovery disabled — periodic checks will retry compact
				// after COMPACT_RETRY_COOLDOWN_MS via performCheck()
				this.logger.warn('Context critical, compact exhausted, auto-recovery disabled. Periodic retry will continue.', {
					sessionName: state.sessionName,
					contextPercent: state.contextPercent,
					compactAttempts: state.compactAttempts,
				});
			}
		}

		// Broadcast to frontend
		this.broadcastContextWarning(state);
	}

	/**
	 * Publish a context event via the event bus.
	 *
	 * @param state - Context window state
	 * @param eventType - Event type to publish
	 */
	private publishContextEvent(state: ContextWindowState, eventType: EventType): void {
		if (!this.eventBusService) {
			return;
		}

		const event: AgentEvent = {
			id: uuidv4(),
			type: eventType,
			timestamp: new Date().toISOString(),
			teamId: state.teamId,
			teamName: '',
			memberId: state.memberId,
			memberName: '',
			sessionName: state.sessionName,
			previousValue: String(state.contextPercent),
			newValue: state.level,
			changedField: 'contextUsage',
		};

		this.eventBusService.publish(event);

		this.logger.info('Published context event', {
			eventType,
			sessionName: state.sessionName,
			contextPercent: state.contextPercent,
			level: state.level,
		});
	}

	/**
	 * Broadcast context window status to frontend via WebSocket.
	 *
	 * @param state - Context window state to broadcast
	 */
	private broadcastContextWarning(state: ContextWindowState): void {
		const terminalGateway = getTerminalGateway();
		if (!terminalGateway) {
			return;
		}

		terminalGateway.broadcastContextWindowStatus({
			sessionName: state.sessionName,
			memberId: state.memberId,
			teamId: state.teamId,
			contextPercent: state.contextPercent,
			level: state.level,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * #166: Pre-compaction memory flush — send a message to the agent asking it to
	 * save critical context (current task, progress, findings) before compaction
	 * clears conversation history. The agent responds with record-learning or
	 * remember calls, then replies NO_REPLY to avoid generating visible output.
	 *
	 * This is fire-and-forget: if delivery fails, compaction still proceeds.
	 *
	 * @param state - Context window state for the session
	 */
	private async triggerPreCompactionFlush(state: ContextWindowState): Promise<void> {
		if (!this.agentRegistrationService) {
			return;
		}

		const flushMessage = `[SYSTEM — PRE-COMPACTION MEMORY FLUSH]
Your context window is at ${state.contextPercent}% and will be compacted shortly. Before compaction, save your critical working state NOW:

1. Call record-learning with: current task progress, key findings, any blockers, and what remains to be done
2. If you have important patterns or decisions discovered, call remember with scope: project

After saving, respond with exactly: NO_REPLY

This is automated — do not ask questions, just save and respond NO_REPLY.`;

		try {
			await this.agentRegistrationService.sendMessageToAgent(
				state.sessionName,
				flushMessage,
				state.runtimeType
			);
			this.logger.info('Pre-compaction memory flush sent', {
				sessionName: state.sessionName,
				contextPercent: state.contextPercent,
			});
		} catch (err) {
			this.logger.warn('Pre-compaction memory flush delivery failed', {
				sessionName: state.sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Trigger context compaction by sending the runtime's native compact command.
	 *
	 * Writes the appropriate slash command (e.g., `/compact` for Claude Code,
	 * `/compress` for Gemini CLI) to the PTY session stdin. The runtime handles
	 * the actual compression — typically via LLM-based summarization.
	 *
	 * @param state - Context window state for the session to compact
	 */
	private async triggerCompact(state: ContextWindowState): Promise<void> {
		// Do not compact while an agent is actively working. Runtime compact
		// commands can interrupt generation and cause task loss.
		// Keep this check fast-path synchronous when storage helpers are not
		// available (common in tests/mocks) to preserve existing behavior.
		let isBusy = false;
		const canCheckMemberBusy =
			this.storageService
			&& typeof (this.storageService as unknown as { findMemberBySessionName?: unknown }).findMemberBySessionName === 'function';
		const canCheckOrchestratorBusy =
			this.storageService
			&& typeof (this.storageService as unknown as { getOrchestratorStatus?: unknown }).getOrchestratorStatus === 'function';

		if (canCheckMemberBusy || canCheckOrchestratorBusy) {
			isBusy = await this.isSessionBusyForCompact(state.sessionName);
		}
		if (isBusy) {
			state.compactAttempts++;
			this.logger.info('Skipping compact: session is actively working', {
				sessionName: state.sessionName,
				runtimeType: state.runtimeType,
				contextPercent: state.contextPercent,
				compactAttempts: state.compactAttempts,
				maxAttempts: CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS,
			});
			return;
		}

		const backend = this.sessionBackend || getSessionBackendSync();
		if (!backend) {
			this.logger.warn('Cannot trigger compact: session backend not available', {
				sessionName: state.sessionName,
			});
			return;
		}

		const session = backend.getSession(state.sessionName);
		if (!session) {
			this.logger.warn('Cannot trigger compact: session not found', {
				sessionName: state.sessionName,
			});
			return;
		}

		const command = RUNTIME_COMPACT_COMMANDS[state.runtimeType];
		if (!command) {
			this.logger.warn('No compact command for runtime type', {
				sessionName: state.sessionName,
				runtimeType: state.runtimeType,
			});
			return;
		}

		state.compactInProgress = true;
		state.compactAttempts++;
		state.lastCompactAt = Date.now();
		state.preCompactPercent = state.contextPercent;

		this.logger.info('Triggering context compaction', {
			sessionName: state.sessionName,
			runtimeType: state.runtimeType,
			command,
			attempt: state.compactAttempts,
			contextPercent: state.contextPercent,
		});

		// Claude/Codex: Escape can safely clear in-progress input.
		// Gemini: Escape cancels the current request ("Request cancelled"), so skip it.
		if (state.runtimeType !== RUNTIME_TYPES.GEMINI_CLI) {
			session.write('\x1b');
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		session.write(command + '\r');

		// Clear any previous compact wait timer to avoid stale callbacks
		if (state.compactWaitTimer) {
			clearTimeout(state.compactWaitTimer);
		}

		// After COMPACT_WAIT_MS, mark compact as no longer in progress
		// and verify that context usage actually decreased (post-compact verification).
		state.compactWaitTimer = setTimeout(() => {
			state.compactInProgress = false;
			state.compactWaitTimer = null;

			// Post-compact verification: if context % did not decrease,
			// reset compact tracking so the next threshold evaluation retries.
			if (state.contextPercent >= state.preCompactPercent && state.level !== 'normal') {
				this.logger.warn('Post-compact verification: context did not decrease', {
					sessionName: state.sessionName,
					preCompactPercent: state.preCompactPercent,
					currentPercent: state.contextPercent,
					level: state.level,
				});
			} else if (state.contextPercent < state.preCompactPercent) {
				this.logger.info('Post-compact verification: context decreased', {
					sessionName: state.sessionName,
					preCompactPercent: state.preCompactPercent,
					currentPercent: state.contextPercent,
				});
			}
		}, CONTEXT_WINDOW_MONITOR_CONSTANTS.COMPACT_WAIT_MS);

		// Broadcast compact status to frontend
		const terminalGateway = getTerminalGateway();
		if (terminalGateway) {
			terminalGateway.broadcastContextWindowStatus({
				sessionName: state.sessionName,
				memberId: state.memberId,
				teamId: state.teamId,
				contextPercent: state.contextPercent,
				level: state.level,
				timestamp: new Date().toISOString(),
			});
		}
	}

	/**
	 * Returns true when a session is currently marked as in-progress.
	 * Falls back to false on lookup errors so monitoring can continue.
	 */
	private async isSessionBusyForCompact(sessionName: string): Promise<boolean> {
		if (!this.storageService) {
			return false;
		}

		try {
			if (sessionName === ORCHESTRATOR_SESSION_NAME) {
				const orchestrator = await this.storageService.getOrchestratorStatus();
				return orchestrator?.workingStatus === CREWLY_CONSTANTS.WORKING_STATUSES.IN_PROGRESS;
			}

			const memberInfo = await this.storageService.findMemberBySessionName(sessionName);
			const workingStatus = (memberInfo?.member as { workingStatus?: string } | undefined)?.workingStatus;
			return workingStatus === CREWLY_CONSTANTS.WORKING_STATUSES.IN_PROGRESS;
		} catch (error) {
			this.logger.debug('Failed to read working status before compact (non-fatal)', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Trigger auto-recovery for a session at critical context usage.
	 *
	 * Mirrors the restart pattern from AgentHeartbeatMonitorService:
	 * 1. Check cooldown
	 * 2. Save Claude session ID
	 * 3. Stop exit monitoring
	 * 4. Kill PTY session
	 * 5. Clear activity tracker
	 * 6. Pre-set session ID for resume
	 * 7. Recreate agent session
	 * 8. Broadcast status
	 * 9. Re-deliver tasks
	 *
	 * @param state - Context window state for the session to recover
	 */
	private async triggerAutoRecovery(state: ContextWindowState): Promise<void> {
		const backend = this.sessionBackend || getSessionBackendSync();
		if (!backend || !this.agentRegistrationService) {
			this.logger.warn('Cannot trigger auto-recovery: missing dependencies', {
				sessionName: state.sessionName,
			});
			return;
		}

		// Check cooldown
		const now = Date.now();
		const windowStart = now - CONTEXT_WINDOW_MONITOR_CONSTANTS.COOLDOWN_WINDOW_MS;
		state.recoveryTimestamps = state.recoveryTimestamps.filter(ts => ts > windowStart);

		if (state.recoveryTimestamps.length >= CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_RECOVERIES_PER_WINDOW) {
			this.logger.warn('Context recovery cooldown active, skipping', {
				sessionName: state.sessionName,
				recoveriesInWindow: state.recoveryTimestamps.length,
				maxPerWindow: CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_RECOVERIES_PER_WINDOW,
			});
			return;
		}

		this.logger.info('Triggering context window auto-recovery', {
			sessionName: state.sessionName,
			contextPercent: state.contextPercent,
			recoveryCount: state.recoveryCount,
		});

		try {
			// Save Claude session ID before killing
			let claudeSessionId: string | undefined;
			try {
				const persistence = getSessionStatePersistence();
				claudeSessionId = persistence.getSessionId(state.sessionName);
			} catch {
				this.logger.warn('Could not retrieve Claude session ID for recovery', {
					sessionName: state.sessionName,
				});
			}

			// Stop exit monitoring to avoid triggering exit callbacks
			RuntimeExitMonitorService.getInstance().stopMonitoring(state.sessionName);

			// Stop our own monitoring (will be re-started after session creation)
			this.stopSessionMonitoring(state.sessionName);

			// Kill old PTY session
			if (backend.sessionExists(state.sessionName)) {
				await backend.killSession(state.sessionName);
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
				this.logger.error('Context recovery createAgentSession failed', {
					sessionName: state.sessionName,
					error: result.error,
				});
				return;
			}

			// Track recovery
			state.recoveryTimestamps.push(now);
			state.recoveryCount++;

			// Broadcast agent recovered status
			const terminalGateway = getTerminalGateway();
			if (terminalGateway) {
				terminalGateway.broadcastTeamMemberStatus({
					teamId: state.teamId,
					memberId: state.memberId,
					sessionName: state.sessionName,
					agentStatus: 'active',
				});
			}

			this.logger.info('Context window auto-recovery successful', {
				sessionName: state.sessionName,
				recoveryCount: state.recoveryCount,
				claudeSessionId: claudeSessionId ? '(resumed)' : '(fresh)',
			});

			// Re-deliver in-progress tasks (async, non-blocking)
			this.redeliverTasks(state).catch((err) => {
				this.logger.error('Task re-delivery failed after context recovery', {
					sessionName: state.sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		} catch (err) {
			this.logger.error('Failed to perform context window auto-recovery', {
				sessionName: state.sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Re-deliver in-progress tasks to a recovered agent.
	 *
	 * @param state - Context window state for the recovered session
	 */
	private async redeliverTasks(state: ContextWindowState): Promise<void> {
		if (!this.taskTrackingService) {
			return;
		}

		const backend = this.sessionBackend || getSessionBackendSync();
		if (!backend) {
			return;
		}

		// Wait for agent initialization
		await new Promise(resolve => setTimeout(resolve, AGENT_SUSPEND_CONSTANTS.REHYDRATION_TIMEOUT_MS));

		if (!backend.sessionExists(state.sessionName)) {
			this.logger.warn('Agent session not found after recovery, skipping task re-delivery', {
				sessionName: state.sessionName,
			});
			return;
		}

		const session = backend.getSession(state.sessionName);
		if (!session) {
			return;
		}

		const tasks = await this.taskTrackingService.getTasksForTeamMember(state.memberId);
		const activeTasks = tasks.filter(t => t.status === 'assigned' || t.status === 'active');

		if (activeTasks.length === 0) {
			this.logger.debug('No active tasks to re-deliver after context recovery', {
				sessionName: state.sessionName,
			});
			return;
		}

		this.logger.info('Re-delivering tasks after context recovery', {
			sessionName: state.sessionName,
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
				'[TASK RE-DELIVERY] Your previous session ran out of context window.',
				'You were working on this task before your session was recovered:',
				`Task: ${task.taskName}`,
				`File: ${task.taskFilePath}`,
				'---',
				taskContent,
				'---',
				'Please continue working on this task.',
			].join('\n');

			session.write(message);

			const pasteDelay = Math.min(
				SESSION_COMMAND_DELAYS.MESSAGE_DELAY + Math.ceil(message.length / 10),
				5000
			);
			await new Promise(resolve => setTimeout(resolve, pasteDelay));
			session.write('\r');

			await new Promise(resolve => setTimeout(resolve, 2000));
		}

		this.logger.info('Task re-delivery after context recovery complete', {
			sessionName: state.sessionName,
			tasksDelivered: activeTasks.length,
		});
	}

	/**
	 * Periodic check for stale states, cleanup, compact retries, and proactive compaction.
	 *
	 * For stale sessions (no context % detected recently), resets to normal.
	 * For critical sessions with exhausted compacts, retries compact after
	 * COMPACT_RETRY_COOLDOWN_MS has elapsed since the last attempt.
	 * For all monitored sessions, checks cumulative output bytes and triggers
	 * proactive compact when threshold is exceeded.
	 */
	private performCheck(): void {
		const now = Date.now();
		const staleThreshold = CONTEXT_WINDOW_MONITOR_CONSTANTS.STALE_DETECTION_THRESHOLD_MS;

		// Proactive compact based on cumulative output volume (configurable)
		if (this.proactiveCompactEnabled) {
			this.checkProactiveCompact(now);
		}
		// Refresh cached settings in background so runtime config changes are picked up.
		void this.refreshProactiveCompactSetting();
		void this.refreshThresholdCompactSetting();

		for (const [sessionName, state] of this.contextStates) {
			const timeSinceLastDetection = now - state.lastDetectedAt;

			// Clean up stale states (no context % detected for a while)
			if (timeSinceLastDetection > staleThreshold && state.level !== 'normal') {
				// If we're critical and compact never succeeded, keep state to allow retry
				if (state.level === 'critical' && state.compactAttempts > 0) {
					this.logger.debug('Keeping critical state despite staleness (compact attempts pending)', {
						sessionName,
						compactAttempts: state.compactAttempts,
					});
					continue;
				}
				this.logger.debug('Context state stale, resetting to normal', {
					sessionName,
					timeSinceLastDetectionMs: timeSinceLastDetection,
				});
				state.level = 'normal';
				state.recoveryTriggered = false;
				state.compactAttempts = 0;
				state.compactInProgress = false;
				continue;
			}

			// Retry compact for critical sessions after cooldown
			if (
				state.level === 'critical' &&
				!state.compactInProgress &&
				!state.recoveryTriggered &&
				state.compactAttempts >= CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS
			) {
				const timeSinceLastCompact = now - state.lastCompactAt;
				if (timeSinceLastCompact >= CONTEXT_WINDOW_MONITOR_CONSTANTS.COMPACT_RETRY_COOLDOWN_MS) {
					this.logger.info('Retrying compact after cooldown for critical session', {
						sessionName,
						contextPercent: state.contextPercent,
						compactAttempts: state.compactAttempts,
						timeSinceLastCompactMs: timeSinceLastCompact,
					});

					// Reset attempts to allow one more try
					state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS - 1;
					this.triggerCompact(state).catch((err) => {
						this.logger.error('Compact retry failed', {
							sessionName: state.sessionName,
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			}
		}
	}

	/** Timestamp of last proactive compact per session for cooldown tracking */
	private proactiveCompactLastTriggered: Map<string, number> = new Map();
	/**
	 * Cached toggle for proactive compact behavior (loaded from settings).
	 *
	 * Default: `false` (fail-safe CLOSED). Per spec 2026-05-05-compact-fix-AB-followup §A.2 —
	 * before the first refresh from settings, the wrapper does NOT proactively compact.
	 * The runtime (Claude Code) handles its own compaction internally.
	 */
	private proactiveCompactEnabled: boolean = false;
	/**
	 * Cached toggle for threshold-driven compact at RED (85%) / CRITICAL (95%).
	 *
	 * Default: `false` (fail-safe CLOSED). Per spec 2026-05-05-compact-fix-AB-followup §B —
	 * threshold-driven external compaction is opt-in. Auto-recovery (kill+restart) still
	 * runs at CRITICAL when AUTO_RECOVERY_ENABLED, regardless of this flag.
	 */
	private thresholdCompactEnabled: boolean = false;

	/**
	 * Refresh the cached proactive compact toggle from persisted settings.
	 * Non-fatal: any read failure keeps the previous cached value.
	 *
	 * Fail-safe semantics: when the persisted setting is undefined, default to
	 * `false` so an absent configuration cannot enable external compaction.
	 */
	private async refreshProactiveCompactSetting(): Promise<void> {
		try {
			const settings = await getSettingsService().getSettings();
			this.proactiveCompactEnabled = settings?.general?.enableProactiveCompact ?? false;
		} catch {
			// Keep last known value on read failures.
		}
	}

	/**
	 * Refresh the cached threshold compact toggle from persisted settings.
	 * Non-fatal: any read failure keeps the previous cached value.
	 *
	 * Fail-safe semantics: when the persisted setting is undefined, default to
	 * `false` so an absent configuration cannot enable threshold-driven compaction.
	 */
	private async refreshThresholdCompactSetting(): Promise<void> {
		try {
			const settings = await getSettingsService().getSettings();
			this.thresholdCompactEnabled = settings?.general?.enableThresholdCompact ?? false;
		} catch {
			// Keep last known value on read failures.
		}
	}

	/**
	 * Check all monitored sessions for cumulative output volume and trigger
	 * proactive compact when the threshold is exceeded.
	 *
	 * @param now - Current timestamp in epoch ms
	 */
	private checkProactiveCompact(now: number): void {
		const backend = this.sessionBackend || getSessionBackendSync();
		if (!backend || !backend.getCumulativeOutputBytes || !backend.resetCumulativeOutput) {
			return;
		}

		for (const [sessionName, state] of this.contextStates) {
			if (state.compactInProgress) {
				continue;
			}

			const cumulativeBytes = backend.getCumulativeOutputBytes(sessionName);
			if (cumulativeBytes < CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_THRESHOLD_BYTES) {
				continue;
			}

			// Check cooldown
			const lastTriggered = this.proactiveCompactLastTriggered.get(sessionName) ?? 0;
			if (now - lastTriggered < CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_COOLDOWN_MS) {
				continue;
			}

			this.logger.info('Proactive compact triggered by cumulative output volume', {
				sessionName,
				cumulativeBytes,
				thresholdBytes: CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_THRESHOLD_BYTES,
			});

			this.proactiveCompactLastTriggered.set(sessionName, now);
			backend.resetCumulativeOutput(sessionName);

			this.triggerCompact(state).catch((err) => {
				this.logger.error('Proactive compact failed', {
					sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
	}

	/**
	 * Destroy all PTY subscriptions. Used during resetInstance.
	 */
	private destroyAllSubscriptions(): void {
		for (const [sessionName, sub] of this.sessionSubscriptions) {
			sub.unsubscribe();
		}
		this.sessionSubscriptions.clear();
		this.contextStates.clear();
		this.proactiveCompactLastTriggered.clear();
	}
}
