import * as path from 'path';
import * as os from 'os';
import { readFile, readdir, stat, mkdir, writeFile, access } from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import {
	SessionCommandHelper,
	createSessionCommandHelper,
	getSessionBackendSync,
	createSessionBackend,
	getSessionStatePersistence,
} from '../session/index.js';
import { RuntimeAgentService } from './runtime-agent.service.abstract.js';
import { RuntimeServiceFactory } from './runtime-service.factory.js';
import { CrewlyAgentRuntimeService } from './crewly-agent/crewly-agent-runtime.service.js';
import { StorageService } from '../core/storage.service.js';
import {
	CREWLY_CONSTANTS,
	ENV_CONSTANTS,
	AGENT_TIMEOUTS,
	ORCHESTRATOR_SESSION_NAME,
	ORCHESTRATOR_ROLE,
	RUNTIME_TYPES,
	RuntimeType,
	SESSION_COMMAND_DELAYS,
	EVENT_DELIVERY_CONSTANTS,
	TERMINAL_PATTERNS,
	GEMINI_SHELL_MODE_CONSTANTS,
	GEMINI_STUCK_CONNECTIVITY_PATTERN,
	GEMINI_ERROR_STATE_CONSTANTS,
} from '../../constants.js';
import { WEB_CONSTANTS } from '../../../../config/constants.js';
import { delay } from '../../utils/async.utils.js';
import { getSettingsService } from '../settings/settings.service.js';
import { SessionMemoryService } from '../memory/session-memory.service.js';
import { RuntimeExitMonitorService } from './runtime-exit-monitor.service.js';
import { ContextWindowMonitorService } from './context-window-monitor.service.js';
import { OAuthReloginMonitorService } from './oauth-relogin-monitor.service.js';
import { SubAgentMessageQueue } from '../messaging/sub-agent-message-queue.service.js';
import { AgentSuspendService } from './agent-suspend.service.js';
import { PromptBuilderService } from '../ai/prompt-builder.service.js';
import type { SubordinateInfo, TeamMemberSessionConfig, Team, TeamMember } from '../../types/index.js';
import { stripAnsiCodes } from '../../utils/terminal-output.utils.js';
import {
	isPromptLine,
	isAgentAtPrompt,
	containsSpinnerOrWorkingIndicator,
	containsProcessingIndicator,
	containsBusyStatusBar,
	containsRewindMode,
	containsGeminiProcessingKeywords,
	extractChatPrefix,
	stripTuiLineBorders,
	matchTuiPromptLine,
	stripBoxDrawing,
} from '../../utils/terminal-string-ops.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';

export interface OrchestratorConfig {
	sessionName: string;
	projectPath: string;
	windowName?: string;
}

/**
 * Service responsible for the complex, multi-step process of agent initialization and registration.
 * Isolates the complex state management of agent startup with progressive escalation.
 *
 * Key capabilities:
 * - Agent session creation and management
 * - Runtime initialization and registration
 * - Reliable message delivery to Claude Code with retry logic
 * - Health checking and status management
 */
export class AgentRegistrationService {
	private logger: ComponentLogger;
	private _sessionHelper: SessionCommandHelper | null = null;
	private storageService: StorageService;
	private projectRoot: string;

	// Prompt file caching to eliminate file I/O contention during concurrent session creation
	private promptCache = new Map<string, string>();

	// Session creation locks to prevent concurrent createAgentSession calls for the same session
	private sessionCreationLocks = new Map<string, Promise<{ success: boolean; sessionName?: string; message?: string; error?: string }>>();

	// AbortControllers for pending registration prompts (keyed by session name)
	private registrationAbortControllers = new Map<string, AbortController>();

	// Background stuck-message detector timer
	private stuckMessageDetectorTimer: ReturnType<typeof setInterval> | null = null;

	// Track TUI sessions for the stuck-message detector (sessionName → runtimeType)
	private tuiSessionRegistry = new Map<string, RuntimeType>();

	// Track recently-sent messages for background stuck-detection (all runtimes).
	// Key: sessionName, Value: array of tracked message entries
	private sentMessageTracker = new Map<string, Array<{
		snippet: string;
		sentAt: number;
		recovered: boolean;
		recoveryAttempts: number;
	}>>();

	// Per-session delivery mutex to serialize message delivery.
	// Prevents concurrent sendMessageWithRetry calls to the same session,
	// which causes multiple Ctrl+C presses that can crash the runtime.
	private sessionDeliveryMutex = new Map<string, Promise<void>>();

	// Per-session hash of last sent message to prevent duplicate writes (#128).
	// Key: sessionName, Value: { hash, sentAt }
	private lastSentMessageHash = new Map<string, { hash: string; sentAt: number }>();

	// In-process Crewly Agent runtimes (sessionName → runtime instance).
	// Used for crewly-agent runtimeType agents that run without PTY sessions.
	private inProcessRuntimes = new Map<string, CrewlyAgentRuntimeService>();

	/** #167: Optional scheduler service for DLQ drain on agent activation. */
	private schedulerService: { drainDeadLetterQueue(sessionName: string): Promise<number> } | null = null;


	// Terminal patterns are now centralized in TERMINAL_PATTERNS constant
	// Keeping prompt chars as static getter for backwards compatibility within the class
	private static get CLAUDE_PROMPT_INDICATORS() {
		return TERMINAL_PATTERNS.PROMPT_CHARS;
	}

	constructor(
		_legacyTmuxService: unknown, // Legacy parameter for backwards compatibility
		projectRoot: string | null,
		storageService: StorageService
	) {
		this.logger = LoggerService.getInstance().createComponentLogger('AgentRegistrationService');
		this.storageService = storageService;
		this.projectRoot = projectRoot || this.findProjectRoot();

		// Wire up the exit monitor to cancel pending registrations on runtime exit
		RuntimeExitMonitorService.getInstance().setOnExitDetectedCallback(
			(sessionName: string) => {
				this.cancelPendingRegistration(sessionName);
				this.unregisterTuiSession(sessionName);
				// Preserve queued messages for suspended agents (they'll be delivered on rehydrate)
				if (!AgentSuspendService.getInstance().isSuspended(sessionName)) {
					SubAgentMessageQueue.getInstance().clear(sessionName);
				}
			}
		);
	}

	/**
	 * #167: Inject scheduler service for dead-letter queue drain on agent activation.
	 *
	 * @param scheduler - Scheduler service with drainDeadLetterQueue method
	 */
	setSchedulerService(scheduler: { drainDeadLetterQueue(sessionName: string): Promise<number> }): void {
		this.schedulerService = scheduler;
	}

	/**
	 * Cancel a pending registration prompt for a session.
	 * Called by RuntimeExitMonitorService when a runtime exit is detected.
	 *
	 * @param sessionName - The session whose registration to cancel
	 */
	cancelPendingRegistration(sessionName: string): void {
		const controller = this.registrationAbortControllers.get(sessionName);
		if (controller) {
			controller.abort();
			this.registrationAbortControllers.delete(sessionName);
			this.logger.info('Cancelled pending registration', { sessionName });
		}
	}

	/**
	 * Get or create the session helper with lazy initialization
	 */
	private async getSessionHelper(): Promise<SessionCommandHelper> {
		this.logger.debug('Getting session helper', {
			hasExistingHelper: !!this._sessionHelper,
		});

		if (this._sessionHelper) {
			return this._sessionHelper;
		}

		let backend = getSessionBackendSync();
		this.logger.debug('Backend sync check', {
			hasBackend: !!backend,
		});

		if (!backend) {
			this.logger.info('Creating new PTY session backend');
			backend = await createSessionBackend('pty');
			this.logger.info('PTY session backend created', {
				hasBackend: !!backend,
			});
		}

		this._sessionHelper = createSessionCommandHelper(backend);
		this.logger.debug('Session helper created');
		return this._sessionHelper;
	}

	/**
	 * Get session helper synchronously (may throw if not initialized)
	 */
	private getSessionHelperSync(): SessionCommandHelper {
		if (!this._sessionHelper) {
			const backend = getSessionBackendSync();
			if (!backend) {
				throw new Error('Session backend not initialized');
			}
			this._sessionHelper = createSessionCommandHelper(backend);
		}
		return this._sessionHelper;
	}

