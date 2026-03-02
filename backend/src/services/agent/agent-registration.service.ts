import * as path from 'path';
import * as os from 'os';
import { readFile, readdir, stat, mkdir, writeFile, access } from 'fs/promises';
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
} from '../../constants.js';
import { WEB_CONSTANTS } from '../../../../config/constants.js';
import { delay } from '../../utils/async.utils.js';
import { getSettingsService } from '../settings/settings.service.js';
import { SessionMemoryService } from '../memory/session-memory.service.js';
import { RuntimeExitMonitorService } from './runtime-exit-monitor.service.js';
import { ContextWindowMonitorService } from './context-window-monitor.service.js';
import { SubAgentMessageQueue } from '../messaging/sub-agent-message-queue.service.js';
import { AgentSuspendService } from './agent-suspend.service.js';
import { stripAnsiCodes } from '../../utils/terminal-output.utils.js';

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
	}>>();

	// Per-session delivery mutex to serialize message delivery.
	// Prevents concurrent sendMessageWithRetry calls to the same session,
	// which causes multiple Ctrl+C presses that can crash the runtime.
	private sessionDeliveryMutex = new Map<string, Promise<void>>();


	// Terminal patterns are now centralized in TERMINAL_PATTERNS constant
	// Keeping these as static getters for backwards compatibility within the class
	private static get CLAUDE_PROMPT_INDICATORS() {
		return TERMINAL_PATTERNS.PROMPT_CHARS;
	}

	private static get CLAUDE_PROMPT_STREAM_PATTERN() {
		return TERMINAL_PATTERNS.PROMPT_STREAM;
	}

	private static get CLAUDE_PROCESSING_INDICATORS() {
		return TERMINAL_PATTERNS.PROCESSING_INDICATORS;
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

		return RUNTIME_TYPES.CLAUDE_CODE;
	}

	/**
	 * Find the project root by looking for package.json
	 */
	private findProjectRoot(): string {
		// Simple fallback - could be improved to walk up directories
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
						this.logger.warn('Skill config not found in any known directory', { skillId });
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

		const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId);
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

		// Write prompt file before launching runtime so --append-system-prompt-file works
		let promptFilePath: string | undefined;
		if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
			try {
				const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId);
				promptFilePath = await this.writePromptFile(sessionName, prompt);
			} catch (promptError) {
				this.logger.warn('Failed to pre-write prompt file (non-fatal, will fall back to direct delivery)', {
					sessionName,
					error: promptError instanceof Error ? promptError.message : String(promptError),
				});
			}
		}

		// Reinitialize runtime using the appropriate initialization script (always fresh start)
		// runtimeService2: Fresh instance for runtime reinitialization after cleanup
		// New instance ensures clean state without cached detection results
		const runtimeService2 = this.createRuntimeService(runtimeType);
		await runtimeService2.executeRuntimeInitScript(sessionName, projectPath, effectiveFlags, promptFilePath);

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
			const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId);

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

		// Write prompt file before launching runtime so --append-system-prompt-file works
		let promptFilePath: string | undefined;
		if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
			try {
				const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId);
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
			await runtimeService.executeRuntimeInitScript(sessionName, process.cwd(), effectiveFlags, promptFilePath);

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
			await runtimeService.executeRuntimeInitScript(sessionName, projectPath, effectiveFlags, promptFilePath);

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
	 * Load registration prompt from config files (with caching to prevent file I/O contention)
	 */
	private async loadRegistrationPrompt(
		role: string,
		sessionName: string,
		memberId?: string
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

			// Look up project path for team members
			let projectPath = process.cwd();
			try {
				const teams = await this.storageService.getTeams();
				for (const team of teams) {
					const member = team.members?.find((m) => m.sessionName === sessionName);
					if (member && team.projectIds[0]) {
						const projects = await this.storageService.getProjects();
						const project = projects.find((p) => p.id === team.projectIds[0]);
						if (project?.path) {
							projectPath = project.path;
						}
						break;
					}
				}
			} catch {
				// Non-critical - use default project path
			}

			// Write .crewly/CLAUDE.md in the project directory so Claude Code
			// recognizes Crewly as a legitimate project configuration (fixes #33)
			if (role !== ORCHESTRATOR_ROLE) {
				try {
					const crewlyDir = path.join(projectPath, '.crewly');
					const claudeMdPath = path.join(crewlyDir, 'CLAUDE.md');
					await mkdir(crewlyDir, { recursive: true });
					const templatePath = path.join(this.projectRoot, 'config', 'templates', 'agent-claude-md.md');
					let claudeMdContent = this.promptCache.get(templatePath);
					if (!claudeMdContent) {
						claudeMdContent = await readFile(templatePath, 'utf8');
						this.promptCache.set(templatePath, claudeMdContent);
					}
					await writeFile(claudeMdPath, claudeMdContent, { flag: 'wx' }).catch(() => {
						// File already exists — no action needed
					});
				} catch (claudeMdError) {
					this.logger.warn('Could not provision .crewly/CLAUDE.md for agent trust (non-critical)', {
						templatePath: path.join(this.projectRoot, 'config', 'templates', 'agent-claude-md.md'),
						projectPath,
						error: claudeMdError instanceof Error ? claudeMdError.message : String(claudeMdError),
					});
				}
			}

			// Replace project path placeholder (must happen after project path lookup above)
			prompt = prompt.replace(/\{\{PROJECT_PATH\}\}/g, projectPath);

			// Replace agent skills path placeholder
			const agentSkillsPath = path.join(this.projectRoot, 'config', 'skills', 'agent');
			prompt = prompt.replace(/\{\{AGENT_SKILLS_PATH\}\}/g, agentSkillsPath);

			// Replace marketplace skills path placeholder
			const marketplaceSkillsPath = path.join(os.homedir(), '.crewly', 'marketplace', 'skills');
			prompt = prompt.replace(/\{\{MARKETPLACE_SKILLS_PATH\}\}/g, marketplaceSkillsPath);

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
bash ${skillsPath}/register-self/execute.sh '{"role":"${role}","sessionName":"${sessionName}"${memberIdJson}}'
\`\`\`
All it does is update a local status flag so the web UI shows you as online - nothing more.

After checking in, just say "Ready for tasks" and wait for me to send you work.`;
		}
	}

	/**
	 * Write the registration prompt to a file on disk.
	 * Returns the file path on success, or undefined on failure.
	 *
	 * @param sessionName - Session name (used for filename)
	 * @param prompt - The full prompt content
	 * @returns The absolute path to the written file, or undefined on error
	 */
	private async writePromptFile(
		sessionName: string,
		prompt: string
	): Promise<string | undefined> {
		const promptFilePath = this.getInitPromptFilePath(sessionName);
		const promptsDir = path.dirname(promptFilePath);

		try {
			await mkdir(promptsDir, { recursive: true });
			await writeFile(promptFilePath, prompt, 'utf8');
			this.logger.debug('Wrote init prompt to file', {
				sessionName,
				promptFilePath,
				promptLength: prompt.length,
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
	 * Build the unified init prompt path used by all runtimes.
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
				const prompt = await this.loadRegistrationPrompt(role, sessionName, memberId);
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

			// Pass Gemini API key to gemini-cli agents so they authenticate
			// with the paid API key instead of the free-tier Google login.
			if (runtimeType === RUNTIME_TYPES.GEMINI_CLI) {
				const geminiApiKey = process.env[ENV_CONSTANTS.GEMINI_API_KEY];
				if (geminiApiKey) {
					await sessionHelper.setEnvironmentVariable(
						sessionName,
						ENV_CONSTANTS.GEMINI_API_KEY,
						geminiApiKey
					);
				}
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

			// Stop context window monitoring before killing the session
			ContextWindowMonitorService.getInstance().stopSessionMonitoring(sessionName);

			// Get session helper once to avoid repeated async calls
			const sessionHelper = await this.getSessionHelper();
			const sessionExists = sessionHelper.sessionExists(sessionName);

			if (sessionExists) {
				// Kill the tmux session
				await sessionHelper.killSession(sessionName);
				this.logger.info('Session terminated successfully', { sessionName });
			} else {
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

			// Use robust message delivery with proper waiting mechanism
			const delivered = await this.sendMessageWithRetry(sessionName, message, 3, runtimeType);

			if (!delivered) {
				// Check if the agent is actively processing (busy) — the queue
				// processor can re-queue instead of permanently failing the message.
				const busyOutput = sessionHelper.capturePane(sessionName).slice(-2000);
				const isBusy = TERMINAL_PATTERNS.BUSY_STATUS_BAR.test(busyOutput) ||
					TERMINAL_PATTERNS.PROCESSING_WITH_TEXT.test(busyOutput);

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

		// Use runtime-specific pattern for stream detection to avoid false positives
		// (e.g. Gemini's `> ` pattern matching markdown blockquotes in Claude Code output)
		const streamPattern = this.getPromptPatternForRuntime(runtimeType);

		return new Promise<boolean>((resolve) => {
			let resolved = false;
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
				const output = sessionHelper.capturePane(sessionName);
				if (this.isClaudeAtPrompt(output, runtimeType)) {
					this.logger.debug('Agent at prompt (detected via polling)', { sessionName });
					cleanup();
					resolve(true);
				}
			}, pollInterval);

			// Deep scan with larger buffer every DEEP_SCAN_INTERVAL to catch prompts
			// that the fast poll misses (e.g. when prompt is beyond the default 200 lines)
			const deepScanId = setInterval(() => {
				if (resolved) return;
				const output = sessionHelper.capturePane(sessionName, EVENT_DELIVERY_CONSTANTS.DEEP_SCAN_LINES);
				if (this.isClaudeAtPrompt(output, runtimeType)) {
					this.logger.debug('Agent at prompt (detected via deep scan)', { sessionName });
					cleanup();
					resolve(true);
				}
			}, EVENT_DELIVERY_CONSTANTS.DEEP_SCAN_INTERVAL);

			// Also subscribe to terminal data for faster detection
			const unsubscribe = session.onData((data) => {
				if (resolved) return;
				// Strip ANSI escape sequences before testing — raw PTY data contains
				// cursor positioning, color codes, etc. that break regex matching (#106)
				const cleanData = stripAnsiCodes(data);
				if (streamPattern.test(cleanData)) {
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
	 * @deprecated Replaced by SessionCommandHelper.sendMessage() in sendMessageWithRetry.
	 * Complex event-driven state machine was fragile — Enter key often got lost.
	 * Kept as dead code for reference during transition.
	 */
	private async _deprecated_sendMessageEventDriven(
		sessionName: string,
		message: string,
		timeoutMs: number = EVENT_DELIVERY_CONSTANTS.TOTAL_DELIVERY_TIMEOUT
	): Promise<boolean> {
		const sessionHelper = await this.getSessionHelper();
		const session = sessionHelper.getSession(sessionName);

		if (!session) {
			this.logger.error('Session not found for event-driven delivery', { sessionName });
			return false;
		}

		return new Promise<boolean>((resolve) => {
			let buffer = '';
			let messageSent = false;
			let enterSent = false;
			let enterAccepted = false;
			let deliveryConfirmed = false;
			let resolved = false;

			// Track all timeouts to prevent memory leaks (P1.1 fix)
			const pendingTimeouts: NodeJS.Timeout[] = [];
			const scheduleTimeout = (fn: () => void | Promise<void>, delayMs: number): NodeJS.Timeout => {
				const id = setTimeout(fn, delayMs);
				pendingTimeouts.push(id);
				return id;
			};

			const cleanup = () => {
				// Immediately mark as resolved to prevent race conditions (P1.2 fix)
				const wasResolved = resolved;
				resolved = true;
				if (!wasResolved) {
					// Clear all pending timeouts to prevent memory leaks
					pendingTimeouts.forEach((id) => clearTimeout(id));
					clearTimeout(timeoutId);
					unsubscribe();
				}
			};

			// Use centralized patterns from TERMINAL_PATTERNS
			const PASTE_PATTERN = TERMINAL_PATTERNS.PASTE_INDICATOR;
			const PROCESSING_PATTERN = TERMINAL_PATTERNS.PROCESSING;

			// Use centralized timing from EVENT_DELIVERY_CONSTANTS
			const INITIAL_DELAY = EVENT_DELIVERY_CONSTANTS.INITIAL_MESSAGE_DELAY;
			const PASTE_CHECK_DELAY = EVENT_DELIVERY_CONSTANTS.PASTE_CHECK_DELAY;
			const ENTER_RETRY_DELAY = EVENT_DELIVERY_CONSTANTS.ENTER_RETRY_DELAY;
			const MAX_ENTER_RETRIES = EVENT_DELIVERY_CONSTANTS.MAX_ENTER_RETRIES;
			const MAX_BUFFER_SIZE = EVENT_DELIVERY_CONSTANTS.MAX_BUFFER_SIZE;

		// Helper to send the message when prompt is detected
			const sendMessageNow = () => {
				if (messageSent || resolved) return;

				this.logger.debug('Claude at prompt, sending message', {
					sessionName,
					messageLength: message.length,
					isMultiLine: message.includes('\n'),
				});

				// Send the message text
				session.write(message);
				messageSent = true;
				const isMultiLine = message.includes('\n');

				// Track Enter key state
				let enterAttempts = 0;
				let processingDetected = false;
				const bufferAtSend = buffer;

				// Function to send Enter and track attempts
				const sendEnterKey = (reason: string) => {
					if (resolved || processingDetected) return;
					enterAttempts++;
					session.write('\r');
					enterSent = true;
					this.logger.debug('Enter key sent', {
						sessionName,
						attempt: enterAttempts,
						reason,
					});
				};

				// Function to check if Enter was accepted (processing started)
				const checkProcessingStarted = (): boolean => {
					const newData = buffer.slice(bufferAtSend.length);
					return PROCESSING_PATTERN.test(newData);
				};

				// Function to check for paste indicator
				const checkPasteIndicator = (): boolean => {
					const newData = buffer.slice(bufferAtSend.length);
					return PASTE_PATTERN.test(newData);
				};

				// Strategy: Send Enter with progressive timing, retry if not accepted
				const attemptEnter = (attemptNum: number) => {
					if (resolved || processingDetected) return;

					// Check if processing already started
					if (checkProcessingStarted()) {
						processingDetected = true;
						enterAccepted = true;
						this.logger.debug('Processing detected, message accepted', { sessionName, attemptNum });
						buffer = ''; // Reset for processing indicator detection
						return;
					}

					if (attemptNum > MAX_ENTER_RETRIES) {
						this.logger.warn('Max Enter retries reached, verifying message acceptance', { sessionName });
						scheduleTimeout(async () => {
							if (resolved) return;
							const stuck = await this.isMessageStuckAtPrompt(sessionName, message);
							if (stuck) {
								this.logger.warn('Message stuck at prompt after all Enter retries', { sessionName });
								const stuckHelper = await this.getSessionHelper();
								await stuckHelper.clearCurrentCommandLine(sessionName);
								enterAccepted = false;
							} else {
								this.logger.debug('Message appears accepted (no longer at prompt)', { sessionName });
								enterAccepted = true;
								buffer = '';
							}
						}, EVENT_DELIVERY_CONSTANTS.POST_ENTER_VERIFICATION_DELAY);
						return;
					}

					sendEnterKey(attemptNum === 1 ? 'initial' : `retry-${attemptNum}`);

					// Schedule check and possible retry (using tracked timeout to prevent leaks)
					scheduleTimeout(() => {
						if (resolved) return;

						if (checkProcessingStarted()) {
							processingDetected = true;
							enterAccepted = true;
							this.logger.debug('Processing detected after Enter', { sessionName, attemptNum });
							buffer = '';
						} else {
							// Not accepted yet, retry
							this.logger.debug('Enter may not have been accepted, retrying', {
								sessionName,
								attemptNum,
								bufferLength: buffer.length,
							});
							attemptEnter(attemptNum + 1);
						}
					}, ENTER_RETRY_DELAY);
				};

				// For multi-line messages, wait longer for paste indicator
				// For single-line messages, send Enter sooner
				const initialWait = isMultiLine ? PASTE_CHECK_DELAY : INITIAL_DELAY;

				scheduleTimeout(() => {
					if (resolved) return;

					// For multi-line: check if paste indicator appeared
					if (isMultiLine && checkPasteIndicator()) {
						this.logger.debug('Paste indicator detected', { sessionName });
					}

					// Start Enter key attempts
					attemptEnter(1);
				}, initialWait);
			};

			const timeoutId = setTimeout(async () => {
				this.logger.debug('Event-driven delivery timed out', {
					sessionName,
					messageSent,
					enterSent,
					enterAccepted,
					deliveryConfirmed,
					bufferLength: buffer.length,
				});

				// If Enter was sent but not confirmed accepted, verify via terminal capture
				if (enterSent && !enterAccepted && !deliveryConfirmed) {
					const timeoutHelper = await this.getSessionHelper();
					const stuck = await this.isMessageStuckAtPrompt(sessionName, message);
					if (stuck) {
						this.logger.warn('Timeout: message stuck at prompt, clearing and failing', { sessionName });
						await timeoutHelper.clearCurrentCommandLine(sessionName);
						cleanup();
						resolve(false);
						return;
					}
					this.logger.debug('Timeout: message not at prompt, treating as accepted', { sessionName });
				}

				cleanup();
				resolve(enterAccepted || deliveryConfirmed);
			}, timeoutMs);

			// IMPORTANT: Check current terminal state, but wait for output to settle first.
			// If the orchestrator just finished outputting (greeting, notification, status bar),
			// the prompt may not be cleanly detectable. We capture the pane, wait briefly,
			// and re-capture. If output is still changing, wait again before checking prompt.
			// Use 50 lines to account for status bars and notifications that can
			// wrap across many lines and push the prompt out of a smaller window.
			const waitForSettled = async () => {
				let prevOutput = sessionHelper.capturePane(sessionName);
				for (let i = 0; i < 5; i++) { // Max 5 checks, 500ms apart = 2.5s max
					if (resolved) return;
					await delay(500);
					if (resolved) return;
					const currentOutput = sessionHelper.capturePane(sessionName);
					if (currentOutput === prevOutput) {
						// Output settled
						if (this.isClaudeAtPrompt(currentOutput)) {
							this.logger.debug('Claude at prompt after output settled', { sessionName, settleChecks: i + 1 });
							sendMessageNow();
						}
						return;
					}
					prevOutput = currentOutput;
				}
				// Output still changing after 2.5s - check anyway
				if (!resolved && this.isClaudeAtPrompt(prevOutput)) {
					this.logger.debug('Claude at prompt (output still changing, checking anyway)', { sessionName });
					sendMessageNow();
				}
			};
			waitForSettled();

			const unsubscribe = session.onData((data) => {
				if (resolved) return;

				// Accumulate data with size limit to prevent memory exhaustion (P2.3 fix)
				buffer += data;
				if (buffer.length > MAX_BUFFER_SIZE) {
					buffer = buffer.slice(-MAX_BUFFER_SIZE);
				}

				// Phase 1: Wait for Claude to be at prompt before sending
				if (!messageSent) {
					const isAtPrompt = AgentRegistrationService.CLAUDE_PROMPT_STREAM_PATTERN.test(buffer);

					if (isAtPrompt) {
						sendMessageNow();
					}
					return;
				}

				// Phase 2: Only check for processing indicators AFTER Enter has been sent
				if (!enterSent) {
					return; // Wait for Enter to be sent
				}

				// Look for processing indicators confirming delivery
				const hasProcessingIndicator =
					AgentRegistrationService.CLAUDE_PROCESSING_INDICATORS.some((pattern) =>
						pattern.test(buffer)
					);

				// Also check if prompt disappeared (Claude is working)
				const promptStillVisible =
					AgentRegistrationService.CLAUDE_PROMPT_STREAM_PATTERN.test(buffer);

				// Use constant for minimum buffer check (P3.2 fix)
				if (hasProcessingIndicator || (!promptStillVisible && buffer.length > EVENT_DELIVERY_CONSTANTS.MIN_BUFFER_FOR_PROCESSING_DETECTION)) {
					this.logger.debug('Message delivery confirmed (event-driven)', {
						sessionName,
						hasProcessingIndicator,
						promptStillVisible,
						bufferLength: buffer.length,
					});
					deliveryConfirmed = true;
					cleanup();
					resolve(true);
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
				if (!this.isClaudeAtPrompt(output, runtimeType)) {
					if (attempt === maxAttempts) {
						// On the final attempt, check if the agent is DEFINITELY busy
						// before force-delivering. If we see "esc to interrupt" or
						// processing indicators, the agent is actively working and
						// force-delivery risks corrupting its current task.
						const tailForBusyCheck = output.slice(-2000);
						const isBusy = TERMINAL_PATTERNS.BUSY_STATUS_BAR.test(tailForBusyCheck) ||
							TERMINAL_PATTERNS.PROCESSING_WITH_TEXT.test(tailForBusyCheck);

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
						await sessionHelper.sendCtrlC(sessionName);
						await delay(300);
					}
				} else {
					// Detect recent /compress — Ink TUI loses internal focus after
					// /compress re-renders, causing subsequent messages to be silently
					// dropped even though the prompt `>` is visible (#114).
					// Always force PTY resize on attempt 1 if /compress detected.
					const recentOutput = sessionHelper.capturePane(sessionName, 40);
					const compressDetected = recentOutput.includes('/compress') ||
						recentOutput.includes('Context compressed') ||
						recentOutput.includes('Compressing context');
					const needsResize = attempt > 1 || compressDetected;

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

					// Send Tab to cycle Ink focus. In Ink v6, Tab triggers
					// focusNext() in FocusContext, which moves focus to the next
					// focusable component (InputPrompt). This works even when the
					// input is defocused because the Tab handler runs at the Ink
					// framework level, not the component level.
					await sessionHelper.sendKey(sessionName, 'Tab');
					await delay(300);

					// Then Enter to dismiss any notification overlay and ensure
					// the input is engaged. Enter on an empty `> ` prompt is a
					// safe no-op (just shows a new blank prompt line).
					await sessionHelper.sendEnter(sessionName);
					// Extra settling time after /compress to let Ink TUI stabilize
					await delay(compressDetected ? 1000 : 500);
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
						if (TERMINAL_PATTERNS.PROCESSING.test(currentOutput)) {
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
								this.logger.warn('At prompt with message text at bottom — pressing Enter', {
									sessionName,
									attempt,
									intervalMs,
								});
								await sessionHelper.sendEnter(sessionName);
								await delay(500);
								await sessionHelper.sendEnter(sessionName); // backup

								await delay(SESSION_COMMAND_DELAYS.MESSAGE_PROCESSING_DELAY);

								// Verify recovery
								const postEnterOutput = sessionHelper.capturePane(sessionName);
								if (TERMINAL_PATTERNS.PROCESSING.test(postEnterOutput) ||
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
							// press Enter immediately to submit the already-pasted text.
							this.logger.warn('Message text stuck at bottom — pressing Enter to recover', {
								sessionName,
								attempt,
								intervalMs,
							});
							await sessionHelper.sendEnter(sessionName);
							await delay(500);
							await sessionHelper.sendEnter(sessionName); // backup Enter

							// Give the agent a moment to start processing after Enter
							await delay(SESSION_COMMAND_DELAYS.MESSAGE_PROCESSING_DELAY);

							// Verify recovery: check if processing started
							const recoveryOutput = sessionHelper.capturePane(sessionName);
							if (TERMINAL_PATTERNS.PROCESSING.test(recoveryOutput)) {
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
					if (claudeDelivered) {
						return true;
					}
				} else {
					// --- Phase 1: Direct stuck-at-prompt detection ---
					// Check if our message text is literally sitting on the `> ` prompt
					// line. This is the definitive signal that Enter was not pressed or
					// was silently consumed by the TUI. Unlike output-change detection,
					// this has no false positives from TUI redraws or historical text.
					const stuckAtPrompt = this.isTextStuckAtTuiPrompt(sessionName, message);
					if (stuckAtPrompt) {
						// Attempt immediate recovery: press Enter to submit the text
						const recovered = await this.recoverStuckTuiMessage(sessionName, message);
						if (recovered) {
							this.logger.info('Message recovered via Enter re-press', {
								sessionName,
								attempt,
							});
							return true;
						}
						// Still stuck after recovery — fall through to retry with cleanup
						this.logger.warn('Message still stuck after Enter recovery, will retry', {
							sessionName,
							attempt,
						});
						// Skip the output-change check — we know it's stuck
					} else {
						// --- Phase 2: Output-change detection ---
						// Text is NOT on the prompt line. Either it was delivered (Enter
						// worked) or it was never written (TUI was defocused and the Ink
						// framework consumed the text silently). Compare output snapshots.
						const afterOutput = sessionHelper.capturePane(sessionName, 20);
						const lengthDiff = afterOutput.length - beforeLength;
						const contentChanged = beforeOutput !== afterOutput;

						// CRITICAL: Only check for processing indicators in NEW content
						// (the diff between before and after). Checking the full afterOutput
						// causes false positives because words like "generating", "searching"
						// commonly appear in the agent's previous response text visible in
						// the 20-line capture.
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

						const hasProcessingIndicators = TERMINAL_PATTERNS.PROCESSING_WITH_TEXT.test(
							newContent || afterOutput.slice(-500)
						);
						const hasGeminiIndicators = newContent.length > 0
							&& /reading|thinking|processing|analyzing|generating|searching/i.test(newContent);

						const significantLengthChange = Math.abs(lengthDiff) > 10;
						// For Gemini CLI, contentChanged alone is sufficient evidence of
						// delivery. The TUI redraws minimally (lengthDiff can be as low as
						// 1-2 chars) when processing starts, so requiring significantLengthChange
						// causes false "stuck" detection. False "stuck" + Ctrl+C kills the CLI.
						const isGemini = runtimeType === RUNTIME_TYPES.GEMINI_CLI;
						const delivered = (lengthDiff > 20)
							|| (contentChanged && significantLengthChange)
							|| (contentChanged && isGemini)
							|| hasProcessingIndicators
							|| hasGeminiIndicators;

						if (delivered) {
							// Log at warn level when verification passed on weak signals
							// (output length change only, no explicit processing indicators)
							// so future false positives are traceable in logs.
							const hasStrongSignal = hasProcessingIndicators || hasGeminiIndicators;
							const logLevel = hasStrongSignal ? 'debug' : 'warn';
							this.logger[logLevel](`Message delivery verified (${hasStrongSignal ? 'strong' : 'weak'} signal)`, {
								sessionName,
								attempt,
								lengthDiff,
								contentChanged,
								hasProcessingIndicators,
								hasGeminiIndicators,
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
							hasGeminiIndicators,
							newContentLength: newContent.length,
						});
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

		// Verification failed, but the message was physically written to the PTY.
		// If the session is still alive, the agent will likely process it — return
		// true to avoid false "Failed to deliver" errors shown to users (#99).
		const backend = getSessionBackendSync();
		const childAlive = backend?.isChildProcessAlive?.(sessionName);
		if (childAlive !== false) {
			this.logger.warn('Message delivery verification inconclusive but session alive — assuming success', {
				sessionName,
				maxAttempts,
				messageLength: message.length,
			});
			return true;
		}

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
			const chatPrefixMatch = message.match(/^\[CHAT:[^\]]+\]\s*/);
			const contentAfterPrefix = chatPrefixMatch
				? message.slice(chatPrefixMatch[0].length)
				: message;
			const searchToken = contentAfterPrefix.slice(0, 40).trim();

			// Also use [CHAT: as a secondary token if message has a CHAT prefix
			const chatToken = chatPrefixMatch ? '[CHAT:' : null;

			// Check last 20 non-empty lines for either token.
			// Gemini CLI TUI has status bars at the bottom (branch, sandbox, model info)
			// that push input content further up. 5 lines was insufficient.
			const lines = output.split('\n').filter((line) => line.trim().length > 0);
			const linesToCheck = lines.slice(-20);

			const isStuck = linesToCheck.some((line) => {
				// Strip TUI box-drawing borders before checking (Gemini CLI wraps content in │...│)
				const stripped = line.replace(/^[│┃║|\s]+/, '').replace(/[│┃║|\s]+$/, '');
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
			const chatPrefixMatch = message.match(/^\[CHAT:[^\]]+\]\s*/);
			const contentAfterPrefix = chatPrefixMatch
				? message.slice(chatPrefixMatch[0].length)
				: message;
			const searchToken = contentAfterPrefix.slice(0, 30).trim();

			if (!searchToken) return false;

			// Find lines that look like a TUI prompt with text after it.
			// Gemini CLI TUI wraps content in box-drawing borders: │ > text │
			// Or without borders: > text
			// The prompt line is the line with `> ` followed by actual content.
			const lines = output.split('\n');
			const promptLineRegex = /^[│┃║|\s]*>\s+(.+)/;

			for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
				const line = lines[i];
				const match = line.match(promptLineRegex);
				if (match) {
					const promptContent = match[1].replace(/[│┃║|\s]+$/, '').trim();
					// Check if the prompt line content contains our message text
					if (promptContent.length > 5 && promptContent.includes(searchToken)) {
						this.logger.warn('Text stuck at TUI prompt — Enter was not pressed', {
							sessionName,
							searchToken: searchToken.slice(0, 20),
							promptContent: promptContent.slice(0, 60),
						});
						return true;
					}
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

		// Press Enter to submit the stuck text
		this.logger.info('Pressing Enter to recover stuck TUI message', { sessionName });
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
				if (TERMINAL_PATTERNS.REWIND_MODE.test(output)) {
					this.logger.warn('Rewind mode detected, sending q to exit', { sessionName });
					sessionHelper.writeRaw(sessionName, 'q');
					await delay(500);
				}
			} catch {
				// Non-fatal: session may have been destroyed
			}
		}

		// --- Part 1: Existing TUI prompt-line scanning (unchanged) ---
		for (const [sessionName] of this.tuiSessionRegistry) {
			try {
				// Skip sessions that no longer exist
				if (!sessionHelper.sessionExists(sessionName)) {
					this.tuiSessionRegistry.delete(sessionName);
					continue;
				}

				const output = sessionHelper.capturePane(sessionName);
				if (!output || output.trim().length === 0) continue;

				// Look for any text sitting on the prompt line
				const lines = output.split('\n');
				const promptLineRegex = /^[│┃║|\s]*>\s+(.+)/;

				for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
					const match = lines[i].match(promptLineRegex);
					if (match) {
						const promptContent = match[1].replace(/[│┃║|\s]+$/, '').trim();
						// Only act on substantial text (> 10 chars) to avoid false positives
						// from TUI rendering artifacts or short status text
						if (promptContent.length > 10) {
							// Skip known Gemini CLI idle placeholder text that sits at
							// the `> ` prompt when no user input is present. These are
							// NOT stuck messages — they are TUI decoration.
							const isPlaceholder =
								/^Type your message/i.test(promptContent) ||
								/^@[\w/.]+/.test(promptContent);  // e.g., "@path/to/file"
							if (isPlaceholder) {
								break;
							}

							this.logger.warn('Background scan: text stuck at TUI prompt, pressing Enter', {
								sessionName,
								promptContent: promptContent.slice(0, 80),
							});

							// Press Enter to submit the stuck text
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

		// --- Part 2: Tracked-message scanning (all runtimes) ---
		const now = Date.now();
		const MIN_AGE_MS = 15000; // Only check messages older than 15s

		for (const [sessionName, entries] of this.sentMessageTracker) {
			if (!sessionHelper.sessionExists(sessionName)) {
				this.sentMessageTracker.delete(sessionName);
				continue;
			}

			try {
				const output = sessionHelper.capturePane(sessionName);
				if (!output || output.trim().length === 0) continue;
				const bottomText = output.split('\n').slice(-15).join(' ').replace(/\s+/g, ' ');

				for (const entry of entries) {
					if (entry.recovered) continue;
					if (now - entry.sentAt < MIN_AGE_MS) continue;

					if (bottomText.includes(entry.snippet)) {
						this.logger.warn('Background scan: tracked message stuck, pressing Enter', {
							sessionName,
							snippet: entry.snippet.slice(0, 50),
							ageMs: now - entry.sentAt,
						});

						await sessionHelper.sendEnter(sessionName);
						await delay(500);
						await sessionHelper.sendEnter(sessionName); // backup
						entry.recovered = true;
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
		const prefixMatch = message.match(/^\[CHAT:[^\]]+\]\s*/);
		const contentStart = prefixMatch ? prefixMatch[0].length : 0;
		// Normalize whitespace: messages may contain \n from enhanced templates.
		// Terminal bottom text is join(' '), so \n in snippet would never match.
		const snippet = message.slice(contentStart, contentStart + 80).replace(/\s+/g, ' ').trim();
		if (snippet.length < 10) return; // Too short to reliably match

		const entries = this.sentMessageTracker.get(sessionName) || [];
		entries.push({ snippet, sentAt: Date.now(), recovered: false });

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
	 * Get the runtime-specific prompt regex pattern.
	 * Avoids false positives by using narrow patterns when runtime is known.
	 *
	 * @param runtimeType - The runtime type (claude-code, gemini-cli, etc.)
	 * @returns The appropriate prompt detection regex
	 */
	private getPromptPatternForRuntime(runtimeType?: RuntimeType): RegExp {
		if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) return TERMINAL_PATTERNS.CLAUDE_CODE_PROMPT;
		if (runtimeType === RUNTIME_TYPES.GEMINI_CLI) return TERMINAL_PATTERNS.GEMINI_CLI_PROMPT;
		if (runtimeType === RUNTIME_TYPES.CODEX_CLI) return TERMINAL_PATTERNS.CODEX_CLI_PROMPT;
		return TERMINAL_PATTERNS.PROMPT_STREAM;
	}

	/**
	 * Check if the agent appears to be at an input prompt.
	 * Looks for prompt indicators (❯, ⏵, $, ❯❯, ⏵⏵) in terminal output.
	 * Also checks for busy indicators (esc to interrupt, spinners, ⏺)
	 * to avoid false negatives when the agent is processing.
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

		const isGemini = runtimeType === RUNTIME_TYPES.GEMINI_CLI;
		const isClaudeCode = runtimeType === RUNTIME_TYPES.CLAUDE_CODE;
		const isCodex = runtimeType === RUNTIME_TYPES.CODEX_CLI;
		const streamPattern = this.getPromptPatternForRuntime(runtimeType);

		// Check for prompt FIRST. Processing indicators like "thinking" or "analyzing"
		// can appear in the agent's previous response text and persist in the terminal
		// scroll buffer, causing false negatives if checked before the prompt.
		if (streamPattern.test(tailSection)) {
			return true;
		}

		// Fallback: check last several lines for prompt indicators.
		// The prompt may not be on the very last line due to status bars,
		// notifications, or terminal wrapping below the prompt.
		const lines = tailSection.split('\n').filter((line) => line.trim().length > 0);
		const linesToCheck = lines.slice(-10);

		const hasPrompt = linesToCheck.some((line) => {
			const trimmed = line.trim();
			// Strip TUI box-drawing borders that Gemini CLI and other TUI frameworks
			// wrap around prompts. Covers full Unicode box-drawing range (#106).
			const stripped = trimmed
				.replace(/^[\u2500-\u257F|+\-═║╭╮╰╯]+\s*/, '')
				.replace(/\s*[\u2500-\u257F|+\-═║╭╮╰╯]+$/, '');

			// Claude Code prompts: ❯, ⏵, $ alone on a line
			if (!isGemini && !isCodex) {
				if (['❯', '⏵', '$'].some(ch => trimmed === ch || stripped === ch)) {
					return true;
				}
				// ❯❯ = bypass permissions prompt (idle).
				// Matches "❯❯", "❯❯ ", and "❯❯ bypass permissions on (shift+tab to cycle)".
				// Note: ⏵⏵ appears in the status bar but is visible both when idle AND
				// busy, so it cannot be used as a reliable prompt indicator.
				if (trimmed.startsWith('❯❯')) {
					return true;
				}
			}

			// Gemini CLI prompts: > or ! followed by space
			if (!isClaudeCode) {
				if (isCodex) {
					// Codex prompt uses `›`; avoid plain `> ` to prevent false-positives
					// from markdown blockquotes in agent output.
					if (trimmed.startsWith('› ') || stripped.startsWith('› ')) {
						return true;
					}
				} else if (
					trimmed.startsWith('> ') || trimmed.startsWith('! ') ||
					stripped.startsWith('> ') || stripped.startsWith('! ')
				) {
					return true;
				}
			}

			return false;
		});

		if (hasPrompt) {
			return true;
		}

		// No prompt found — check if still processing.
		// Check last 10 lines (not just 5) because tool output can push processing
		// indicators further up while the status bar stays at the bottom.
		const recentLines = linesToCheck.join('\n');
		if (TERMINAL_PATTERNS.PROCESSING_WITH_TEXT.test(recentLines)) {
			this.logger.debug('Processing indicators present near bottom of output');
			return false;
		}

		// Check for "esc to interrupt" in the status bar — this is a definitive
		// busy signal. Claude Code only shows this text while actively processing.
		// It disappears when the agent returns to idle at the prompt.
		if (TERMINAL_PATTERNS.BUSY_STATUS_BAR.test(recentLines)) {
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
		// Claude Code: prompt was already loaded via --append-system-prompt-file at launch,
		// so the agent already has all instructions as a system prompt. Just send a short
		// kickoff trigger — no need to ask it to read the file again.
		// Gemini CLI / other runtimes: need the file-read instruction since the prompt
		// was NOT loaded via system prompt.
		const messageToSend = isClaudeCode
			? 'Begin your work now. Follow the instructions you were given and start by doing an initial assessment of the project.'
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
						if (TERMINAL_PATTERNS.PROCESSING.test(currentOutput)) {
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