	/**
	 * Resolve the runtime type for a session from storage.
	 * Checks orchestrator status first, then team member data.
	 * Falls back to CLAUDE_CODE if nothing is found.
	 *
	 * IMPORTANT: Callers should prefer passing runtimeType explicitly.
	 * This method exists as a safety net so that Ctrl+C (Claude Code
	 * cleanup) is never sent to a Gemini CLI session, which would
	 * trigger /quit and kill the agent.
	 */
	private async resolveSessionRuntimeType(sessionName: string): Promise<RuntimeType> {
		try {
			// Check if this is the orchestrator session
			if (sessionName === ORCHESTRATOR_SESSION_NAME) {
				const orchestratorStatus = await this.storageService.getOrchestratorStatus();
				if (orchestratorStatus?.runtimeType) {
					return orchestratorStatus.runtimeType as RuntimeType;
				}
			}

			// Check team member data
			const memberInfo = await this.storageService.findMemberBySessionName(sessionName);
			if (memberInfo?.member?.runtimeType) {
				return memberInfo.member.runtimeType as RuntimeType;
			}
		} catch (error) {
			this.logger.debug('Could not resolve runtime type from storage, using default', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		// Check in-process runtimes before defaulting to CLAUDE_CODE.
		// crewly-agent runtimes may not have a team config entry yet.
		if (this.inProcessRuntimes.has(sessionName)) {
			return RUNTIME_TYPES.CREWLY_AGENT;
		}

		return RUNTIME_TYPES.CLAUDE_CODE;
	}

	/**
	 * Route a crewly-agent in-process response to the originating chat conversation.
	 *
	 * PTY-based runtimes emit [NOTIFY] markers that the terminal gateway parses.
	 * In-process crewly-agents have no terminal output, so this method provides
	 * the equivalent routing for their text responses.
	 *
	 * @param sessionName - Agent session that produced the response
	 * @param text - Response text from the agent
	 * @param conversationId - Chat conversation to route the response to
	 */
	private routeInProcessResponseToChat(
		sessionName: string,
		text: string,
		conversationId: string,
	): void {
		// Lazy import to avoid circular dependencies at module load time
		import('../../websocket/chat.gateway.js')
			.then(({ getChatGateway }) => {
				const chatGateway = getChatGateway();
				if (!chatGateway) {
					this.logger.debug('ChatGateway not available, skipping response routing', {
						sessionName, conversationId,
					});
					return;
				}
				return chatGateway.processNotifyMessage(
					sessionName,
					text,
					conversationId,
					{ source: 'crewly-agent' },
				);
			})
			.then((chatMessage) => {
				if (chatMessage) {
					this.logger.debug('Routed in-process agent response to chat', {
						sessionName, conversationId,
						messageId: typeof chatMessage === 'object' ? (chatMessage as unknown as Record<string, unknown>).id : undefined,
					});
				}
			})
			.catch((err) => {
				this.logger.warn('Failed to route in-process agent response to chat', {
					sessionName, conversationId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	/**
	 * Find the project root by looking for package.json
	 */
	private findProjectRoot(): string {
		// Resolve from the compiled dist/ location to the package root (#209)
		// dist/backend/src/services/agent/ → root (5 levels up)
		// This works for both local dev and npm global installs
		try {
			// Use __dirname equivalent: path.dirname(fileURLToPath(import.meta.url))
			// But since Jest doesn't support import.meta, we use the module path directly
			const candidates = [
				// From source: backend/src/services/agent/ → root
				path.resolve(__dirname, '..', '..', '..', '..'),
				// From compiled dist: dist/backend/src/services/agent/ → root
				path.resolve(__dirname, '..', '..', '..', '..', '..'),
			];
			for (const candidate of candidates) {
				if (existsSync(path.join(candidate, 'config', 'skills'))) {
					return candidate;
				}
			}
		} catch {
			// Path resolution failed — fall back
		}
		return process.cwd();
	}

	/**
	 * Resolve runtime flags from the agent's effective skills.
	 * Reads role config and skill configs to collect flags compatible with the runtime.
	 *
	 * @param role - The agent's role name
	 * @param runtimeType - The agent's runtime type (e.g. 'claude-code')
	 * @param skillOverrides - Additional skills assigned to the member
	 * @param excludedRoleSkills - Skills excluded from the role's default set
	 * @returns Array of CLI flags to inject (e.g. ['--chrome'])
	 */
	private async resolveRuntimeFlags(
		role: string,
		runtimeType: RuntimeType,
		skillOverrides?: string[],
		excludedRoleSkills?: string[]
	): Promise<string[]> {
		const flags = new Set<string>();
		try {
			// 1. Get role's assigned skills from config/roles/{role}/role.json
			const roleName = role.toLowerCase().replace(/\s+/g, '-');
			const rolePath = path.join(this.projectRoot, 'config', 'roles', roleName, 'role.json');
			const roleContent = await readFile(rolePath, 'utf8');
			const roleConfig = JSON.parse(roleContent);
			const roleSkills: string[] = roleConfig.assignedSkills || [];

			// 2. Apply skill overrides and exclusions
			const effectiveSkills = new Set([...roleSkills, ...(skillOverrides || [])]);
			for (const excluded of (excludedRoleSkills || [])) {
				effectiveSkills.delete(excluded);
			}

			// 3. For each skill, read skill.json and collect flags matching runtime.
			//    Skills live under agent/core/ or agent/marketplace/ subdirectories,
			//    so search both paths when looking up skill.json.
			for (const skillId of effectiveSkills) {
				try {
					const skillJsonPath = await this.findSkillJsonPath(skillId);
					if (!skillJsonPath) {
						this.logger.debug('Skill config not found in any known directory (no runtime flags)', { skillId });
						continue;
					}
					const skillContent = await readFile(skillJsonPath, 'utf8');
					const skillConfig = JSON.parse(skillContent);
					if (skillConfig.runtime?.runtime === runtimeType && Array.isArray(skillConfig.runtime?.flags)) {
						for (const flag of skillConfig.runtime.flags) {
							flags.add(flag);
						}
					}
				} catch (skillErr) {
					this.logger.warn('Failed to read skill config', {
						skillId,
						error: skillErr instanceof Error ? skillErr.message : String(skillErr),
					});
				}
			}

			if (flags.size > 0) {
				this.logger.info('Resolved runtime flags from skills', {
					role, runtimeType, flags: Array.from(flags),
				});
			}
		} catch (error) {
			this.logger.debug('Could not resolve runtime flags (no role config or read error)', {
				role, runtimeType, error: error instanceof Error ? error.message : String(error),
			});
		}
		return Array.from(flags);
	}

	/**
	 * Search known skill directories for a skill's skill.json file.
	 * Skills live under `config/skills/agent/core/` or `config/skills/agent/marketplace/`.
	 *
	 * @param skillId - The skill identifier (directory name)
	 * @returns Absolute path to skill.json, or null if not found
	 */
	private async findSkillJsonPath(skillId: string): Promise<string | null> {
		const searchDirs = [
			path.join(this.projectRoot, 'config', 'skills', 'agent', 'core', skillId, 'skill.json'),
			path.join(this.projectRoot, 'config', 'skills', 'agent', 'marketplace', skillId, 'skill.json'),
		];
		for (const candidate of searchDirs) {
			try {
				await access(candidate);
				return candidate;
			} catch {
				// Not found in this directory, try next
			}
		}
		return null;
	}

	/**
	 * Create a runtime service instance for the given runtime type.
	 * Centralizes RuntimeServiceFactory creation to reduce code duplication.
	 */
	private createRuntimeService(runtimeType: RuntimeType): RuntimeAgentService {
		return RuntimeServiceFactory.create(runtimeType, null, this.projectRoot);
	}

	/**
	 * Get an in-process Crewly Agent runtime by session name.
	 * Used by the terminal controller for force-delivery to in-process agents.
	 *
	 * @param sessionName - Session name to look up
	 * @returns The CrewlyAgentRuntimeService if it exists, undefined otherwise
	 */
	getInProcessRuntime(sessionName: string): CrewlyAgentRuntimeService | undefined {
		return this.inProcessRuntimes.get(sessionName);
	}

	/**
	 * Check if an in-process Crewly Agent runtime is active and ready for a given session.
	 *
	 * Used by team status resolution to correctly report active status for
	 * crewly-agent runtimes that have no PTY session.
	 *
	 * @param sessionName - The session name to check
	 * @returns True if an in-process runtime exists and is ready
	 */
	isInProcessRuntimeActive(sessionName: string): boolean {
		const runtime = this.inProcessRuntimes.get(sessionName);
		return runtime !== undefined && runtime.isReady();
	}

	/**
	 * Get the check interval based on environment.
	 * Uses shorter intervals in test environment for faster tests.
	 */
	private getCheckInterval(): number {
		return process.env.NODE_ENV === 'test' ? 1000 : 2000;
	}

	/**
	 * Update agent status with safe error handling (non-blocking).
	 * Returns true if successful, false if failed.
	 */
	private async updateAgentStatusSafe(
		sessionName: string,
		status: (typeof CREWLY_CONSTANTS.AGENT_STATUSES)[keyof typeof CREWLY_CONSTANTS.AGENT_STATUSES],
		context?: { role?: string }
	): Promise<boolean> {
		try {
			await this.storageService.updateAgentStatus(sessionName, status);
			this.logger.info(`Agent status updated to ${status}`, { sessionName, ...context });
			return true;
		} catch (error) {
			this.logger.warn('Failed to update agent status (non-critical)', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Get prompt file path for a specific role
	 * Uses the unified config/roles/{role}/prompt.md structure
	 */
	private async getPromptFileForRole(role: string): Promise<string> {
		// Normalize role name to directory name format
		const roleName = role.toLowerCase().replace(/\s+/g, '-');
		return path.join(process.cwd(), 'config', 'roles', roleName, 'prompt.md');
	}

	/**
	 * Initialize agent with optimized 2-step escalation process
	 * Reduced from 4-step to 2-step with shorter timeouts for better concurrency
	 */
	async initializeAgentWithRegistration(
		sessionName: string,
		role: string,
		projectPath?: string,
		timeout: number = AGENT_TIMEOUTS.REGULAR_AGENT_INITIALIZATION,
		memberId?: string,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE,
		runtimeFlags?: string[],
		additionalAllowlistPaths?: string[]
	): Promise<{
		success: boolean;
		message?: string;
		error?: string;
	}> {
		const startTime = Date.now();

		this.logger.info('Starting optimized agent initialization with registration', {
			sessionName,
			role,
			timeout,
			runtimeType,
		});

		// PHASE 4: agentStatus is now set immediately in API endpoints (startTeam/startTeamMember)
		// No longer need to set it here - focus only on session creation
		this.logger.info('Starting agent session initialization', { sessionName, role });

		// Clear detection cache to ensure fresh runtime detection
		const runtimeService = this.createRuntimeService(runtimeType);
		runtimeService.clearDetectionCache(sessionName);

		// Skip Step 1 (direct registration) as it often fails in concurrent scenarios
		// Go directly to Step 2: Cleanup + reinit (more reliable)
		try {
			this.logger.info('Step 1: Attempting cleanup and reinitialization', {
				sessionName,
			});
			const step1Success = await this.tryCleanupAndReinit(
				sessionName,
				role,
				70000, // 70 seconds for cleanup and reinit (allows 60s for runtime ready)
				projectPath,
				memberId,
				runtimeType,
				runtimeFlags,
				additionalAllowlistPaths
			);
			if (step1Success) {
				return {
					success: true,
					message: 'Agent registered successfully after cleanup and reinit',
				};
			}
		} catch (error) {
			this.logger.warn('Step 1 (cleanup + reinit) failed', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		// Step 2: Full session recreation (30 seconds) - only if time remaining
		if (Date.now() - startTime < timeout - 35000) {
			try {
				this.logger.info('Step 2: Attempting full session recreation', { sessionName });
				const step2Success = await this.tryFullRecreation(
					sessionName,
					role,
					30000, // Reduced from 45000 to 30000
					projectPath,
					memberId,
					runtimeType,
					runtimeFlags
				);
				if (step2Success) {
					return {
						success: true,
						message: 'Agent registered successfully after full recreation',
					};
				}
			} catch (error) {
				this.logger.warn('Step 2 (full recreation) failed', {
					sessionName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Give up after 2 steps
		const errorMsg = `Failed to initialize agent after optimized escalation attempts (${Math.round(
			(Date.now() - startTime) / 1000
		)}s)`;
		this.logger.error(errorMsg, { sessionName, role });
		return { success: false, error: errorMsg };
	}

	/**
	 * Step 1: Try direct registration prompt
	 * Assumes Claude is already running and just needs a registration prompt
	 */
	private async tryDirectRegistration(
		sessionName: string,
		role: string,
		timeout: number,
		memberId?: string,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE
	): Promise<boolean> {
		// Clear any existing input. Claude already performs Ctrl+C cleanup during
		// runtime detection, so avoid sending additional Ctrl+C sequences.
		// Gemini CLI: Skip cleanup — Ctrl+C at an empty prompt triggers /quit.
		// Escape defocuses the TUI. Ctrl+U is ignored by the TUI.
		const helper = await this.getSessionHelper();

		// First check if runtime is running before sending the prompt
		// runtimeService2: Separate instance for pre-registration runtime detection
		// This instance is isolated from main runtimeService to avoid cache interference
		const runtimeService2 = this.createRuntimeService(runtimeType);
		const runtimeRunning = await runtimeService2.detectRuntimeWithCommand(sessionName);
		if (!runtimeRunning) {
			this.logger.debug('Runtime not detected in Step 1, skipping direct registration', {
				sessionName,
				runtimeType,
			});
			return false;
		}

		this.logger.debug('Runtime detected, sending registration prompt', {
			sessionName,
			runtimeType,
		});

		// Clear any pending slash command from detection. Claude detection already
		// exits slash mode. Gemini CLI: skip — Ctrl+C at empty prompt exits CLI,
		// Escape defocuses TUI, Ctrl+U is ignored. The prompt should be clean.

		const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId, runtimeType);
		const promptDelivered = await this.sendPromptRobustly(sessionName, prompt, runtimeType);

		if (!promptDelivered) {
			this.logger.warn('Failed to deliver registration prompt', { sessionName, role });
			return false;
		}

		return await this.waitForRegistration(sessionName, role, timeout);
	}

	/**
	 * Step 2: Cleanup with Ctrl+C and reinitialize
	 * Tries to reset the runtime session and start fresh
	 */
	private async tryCleanupAndReinit(
		sessionName: string,
		role: string,
		timeout: number,
		projectPath?: string,
		memberId?: string,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE,
		runtimeFlags?: string[],
		additionalAllowlistPaths?: string[]
	): Promise<boolean> {
		// Clear Commandline
		await (await this.getSessionHelper()).clearCurrentCommandLine(sessionName);

		// Inject --resume flag if this was a previously running Claude Code session
		const effectiveFlags = runtimeFlags ? [...runtimeFlags] : [];
		if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
			try {
				const settings = await getSettingsService().getSettings();
				if (settings.general.autoResumeOnRestart) {
					const persistence = getSessionStatePersistence();
					if (persistence.isRestoredSession(sessionName)) {
						const storedSessionId = persistence.getSessionId(sessionName);
						if (storedSessionId) {
							effectiveFlags.push('--resume', storedSessionId);
							this.logger.info('Injecting --resume flag for session restore', {
								sessionName, sessionId: storedSessionId,
							});
						}
					}
				} else {
					this.logger.info('Auto-resume disabled by settings, skipping session resume', { sessionName });
				}
			} catch (resumeError) {
				this.logger.debug('Could not resolve resume flag (non-fatal)', {
					sessionName, error: resumeError instanceof Error ? resumeError.message : String(resumeError),
				});
			}
		}

		// Write prompt file before launching runtime so --agent (Claude Code) or --append-system-prompt-file works
		let promptFilePath: string | undefined;
		let agentName: string | undefined;
		if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
			try {
				const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId, runtimeType);
				promptFilePath = await this.writePromptFile(sessionName, prompt);
			} catch (promptError) {
				this.logger.warn('Failed to pre-write prompt file (non-fatal, will fall back to direct delivery)', {
					sessionName,
					error: promptError instanceof Error ? promptError.message : String(promptError),
				});
			}
		}

		// Reinitialize runtime using the appropriate initialization script (always fresh start)
		const runtimeService2 = this.createRuntimeService(runtimeType);
		await runtimeService2.executeRuntimeInitScript(sessionName, projectPath, effectiveFlags, promptFilePath, agentName);

		// Wait for runtime to be ready (simplified detection)
		// Use shorter check interval in test environment, and reasonable interval in production
		const checkInterval = this.getCheckInterval();
		const isReady = await runtimeService2.waitForRuntimeReady(
			sessionName,
			60000,
			checkInterval
		); // 60s timeout — Claude Code cold starts can take 30-60s
		if (!isReady) {
			throw new Error(`Failed to reinitialize ${runtimeType} within timeout`);
		}

		// Start runtime exit monitoring IMMEDIATELY after runtime is ready.
		// Must be before postInitialize and sendRegistrationPromptAsync so exits
		// during those phases are detected and the abort signal fires in time.
		RuntimeExitMonitorService.getInstance().startMonitoring(
			sessionName, runtimeType, role
		);

		// Start OAuth relogin monitoring for automatic re-authentication
		OAuthReloginMonitorService.getInstance().startMonitoring(sessionName, runtimeType);

		// Look up per-agent browser automation override from member config
		let browserAutomationOverride: boolean | undefined;
		if (memberId) {
			try {
				const teams = await this.storageService.getTeams();
				for (const team of teams) {
					const member = team.members?.find((m) => m.id === memberId || m.sessionName === sessionName);
					if (member?.enableBrowserAutomation !== undefined) {
						browserAutomationOverride = member.enableBrowserAutomation;
						break;
					}
				}
			} catch {
				// Non-fatal — will use global setting
			}
		}

		// Run post-initialization hook (e.g., Gemini CLI directory allowlist)
		try {
			await runtimeService2.postInitialize(sessionName, projectPath, additionalAllowlistPaths, browserAutomationOverride);
			// Drain stale terminal escape sequences (e.g. DA1 [?1;2c) that may have
			// arrived during postInitialize commands, so they don't leak into the prompt input
			await delay(500);
			// Clear any pending input after post-initialization.
			// Claude Code: Ctrl+C + Ctrl+U (clearCurrentCommandLine) — standard cleanup.
			// Gemini CLI: Skip cleanup entirely — the TUI just started with a clean
			// prompt. Ctrl+C at an empty Gemini CLI prompt triggers /quit and exits
			// the CLI. Escape defocuses the TUI. Ctrl+U is ignored. The delay(500)
			// above is sufficient to drain stale escape sequences.
			if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
				await (await this.getSessionHelper()).clearCurrentCommandLine(sessionName);
			}
		} catch (postInitError) {
			this.logger.warn('Post-initialization hook failed (non-fatal)', {
				sessionName,
				runtimeType,
				error: postInitError instanceof Error ? postInitError.message : String(postInitError),
			});
		}

		// For PTY sessions, once runtime is detected as ready, consider initialization successful
		// MCP registration will happen async when the agent processes its first prompt
		this.logger.info('Runtime detected as ready, session initialization successful', {
			sessionName,
			role,
			runtimeType,
		});

		// Background: detect and store session ID for resume-on-restart
		if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
			const detectPath = projectPath || process.cwd();
			setTimeout(() => {
				this.detectAndStoreSessionId(sessionName, detectPath).catch(() => {});
			}, 10000);
		}

		// Send the registration prompt in background (don't block on it)
		this.sendRegistrationPromptAsync(sessionName, role, memberId, runtimeType).catch((err) => {
			this.logger.warn('Background registration prompt failed (non-blocking)', {
				sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
		});

		// Update agent status to 'started' since the runtime is running
		// The agent will become 'active' only after it registers via the API endpoint
		try {
			await this.storageService.updateAgentStatus(
				sessionName,
				CREWLY_CONSTANTS.AGENT_STATUSES.STARTED
			);
			this.logger.info('Agent status updated to started (runtime running, awaiting registration)', { sessionName, role });
		} catch (statusError) {
			this.logger.warn('Failed to update agent status (non-critical)', {
				sessionName,
				error: statusError instanceof Error ? statusError.message : String(statusError),
			});
		}

		return true;
	}

	/**
	 * Detect and store the Claude Code session ID by scanning the filesystem.
	 * Claude Code stores conversations as <UUID>.jsonl files in
	 * ~/.claude/projects/<path-slug>/ where path-slug is the absolute
	 * project path with / replaced by -.
	 *
	 * Runs in background after agent init to capture the session ID
	 * for resume-on-restart support.
	 *
	 * @param sessionName - PTY session name
	 * @param projectPath - Absolute path to the agent's project directory
	 */
	private async detectAndStoreSessionId(sessionName: string, projectPath: string): Promise<void> {
		try {
			const slug = projectPath.replace(/\//g, '-');
			const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', slug);

			const files = await readdir(claudeProjectDir);
			const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

			if (jsonlFiles.length === 0) return;

			// Find most recent .jsonl by mtime
			let latestFile = '';
			let latestMtime = 0;
			for (const file of jsonlFiles) {
				const fileStat = await stat(path.join(claudeProjectDir, file));
				if (fileStat.mtimeMs > latestMtime) {
					latestMtime = fileStat.mtimeMs;
					latestFile = file;
				}
			}

			if (!latestFile) return;

			// Extract UUID from filename (remove .jsonl extension)
			const sessionId = latestFile.replace('.jsonl', '');

			const persistence = getSessionStatePersistence();
			persistence.updateSessionId(sessionName, sessionId);

			this.logger.info('Detected and stored Claude session ID from filesystem', {
				sessionName,
				sessionId,
				claudeProjectDir,
			});
		} catch (error) {
			this.logger.debug('Could not detect Claude session ID from filesystem (non-fatal)', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Provision the runtime-specific project config file.
	 *
	 * Each agent CLI reads a different file for project configuration:
	 * - Claude Code  → .crewly/CLAUDE.md
	 * - Gemini CLI   → GEMINI.md (project root)
	 * - Codex        → AGENTS.md (project root)
	 *
	 * Uses 'wx' flag to avoid overwriting existing files.
	 *
	 * @param projectPath - Project directory path
	 * @param runtimeType - Agent runtime type
	 */
	private async provisionRuntimeConfigFile(projectPath: string, runtimeType: RuntimeType): Promise<void> {
		// Map runtime type to template file and output path
		const configMap: Record<string, { template: string; outputPath: string }> = {
			[RUNTIME_TYPES.CLAUDE_CODE]: {
				template: 'agent-claude-md.md',
				outputPath: path.join(projectPath, '.crewly', 'CLAUDE.md'),
			},
			[RUNTIME_TYPES.GEMINI_CLI]: {
				template: 'agent-gemini-md.md',
				outputPath: path.join(projectPath, 'GEMINI.md'),
			},
			[RUNTIME_TYPES.CODEX_CLI]: {
				template: 'agent-agents-md.md',
				outputPath: path.join(projectPath, 'AGENTS.md'),
			},
		};

		const config = configMap[runtimeType];
		if (!config) return; // Unknown runtime — skip

		try {
			// Ensure parent directory exists
			const dir = path.dirname(config.outputPath);
			await mkdir(dir, { recursive: true });

			const templatePath = path.join(this.projectRoot, 'config', 'templates', config.template);
			let content = this.promptCache.get(templatePath);
			if (!content) {
				content = await readFile(templatePath, 'utf8');
				this.promptCache.set(templatePath, content);
			}

			await writeFile(config.outputPath, content, { flag: 'wx' }).catch(() => {
				// File already exists — no action needed
			});
		} catch (err) {
			this.logger.warn('Could not provision runtime config file (non-critical)', {
				runtimeType,
				outputPath: config.outputPath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Send registration prompt asynchronously (non-blocking).
	 * Uses an AbortController so the operation can be cancelled if the
	 * runtime exits before registration completes.
	 */
	private async sendRegistrationPromptAsync(
		sessionName: string,
		role: string,
		memberId?: string,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE
	): Promise<void> {
		// Create AbortController for this registration
		const controller = new AbortController();
		this.registrationAbortControllers.set(sessionName, controller);

		try {
			this.logger.info('Loading registration prompt', { sessionName, role, runtimeType });

			if (controller.signal.aborted) return;
			const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId, runtimeType);

			this.logger.info('Registration prompt loaded, sending to agent', {
				sessionName, role, runtimeType, promptLength: prompt.length,
			});

			if (controller.signal.aborted) return;
			const sent = await this.sendPromptRobustly(sessionName, prompt, runtimeType, controller.signal);

			if (sent) {
				this.logger.info('Registration prompt sent successfully', { sessionName, role });
			} else {
				this.logger.warn('Registration prompt delivery returned false', { sessionName, role, runtimeType });
			}
		} catch (error) {
			if (controller.signal.aborted) {
				this.logger.info('Registration prompt cancelled (runtime exited)', { sessionName });
				return;
			}
			this.logger.warn('Failed to send registration prompt asynchronously', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		} finally {
			this.registrationAbortControllers.delete(sessionName);
		}
	}

	/**
	 * Step 3: Kill session and recreate completely
	 * Most aggressive approach - completely recreates the session from scratch
	 */
	private async tryFullRecreation(
		sessionName: string,
		role: string,
		timeout: number,
		projectPath?: string,
		memberId?: string,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE,
		runtimeFlags?: string[]
	): Promise<boolean> {
		// Kill existing session
		await (await this.getSessionHelper()).killSession(sessionName);

		// Wait for cleanup
		await delay(1000);

		// Inject --resume flag if this was a previously running Claude Code session
		const effectiveFlags = runtimeFlags ? [...runtimeFlags] : [];
		if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
			try {
				const settings = await getSettingsService().getSettings();
				if (settings.general.autoResumeOnRestart) {
					const persistence = getSessionStatePersistence();
					if (persistence.isRestoredSession(sessionName)) {
						const storedSessionId = persistence.getSessionId(sessionName);
						if (storedSessionId) {
							effectiveFlags.push('--resume', storedSessionId);
							this.logger.info('Injecting --resume flag for session restore (full recreation)', {
								sessionName, sessionId: storedSessionId,
							});
						}
					}
				} else {
					this.logger.info('Auto-resume disabled by settings, skipping session resume after recreation', { sessionName });
				}
			} catch (resumeError) {
				this.logger.debug('Could not resolve resume flag (non-fatal)', {
					sessionName, error: resumeError instanceof Error ? resumeError.message : String(resumeError),
				});
			}
		}

		// Write prompt file before launching runtime so --agent (Claude Code) or --append-system-prompt-file works
		let promptFilePath: string | undefined;
		let agentName: string | undefined;
		if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
			try {
				const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId, runtimeType);
				promptFilePath = await this.writePromptFile(sessionName, prompt);
			} catch (promptError) {
				this.logger.warn('Failed to pre-write prompt file in full recreation (non-fatal)', {
					sessionName,
					error: promptError instanceof Error ? promptError.message : String(promptError),
				});
			}
		}

		// Recreate session based on role
		if (role === ORCHESTRATOR_ROLE) {
			await this.createOrchestratorSession({
				sessionName,
				projectPath: projectPath || process.cwd(),
			});

			// Initialize runtime for orchestrator using script (always fresh start)
			const runtimeService = this.createRuntimeService(runtimeType);
			await runtimeService.executeRuntimeInitScript(sessionName, process.cwd(), effectiveFlags, promptFilePath, agentName);

			// Wait for runtime to be ready
			const checkInterval = this.getCheckInterval();
			// runtimeService3: Separate instance for orchestrator ready-state detection
			// Isolated from runtimeService to prevent interference between init and ready checks
			const runtimeService3 = this.createRuntimeService(runtimeType);
			const isReady = await runtimeService3.waitForRuntimeReady(
				sessionName,
				45000,
				checkInterval
			);
			if (!isReady) {
				throw new Error(
					`Failed to initialize ${runtimeType} in recreated orchestrator session within timeout`
				);
			}

			// Start runtime exit monitoring immediately after runtime is ready
			RuntimeExitMonitorService.getInstance().startMonitoring(
				sessionName, runtimeType, role
			);

			// Start OAuth relogin monitoring for automatic re-authentication
			OAuthReloginMonitorService.getInstance().startMonitoring(sessionName, runtimeType);

			// Additional verification: Use runtime detection to confirm runtime is responding
			// Wait a bit longer for runtime to fully load after showing welcome message
			this.logger.debug(
				'Runtime ready detected for orchestrator, waiting for full startup before verification',
				{ sessionName, runtimeType }
			);
			await delay(5000);

			// Codex CLI is sensitive to active key-probe verification (it may drop to
			// the shell when probe keys are interpreted outside the TUI). We already
			// passed waitForRuntimeReady above, so skip the extra command probe here.
			if (runtimeType !== RUNTIME_TYPES.CODEX_CLI) {
				this.logger.debug('Verifying orchestrator runtime responsiveness', {
					sessionName,
					runtimeType,
				});
				// runtimeService4: Final verification instance for orchestrator responsiveness
				// Clean instance for post-initialization responsiveness testing
				const runtimeService4 = this.createRuntimeService(runtimeType);
				const runtimeResponding = await runtimeService4.detectRuntimeWithCommand(sessionName);
				if (!runtimeResponding) {
					throw new Error(
						`${runtimeType} not responding to commands after orchestrator recreation`
					);
				}
			} else {
				this.logger.debug('Skipping active runtime probe for Codex orchestrator recreation', {
					sessionName,
					runtimeType,
				});
			}

			this.logger.debug(
				'Runtime confirmed ready for orchestrator in Step 3',
				{ sessionName, runtimeType }
			);
		} else {
			// For other roles, create basic session and initialize Claude (always fresh start)
			await (await this.getSessionHelper()).createSession(sessionName, projectPath || process.cwd());

			const runtimeService = this.createRuntimeService(runtimeType);
			await runtimeService.executeRuntimeInitScript(sessionName, projectPath, effectiveFlags, promptFilePath, agentName);

			// Wait for runtime to be ready (simplified detection)
			const checkInterval = this.getCheckInterval();
			const isReady = await this.createRuntimeService(runtimeType)
				.waitForRuntimeReady(sessionName, 25000, checkInterval); // 25s timeout
			if (!isReady) {
				throw new Error(
					`Failed to initialize ${runtimeType} in recreated session within timeout`
				);
			}

			// Start runtime exit monitoring immediately after runtime is ready
			RuntimeExitMonitorService.getInstance().startMonitoring(
				sessionName, runtimeType, role
			);

			// Start OAuth relogin monitoring for automatic re-authentication
			OAuthReloginMonitorService.getInstance().startMonitoring(sessionName, runtimeType);
		}

		// Look up per-agent browser automation override from member config
		let browserOverrideForRecreation: boolean | undefined;
		if (memberId) {
			try {
				const teams = await this.storageService.getTeams();
				for (const team of teams) {
					const member = team.members?.find((m) => m.id === memberId || m.sessionName === sessionName);
					if (member?.enableBrowserAutomation !== undefined) {
						browserOverrideForRecreation = member.enableBrowserAutomation;
						break;
					}
				}
			} catch {
				// Non-fatal — will use global setting
			}
		}

		// Run post-initialization hook (e.g., Gemini CLI directory allowlist)
		try {
			const postInitService = this.createRuntimeService(runtimeType);
			await postInitService.postInitialize(sessionName, projectPath, undefined, browserOverrideForRecreation);
			// Drain stale terminal escape sequences (e.g. DA1 [?1;2c) that may have
			// arrived during postInitialize commands, so they don't leak into the prompt input
			await delay(500);
			// Claude Code: Ctrl+C + Ctrl+U to clear any stale input.
			// Gemini CLI (Ink TUI): Do NOT send any cleanup keystrokes.
			// Escape defocuses the Ink TUI input permanently. Ctrl+C at empty
			// prompt triggers /quit. Ctrl+U is ignored. The delay above is
			// sufficient to drain stale escape sequences.
			if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
				await (await this.getSessionHelper()).clearCurrentCommandLine(sessionName);
			}
		} catch (postInitError) {
			this.logger.warn('Post-initialization hook failed after recreation (non-fatal)', {
				sessionName,
				runtimeType,
				error: postInitError instanceof Error ? postInitError.message : String(postInitError),
			});
		}

		// For PTY sessions, once runtime is detected as ready, consider initialization successful
		this.logger.info('Runtime detected as ready after full recreation, session initialization successful', {
			sessionName,
			role,
			runtimeType,
		});

		// Background: detect and store session ID for resume-on-restart
		if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
			const detectPath = projectPath || process.cwd();
			setTimeout(() => {
				this.detectAndStoreSessionId(sessionName, detectPath).catch(() => {});
			}, 10000);
		}

		// Send the registration prompt in background (don't block on it)
		this.sendRegistrationPromptAsync(sessionName, role, memberId, runtimeType).catch((err) => {
			this.logger.warn('Background registration prompt failed after recreation (non-blocking)', {
				sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
		});

		// Update agent status to 'started' since the runtime is running
		// The agent will become 'active' only after it registers via the API endpoint
		try {
			await this.storageService.updateAgentStatus(
				sessionName,
				CREWLY_CONSTANTS.AGENT_STATUSES.STARTED
			);
			this.logger.info('Agent status updated to started after recreation (awaiting registration)', { sessionName, role });
		} catch (statusError) {
			this.logger.warn('Failed to update agent status after recreation (non-critical)', {
				sessionName,
				error: statusError instanceof Error ? statusError.message : String(statusError),
			});
		}

		return true;
	}

	/**
	 * Register a crewly-agent member as active by updating its team config directly.
	 * In-process agents cannot run bash scripts, so this performs the registration
	 * that the register-self skill would normally do for PTY-based runtimes.
	 *
	 * @param sessionName - Agent session name
	 * @param role - Agent role
	 * @param memberId - Optional member UUID
	 * @returns True if registration succeeded
	 */
	private async registerMemberActive(
		sessionName: string,
		role: string,
		memberId?: string,
	): Promise<boolean> {
		try {
			// Handle orchestrator separately — its config is stored outside getTeams()
			if (sessionName === ORCHESTRATOR_SESSION_NAME) {
				await this.storageService.updateOrchestratorStatus(CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE);
				this.logger.info('Orchestrator registered as active via config', { sessionName });
				return true;
			}

			const teams = await this.storageService.getTeams();
			for (const team of teams) {
				const member = team.members.find(
					(m) =>
						(m.sessionName === sessionName) ||
						(memberId !== undefined && m.id === memberId),
				);
				if (member) {
					member.agentStatus = 'active';
					member.workingStatus = 'idle';
					member.updatedAt = new Date().toISOString();
					// Pre-populate sessionName so register_self tool can find this member
					if (!member.sessionName && sessionName) {
						member.sessionName = sessionName;
					}
					await this.storageService.saveTeam(team);
					this.logger.info('Member registered as active', { sessionName, teamId: team.id });

					// #167: Drain dead-letter queue for newly active agent
					if (this.schedulerService) {
						this.schedulerService.drainDeadLetterQueue(sessionName).catch((err: Error) => {
							this.logger.warn('Failed to drain DLQ on activation (non-critical)', {
								sessionName,
								error: err.message,
							});
						});
					}

					return true;
				}
			}
			this.logger.warn('Could not find member to register as active', { sessionName, memberId });
			return false;
		} catch (error) {
			this.logger.error('Failed to register member as active', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Load registration prompt from config files (with caching to prevent file I/O contention)
	 */
	private async loadRegistrationPrompt(
		role: string,
		sessionName: string,
		memberId?: string,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE
	): Promise<string> {
		try {
			// Cache key is role only - the template file is the same regardless of memberId
			const cacheKey = role;

			// Check cache first to avoid file I/O during concurrent operations
			if (!this.promptCache.has(cacheKey)) {
				this.logger.debug('Loading prompt template from file', { role, cacheKey });

				// Get the prompt file path from team roles configuration
				const promptPath = await this.getPromptFileForRole(role);
				const promptTemplate = await readFile(promptPath, 'utf8');
				this.promptCache.set(cacheKey, promptTemplate);
				this.logger.debug('Prompt template cached', { role, cacheKey, promptPath });
			} else {
				this.logger.debug('Using cached prompt template', { role, cacheKey });
			}

			// Get cached template and apply variable replacements
			let prompt = this.promptCache.get(cacheKey)!;

			// Replace all template placeholders
			prompt = prompt.replace(/\{\{SESSION_ID\}\}/g, sessionName);
			prompt = prompt.replace(/\{\{SESSION_NAME\}\}/g, sessionName);
			prompt = prompt.replace(/\{\{ROLE\}\}/g, role);
			if (memberId) {
				prompt = prompt.replace(/\{\{MEMBER_ID\}\}/g, memberId);
			} else {
				// For orchestrator or cases without member ID, remove the memberId parameter
				prompt = prompt.replace(/,\s*"memberId":\s*"\{\{MEMBER_ID\}\}"/g, '');
			}

			// Look up project path and TL hierarchy for team members
			let projectPath = process.cwd();
			let foundTeam: Team | null = null;
			let foundMember: TeamMember | null = null;
			try {
				const teams = await this.storageService.getTeams();
				for (const team of teams) {
					const member = team.members?.find((m) => m.sessionName === sessionName);
					if (member) {
						foundTeam = team;
						foundMember = member;
						if (team.projectIds[0]) {
							const projects = await this.storageService.getProjects();
							const project = projects.find((p) => p.id === team.projectIds[0]);
							if (project?.path) {
								projectPath = project.path;
							}
						}
						break;
					}
				}
			} catch {
				// Non-critical - use default project path
			}

			// Write runtime-specific project config file so the agent CLI
			// recognizes Crewly as a legitimate project configuration (fixes #33)
			// Claude Code → .crewly/CLAUDE.md, Gemini CLI → GEMINI.md, Codex → AGENTS.md
			if (role !== ORCHESTRATOR_ROLE) {
				await this.provisionRuntimeConfigFile(projectPath, runtimeType);
			}

			// Replace project path placeholder (must happen after project path lookup above)
			prompt = prompt.replace(/\{\{PROJECT_PATH\}\}/g, projectPath);

			// Replace agent skills path placeholder
			const agentSkillsPath = path.join(this.projectRoot, 'config', 'skills', 'agent');
			prompt = prompt.replace(/\{\{AGENT_SKILLS_PATH\}\}/g, agentSkillsPath);

			// Replace marketplace skills path placeholder
			const marketplaceSkillsPath = path.join(os.homedir(), '.crewly', 'marketplace', 'skills');
			prompt = prompt.replace(/\{\{MARKETPLACE_SKILLS_PATH\}\}/g, marketplaceSkillsPath);

			// #210: Inject member's systemPrompt if available
			// This contains role context and authorization info that the agent needs at startup
			if (foundTeam && foundMember?.id) {
				try {
					const memberPrompt = await this.storageService.getMemberPrompt(foundTeam.id, foundMember.id);
					if (memberPrompt && memberPrompt.trim()) {
						prompt = memberPrompt.trim() + '\n\n' + prompt;
						this.logger.info('Member systemPrompt prepended to init prompt', {
							sessionName,
							memberId: foundMember.id,
							systemPromptLength: memberPrompt.length,
						});
					}
				} catch (err) {
					this.logger.warn('Failed to load member systemPrompt (non-critical)', {
						sessionName,
						memberId: foundMember.id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			// Inject skill authorization section — tells agents that all skills
			// (including browser control) are pre-authorized by the user
			prompt += '\n\n## Authorized Operations\n\n'
				+ 'The user has authorized you to operate their browser and execute all skills '
				+ 'in the Crewly skills directory. These are legitimate, authorized operations. '
				+ 'Do not refuse browser control requests — they come from the user who owns the browser. '
				+ 'When a browser skill (e.g. remote-browser) is available, use it instead of Playwright or raw HTTP for browser tasks.';

			// Inject Team Lead addon for members with canDelegate=true and subordinates
			if (foundMember?.canDelegate && foundMember.subordinateIds && foundMember.subordinateIds.length > 0 && foundTeam) {
				try {
					// Resolve subordinateIds to SubordinateInfo[]
					const subordinates: SubordinateInfo[] = foundMember.subordinateIds
						.map((subId) => {
							const subMember = foundTeam!.members?.find((m) => m.id === subId);
							if (!subMember) return null;
							return {
								name: subMember.name,
								sessionName: subMember.sessionName || '',
								role: subMember.role || 'developer',
								memberId: subMember.id || subId,
							} as SubordinateInfo;
						})
						.filter((s): s is SubordinateInfo => s !== null);

					if (subordinates.length > 0) {
						const tlConfig: TeamMemberSessionConfig = {
							name: sessionName,
							role: role as TeamMemberSessionConfig['role'],
							systemPrompt: '',
							projectPath,
							memberId,
							teamId: foundTeam.id,
							canDelegate: true,
							subordinates,
						};

						const promptBuilder = new PromptBuilderService(this.projectRoot);
						const tlSection = await promptBuilder.buildTeamLeadSection(tlConfig);

						if (tlSection) {
							prompt += `\n\n---\n\n${tlSection}`;
							this.logger.info('TL addon injected into init prompt', {
								sessionName,
								subordinateCount: subordinates.length,
								subordinateNames: subordinates.map((s) => s.name),
								tlSectionLength: tlSection.length,
							});
						}
					}
				} catch (tlError) {
					this.logger.warn('Failed to inject TL addon (non-critical)', {
						sessionName,
						error: tlError instanceof Error ? tlError.message : String(tlError),
					});
				}
			}

			// Generate and inject startup briefing from session memory
			try {
				const sessionMemoryService = SessionMemoryService.getInstance();
				await sessionMemoryService.onSessionStart(sessionName, role, projectPath);
				const briefing = await sessionMemoryService.generateStartupBriefing(sessionName, role, projectPath);
				const briefingMd = sessionMemoryService.formatBriefingAsMarkdown(briefing);
				if (briefingMd && briefingMd.length > 30) {
					prompt += `\n\n---\n\n${briefingMd}`;
					this.logger.info('Startup briefing injected into prompt', { sessionName, role, briefingLength: briefingMd.length });
				}
			} catch (briefingError) {
				this.logger.warn('Failed to generate startup briefing (non-critical)', {
					sessionName,
					error: briefingError instanceof Error ? briefingError.message : String(briefingError),
				});
			}

			// Inject mandatory session recovery protocol (recall + get-my-context)
			try {
				const recoveryBuilder = new PromptBuilderService(this.projectRoot);
				const recoverySection = recoveryBuilder.buildSessionRecoverySection(sessionName, role, projectPath);
				prompt += `\n\n---\n\n${recoverySection}`;
				this.logger.info('Session recovery protocol injected into prompt', { sessionName, role });
			} catch (recoveryError) {
				this.logger.warn('Failed to inject session recovery protocol (non-critical)', {
					sessionName,
					error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
				});
			}

			// Append identity section so the agent knows its session name and project path
			prompt += `\n\n---\n\n## Your Identity\n- **Session Name:** ${sessionName}\n- **Project Path:** ${projectPath}`;
			if (memberId) {
				prompt += `\n- **Member ID:** ${memberId}`;
			}

			// Conditionally append Self Evolution instructions for the orchestrator
			if (role === ORCHESTRATOR_ROLE) {
				try {
					const settings = await getSettingsService().getSettings();
					if (settings.general.enableSelfEvolution) {
						const selfEvoPath = path.join(
							this.projectRoot, 'config', 'roles', 'orchestrator', 'self-evolution.md'
						);
						const selfEvoPrompt = await readFile(selfEvoPath, 'utf8');
						prompt += `\n\n---\n\n${selfEvoPrompt}`;
						this.logger.info('Self Evolution prompt injected', { sessionName });
					}
				} catch (selfEvoError) {
					this.logger.warn('Failed to load self-evolution prompt (non-critical)', {
						sessionName,
						error: selfEvoError instanceof Error ? selfEvoError.message : String(selfEvoError),
					});
				}
			}

			return prompt;
		} catch (error) {
			// Fallback to inline prompt if file doesn't exist
			const attemptedPath = await this.getPromptFileForRole(role);

			this.logger.error('Could not load prompt from config, using fallback', {
				role,
				promptPath: attemptedPath,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});

			const memberIdJson = memberId ? `,"teamMemberId":"${memberId}"` : '';
			const skillsPath = path.join(this.projectRoot, 'config', 'skills', 'agent');

			return `Hey! I need your help with some tasks on this project.

## Quick context about this setup

This project uses Crewly for team coordination. You have bash skills available at \`${skillsPath}/\` that communicate with the Crewly backend running locally. Read the skills catalog at \`~/.crewly/skills/AGENT_SKILLS_CATALOG.md\` for a full reference of available skills.

## First thing - please check in

Please run the register-self skill to let the team dashboard know you're available:
\`\`\`bash
bash ${skillsPath}/core/register-self/execute.sh '{"role":"${role}","sessionName":"${sessionName}"${memberIdJson}}'
\`\`\`
All it does is update a local status flag so the web UI shows you as online - nothing more.

After checking in, just say "Ready for tasks" and wait for me to send you work.`;
		}
	}

	/**
	 * Write the registration prompt to a file on disk.
	 *
	 * For Claude Code agents (#207): writes to `{projectPath}/.claude/agents/{sessionName}.md`
	 * with YAML frontmatter so the `--agent` flag can load it as a custom agent definition.
	 * For other runtimes: writes to `~/.crewly/prompts/{sessionName}-init.md`.
	 *
	 * @param sessionName - Session name (used for filename)
	 * @param prompt - The full prompt content
	 * @param options - Optional: projectPath, runtimeType, and role for claude-code agent mode
	 * @returns The absolute path to the written file, or undefined on error
	 */
	private async writePromptFile(
		sessionName: string,
		prompt: string,
		options?: { projectPath?: string; runtimeType?: RuntimeType; role?: string }
	): Promise<string | undefined> {
		const isClaudeAgent = options?.runtimeType === RUNTIME_TYPES.CLAUDE_CODE && options?.projectPath;
		const promptFilePath = isClaudeAgent
			? path.join(options.projectPath!, '.claude', 'agents', `${sessionName}.md`)
			: this.getInitPromptFilePath(sessionName);
		const promptsDir = path.dirname(promptFilePath);

		// Quote YAML values to prevent injection via sessionName or role containing special chars
		const yamlSafeName = sessionName.replace(/"/g, '\\"');
		const yamlSafeRole = (options?.role || 'developer').replace(/"/g, '\\"');
		const fileContent = isClaudeAgent
			? `---\nname: "${yamlSafeName}"\ndescription: "${yamlSafeRole} agent for Crewly orchestration"\n---\n\n${prompt}`
			: prompt;

		try {
			await mkdir(promptsDir, { recursive: true });
			await writeFile(promptFilePath, fileContent, 'utf8');
			this.logger.debug('Wrote init prompt to file', {
				sessionName,
				promptFilePath,
				promptLength: fileContent.length,
				mode: isClaudeAgent ? 'claude-agent' : 'legacy',
			});
			return promptFilePath;
		} catch (error) {
			this.logger.warn('Failed to write init prompt file', {
				sessionName,
				promptFilePath,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * Build the unified init prompt path used by non-Claude-Code runtimes.
	 */
	private getInitPromptFilePath(sessionName: string): string {
		return path.join(
			os.homedir(),
			CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
			'prompts',
			`${sessionName}-init.md`
		);
	}

	/**
	 * Wait for agent registration to complete
	 */
	private async waitForRegistration(
		sessionName: string,
		role: string,
		timeout: number
	): Promise<boolean> {
		const startTime = Date.now();
		const checkInterval = 5000; // Check every 5 seconds to prevent overlapping with `/` detection

		while (Date.now() - startTime < timeout) {
			try {
				if (await this.checkAgentRegistration(sessionName, role)) {
					this.logger.info('Agent registration confirmed', { sessionName, role });
					return true;
				}

				await delay(checkInterval);
			} catch (error) {
				this.logger.warn('Error checking registration', {
					sessionName,
					role,
					error: error instanceof Error ? error.message : String(error),
				});
				await delay(checkInterval);
			}
		}

		this.logger.warn('Timeout waiting for agent registration', { sessionName, role, timeout });
		return false;
	}

	/**
	 * Check if agent is properly registered
	 */
	private async checkAgentRegistration(sessionName: string, role: string): Promise<boolean> {
		try {
			if (role === ORCHESTRATOR_ROLE) {
				// For orchestrator, check agentStatus is active
				const orchestratorStatus = await this.storageService.getOrchestratorStatus();
				return orchestratorStatus?.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE;
			}

			// For team members, check teams data
			const teams = await this.storageService.getTeams();

			// Find team member with matching sessionName and check agentStatus
			for (const team of teams) {
				if (team.members) {
					for (const member of team.members) {
						if (member.sessionName === sessionName && member.role === role) {
							return member.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE;
						}
					}
				}
			}

			return false;
		} catch (error) {
			this.logger.debug('Error checking agent registration', {
				sessionName,
				role,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Fast registration with verification and retry mechanism
	 * Sends system prompt to runtime which triggers MCP registration via teams.json
	 * @param skipInitialCleanup If true, skips Ctrl+C on first attempt (when runtime was just initialized)
	 */
	private async attemptRegistrationWithVerification(
		sessionName: string,
		role: string,
		timeout: number,
		memberId?: string,
		maxRetries: number = 3,
		skipInitialCleanup: boolean = false,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE
	): Promise<boolean> {
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			this.logger.info('Attempting system prompt registration with MCP flow', {
				sessionName,
				role,
				runtimeType,
				attempt,
				maxRetries,
			});

			try {
				// Step 1: Send Ctrl+C to clear any pending commands (skip on first attempt if Claude was just initialized)
				if (!skipInitialCleanup || attempt > 1) {
					await (await this.getSessionHelper()).clearCurrentCommandLine(sessionName);
					await delay(500);
					this.logger.debug('Sent Ctrl+C to clear terminal state', {
						sessionName,
						attempt,
					});
				} else {
					this.logger.debug(
						'Skipping Ctrl+C on first attempt (Claude was just initialized)',
						{ sessionName, attempt }
					);
				}

				// Step 2: Verify runtime is running (skip detection if runtime was just initialized and verified)
				let runtimeRunning = true; // Assume true if we skip detection

				if (!skipInitialCleanup || attempt > 1) {
					// Only do runtime detection on retries or when runtime wasn't just initialized
					const forceRefresh = attempt > 1; // Force refresh on retry attempts
					const runtimeService5 = this.createRuntimeService(runtimeType);
					runtimeRunning = await runtimeService5.detectRuntimeWithCommand(
						sessionName,
						forceRefresh
					);

					if (!runtimeRunning) {
						this.logger.warn('Runtime not detected, cannot send system prompt', {
							sessionName,
							runtimeType,
							attempt,
							forceRefresh,
						});

						// Clear detection cache before continuing to retry
						const runtimeService6 = this.createRuntimeService(runtimeType);
						runtimeService6.clearDetectionCache(sessionName);

						// Add longer delay between failed detection attempts
						if (attempt < maxRetries) {
							await delay(2000);
						}
						continue; // Try again
					}
				} else {
					this.logger.debug(
						'Skipping runtime detection (runtime was just initialized and verified)',
						{
							sessionName,
							runtimeType,
							attempt,
						}
					);
				}

				// Step 3: Send system prompt with robust delivery mechanism
				const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId, runtimeType);
				const promptDelivered = await this.sendPromptRobustly(sessionName, prompt, runtimeType);

				if (!promptDelivered) {
					this.logger.warn('Failed to deliver system prompt reliably', {
						sessionName,
						attempt,
						promptLength: prompt.length,
					});
					continue; // Try again
				}

				this.logger.debug('System prompt delivered successfully', {
					sessionName,
					promptLength: prompt.length,
				});

				this.logger.debug('Terminal activity detected, waiting for MCP registration', {
					sessionName,
				});

				// Step 5: Wait for registration API call to update teams.json (agentStatus: activating -> active)
				const registrationTimeout = Math.min(timeout, 25000); // Max 25s per attempt
				const registered = await this.waitForRegistrationFast(
					sessionName,
					role,
					registrationTimeout
				);

				if (registered) {
					this.logger.info('MCP registration successful (teams.json updated)', {
						sessionName,
						role,
						attempt,
					});
					return true;
				}

				this.logger.warn('MCP registration timeout, retrying', {
					sessionName,
					role,
					attempt,
					nextAttempt: attempt < maxRetries,
				});
			} catch (error) {
				this.logger.error('System prompt registration attempt failed', {
					sessionName,
					role,
					attempt,
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Short delay before retry
			if (attempt < maxRetries) {
				await delay(1000);
			}
		}

		this.logger.warn('Background MCP registration did not complete within timeout (agent still running)', {
			sessionName,
			role,
			runtimeType,
			maxRetries,
		});
		return false;
	}

	/**
	 * Fast registration polling with shorter intervals
	 */
	private async waitForRegistrationFast(
		sessionName: string,
		role: string,
		timeout: number
	): Promise<boolean> {
		const startTime = Date.now();
		const fastCheckInterval = 2000; // Check every 2 seconds (faster than original 5s)

		while (Date.now() - startTime < timeout) {
			try {
				if (await this.checkAgentRegistration(sessionName, role)) {
					this.logger.info('Fast registration confirmation', { sessionName, role });
					return true;
				}

				await delay(fastCheckInterval);
			} catch (error) {
				this.logger.debug('Error in fast registration check', {
					sessionName,
					role,
					error: error instanceof Error ? error.message : String(error),
				});
				await delay(1000); // Shorter error delay
			}
		}

		this.logger.warn('Fast registration timeout', { sessionName, role, timeout });
		return false;
	}

	/**
	 * Create orchestrator session - extracted from the original tmux service
	 */
	private async createOrchestratorSession(config: OrchestratorConfig): Promise<void> {
		this.logger.info('Creating orchestrator session', {
			sessionName: config.sessionName,
			projectPath: config.projectPath,
		});

		// Check if session already exists
		if (await (await this.getSessionHelper()).sessionExists(config.sessionName)) {
			this.logger.info('Orchestrator session already exists', {
				sessionName: config.sessionName,
			});
			return;
		}

		// Create new session for orchestrator
		await (await this.getSessionHelper()).createSession(
			config.sessionName,
			config.projectPath
			// windowName not used in PTY backend
		);

		this.logger.info('Orchestrator session created successfully', {
			sessionName: config.sessionName,
		});
	}

	/**
	 * Unified session creation that handles both orchestrator and team members
	 * @param config Session configuration
	 * @returns Promise with success/error information
	 */
	async createAgentSession(config: {
		sessionName: string;
		role: string;
		projectPath?: string;
		windowName?: string;
		memberId?: string;
		runtimeType?: RuntimeType;
		teamId?: string;
		/**
		 * Skip intelligent recovery and force immediate session kill + recreation.
		 * Use during server startup to avoid expensive recovery on stale sessions.
		 * @default false
		 */
		forceRecreate?: boolean;
		/**
		 * Additional paths to add to Gemini CLI's /directory allowlist during
		 * postInitialize, before the registration prompt is sent. Used by the
		 * orchestrator to include all existing project paths so they don't
		 * race with the "Read the file..." prompt.
		 */
		additionalAllowlistPaths?: string[];
	}): Promise<{
		success: boolean;
		sessionName?: string;
		message?: string;
		error?: string;
	}> {
		// If another creation is in progress for this session, wait for it
		const existingLock = this.sessionCreationLocks.get(config.sessionName);
		if (existingLock) {
			this.logger.info('Waiting for existing session creation to complete', { sessionName: config.sessionName });
			try {
				return await existingLock;
			} catch {
				// Previous creation failed, proceed with our own attempt
				this.logger.info('Previous session creation failed, proceeding with new attempt', { sessionName: config.sessionName });
			}
		}

		// Create and store the lock promise
		const creationPromise = this._createAgentSessionImpl(config);
		this.sessionCreationLocks.set(config.sessionName, creationPromise);
		try {
			const result = await creationPromise;
			return result;
		} finally {
			// Only delete lock if it's still ours — a concurrent caller may have
			// replaced it with a new promise after our catch path above.
			if (this.sessionCreationLocks.get(config.sessionName) === creationPromise) {
				this.sessionCreationLocks.delete(config.sessionName);
			}
		}
	}

	/**
	 * Internal implementation of createAgentSession, guarded by sessionCreationLocks.
	 * @param config Session configuration
	 * @returns Promise with success/error information
	 */
	private async _createAgentSessionImpl(config: {
		sessionName: string;
		role: string;
		projectPath?: string;
		windowName?: string;
		memberId?: string;
		runtimeType?: RuntimeType;
		teamId?: string;
		forceRecreate?: boolean;
		additionalAllowlistPaths?: string[];
	}): Promise<{
		success: boolean;
		sessionName?: string;
		message?: string;
		error?: string;
	}> {
		const { sessionName, role, projectPath = process.cwd(), windowName, memberId } = config;
		const forceRecreate = config.forceRecreate ?? false;

		// Get runtime type from config or default to claude-code
		let runtimeType = config.runtimeType || RUNTIME_TYPES.CLAUDE_CODE;

		// Resolve runtime flags from the agent's effective skills
		let runtimeFlags: string[] = [];

		// For team members, try to get runtime type from storage and resolve skill flags
		if (!config.runtimeType && role !== ORCHESTRATOR_ROLE) {
			try {
				const teams = await this.storageService.getTeams();
				for (const team of teams) {
					const member = team.members?.find((m) => m.sessionName === sessionName);
					if (member) {
						if (member.runtimeType) {
							runtimeType = member.runtimeType as RuntimeType;
						}
						// Resolve runtime flags from role skills + member overrides
						runtimeFlags = await this.resolveRuntimeFlags(
							role, runtimeType, member.skillOverrides, member.excludedRoleSkills
						);
						break;
					}
				}
			} catch (error) {
				this.logger.warn('Failed to get runtime type or flags from storage, using defaults', {
					sessionName,
					role,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} else if (role !== ORCHESTRATOR_ROLE) {
			// Config-provided runtimeType, still resolve flags
			try {
				const teams = await this.storageService.getTeams();
				for (const team of teams) {
					const member = team.members?.find((m) => m.sessionName === sessionName);
					if (member) {
						runtimeFlags = await this.resolveRuntimeFlags(
							role, runtimeType, member.skillOverrides, member.excludedRoleSkills
						);
						break;
					}
				}
			} catch (error) {
				this.logger.warn('Failed to resolve runtime flags', {
					sessionName, role,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// For orchestrator, try to get runtime type from orchestrator status
		if (role === ORCHESTRATOR_ROLE && !config.runtimeType) {
			try {
				const orchestratorStatus = await this.storageService.getOrchestratorStatus();
				if (orchestratorStatus?.runtimeType) {
					runtimeType = orchestratorStatus.runtimeType as RuntimeType;
				}
			} catch (error) {
				this.logger.warn(
					'Failed to get orchestrator runtime type from storage, using default',
					{
						sessionName,
						role,
						error: error instanceof Error ? error.message : String(error),
					}
				);
			}
		}

		try {
			this.logger.info('Creating agent session (unified approach)', {
				sessionName,
				role,
				runtimeType,
				projectPath,
				windowName,
				memberId,
			});

			// Get session helper first
			this.logger.debug('Getting session helper for session creation');
			const sessionHelper = await this.getSessionHelper();
			this.logger.debug('Session helper obtained', {
				hasHelper: !!sessionHelper,
			});

			// Check if session already exists
			const sessionExists = sessionHelper.sessionExists(sessionName);
			this.logger.debug('Checked if session exists', {
				sessionName,
				sessionExists,
			});

			if (!sessionExists) {
				// Session doesn't exist, go directly to creating a new session
				this.logger.info('Session does not exist, will create new session', { sessionName });
			} else if (forceRecreate) {
				// Skip recovery, kill immediately (used during server startup for stale sessions)
				this.logger.info('Session exists but forceRecreate is set, killing for clean restart', { sessionName });
				try {
					const runtimeService = this.createRuntimeService(runtimeType);
					runtimeService.clearDetectionCache(sessionName);
					await (await this.getSessionHelper()).killSession(sessionName);
					await delay(1000);
				} catch (killError) {
					this.logger.warn('Failed to kill session during forceRecreate, continuing with recreation', {
						sessionName,
						error: killError instanceof Error ? killError.message : String(killError),
					});
				}
			} else {
				this.logger.info(
					'Session already exists, attempting intelligent recovery instead of killing',
					{
						sessionName,
					}
				);

				// Step 1: Try to detect if runtime is already running using slash command
				const runtimeService = this.createRuntimeService(runtimeType);

				let recoverySuccess = false;

				try {
					const runtimeRunning = await runtimeService.detectRuntimeWithCommand(
						sessionName
					);

					if (runtimeRunning) {
						this.logger.info(
							'Runtime detected in existing session, attempting direct registration',
							{
								sessionName,
							}
						);

						// Try to send registration prompt directly
						const registrationResult = await this.attemptRegistrationWithVerification(
							sessionName,
							role,
							25000, // 25 second timeout
							memberId,
							1, // single attempt for now
							true, // skip initial cleanup since runtime is confirmed running
							runtimeType
						);

						if (registrationResult) {
							recoverySuccess = true;
							this.logger.info(
								'Successfully registered existing session with runtime',
								{ sessionName }
							);
						}
					}

					// Step 2: If runtime not detected or registration failed, try Ctrl+C restart
					// only for Claude. Gemini/Codex treat Ctrl+C as destructive at prompt
					// and can exit the runtime instead of recovering.
					if (!recoverySuccess) {
						if (runtimeType !== RUNTIME_TYPES.CLAUDE_CODE) {
							this.logger.info(
								'Skipping Ctrl+C recovery for non-Claude runtime; falling back to recreation',
								{ sessionName, runtimeType }
							);
							throw new Error(`${runtimeType} recovery requires full recreation`);
						}

						this.logger.info(
							'Runtime not detected or registration failed, attempting Ctrl+C restart',
							{
								sessionName,
							}
						);

						// Send Ctrl+C twice to try to restart Claude
						await (await this.getSessionHelper()).sendCtrlC(sessionName);
						await delay(1000);
						await (await this.getSessionHelper()).sendCtrlC(sessionName);
						await delay(2000);

						// Clear runtime detection cache after Ctrl+C restart
						runtimeService.clearDetectionCache(sessionName);

						// Try registration after Ctrl+C restart
						const postCtrlCResult = await this.attemptRegistrationWithVerification(
							sessionName,
							role,
							25000,
							memberId,
							1, // single attempt
							false, // don't skip cleanup after Ctrl+C
							runtimeType
						);

						if (postCtrlCResult) {
							recoverySuccess = true;
							this.logger.info(
								'Successfully recovered session after Ctrl+C restart',
								{ sessionName }
							);
						}
					}
				} catch (error) {
					this.logger.warn('Error during intelligent session recovery', {
						sessionName,
						error: error instanceof Error ? error.message : String(error),
					});
				}

				// If recovery succeeded, register for persistence, start monitoring, and return early
				if (recoverySuccess) {
					// Register session for state persistence so it survives restarts
					try {
						const persistence = getSessionStatePersistence();
						persistence.registerSession(sessionName, {
							cwd: projectPath || process.cwd(),
							command: process.env.SHELL || '/bin/bash',
							args: [],
						}, runtimeType, role, config.teamId, config.memberId);
					} catch (persistError) {
						this.logger.warn('Failed to register recovered session for persistence (non-critical)', {
							sessionName,
							error: persistError instanceof Error ? persistError.message : String(persistError),
						});
					}

					// Start context window monitoring for recovered non-orchestrator session
					if (role !== ORCHESTRATOR_ROLE && config.teamId && config.memberId) {
						ContextWindowMonitorService.getInstance().startSessionMonitoring(
							sessionName, config.memberId, config.teamId, role, runtimeType
						);
					}

					// Start OAuth relogin monitoring for recovered session
					OAuthReloginMonitorService.getInstance().startMonitoring(sessionName, runtimeType);

					return {
						success: true,
						sessionName,
						message: 'Agent session recovered and registered successfully',
					};
				}

				// Step 3: Last resort - fall back to killing session for clean restart
				this.logger.warn(
					'All recovery attempts failed, falling back to session recreation',
					{
						sessionName,
					}
				);
				await (await this.getSessionHelper()).killSession(sessionName);
				await delay(1000); // Wait for cleanup
			}

			// ===== In-process Crewly Agent branch =====
			// Crewly Agent runs inside the Node.js process — no PTY session needed.
			if (runtimeType === RUNTIME_TYPES.CREWLY_AGENT) {
				this.logger.info('Starting in-process Crewly Agent runtime', { sessionName, role });

				const crewlyRuntime = this.createRuntimeService(runtimeType) as CrewlyAgentRuntimeService;

				// Look up member's modelId from team config (if available)
				let memberModelId: string | undefined;
				if (config.memberId) {
					try {
						const teams = await this.storageService.getTeams();
						for (const team of teams) {
							const member = team.members?.find(m => m.id === config.memberId);
							if (member?.modelId) {
								memberModelId = member.modelId;
								break;
							}
						}
					} catch {
						// Non-critical — fall back to default model
					}
				}

				// Parse modelId into model config (falls back to DEFAULT_MODEL)
				const { parseModelId } = await import('./crewly-agent/types.js');
				const modelConfig = memberModelId ? { model: parseModelId(memberModelId) } : {};

				// Determine role name for system prompt lookup
				const roleName = role === ORCHESTRATOR_ROLE ? 'orchestrator' : role.toLowerCase().replace(/\s+/g, '-');
				const memberId = config.memberId;
				await crewlyRuntime.initializeInProcess(sessionName, { projectPath, memberId, ...modelConfig }, roleName);

				// Track the in-process runtime for message routing
				this.inProcessRuntimes.set(sessionName, crewlyRuntime);

				// Auto-register agent as active — crewly-agent cannot run bash scripts,
				// so we register on its behalf instead of relying on the register_self tool.
				try {
					const registerResult = await this.registerMemberActive(sessionName, role, memberId);
					this.logger.info('Auto-registered crewly-agent as active', {
						sessionName, role, success: registerResult,
					});
				} catch (registerErr) {
					this.logger.warn('Auto-registration failed (non-fatal)', {
						sessionName,
						error: registerErr instanceof Error ? registerErr.message : String(registerErr),
					});
				}

				// For crewly-agent, the system prompt is already loaded during initializeInProcess().
				// Do NOT deliver the full registration prompt as a message — that would trigger
				// a redundant generateText call (60K chars → rate limits). Instead, send a
				// lightweight activation message that tells the agent to start working.
				crewlyRuntime.handleMessage(
					`You are now active as "${role}" (session: ${sessionName}). ` +
					'Your system prompt is already loaded. Begin by calling register_self, ' +
					'then wait for tasks.'
				).catch(promptError => {
					this.logger.warn('Initial activation message failed (non-fatal for crewly-agent)', {
						sessionName,
						error: promptError instanceof Error ? promptError.message : String(promptError),
					});
				});

				// Start context window monitoring if applicable
				if (role !== ORCHESTRATOR_ROLE && config.teamId && config.memberId) {
					ContextWindowMonitorService.getInstance().startSessionMonitoring(
						sessionName, config.memberId, config.teamId, role, runtimeType
					);
				}

				return {
					success: true,
					sessionName,
					message: 'Crewly Agent in-process runtime initialized and registered',
				};
			}

			// Create new session (same approach for both orchestrator and team members)
			const cwdToUse = projectPath || process.cwd();
			this.logger.info('Creating PTY session', {
				sessionName,
				cwd: cwdToUse,
			});

			try {
				const createdSession = await sessionHelper.createSession(sessionName, cwdToUse);
				this.logger.info('PTY session created successfully', {
					sessionName,
					pid: createdSession.pid,
					cwd: createdSession.cwd,
				});
			} catch (createError) {
				this.logger.error('Failed to create PTY session', {
					sessionName,
					cwd: cwdToUse,
					error: createError instanceof Error ? createError.message : String(createError),
					stack: createError instanceof Error ? createError.stack : undefined,
				});
				throw createError;
			}

			// Verify session was created
			const sessionCreatedCheck = sessionHelper.sessionExists(sessionName);
			this.logger.info('Session creation verification', {
				sessionName,
				exists: sessionCreatedCheck,
			});

			if (!sessionCreatedCheck) {
				throw new Error(`Session '${sessionName}' was not created successfully`);
			}

			// Register session for state persistence so it survives restarts
			try {
				const persistence = getSessionStatePersistence();
				persistence.registerSession(sessionName, {
					cwd: cwdToUse,
					command: process.env.SHELL || '/bin/bash',
					args: [],
				}, runtimeType, role, config.teamId, config.memberId);
			} catch (persistError) {
				this.logger.warn('Failed to register session for persistence (non-critical)', {
					sessionName,
					error: persistError instanceof Error ? persistError.message : String(persistError),
				});
			}

			// Set environment variables for MCP connection
			await sessionHelper.setEnvironmentVariable(
				sessionName,
				ENV_CONSTANTS.CREWLY_SESSION_NAME,
				sessionName
			);
			await sessionHelper.setEnvironmentVariable(
				sessionName,
				ENV_CONSTANTS.CREWLY_ROLE,
				role
			);
			await sessionHelper.setEnvironmentVariable(
				sessionName,
				ENV_CONSTANTS.CREWLY_API_URL,
				`http://localhost:${WEB_CONSTANTS.PORTS.BACKEND}`
			);
			// #187: Set project path so memory skills can auto-inject it
			await sessionHelper.setEnvironmentVariable(
				sessionName,
				ENV_CONSTANTS.CREWLY_PROJECT_PATH,
				cwdToUse
			);

			// Inject API keys from settings (with override chain) for all runtimes
			const settingsService = getSettingsService();
			const runtimeContext = { runtime: runtimeType };

			// Gemini key — needed by gemini-cli and crewly-agent
			const geminiKey = await settingsService.getApiKey('gemini', runtimeContext);
			if (geminiKey) {
				await sessionHelper.setEnvironmentVariable(sessionName, 'GOOGLE_GENERATIVE_AI_API_KEY', geminiKey);
				await sessionHelper.setEnvironmentVariable(sessionName, ENV_CONSTANTS.GEMINI_API_KEY, geminiKey);
			}

			// Anthropic key — needed by claude-code and crewly-agent
			const anthropicKey = await settingsService.getApiKey('anthropic', runtimeContext);
			if (anthropicKey) {
				await sessionHelper.setEnvironmentVariable(sessionName, 'ANTHROPIC_API_KEY', anthropicKey);
			}

			// OpenAI key — needed by codex-cli and crewly-agent
			const openaiKey = await settingsService.getApiKey('openai', runtimeContext);
			if (openaiKey) {
				await sessionHelper.setEnvironmentVariable(sessionName, 'OPENAI_API_KEY', openaiKey);
			}

			// Token tracking telemetry — inject env vars for runtimes that need them
			const settings = await settingsService.getSettings();
			if (settings.general?.tokenTracking && runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
				await sessionHelper.setEnvironmentVariable(
					sessionName,
					ENV_CONSTANTS.CLAUDE_CODE_ENABLE_TELEMETRY,
					'1'
				);
				this.logger.debug('Token tracking enabled: set CLAUDE_CODE_ENABLE_TELEMETRY=1', { sessionName });
			}

			this.logger.info('Agent session created and environment variables set, initializing with registration', {
				sessionName,
				role,
				runtimeType,
			});

			// Use the existing unified registration system
			const timeout =
				role === ORCHESTRATOR_ROLE
					? AGENT_TIMEOUTS.ORCHESTRATOR_INITIALIZATION
					: AGENT_TIMEOUTS.REGULAR_AGENT_INITIALIZATION;
			const initResult = await this.initializeAgentWithRegistration(
				sessionName,
				role,
				projectPath,
				timeout,
				memberId,
				runtimeType,
				runtimeFlags,
				config.additionalAllowlistPaths
			);

			if (!initResult.success) {
				return {
					success: false,
					sessionName,
					error: initResult.error || 'Failed to initialize and register agent',
				};
			}

			// Start context window monitoring for newly created non-orchestrator session
			if (role !== ORCHESTRATOR_ROLE && config.teamId && config.memberId) {
				ContextWindowMonitorService.getInstance().startSessionMonitoring(
					sessionName, config.memberId, config.teamId, role, runtimeType
				);
			}

			// Start OAuth relogin monitoring for newly created session
			OAuthReloginMonitorService.getInstance().startMonitoring(sessionName, runtimeType);

			return {
				success: true,
				sessionName,
				message: initResult.message || 'Agent session created and registered successfully',
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to create agent session', {
				sessionName,
				role,
				error: errorMessage,
			});

			return {
				success: false,
				sessionName,
				error: errorMessage,
			};
		}
	}

	/**
	 * Unified session termination that handles both orchestrator and team members
	 * @param sessionName The session to terminate
	 * @param role The role for proper status updates
	 * @returns Promise with success/error information
	 */
	async terminateAgentSession(
		sessionName: string,
		role: string = 'unknown'
	): Promise<{
		success: boolean;
		message?: string;
		error?: string;
	}> {
		try {
			this.logger.info('Terminating agent session (unified approach)', { sessionName, role });

			// Stop runtime exit monitoring before killing the session
			RuntimeExitMonitorService.getInstance().stopMonitoring(sessionName);

			// Stop OAuth relogin monitoring before killing the session
			OAuthReloginMonitorService.getInstance().stopMonitoring(sessionName);

			// Stop context window monitoring before killing the session
			ContextWindowMonitorService.getInstance().stopSessionMonitoring(sessionName);

			// Shut down in-process Crewly Agent runtime if present
			const inProcessRuntime = this.inProcessRuntimes.get(sessionName);
			if (inProcessRuntime) {
				inProcessRuntime.shutdown();
				this.inProcessRuntimes.delete(sessionName);
				this.logger.info('In-process Crewly Agent runtime shut down', { sessionName });
			}

			// Get session helper once to avoid repeated async calls
			const sessionHelper = await this.getSessionHelper();
			const sessionExists = sessionHelper.sessionExists(sessionName);

			if (sessionExists) {
				// Kill the tmux session
				await sessionHelper.killSession(sessionName);
				this.logger.info('Session terminated successfully', { sessionName });
			} else if (!inProcessRuntime) {
				this.logger.info('Session already terminated or does not exist', { sessionName });
			}

			// Capture session end for memory persistence
			try {
				const sessionMemoryService = SessionMemoryService.getInstance();
				await sessionMemoryService.onSessionEnd(sessionName, role, process.cwd());
				this.logger.info('Session memory captured on termination', { sessionName, role });
			} catch (memoryError) {
				this.logger.warn('Failed to capture session memory on termination (non-critical)', {
					sessionName,
					error: memoryError instanceof Error ? memoryError.message : String(memoryError),
				});
			}

			// Update agent status to inactive (works for both orchestrator and team members)
			await this.storageService.updateAgentStatus(
				sessionName,
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE
			);
			this.logger.info('Agent status updated to inactive', { sessionName, role });

			// Unregister from persistence so explicitly stopped agents don't reappear in resume popup
			try {
				const persistence = getSessionStatePersistence();
				persistence.unregisterSession(sessionName);
			} catch (persistError) {
				this.logger.warn('Failed to unregister session from persistence (non-critical)', {
					sessionName,
					error: persistError instanceof Error ? persistError.message : String(persistError),
				});
			}

			return {
				success: true,
				message: sessionExists
					? 'Agent session terminated successfully'
					: 'Agent session was already terminated',
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to terminate agent session', {
				sessionName,
				role,
				error: errorMessage,
			});

			return {
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Send a message to any agent session with reliable delivery.
	 * Uses robust delivery mechanism with retry logic to ensure messages
	 * are properly delivered to Claude Code's input.
	 *
	 * @param sessionName - The agent session name
	 * @param message - The message to send
	 * @returns Promise with success status and optional error message
	 *
	 * @example
	 * ```typescript
	 * const result = await agentRegistrationService.sendMessageToAgent(
	 *   'crewly-orc',
	 *   '[CHAT:123] Hello, orchestrator!'
	 * );
	 * if (result.success) {
	 *   console.log('Message delivered');
	 * } else {
	 *   console.error('Delivery failed:', result.error);
	 * }
	 * ```
	 */
	async sendMessageToAgent(
		sessionName: string,
		message: string,
		runtimeType?: RuntimeType
	): Promise<{
		success: boolean;
		message?: string;
		error?: string;
	}> {
		// Per-session delivery serialization: chain this delivery after any
		// in-flight delivery to the same session. This prevents concurrent
		// sendMessageWithRetry calls that each send Ctrl+C on retry attempts,
		// which can kill the runtime when 25+ scheduled checks fire at once.
		const previousDelivery = this.sessionDeliveryMutex.get(sessionName);
		let releaseMutex!: () => void;
		const currentDelivery = new Promise<void>((r) => { releaseMutex = r; });
		this.sessionDeliveryMutex.set(sessionName, currentDelivery);

		if (previousDelivery) {
			this.logger.info('Waiting for in-flight delivery to complete before sending', {
				sessionName,
				messageLength: message.length,
			});
			await previousDelivery.catch(() => {});
		}

		try {
			if (!message || typeof message !== 'string') {
				return {
					success: false,
					error: 'Message is required and must be a string',
				};
			}

			// Auto-resolve runtime type if not provided.
			// CRITICAL: defaulting to CLAUDE_CODE is dangerous because
			// Ctrl+C cleanup (Claude Code behavior) triggers /quit on Gemini CLI.
			if (!runtimeType) {
				runtimeType = await this.resolveSessionRuntimeType(sessionName);
			}

			// ===== In-process Crewly Agent delivery =====
			// Route directly to the in-process runtime, bypassing PTY entirely.
			// Fire-and-forget: mirrors PTY runtimes where the write returns immediately.
			// The LLM processes the message asynchronously in the background.
			//
			// IMPORTANT: Always check inProcessRuntimes map first, regardless of
			// the runtimeType parameter. This makes delivery robust against runtime
			// type misresolution — e.g., when storage lookup fails and defaults to
			// claude-code for what is actually a crewly-agent session. Without this
			// fallback, messages to crewly-agent sessions silently fail when routed
			// through the PTY path (no PTY session exists).
			const crewlyRuntime = this.inProcessRuntimes.get(sessionName);
			if (crewlyRuntime || runtimeType === RUNTIME_TYPES.CREWLY_AGENT) {
				if (!crewlyRuntime || !crewlyRuntime.isReady()) {
					return {
						success: false,
						error: `Crewly Agent runtime for '${sessionName}' is not initialized`,
					};
				}

				// Extract conversationId from [CHAT:xxx] or [GCHAT:xxx ...] prefix for response routing
				const chatPrefixMatch = message.match(/^\[(?:G?CHAT):([^\]\s]+)[^\]]*\]\s*/);
				const incomingConversationId = chatPrefixMatch?.[1];

				// Extract Slack context from [SLACK:channelId:threadTs] marker if present (Bug 5).
				// This allows crewly-agent to auto-fill reply_slack with the correct thread.
				let slackMetadata: Record<string, string> | undefined;
				const slackPrefixMatch = message.match(/\[SLACK:([^:\]]+)(?::([^\]]+))?\]/);
				if (slackPrefixMatch) {
					slackMetadata = { channelId: slackPrefixMatch[1] };
					if (slackPrefixMatch[2]) slackMetadata.threadTs = slackPrefixMatch[2];
				}

				// Process message asynchronously — don't block the caller
				crewlyRuntime.handleMessage(message, slackMetadata)
					.then((result) => {
						this.logger.info('Crewly Agent finished processing message', {
							sessionName, messageLength: message.length,
							responseLength: result.text?.length ?? 0,
						});

						// Route response text back to the originating chat conversation.
						// Without this, crewly-agent responses are discarded — the agent
						// has no terminal output for the NOTIFY pathway used by PTY runtimes.
						//
						// For Slack-sourced messages: check if the agent already sent a
						// reply via reply_slack tool during processing. If so, skip routing
						// to avoid duplicates. If not, route normally to ensure delivery.
						const agentAlreadyReplied = result.toolCalls?.some(
							tc => tc.toolName === 'reply_slack' || tc.toolName === 'reply-slack'
						) ?? false;

						if (result.text && incomingConversationId && !agentAlreadyReplied) {
							this.routeInProcessResponseToChat(sessionName, result.text, incomingConversationId);
						} else if (agentAlreadyReplied) {
							this.logger.debug('Skipping chat routing — agent already replied via reply_slack', {
								sessionName, conversationId: incomingConversationId,
							});
						}
					})
					.catch(async (agentError) => {
						const errMsg = agentError instanceof Error ? agentError.message : String(agentError);
						this.logger.error('Crewly Agent message handling failed', {
							sessionName, error: errMsg,
							messageLength: message.length,
							messagePreview: message.substring(0, 200),
						});

						// Log to InProcessLogBuffer so orchestrator can see the error via get-agent-logs
						try {
							const { InProcessLogBuffer } = await import('./crewly-agent/in-process-log-buffer.js');
							InProcessLogBuffer.getInstance().append(sessionName, 'error', `Message handling failed: ${errMsg}`);
						} catch { /* non-critical */ }

						// Update workingStatus to idle so the agent is not stuck as in_progress
						try {
							const memberInfo = await this.storageService.findMemberBySessionName(sessionName);
							if (memberInfo) {
								memberInfo.member.workingStatus = 'idle';
								memberInfo.member.updatedAt = new Date().toISOString();
								await this.storageService.saveTeam(memberInfo.team);
								this.logger.info('Reset workingStatus to idle after crewly-agent error', { sessionName });
							}
						} catch (statusError) {
							this.logger.warn('Failed to reset workingStatus after error', {
								sessionName,
								error: statusError instanceof Error ? statusError.message : String(statusError),
							});
						}
					});

				this.logger.info('Message dispatched to in-process Crewly Agent', {
					sessionName, messageLength: message.length,
				});
				return { success: true, message: 'Message delivered to Crewly Agent' };
			}

			// Get session helper once for this method
			const sessionHelper = await this.getSessionHelper();

			// Check if session exists
			if (!sessionHelper.sessionExists(sessionName)) {
				return {
					success: false,
					error: `Session '${sessionName}' does not exist`,
				};
			}

			// Guard: refuse to deliver if the runtime process has exited.
			// When Claude Code exits (e.g. context exhaustion), the PTY shell
			// stays alive. Writing to it would execute garbage as shell commands.
			const backend =
				typeof (sessionHelper as { getBackend?: () => { isChildProcessAlive?: (name: string) => boolean } }).getBackend === 'function'
					? (sessionHelper as { getBackend: () => { isChildProcessAlive?: (name: string) => boolean } }).getBackend()
					: getSessionBackendSync();
			const childAlive = backend?.isChildProcessAlive?.(sessionName);
			if (childAlive === false) {
				this.logger.error('Runtime process not alive, refusing to deliver message', {
					sessionName,
					messageLength: message.length,
				});
				return {
					success: false,
					error: 'Runtime has exited — no child process in session',
				};
			}

			// Use robust message delivery with proper waiting mechanism.
			// Gemini CLI: use 2 attempts — one retry is needed for TUI focus
			// issues (Tab+Enter recovery). Previously set to 1 which caused
			// Google Chat messages to fail permanently on first TUI hiccup.
			const maxDeliveryAttempts = runtimeType === RUNTIME_TYPES.GEMINI_CLI ? 2 : 3;
			const delivered = await this.sendMessageWithRetry(sessionName, message, maxDeliveryAttempts, runtimeType);

			if (!delivered) {
				// Check if the agent is actively processing (busy) — the queue
				// processor can re-queue instead of permanently failing the message.
				// Use PTY idle time instead of regex patterns for robust cross-runtime detection.
				const idleMs = PtyActivityTrackerService.getInstance().getIdleTimeMs(sessionName);
				const isBusy = idleMs < SESSION_COMMAND_DELAYS.AGENT_BUSY_IDLE_THRESHOLD_MS;

				return {
					success: false,
					error: isBusy
						? '[AGENT_BUSY] Failed to deliver message — agent is actively processing'
						: 'Failed to deliver message after multiple attempts',
				};
			}

			this.logger.info('Message sent to agent successfully', {
				sessionName,
				messageLength: message.length,
			});

			return {
				success: true,
				message: 'Message sent to agent successfully',
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to send message to agent', {
				sessionName,
				error: errorMessage,
			});

			return {
				success: false,
				error: errorMessage,
			};
		} finally {
			releaseMutex();
			if (this.sessionDeliveryMutex.get(sessionName) === currentDelivery) {
				this.sessionDeliveryMutex.delete(sessionName);
			}
		}
	}

	/**
	 * Wait for an agent session to be at a ready prompt before sending messages.
	 *
	 * Subscribes to terminal output and polls capturePane to detect when the
	 * agent returns to an input prompt. This is critical for sequential message
	 * processing: after the orchestrator responds to a message it may continue
	 * working (managing agents, running commands) before returning to prompt.
	 *
	 * @param sessionName - The session name to wait on
	 * @param timeoutMs - Maximum time to wait (default 120s)
	 * @returns true if agent is ready, false if timed out
	 */
	async waitForAgentReady(
		sessionName: string,
		timeoutMs: number = EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT,
		runtimeType?: RuntimeType
	): Promise<boolean> {
		// In-process Crewly Agent is always "ready" (no prompt to wait for)
		const inProcessRuntime = this.inProcessRuntimes.get(sessionName);
		if (inProcessRuntime) {
			return inProcessRuntime.isReady();
		}

		const sessionHelper = await this.getSessionHelper();

		// Check if session exists
		if (!sessionHelper.sessionExists(sessionName)) {
			this.logger.warn('Session does not exist for waitForAgentReady', { sessionName });
			return false;
		}

		// Quick check - already at prompt?
		const currentOutput = sessionHelper.capturePane(sessionName);
		if (this.isClaudeAtPrompt(currentOutput, runtimeType)) {
			this.logger.debug('Agent already at prompt', { sessionName });
			return true;
		}

		this.logger.info('Waiting for agent to return to prompt', { sessionName, timeoutMs });

		const session = sessionHelper.getSession(sessionName);
		if (!session) {
			return false;
		}

		const waitStartMs = Date.now();

		return new Promise<boolean>((resolve) => {
			let resolved = false;
			let pollCount = 0;
			const pollInterval = EVENT_DELIVERY_CONSTANTS.AGENT_READY_POLL_INTERVAL;

			const cleanup = () => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				clearInterval(pollId);
				clearInterval(deepScanId);
				unsubscribe();
			};

			// Timeout - give up waiting
			const timeoutId = setTimeout(() => {
				this.logger.warn('Timed out waiting for agent to be ready', { sessionName, timeoutMs });
				cleanup();
				resolve(false);
			}, timeoutMs);

			// Poll capturePane periodically as a fallback
			const pollId = setInterval(() => {
				if (resolved) return;
				pollCount++;
				const output = sessionHelper.capturePane(sessionName);
				if (this.isClaudeAtPrompt(output, runtimeType)) {
					const elapsedMs = Date.now() - waitStartMs;
					this.logger.info('Agent ready after polling', { sessionName, pollCount, elapsedMs });
					cleanup();
					resolve(true);
				}
			}, pollInterval);

			// Deep scan with larger buffer every DEEP_SCAN_INTERVAL to catch prompts
			// that the fast poll misses (e.g. when prompt is beyond the default 200 lines)
			const deepScanId = setInterval(() => {
				if (resolved) return;
				pollCount++;
				const output = sessionHelper.capturePane(sessionName, EVENT_DELIVERY_CONSTANTS.DEEP_SCAN_LINES);
				if (this.isClaudeAtPrompt(output, runtimeType)) {
					const elapsedMs = Date.now() - waitStartMs;
					this.logger.info('Agent ready after polling', { sessionName, pollCount, elapsedMs });
					cleanup();
					resolve(true);
				}
			}, EVENT_DELIVERY_CONSTANTS.DEEP_SCAN_INTERVAL);

			// Also subscribe to terminal data for faster detection
			const unsubscribe = session.onData((data) => {
				if (resolved) return;
				// Strip ANSI escape sequences before testing — raw PTY data contains
				// cursor positioning, color codes, etc. that break pattern matching (#106)
				const cleanData = stripAnsiCodes(data);
				// Check each line for prompt pattern (string-based, no regex)
				const hasPromptInStream = cleanData.split('\n').some(
					line => line.trim().length > 0 && isPromptLine(line, runtimeType)
				);
				if (hasPromptInStream) {
					// Double-check with capturePane to avoid false positives from partial data
					const output = sessionHelper.capturePane(sessionName);
					if (this.isClaudeAtPrompt(output, runtimeType)) {
						this.logger.debug('Agent at prompt (detected via stream)', { sessionName });
						cleanup();
						resolve(true);
					}
				}
			});
		});
	}

	/**
	 * Send message with retry logic for reliable delivery to Claude Code.
	 * Uses SessionCommandHelper.sendMessage() (proven two-step write pattern)
	 * with stuck-message detection and retry on failure.
	 *
	 * @param sessionName - The session name
	 * @param message - The message to send
	 * @param maxAttempts - Maximum number of delivery attempts
	 * @returns true if message was delivered successfully
	 */
	private async sendMessageWithRetry(
		sessionName: string,
		message: string,
		maxAttempts: number = 3,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE
	): Promise<boolean> {
		const sessionHelper = await this.getSessionHelper();
		const isClaudeCode = runtimeType === RUNTIME_TYPES.CLAUDE_CODE;

		// Register TUI sessions for TUI prompt-line scanning (Part 1 of scanner).
		// The scanner itself is started lazily by trackSentMessage() which
		// runs after every message send, covering all runtimes.
		if (!isClaudeCode) {
			this.tuiSessionRegistry.set(sessionName, runtimeType);
		}

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				this.logger.debug('Attempting message delivery', {
					sessionName,
					attempt,
					maxAttempts,
					messageLength: message.length,
					runtimeType,
				});

				// Verify agent is at prompt before sending
				const output = sessionHelper.capturePane(sessionName);

				// Gemini CLI stuck-connectivity guard (#128): If the CLI is in a
				// "Trying to reach <model>" retry loop, it will never process
				// new messages. Bail out immediately so the caller gets a clear
				// failure signal and the runtime-exit-monitor can trigger recovery.
				if (runtimeType === RUNTIME_TYPES.GEMINI_CLI && GEMINI_STUCK_CONNECTIVITY_PATTERN.test(output)) {
					this.logger.warn('Gemini CLI stuck in connectivity retry loop, aborting message delivery (#128)', {
						sessionName,
						attempt,
					});
					return false;
				}
				if (!this.isClaudeAtPrompt(output, runtimeType)) {
					if (attempt === maxAttempts) {
						// On the final attempt, check if the agent is DEFINITELY busy
						// before force-delivering. Use PTY idle time for robust
						// cross-runtime detection instead of fragile regex patterns.
						const idleMs = PtyActivityTrackerService.getInstance().getIdleTimeMs(sessionName);
						const isBusy = idleMs < SESSION_COMMAND_DELAYS.AGENT_BUSY_IDLE_THRESHOLD_MS;

						if (isBusy) {
							this.logger.warn('Agent is busy (processing indicators detected), skipping force delivery', {
								sessionName,
								attempt,
								runtimeType,
							});
							return false;
						}

						// Not clearly busy — fall back to direct delivery. The agent
						// may be at a prompt that doesn't match our detection patterns,
						// or the terminal buffer may be stale.
						this.logger.warn('Prompt detection failed on final attempt, delivering message directly', {
							sessionName,
							attempt,
							runtimeType,
						});
						// Fall through to message delivery below
					} else {
						this.logger.debug('Not at prompt, waiting before retry', { sessionName, attempt });
						await delay(SESSION_COMMAND_DELAYS.CLAUDE_RECOVERY_DELAY);
						continue;
					}
				}

				// Gemini CLI shell mode guard: if the prompt shows `!` instead of `>`,
				// input will be executed as a shell command. Send Escape to exit first.
				if (runtimeType === RUNTIME_TYPES.GEMINI_CLI && this.isGeminiInShellMode(output)) {
					const escaped = await this.escapeGeminiShellMode(sessionName, sessionHelper);
					if (!escaped) {
						this.logger.warn('Could not exit Gemini shell mode, skipping attempt', {
							sessionName,
							attempt,
						});
						await delay(SESSION_COMMAND_DELAYS.MESSAGE_RETRY_DELAY);
						continue;
					}
				}

				// Clear any stale text before sending.
				// Claude Code: Ctrl+C to cancel any pending input — but ONLY on
				// retry attempts. On the first attempt, waitForAgentReady already
				// confirmed the agent is idle at the prompt, so Ctrl+C is
				// unnecessary and can disrupt Claude Code's input handler if the
				// 300ms settling delay isn't enough.
				// Gemini CLI (Ink TUI): escalating recovery to refocus input box.
				// The TUI input can lose focus after idle periods, auto-update
				// notifications, or dialog overlays. When defocused, writes are
				// silently consumed by the Ink framework but NOT routed to the
				// InputPrompt.
				// Do NOT send Escape (defocuses permanently), Ctrl+C (triggers
				// /quit on empty prompt), or Ctrl+U (ignored by TUI).
				//
				// Recovery strategies (escalating per attempt):
				// 1. Tab + Enter: Tab triggers Ink's focusNext() which cycles
				//    focus through focusable components. If InputPrompt is the
				//    only/next focusable element, it gets refocused. Enter then
				//    dismisses any overlay or acts as safe no-op on empty prompt.
				// 2-3. PTY resize + Tab + Enter: Resize sends SIGWINCH to the
				//    child process, forcing Ink to re-render the entire TUI.
				//    This may restore the internal focus state. Then Tab + Enter
				//    for focus cycling and overlay dismissal.
				if (isClaudeCode) {
					if (attempt > 1) {
						// On retry: Ctrl+C to cancel stale input, then PTY resize to force
						// TUI re-render (SIGWINCH), then Tab to cycle Ink focus.
						await sessionHelper.sendCtrlC(sessionName);
						await delay(300);
					}

					// PTY resize on ALL attempts to force SIGWINCH → Ink TUI re-render.
					// Claude Code's Ink TUI can lose internal input focus after stop hooks
					// (especially ones that error), state transitions, or idle periods.
					// When defocused, the `❯` prompt is visible in the terminal buffer
					// but writes are silently consumed by the framework — NOT routed to
					// the InputPrompt. Tab alone was insufficient; PTY resize forces a
					// full TUI re-render that reliably restores focus state.
					// This matches the manual workaround where pressing a key in the
					// frontend terminal "wakes up" the input handler.
					try {
						const session = sessionHelper.getSession(sessionName);
						if (session) {
							session.resize(81, 25);
							await delay(200);
							session.resize(80, 24);
							await delay(300);
						}
					} catch { /* non-fatal */ }
					await sessionHelper.sendKey(sessionName, 'Tab');
					await delay(300);
				} else {
					// Detect recent /compress — Ink TUI loses internal focus after
					// /compress re-renders, causing subsequent messages to be silently
					// dropped even though the prompt `>` is visible (#114).
					// Always force PTY resize on attempt 1 if /compress detected.
					// Also detect ✖ error state (#130) — MCP connection errors
					// cause a persistent error indicator that steals TUI focus.
					const recentOutput = sessionHelper.capturePane(sessionName, 40);
					const compressDetected = recentOutput.includes('/compress') ||
						recentOutput.includes('Context compressed') ||
						recentOutput.includes('Compressing context');
					// Check for Gemini CLI error indicators in the status bar area (#130).
					const statusArea = recentOutput.split('\n').slice(-GEMINI_ERROR_STATE_CONSTANTS.STATUS_AREA_LINES).join('\n');
					const errorStateDetected = recentOutput.includes(GEMINI_ERROR_STATE_CONSTANTS.ERROR_MARKER) ||
						GEMINI_ERROR_STATE_CONSTANTS.ERROR_COUNT_PATTERN.test(statusArea);
					const needsResize = attempt > 1 || compressDetected || errorStateDetected;

					// Force a PTY resize to trigger SIGWINCH, making Ink
					// re-render the TUI and potentially restore focus state.
					if (needsResize) {
						try {
							const session = sessionHelper.getSession(sessionName);
							if (session) {
								// Resize slightly then back to trigger SIGWINCH
								session.resize(81, 25);
								await delay(200);
								session.resize(80, 24);
								await delay(500);
								this.logger.debug('PTY resize sent to trigger TUI re-render', {
									sessionName,
									attempt,
									compressDetected,
								});
							}
						} catch (resizeErr) {
							this.logger.debug('PTY resize failed (non-fatal)', {
								sessionName,
								error: resizeErr instanceof Error ? resizeErr.message : String(resizeErr),
							});
						}
					}

					// If error state detected (✖), dismiss the error overlay first (#130).
				// F12 toggles the error details panel in Gemini CLI, Enter dismisses
				// any overlay/notification, and the combination restores the TUI to a
				// state where the InputPrompt can accept input.
					if (errorStateDetected) {
						this.logger.info('Gemini CLI error state detected (✖), dismissing before delivery (#130)', {
							sessionName,
							attempt,
						});
						// F12 to close error details panel if open
						await sessionHelper.sendKey(sessionName, 'F12');
						await delay(300);
						// Enter to dismiss any remaining overlay/notification
						await sessionHelper.sendEnter(sessionName);
						await delay(500);
					}

					// Send Tab to cycle Ink focus. In Ink v6, Tab triggers
					// focusNext() in FocusContext, which moves focus to the next
					// focusable component (InputPrompt). This works even when the
					// input is defocused because the Tab handler runs at the Ink
					// framework level, not the component level.
					// Send two Tabs to cycle through error/notification components
					// that may be in the focus chain (#130).
					await sessionHelper.sendKey(sessionName, 'Tab');
					await delay(200);
					await sessionHelper.sendKey(sessionName, 'Tab');
					await delay(300);

					// Then Enter to dismiss any notification overlay and ensure
					// the input is engaged. Enter on an empty `> ` prompt is a
					// safe no-op (just shows a new blank prompt line).
					await sessionHelper.sendEnter(sessionName);
					// Extra settling time after /compress or error state to let Ink TUI stabilize
					await delay((compressDetected || errorStateDetected) ? 1000 : 500);
				}

				// For Gemini CLI: detect and gently escape interactive modes before
				// sending the message. Avoid Ctrl-C here — Gemini interprets it as
				// destructive cancellation/quit in some states.
				if (!isClaudeCode) {
					const preOutput = sessionHelper.capturePane(sessionName, 10);
					const interactiveModePatterns = [
						'Select a file',       // /resume file picker
						'❯',                   // Interactive list selector
						'Choose an option',    // Generic interactive prompt
						'/resume',             // Resume command active
					];
					const inInteractiveMode = interactiveModePatterns.some(p => preOutput.includes(p));
					if (inInteractiveMode) {
						this.logger.warn('Gemini CLI in interactive mode, using non-destructive recovery', {
							sessionName,
							detectedPattern: interactiveModePatterns.find(p => preOutput.includes(p)),
						});
						await sessionHelper.sendKey(sessionName, 'Tab');
						await delay(250);
						await sessionHelper.sendEnter(sessionName);
						await delay(1000);
					}
				}

				// Capture output BEFORE sending to detect changes for ALL runtimes.
				// Claude Code: progressive output-change detection prevents false-positive
				// Ctrl+C by giving Claude up to 6.5s to start rendering output.
				// TUI runtimes: same output-change detection as before.
				// Use a small pane capture (20 lines) to reduce noise from TUI
				// border redraws that can cause length changes unrelated to delivery.
				const beforeOutput = sessionHelper.capturePane(sessionName, 20);
				const beforeLength = beforeOutput.length;

				// Deduplication guard (#128): Check if the agent is already
				// processing on ALL attempts (not just retries). A previous
				// write may have succeeded but verification failed. Re-writing
				// the same message creates a duplicate in the input buffer.
				{
					const preWriteCheck = sessionHelper.capturePane(sessionName);
					const hasSpinner = containsSpinnerOrWorkingIndicator(preWriteCheck);

					if (hasSpinner) {
						// Hash-based dedup: if the same message was recently sent
						// and the agent is processing, it's very likely our message.
						const msgHash = message.substring(0, 200);
						const lastSent = this.lastSentMessageHash.get(sessionName);
						const isRecentDuplicate = lastSent
							&& lastSent.hash === msgHash
							&& (Date.now() - lastSent.sentAt) < 60000;

						if (isRecentDuplicate || attempt > 1) {
							this.logger.info('Agent already processing — skipping write to prevent duplicate (#128)', {
								sessionName,
								attempt,
								isRecentDuplicate: !!isRecentDuplicate,
							});
							return true;
						}
					}

					// On retries: also check if agent is not at prompt AND our
					// message text is NOT stuck at the bottom.
					if (attempt > 1) {
						const notAtPrompt = !this.isClaudeAtPrompt(preWriteCheck, runtimeType);
						if (notAtPrompt) {
							const msgSnippet = (message.length > 20
								? message.substring(0, 80)
								: message).replace(/\s+/g, ' ').trim();
							const bottomLines = preWriteCheck.split('\n').slice(-10).join(' ').replace(/\s+/g, ' ');
							const textStuck = bottomLines.includes(msgSnippet);
							if (!textStuck) {
								this.logger.info('Agent not at prompt and message not stuck — skipping re-write (#128)', {
									sessionName,
									attempt,
								});
								return true;
							}
						}
					}
				}

				// Use SessionCommandHelper.sendMessage() — proven two-step write:
				// 1. session.write(message)    — triggers bracketed paste
				// 2. await delay(scaled)       — waits for paste processing
				// 3. session.write('\r')       — sends Enter separately
				// 4. await delay(KEY_DELAY)    — waits for key processing
				await sessionHelper.sendMessage(sessionName, message);

				// Register for background stuck-detection safety net (all runtimes).
				// If progressive verification below misses an Enter drop, the
				// background scanner will catch it within 30s.
				this.trackSentMessage(sessionName, message);

				// Track message hash for deduplication on retry (#128)
				this.lastSentMessageHash.set(sessionName, {
					hash: message.substring(0, 200),
					sentAt: Date.now(),
				});

				// Wait for agent to start processing, then verify delivery.
				// TUI runtimes need a longer delay (3s) for the TUI to redraw
				// and show processing indicators after accepting input.
				const processingDelay = isClaudeCode
					? SESSION_COMMAND_DELAYS.MESSAGE_PROCESSING_DELAY
					: 3000;
				await delay(processingDelay);

				// === Delivery verification ===
				// Claude Code: prompt disappears during processing, so check
				// isMessageStuckAtPrompt (text still at prompt = stuck).
				// TUI runtimes (Gemini CLI): use TWO-PHASE verification:
				//   Phase 1: Direct check — is the message text sitting ON the
				//            `> ` prompt line? If yes, Enter was dropped. Try
				//            pressing Enter to recover before falling through to retry.
				//   Phase 2: Output-change detection — compare before/after captures
				//            to see if the agent started processing.
				if (isClaudeCode) {
					// Progressive verification for Claude Code.
					// Claude Code routinely takes 3-8s to start rendering with large
					// context. The old 2.5s window caused false-positive Ctrl+C that
					// cancelled valid in-progress prompts. Now we progressively check
					// at [1s, 2s, 3s] intervals (total ~6.5s including processing delay).
					//
					// Progressive verification: check at [1s, 2s, 3s] intervals whether
					// the agent accepted the message and started processing it.
					//
					// Uses runtime-agnostic detection — no hardcoded prompt characters.
					// This stays correct when the agent runtime upgrades its prompt.
					//
					// Three signals checked per interval:
					// 1. Processing indicators (⠋ ⏺ spinners) — definitive success
					// 2. isClaudeAtPrompt() — if still true, agent is idle, wait more
					// 3. Message text in bottom lines — if found, Enter was dropped
					//    (message pasted at prompt but not submitted)
					// If prompt gone AND message text NOT at bottom → success
					let claudeDelivered = false;
					for (const intervalMs of SESSION_COMMAND_DELAYS.CLAUDE_VERIFICATION_INTERVALS) {
						const currentOutput = sessionHelper.capturePane(sessionName);

						// 1. Processing indicators (spinners, working marker) are
						//    definitive proof the agent accepted and is working.
						//    Only check spinner/⏺ chars — NOT text words like
						//    "thinking" which appear in historical response text.
						if (containsSpinnerOrWorkingIndicator(currentOutput)) {
							this.logger.debug('Processing indicators detected — message accepted', {
								sessionName,
								attempt,
							});
							claudeDelivered = true;
							break;
						}

						// 2. Is the agent still at its standard idle prompt?
						//    Reuse isClaudeAtPrompt() — the single source of truth
						//    for prompt detection. This avoids hardcoding prompt
						//    characters and stays correct when the runtime upgrades.
						if (this.isClaudeAtPrompt(currentOutput, runtimeType)) {
							// Prompt is visible. Before just waiting, check if our
							// message text is also at the bottom — this means the
							// text was pasted but Enter was dropped. Press Enter.
							// Normalize whitespace: enhanced messages contain literal \n from
							// addContinuationInstructions(). join(' ') replaces line breaks with
							// spaces, but the snippet still has \n chars, so includes() fails.
							const promptMsgSnippet = (message.length > 20
								? message.substring(0, 80)
								: message).replace(/\s+/g, ' ').trim();
							const promptBottomLines = currentOutput.split('\n').slice(-10).join(' ').replace(/\s+/g, ' ');
							if (promptBottomLines.includes(promptMsgSnippet)) {
								this.logger.warn('At prompt with message text at bottom — pressing Tab+Enter', {
									sessionName,
									attempt,
									intervalMs,
								});
								// Tab restores Ink TUI focus before Enter — without this,
								// Enter may be consumed by the framework but not routed to
								// the input component if focus was lost during a re-render
								// (e.g., after stop hooks, state transitions).
								await sessionHelper.sendKey(sessionName, 'Tab');
								await delay(200);
								await sessionHelper.sendEnter(sessionName);
								await delay(500);
								await sessionHelper.sendEnter(sessionName); // backup

								await delay(SESSION_COMMAND_DELAYS.MESSAGE_PROCESSING_DELAY);

								// Verify recovery
								const postEnterOutput = sessionHelper.capturePane(sessionName);
								if (containsSpinnerOrWorkingIndicator(postEnterOutput) ||
									!this.isClaudeAtPrompt(postEnterOutput, runtimeType)) {
									this.logger.info('Enter recovery from prompt successful', {
										sessionName,
										attempt,
									});
									claudeDelivered = true;
									break;
								}
							}

							this.logger.debug('Agent still at prompt, waiting before re-check', {
								sessionName,
								attempt,
								intervalMs,
							});
							await delay(intervalMs);
							continue;
						}

						// 3. Prompt not in its standard idle form. Before declaring
						//    success, check if our message text is stuck at the
						//    bottom of the terminal. When Enter is dropped, the
						//    pasted text appears on the prompt line — the terminal
						//    shows the prompt char followed by our message text.
						//    This check is runtime-agnostic: it works regardless
						//    of what prompt character the runtime uses.
						// Normalize whitespace in snippet (see Step 2 comment above).
						const msgSnippet = (message.length > 20
							? message.substring(0, 80)
							: message).replace(/\s+/g, ' ').trim();
						const bottomLines = currentOutput.split('\n').slice(-10).join(' ').replace(/\s+/g, ' ');
						if (bottomLines.includes(msgSnippet)) {
							// Message text is at the bottom of the terminal but the
							// prompt is no longer in its idle form — Enter was dropped.
							// Instead of waiting and doing a full Ctrl+C + resend retry,
							// use Tab to restore TUI focus, then Enter to submit.
							this.logger.warn('Message text stuck at bottom — pressing Tab+Enter to recover', {
								sessionName,
								attempt,
								intervalMs,
							});
							await sessionHelper.sendKey(sessionName, 'Tab');
							await delay(200);
							await sessionHelper.sendEnter(sessionName);
							await delay(500);
							await sessionHelper.sendEnter(sessionName); // backup Enter

							// Give the agent a moment to start processing after Enter
							await delay(SESSION_COMMAND_DELAYS.MESSAGE_PROCESSING_DELAY);

							// Verify recovery: check if processing started
							const recoveryOutput = sessionHelper.capturePane(sessionName);
							if (containsSpinnerOrWorkingIndicator(recoveryOutput)) {
								this.logger.info('Enter recovery successful — processing started', {
									sessionName,
									attempt,
								});
								claudeDelivered = true;
								break;
							}

							// Check if prompt reappeared (Enter submitted but processed instantly)
							// or if output changed from the stuck state
							const recoveryBottom = recoveryOutput.split('\n').slice(-10).join(' ').replace(/\s+/g, ' ');
							if (!recoveryBottom.includes(msgSnippet)) {
								this.logger.info('Enter recovery successful — stuck text cleared', {
									sessionName,
									attempt,
								});
								claudeDelivered = true;
								break;
							}

							// Still stuck after Enter recovery — continue to next interval
							this.logger.debug('Still stuck after Enter recovery, continuing verification', {
								sessionName,
								attempt,
							});
							await delay(intervalMs);
							continue;
						}

						// Prompt gone AND no stuck text → agent started processing
						this.logger.debug('Prompt gone, no stuck text — message delivered', {
							sessionName,
							attempt,
						});
						claudeDelivered = true;
						break;
					}

					// --- Extended confirmation loop ---
					// If progressive verification didn't confirm delivery, run an
					// extended check loop (every 3s, up to 30s total). Each iteration
					// captures the pane, checks for spinner/working indicators, and
					// presses Tab+Enter if message text is still stuck at the bottom.
					if (!claudeDelivered) {
						const CONFIRM_INTERVAL_MS = 3000;
						const CONFIRM_MAX_MS = 30000;
						const confirmStart = Date.now();
						let confirmAttempt = 0;

						// Normalize snippet once for reuse
						const confirmSnippet = (message.length > 20
							? message.substring(0, 80)
							: message).replace(/\s+/g, ' ').trim();

						while (Date.now() - confirmStart < CONFIRM_MAX_MS) {
							await delay(CONFIRM_INTERVAL_MS);
							confirmAttempt++;

							const loopOutput = sessionHelper.capturePane(sessionName);

							// Spinner or working indicator → delivered
							if (containsSpinnerOrWorkingIndicator(loopOutput)) {
								this.logger.info('Confirmation loop: processing detected', {
									sessionName, attempt, confirmAttempt,
								});
								claudeDelivered = true;
								break;
							}

							// Not at prompt and text not stuck → delivered
							const loopBottom = loopOutput.split('\n').slice(-10).join(' ').replace(/\s+/g, ' ');
							if (!this.isClaudeAtPrompt(loopOutput, runtimeType) && !loopBottom.includes(confirmSnippet)) {
								this.logger.info('Confirmation loop: prompt gone, text cleared', {
									sessionName, attempt, confirmAttempt,
								});
								claudeDelivered = true;
								break;
							}

							// Text still stuck → Tab+Enter recovery
							if (loopBottom.includes(confirmSnippet)) {
								this.logger.warn('Confirmation loop: text still stuck, pressing Tab+Enter', {
									sessionName, attempt, confirmAttempt,
								});
								await sessionHelper.sendKey(sessionName, 'Tab');
								await delay(200);
								await sessionHelper.sendEnter(sessionName);
								await delay(500);
								await sessionHelper.sendEnter(sessionName); // backup
							}
						}

						if (!claudeDelivered) {
							this.logger.error('Confirmation loop exhausted — delivery unconfirmed', {
								sessionName, attempt, confirmAttempts: confirmAttempt,
							});
						}
					}

					if (claudeDelivered) {
						return true;
					}
				} else {
					// --- Gemini CLI: lightweight verification ---
					// Gemini CLI's PTY write is reliable. The aggressive verification
					// (stuck detection + Tab+Enter recovery + output-change diff) causes
					// false "stuck" judgments that trigger visible retry error spam even
					// when the message was successfully delivered (#retry-storm fix).
					//
					// Strategy: only check for the definitive stuck signal (message text
					// literally sitting on the `> ` prompt line). If not stuck, trust the
					// write. Skip the output-change heuristics that cause false negatives.
					const isGemini = runtimeType === RUNTIME_TYPES.GEMINI_CLI;

					if (isGemini) {
						// Single stuck-at-prompt check — the only reliable failure signal
						const stuckAtPrompt = this.isTextStuckAtTuiPrompt(sessionName, message);
						if (stuckAtPrompt) {
							const recovered = await this.recoverStuckTuiMessage(sessionName, message);
							if (recovered) {
								this.logger.info('Gemini CLI: message recovered via Enter re-press', {
									sessionName,
									attempt,
								});
								return true;
							}
							this.logger.warn('Gemini CLI: message still stuck after Enter recovery', {
								sessionName,
								attempt,
							});
							// Fall through to retry cleanup below
						} else {
							// Not stuck at prompt — PTY write succeeded, trust delivery.
							// The old code did output-change detection here, but TUI redraws
							// and minimal length diffs caused false "not delivered" verdicts.
							this.logger.debug('Gemini CLI: message not stuck at prompt — delivery trusted', {
								sessionName,
								attempt,
							});
							return true;
						}
					} else {
						// --- Non-Gemini TUI runtimes: full verification ---
						// Phase 1: Direct stuck-at-prompt detection
						const stuckAtPrompt = this.isTextStuckAtTuiPrompt(sessionName, message);
						if (stuckAtPrompt) {
							const recovered = await this.recoverStuckTuiMessage(sessionName, message);
							if (recovered) {
								this.logger.info('Message recovered via Enter re-press', {
									sessionName,
									attempt,
								});
								return true;
							}
							this.logger.warn('Message still stuck after Enter recovery, will retry', {
								sessionName,
								attempt,
							});
						} else {
							// Phase 2: Output-change detection
							const afterOutput = sessionHelper.capturePane(sessionName, 20);
							const lengthDiff = afterOutput.length - beforeLength;
							const contentChanged = beforeOutput !== afterOutput;

							let newContent = '';
							if (contentChanged && afterOutput.length > beforeOutput.length) {
								newContent = afterOutput.slice(beforeLength);
							} else if (contentChanged) {
								const beforeLines = new Set(beforeOutput.split('\n'));
								newContent = afterOutput
									.split('\n')
									.filter((line) => !beforeLines.has(line))
									.join('\n');
							}

							const hasProcessingIndicators = containsProcessingIndicator(
								newContent || afterOutput.slice(-500)
							);

							const significantLengthChange = Math.abs(lengthDiff) > 10;
							const delivered = (lengthDiff > 20)
								|| (contentChanged && significantLengthChange)
								|| hasProcessingIndicators;

							if (delivered) {
								const hasStrongSignal = hasProcessingIndicators;
								const logLevel = hasStrongSignal ? 'debug' : 'warn';
								this.logger[logLevel](`Message delivery verified (${hasStrongSignal ? 'strong' : 'weak'} signal)`, {
									sessionName,
									attempt,
									lengthDiff,
									contentChanged,
									hasProcessingIndicators,
									newContentLength: newContent.length,
									signal: hasStrongSignal ? 'processing-indicators' : 'output-length-change-only',
								});
								return true;
							}

							this.logger.warn('TUI output did not change after send — message may not have been accepted', {
								sessionName,
								attempt,
								lengthDiff,
								contentChanged,
								hasProcessingIndicators,
								newContentLength: newContent.length,
							});
						}
					}
				}

				// Message stuck at prompt — clear line and retry.
				this.logger.warn('Message stuck at prompt after send, clearing for retry', {
					sessionName,
					attempt,
				});
				if (isClaudeCode) {
					await sessionHelper.clearCurrentCommandLine(sessionName);
				} else {
					// Gemini CLI retry cleanup: NEVER send Ctrl+C — it triggers /quit
					// and kills the CLI entirely, regardless of whether text is in the
					// input box or not. Use Tab to cycle Ink focus back to the input
					// prompt, then Enter to submit any pending text.
					this.logger.warn('Gemini CLI message stuck — using Tab focus recovery (no Ctrl+C)', {
						sessionName,
						attempt,
					});
					await sessionHelper.sendKey(sessionName, 'Tab');
					await delay(300);
					await sessionHelper.sendEnter(sessionName);
					await delay(300);
				}
				await delay(SESSION_COMMAND_DELAYS.CLEAR_COMMAND_DELAY);

				if (attempt < maxAttempts) {
					await delay(SESSION_COMMAND_DELAYS.MESSAGE_RETRY_DELAY);
				}
			} catch (error) {
				this.logger.error('Error during message delivery', {
					sessionName,
					attempt,
					error: error instanceof Error ? error.message : String(error),
				});

				if (attempt < maxAttempts) {
					await delay(SESSION_COMMAND_DELAYS.MESSAGE_RETRY_DELAY);
				}
			}
		}

		this.logger.warn('Message delivery verification failed — all attempts exhausted', {
			sessionName,
			maxAttempts,
			messageLength: message.length,
		});

		this.logger.error('Message delivery failed after all retry attempts', {
			sessionName,
			maxAttempts,
			messageLength: message.length,
		});

		return false;
	}


	/**
	 * Check if a sent message is stuck at the terminal prompt (Enter was not accepted).
	 *
	 * Captures the current terminal pane and looks for the message text still visible
	 * on the last few lines. If the text is found, Enter was not processed and the
	 * message is stuck.
	 *
	 * @param sessionName - The session to check
	 * @param message - The original message that was sent
	 * @returns true if the message text is still visible at the prompt (stuck)
	 */
	private async isMessageStuckAtPrompt(sessionName: string, message: string): Promise<boolean> {
		try {
			const sessionHelper = await this.getSessionHelper();
			const output = sessionHelper.capturePane(sessionName);

			if (!output || output.trim().length === 0) {
				return false;
			}

			// Extract a search token from the message:
			// Strip [CHAT:uuid] prefix if present, then take the first 40 chars
			const { prefixLength } = extractChatPrefix(message);
			const contentAfterPrefix = prefixLength > 0
				? message.slice(prefixLength)
				: message;
			const searchToken = contentAfterPrefix.slice(0, 40).trim();

			// Also use [CHAT: as a secondary token if message has a CHAT prefix
			const chatToken = prefixLength > 0 ? '[CHAT:' : null;

			// Check last 20 non-empty lines for either token.
			// Gemini CLI TUI has status bars at the bottom (branch, sandbox, model info)
			// that push input content further up. 5 lines was insufficient.
			const lines = output.split('\n').filter((line) => line.trim().length > 0);
			const linesToCheck = lines.slice(-20);

			const isStuck = linesToCheck.some((line) => {
				// Strip TUI box-drawing borders before checking (Gemini CLI wraps content in │...│)
				const stripped = stripTuiLineBorders(line);
				if (searchToken && (line.includes(searchToken) || stripped.includes(searchToken))) return true;
				if (chatToken && (line.includes(chatToken) || stripped.includes(chatToken))) return true;
				return false;
			});

			this.logger.debug('isMessageStuckAtPrompt result', {
				sessionName,
				isStuck,
				searchToken: searchToken.slice(0, 20),
				linesChecked: linesToCheck.length,
			});

			return isStuck;
		} catch (error) {
			this.logger.warn('Error checking if message stuck at prompt', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Check if message text is stuck at the TUI prompt line (Enter was not pressed).
	 *
	 * Unlike `isMessageStuckAtPrompt` which checks the last 20 lines for the message
	 * text ANYWHERE, this method specifically checks whether the message text appears
	 * ON the prompt line itself (the line starting with `> ` or `│ > `).
	 *
	 * After Enter is successfully pressed, the text moves from the prompt line to the
	 * chat history area. So if the text is still on the prompt line, Enter was dropped.
	 *
	 * This avoids the false positive problem where `isMessageStuckAtPrompt` matches
	 * the message text in the TUI's chat history (which echoes submitted messages).
	 *
	 * @param sessionName - The session to check
	 * @param message - The original message that was sent
	 * @returns true if the message text is visible on the TUI prompt line (stuck)
	 */
	private isTextStuckAtTuiPrompt(sessionName: string, message: string): boolean {
		try {
			const sessionHelper = this._sessionHelper;
			if (!sessionHelper) return false;

			const output = sessionHelper.capturePane(sessionName);
			if (!output || output.trim().length === 0) return false;

			// Extract search token: first 30 chars of the message content
			// (after stripping any [CHAT:uuid] prefix)
			const { prefixLength } = extractChatPrefix(message);
			const contentAfterPrefix = prefixLength > 0
				? message.slice(prefixLength)
				: message;
			const searchToken = contentAfterPrefix.slice(0, 30).trim();

			if (!searchToken) return false;

			// Find lines that look like a TUI prompt with text after it.
			// Gemini CLI TUI wraps content in box-drawing borders: │ > text │
			// Or without borders: > text
			// The prompt line is the line with `> ` followed by actual content.
			const lines = output.split('\n');

			for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
				const line = lines[i];
				const promptContent = matchTuiPromptLine(line);
				if (promptContent !== null) {
					const trimmedContent = stripTuiLineBorders(promptContent).trim();
					// Check if the prompt line content contains our message text.
					// Only check the BOTTOMMOST prompt line — historical echoes of
					// submitted messages also appear as `> text` further up in the
					// TUI conversation history. Without this break, those echoes
					// cause false "stuck" detections even after the message was
					// successfully delivered.
					if (trimmedContent.length > 5 && trimmedContent.includes(searchToken)) {
						this.logger.warn('Text stuck at TUI prompt — Enter was not pressed', {
							sessionName,
							searchToken: searchToken.slice(0, 20),
							promptContent: promptContent.slice(0, 60),
						});
						return true;
					}
					break; // Only check the first (bottommost) prompt line
				}
			}

			return false;
		} catch (error) {
			this.logger.debug('Error in isTextStuckAtTuiPrompt', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Attempt to recover from text stuck at TUI prompt by pressing Enter.
	 * Checks if text is stuck, sends Enter, waits, then verifies.
	 *
	 * @param sessionName - The session to recover
	 * @param message - The original message
	 * @returns true if recovery succeeded (text is no longer at prompt)
	 */
	private async recoverStuckTuiMessage(sessionName: string, message: string): Promise<boolean> {
		const sessionHelper = await this.getSessionHelper();

		// Tab restores Ink TUI focus, then Enter to submit the stuck text.
		// Without Tab, Enter may be consumed by the framework but not routed
		// to the input component if focus was lost during a re-render.
		this.logger.info('Pressing Tab+Enter to recover stuck TUI message', { sessionName });
		await sessionHelper.sendKey(sessionName, 'Tab');
		await delay(200);
		await sessionHelper.sendEnter(sessionName);
		await delay(500);

		// Double-tap: send a backup Enter in case the first was consumed
		await sessionHelper.sendEnter(sessionName);
		await delay(2000);

		// Verify text is no longer at prompt
		const stillStuck = this.isTextStuckAtTuiPrompt(sessionName, message);
		if (!stillStuck) {
			this.logger.info('TUI message recovery succeeded — Enter accepted', { sessionName });
			return true;
		}

		this.logger.warn('TUI message still stuck after Enter recovery', { sessionName });
		return false;
	}

	/**
	 * Start a background scanner that periodically checks all registered TUI
	 * sessions for text stuck at the prompt (Enter not pressed).
	 *
	 * This is a safety net that catches messages missed by the per-send
	 * verification in `sendMessageWithRetry`. It scans every 30 seconds.
	 *
	 * When stuck text is detected, the scanner presses Enter to recover.
	 * If text has been sitting at the prompt for multiple consecutive scans,
	 * it escalates to Tab + Enter (TUI focus recovery).
	 */
	startStuckMessageDetector(): void {
		if (this.stuckMessageDetectorTimer) {
			this.logger.debug('Stuck message detector already running');
			return;
		}

		const SCAN_INTERVAL_MS = 30000; // 30 seconds
		this.logger.info('Starting background stuck-message detector', {
			intervalMs: SCAN_INTERVAL_MS,
		});

		this.stuckMessageDetectorTimer = setInterval(async () => {
			try {
				await this.scanForStuckMessages();
			} catch (error) {
				this.logger.debug('Stuck message scan error (non-fatal)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}, SCAN_INTERVAL_MS);
	}

	/**
	 * Stop the background stuck-message detector.
	 */
	stopStuckMessageDetector(): void {
		if (this.stuckMessageDetectorTimer) {
			clearInterval(this.stuckMessageDetectorTimer);
			this.stuckMessageDetectorTimer = null;
			this.logger.info('Stopped background stuck-message detector');
		}
	}

	/**
	 * Scan all sessions for stuck messages. Two complementary strategies:
	 *
	 * 1. TUI prompt-line scanning (existing): checks registered TUI sessions
	 *    for text sitting on the `> ` prompt line.
	 * 2. Tracked-message scanning (new, all runtimes): checks if any recently
	 *    sent message text is still visible at the bottom of the terminal
	 *    after 15+ seconds — runtime-agnostic Enter-drop detection.
	 */
	private async scanForStuckMessages(): Promise<void> {
		const sessionHelper = this._sessionHelper;
		if (!sessionHelper) return;

		// --- Part 0: Rewind mode detection (all sessions) ---
		// If Claude Code is stuck in Rewind mode (triggered by ESC during
		// processing), send 'q' to exit before any other recovery attempts.
		for (const sessionName of sessionHelper.listSessions()) {
			try {
				const output = sessionHelper.capturePane(sessionName);
				if (containsRewindMode(output)) {
					this.logger.warn('Rewind mode detected, sending q to exit', { sessionName });
					sessionHelper.writeRaw(sessionName, 'q');
					await delay(500);
				}
			} catch {
				// Non-fatal: session may have been destroyed
			}
		}

		// --- Part 1: Existing TUI prompt-line scanning ---
		for (const [sessionName, runtimeType] of this.tuiSessionRegistry) {
			try {
				// Skip Gemini CLI sessions — their TUI prompt behaves differently
				// and false-positive stuck detection causes Tab+Enter spam.
				if (runtimeType === RUNTIME_TYPES.GEMINI_CLI) {
					continue;
				}

				// Skip sessions that no longer exist
				if (!sessionHelper.sessionExists(sessionName)) {
					this.tuiSessionRegistry.delete(sessionName);
					continue;
				}

				const output = sessionHelper.capturePane(sessionName);
				if (!output || output.trim().length === 0) continue;

				// Look for any text sitting on the prompt line
				const lines = output.split('\n');

				for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
					const promptContent = matchTuiPromptLine(lines[i]);
					if (promptContent !== null) {
						const trimmedContent = stripTuiLineBorders(promptContent).trim();
						// Only act on substantial text (> 10 chars) to avoid false positives
						// from TUI rendering artifacts or short status text
						if (trimmedContent.length > 10) {
							// Skip known idle placeholder text that sits at
							// the `> ` prompt when no user input is present. These are
							// NOT stuck messages — they are TUI decoration.
							const lowerContent = trimmedContent.toLowerCase();
							const isPlaceholder =
								lowerContent.startsWith('type your message') ||
								trimmedContent.startsWith('@');  // e.g., "@path/to/file"
							if (isPlaceholder) {
								break;
							}

							this.logger.warn('Background scan: text stuck at TUI prompt, pressing Tab+Enter', {
								sessionName,
								promptContent: promptContent.slice(0, 80),
							});

							// Tab restores Ink TUI focus before Enter
							await sessionHelper.sendKey(sessionName, 'Tab');
							await delay(200);
							await sessionHelper.sendEnter(sessionName);
							await delay(500);
							// Backup Enter
							await sessionHelper.sendEnter(sessionName);
						}
						break; // Only check the first prompt line found from the bottom
					}
				}
			} catch (error) {
				this.logger.debug('Error scanning session for stuck messages', {
					sessionName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// --- Part 2: Tracked-message scanning (non-Gemini runtimes) ---
		const now = Date.now();
		const MIN_AGE_MS = 10000; // Check messages older than 10s
		const MAX_RECOVERY_ATTEMPTS = 5; // Give up after 5 Tab+Enter attempts

		for (const [sessionName, entries] of this.sentMessageTracker) {
			if (!sessionHelper.sessionExists(sessionName)) {
				this.sentMessageTracker.delete(sessionName);
				continue;
			}

			// Skip Gemini CLI sessions — Tab+Enter recovery causes more harm
			// than good because the Gemini TUI handles input differently.
			const trackedRuntime = this.tuiSessionRegistry.get(sessionName);
			if (trackedRuntime === RUNTIME_TYPES.GEMINI_CLI) {
				continue;
			}

			try {
				const output = sessionHelper.capturePane(sessionName);
				if (!output || output.trim().length === 0) continue;
				const bottomText = output.split('\n').slice(-15).join(' ').replace(/\s+/g, ' ');

				for (const entry of entries) {
					if (entry.recovered) continue;
					if (now - entry.sentAt < MIN_AGE_MS) continue;
					if (entry.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
						// Exhausted recovery attempts — mark as recovered to stop retrying
						entry.recovered = true;
						this.logger.error('Background scan: max recovery attempts exhausted', {
							sessionName,
							snippet: entry.snippet.slice(0, 50),
							attempts: entry.recoveryAttempts,
						});
						continue;
					}

					if (bottomText.includes(entry.snippet)) {
						entry.recoveryAttempts++;
						this.logger.warn('Background scan: tracked message stuck, pressing Tab+Enter', {
							sessionName,
							snippet: entry.snippet.slice(0, 50),
							ageMs: now - entry.sentAt,
							attempt: entry.recoveryAttempts,
							maxAttempts: MAX_RECOVERY_ATTEMPTS,
						});

						// Tab restores Ink TUI focus before Enter
						await sessionHelper.sendKey(sessionName, 'Tab');
						await delay(200);
						await sessionHelper.sendEnter(sessionName);
						await delay(500);
						await sessionHelper.sendEnter(sessionName); // backup
						break; // One recovery per session per scan cycle
					}
				}
			} catch (error) {
				this.logger.debug('Error scanning tracked messages for session', {
					sessionName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Clean up old tracked-message entries
		for (const [sessionName, entries] of this.sentMessageTracker) {
			const fresh = entries.filter(e => now - e.sentAt < 5 * 60 * 1000);
			if (fresh.length === 0) {
				this.sentMessageTracker.delete(sessionName);
			} else {
				this.sentMessageTracker.set(sessionName, fresh);
			}
		}
	}

	/**
	 * Unregister a TUI session from the stuck-message detector.
	 * Call this when a session is destroyed or agent is stopped.
	 *
	 * @param sessionName - The session to unregister
	 */
	unregisterTuiSession(sessionName: string): void {
		this.tuiSessionRegistry.delete(sessionName);
		this.sentMessageTracker.delete(sessionName);
	}

	/**
	 * Register a message that was sent to a session for background
	 * stuck-detection. The scanner will periodically check if the
	 * message text is still visible at the bottom of the terminal.
	 *
	 * @param sessionName - The session the message was sent to
	 * @param message - The full message text
	 */
	trackSentMessage(sessionName: string, message: string): void {
		// Extract a search snippet: skip [CHAT:uuid] prefix, take first 80 chars
		const { prefixLength } = extractChatPrefix(message);
		const contentStart = prefixLength;
		// Normalize whitespace: messages may contain \n from enhanced templates.
		// Terminal bottom text is join(' '), so \n in snippet would never match.
		const snippet = message.slice(contentStart, contentStart + 80).replace(/\s+/g, ' ').trim();
		if (snippet.length < 10) return; // Too short to reliably match

		const entries = this.sentMessageTracker.get(sessionName) || [];
		entries.push({ snippet, sentAt: Date.now(), recovered: false, recoveryAttempts: 0 });

		// Keep only last 5 minutes of entries
		const cutoff = Date.now() - 5 * 60 * 1000;
		this.sentMessageTracker.set(
			sessionName,
			entries.filter(e => e.sentAt > cutoff)
		);

		// Ensure the background scanner is running
		this.startStuckMessageDetector();
	}

	/**
	 * Check if the agent appears to be at an input prompt.
	 * Delegates to the regex-free isAgentAtPrompt() from terminal-string-ops,
	 * with additional logging and per-line prompt detection using isPromptLine().
	 *
	 * @param terminalOutput - The terminal output to check
	 * @param runtimeType - The runtime type for pattern selection
	 * @returns true if the agent appears to be at a prompt
	 */
	private isClaudeAtPrompt(terminalOutput: string, runtimeType?: RuntimeType): boolean {
		// Handle null/undefined/empty input — return false since an empty buffer
		// may indicate a crashed session or one that hasn't started yet
		if (!terminalOutput || typeof terminalOutput !== 'string') {
			this.logger.debug('Terminal output is empty or invalid, cannot detect prompt', { runtimeType });
			return false;
		}

		// Only analyze the tail of the buffer to avoid matching historical prompts.
		// Use 5000 chars to accommodate large tool outputs that push the prompt
		// further back in the buffer (#106).
		const tailSection = terminalOutput.slice(-5000);

		// Check for prompt FIRST. Processing indicators like "thinking" or "analyzing"
		// can appear in the agent's previous response text and persist in the terminal
		// scroll buffer, causing false negatives if checked before the prompt.
		const lines = tailSection.split('\n').filter((line) => line.trim().length > 0);
		const linesToCheck = lines.slice(-10);

		const hasPrompt = linesToCheck.some(line => isPromptLine(line, runtimeType));
		if (hasPrompt) {
			return true;
		}

		// No prompt found — check if still processing.
		// Check last 10 lines (not just 5) because tool output can push processing
		// indicators further up while the status bar stays at the bottom.
		const recentLines = linesToCheck.join('\n');
		if (containsProcessingIndicator(recentLines)) {
			this.logger.debug('Processing indicators present near bottom of output');
			return false;
		}

		// Check for "esc to interrupt" in the status bar — this is a definitive
		// busy signal. Claude Code only shows this text while actively processing.
		// It disappears when the agent returns to idle at the prompt.
		if (containsBusyStatusBar(recentLines)) {
			this.logger.debug('Busy status bar detected (esc to interrupt)');
			return false;
		}

		this.logger.debug('No prompt detected in terminal output', {
			tailLength: tailSection.length,
			lastLines: linesToCheck.slice(-3).map(l => l.substring(0, 80)),
			runtimeType,
		});

		return false;
	}

	/**
	 * Detect if Gemini CLI is currently in shell mode.
	 *
	 * In shell mode, Gemini CLI changes its prompt from `>` to `!`. Any input
	 * sent in this mode is executed as a shell command instead of being passed
	 * to the model. This method examines the last few lines of terminal output
	 * for shell mode prompt indicators.
	 *
	 * @param terminalOutput - Captured terminal pane content
	 * @returns true if the terminal shows a shell mode prompt
	 */
	private isGeminiInShellMode(terminalOutput: string): boolean {
		if (!terminalOutput || typeof terminalOutput !== 'string') {
			return false;
		}

		const lines = terminalOutput.split('\n').filter((line) => line.trim().length > 0);
		const linesToCheck = lines.slice(-10);

		return linesToCheck.some((line) => {
			const trimmed = line.trim();
			// Strip TUI box-drawing borders
			const stripped = trimmed.replace(/^[│┃|]+\s*/, '').replace(/\s*[│┃|]+$/, '');

			// Shell mode prompt: `!` alone or `! ` with text (not `> ` which is normal mode)
			// Check stripped line — after removing box-drawing, if it starts with `! ` or equals `!`
			if (stripped === '!' || stripped.startsWith('! ')) {
				return true;
			}

			// Also check pattern-based detection for bordered prompts
			return GEMINI_SHELL_MODE_CONSTANTS.SHELL_MODE_PROMPT_PATTERNS.some(
				(pattern) => pattern.test(trimmed)
			);
		});
	}

	/**
	 * Escape from Gemini CLI shell mode by sending Escape key.
	 *
	 * Sends Escape and waits for the prompt to change from `!` back to `>`.
	 * Retries up to MAX_ESCAPE_ATTEMPTS times.
	 *
	 * @param sessionName - The session running Gemini CLI
	 * @param sessionHelper - SessionCommandHelper instance
	 * @returns true if successfully escaped shell mode, false if still in shell mode
	 */
	private async escapeGeminiShellMode(
		sessionName: string,
		sessionHelper: SessionCommandHelper
	): Promise<boolean> {
		for (let attempt = 1; attempt <= GEMINI_SHELL_MODE_CONSTANTS.MAX_ESCAPE_ATTEMPTS; attempt++) {
			this.logger.info('Gemini CLI in shell mode, sending Escape to exit', {
				sessionName,
				attempt,
			});

			await sessionHelper.sendEscape(sessionName);
			await delay(GEMINI_SHELL_MODE_CONSTANTS.ESCAPE_DELAY_MS);

			// Check if we're back to normal mode
			const output = sessionHelper.capturePane(sessionName);
			if (!this.isGeminiInShellMode(output)) {
				this.logger.info('Successfully exited Gemini CLI shell mode', {
					sessionName,
					attempt,
				});
				return true;
			}
		}

		this.logger.warn('Failed to exit Gemini CLI shell mode after max attempts', {
			sessionName,
			maxAttempts: GEMINI_SHELL_MODE_CONSTANTS.MAX_ESCAPE_ATTEMPTS,
		});
		return false;
	}

	/**
	 * Generic key sending to any agent session
	 * @param sessionName The agent session name
	 * @param key The key to send (e.g., 'Enter', 'Ctrl+C')
	 * @returns Promise with success/error information
	 */
	async sendKeyToAgent(
		sessionName: string,
		key: string
	): Promise<{
		success: boolean;
		message?: string;
		error?: string;
	}> {
		try {
			// Get session helper once to avoid repeated async calls
			const sessionHelper = await this.getSessionHelper();

			// Check if session exists
			const sessionExists = sessionHelper.sessionExists(sessionName);
			if (!sessionExists) {
				return {
					success: false,
					error: `Session '${sessionName}' does not exist`,
				};
			}

			// Send key using session command helper
			await sessionHelper.sendKey(sessionName, key);

			this.logger.info('Key sent to agent successfully', {
				sessionName,
				key,
			});

			return {
				success: true,
				message: `${key} key sent to agent successfully`,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to send key to agent', {
				sessionName,
				key,
				error: errorMessage,
			});

			return {
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Generic health check for any agent session
	 * @param sessionName The agent session name
	 * @param role The agent role for additional context
	 * @param timeout Timeout for health check in milliseconds
	 * @returns Promise with health status information
	 */
	async checkAgentHealth(
		sessionName: string,
		role?: string,
		timeout: number = 1000
	): Promise<{
		success: boolean;
		data?: {
			agent: {
				sessionName: string;
				role?: string;
				running: boolean;
				status: (typeof CREWLY_CONSTANTS.AGENT_STATUSES)[keyof typeof CREWLY_CONSTANTS.AGENT_STATUSES];
			};
			timestamp: string;
		};
		error?: string;
	}> {
		try {
			// Lightweight health check with timeout
			const agentRunning = await Promise.race([
				(await this.getSessionHelper()).sessionExists(sessionName),
				new Promise<boolean>((_, reject) =>
					setTimeout(() => reject(new Error('Health check timeout')), timeout)
				),
			]).catch(() => false);

			return {
				success: true,
				data: {
					agent: {
						sessionName,
						role,
						running: agentRunning,
						status: agentRunning
							? CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE
							: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
					},
					timestamp: new Date().toISOString(),
				},
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to check agent health', {
				sessionName,
				role,
				error: errorMessage,
			});

			return {
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Write the prompt to a file and send a short instruction to the agent to read it.
	 *
	 * Instead of pasting large multi-line prompts directly into the terminal (which
	 * causes bracketed paste issues, shell interpretation errors, and truncation),
	 * we write the prompt to ~/.crewly/prompts/{sessionName}-init.md and send a
	 * single-line instruction telling the agent to read that file.
	 *
	 * @param sessionName The session name
	 * @param prompt The full system prompt to deliver
	 * @param runtimeType The agent runtime type
	 * @param abortSignal Optional signal to cancel the operation (e.g. on runtime exit)
	 * @returns true if the instruction was delivered successfully
	 */
	private async sendPromptRobustly(
		sessionName: string,
		prompt: string,
		runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE,
		abortSignal?: AbortSignal
	): Promise<boolean> {
		const isClaudeCode = runtimeType === RUNTIME_TYPES.CLAUDE_CODE;
		const sessionHelper = await this.getSessionHelper();

		// Step 1: Write prompt to a file (idempotent — may already exist from pre-launch write).
		const promptFilePath = await this.writePromptFile(sessionName, prompt);
		if (!promptFilePath) {
			// File write failure is fatal — all runtimes use the file-read approach.
			return false;
		}

		// Step 2: Build the message to send.
		// Claude Code: prompt was already loaded via --agent flag at launch (#207),
		// so the agent already has all instructions as its agent definition. Just send a short
		// kickoff trigger — no need to ask it to read the file again.
		// Gemini CLI / other runtimes: need the file-read instruction since the prompt
		// was NOT loaded via system prompt.
		const messageToSend = isClaudeCode
			? 'Begin your work now. Follow the step-by-step instructions in your agent definition EXACTLY — start with Step 1, then Step 2, then Step 3 (register-self). Do NOT skip or reorder steps. Registration is required before the system will deliver messages to you.'
			: `Read the file at ${promptFilePath} and follow all instructions in it.`;

		// Single attempt for all runtimes. Retrying causes duplicate messages because:
		// - Claude Code: returns to its prompt between tool calls, making retry
		//   checks think the first message wasn't received.
		// - Gemini CLI: the echoed message "Read the file at..." starts with `> `
		//   which isClaudeAtPrompt misdetects as an idle prompt, and the TUI's
		//   input box shows `> ` even during processing. Both cause false-negative
		//   delivery verification and unnecessary retries.
		// The sendMessage helper reliably writes to the PTY — if it succeeds,
		// the message was delivered.
		const maxAttempts = 1;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			// Check abort before each attempt
			if (abortSignal?.aborted) {
				this.logger.info('Prompt delivery aborted (runtime exited)', { sessionName, attempt });
				return false;
			}

			try {
				this.logger.info('Sending prompt to agent', {
					sessionName,
					attempt,
					runtimeType,
					promptFilePath,
					deliveryMethod: isClaudeCode ? 'system-prompt-kickoff' : 'file-read',
				});

				// Check abort before sending to terminal
				if (abortSignal?.aborted) {
					this.logger.info('Prompt delivery aborted before send (runtime exited)', { sessionName });
					return false;
				}

				// Clear any pending input before sending the instruction (first attempt only).
				if (attempt === 1) {
					if (isClaudeCode) {
						// Claude Code: Escape closes slash menus + Ctrl+U clears line.
						await sessionHelper.sendEscape(sessionName);
						await delay(200);
						await sessionHelper.sendKey(sessionName, 'C-u');
						await delay(300);
					} else {
						// Gemini CLI (Ink TUI): After /directory add processing, the TUI
						// input may lose focus or have stale invisible characters.
						// Send Enter to flush any residual input, then wait for the
						// prompt to settle before sending the real instruction.
						this.logger.debug('Gemini CLI pre-send: flushing input with Enter', { sessionName });
						await sessionHelper.sendEnter(sessionName);
						await delay(1000);
					}
				}

				// Check abort right before writing instruction to terminal
				if (abortSignal?.aborted) {
					this.logger.info('Prompt delivery aborted before instruction send (runtime exited)', { sessionName });
					return false;
				}

				// Send the kickoff / file-read instruction
				await sessionHelper.sendMessage(sessionName, messageToSend);

				// Claude Code: rapid-check verification.
				// Check every 1s for up to 8s whether Claude started processing.
				// If Claude leaves the prompt at any point, the message was received.
				// This avoids the old length-comparison approach which was unreliable
				// (Claude's TUI redraws change output length unpredictably).
				if (isClaudeCode) {
					for (let i = 0; i < 8; i++) {
						await delay(1000);
						if (abortSignal?.aborted) return false;

						const currentOutput = sessionHelper.capturePane(sessionName);

						// Processing indicators (spinners) = definitive success
						if (containsSpinnerOrWorkingIndicator(currentOutput)) {
							this.logger.debug('Kickoff delivered — processing indicators detected', {
								sessionName, checkIndex: i,
							});
							return true;
						}

						// Claude left the prompt = started working on the message
						if (!this.isClaudeAtPrompt(currentOutput, RUNTIME_TYPES.CLAUDE_CODE)) {
							this.logger.debug('Kickoff delivered — Claude left prompt', {
								sessionName, checkIndex: i,
							});
							return true;
						}
					}

					// Claude still at prompt after 8s — message likely not received.
					// For Claude Code with --append-system-prompt-file, don't retry
					// (would cause duplicate). Log warning and return false.
					this.logger.warn('Kickoff delivery unconfirmed — Claude still at prompt after 8s (not retrying)', {
						sessionName, runtimeType,
					});
					return false;
				}

				// Gemini CLI / other runtimes: trust the PTY delivery.
				// sendMessage writes directly to the PTY — if it didn't throw,
				// the message was delivered. Terminal-based verification is unreliable
				// because Gemini's TUI always shows `> ` (even during processing)
				// and our echoed message starts with `> `, both causing false
				// "at prompt" detection.
				this.logger.info('Prompt instruction sent to PTY (trusting delivery)', {
					sessionName, attempt, runtimeType,
					messageLength: messageToSend.length,
				});
				return true;
			} catch (error) {
				this.logger.error('Error during prompt instruction delivery', {
					sessionName,
					attempt,
					runtimeType,
					error: error instanceof Error ? error.message : String(error),
				});

				if (attempt === maxAttempts) {
					return false;
				}
			}
		}

		this.logger.warn('Prompt instruction delivery unconfirmed after all attempts (agent may still process it)', {
			sessionName,
			maxAttempts,
			runtimeType,
		});
		return false;
	}
}
