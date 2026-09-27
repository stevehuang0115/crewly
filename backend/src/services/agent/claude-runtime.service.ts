import * as path from 'path';
import { spawn } from 'child_process';
import { RuntimeAgentService, type McpConfigResult } from './runtime-agent.service.abstract.js';
import { SessionCommandHelper } from '../session/index.js';
import { RUNTIME_TYPES, CLAUDE_FATAL_PATTERNS, CLAUDE_STARTUP_CONSTANTS, RUNTIME_INPUT_READY_PATTERNS, type RuntimeType } from '../../constants.js';
import { RuntimeStartupBlockedError, detectRuntimeCliMissing } from './runtime-startup-blocked.error.js';
import { delay } from '../../utils/async.utils.js';

/**
 * Claude Code specific runtime service implementation.
 * Handles Claude Code CLI initialization, detection, and interaction patterns.
 */
export class ClaudeRuntimeService extends RuntimeAgentService {
	constructor(sessionHelper: SessionCommandHelper, projectRoot: string) {
		super(sessionHelper, projectRoot);
	}

	protected getRuntimeType(): RuntimeType {
		return RUNTIME_TYPES.CLAUDE_CODE;
	}

	/**
	 * Claude Code specific detection using slash command
	 */
	protected async detectRuntimeSpecific(sessionName: string): Promise<boolean> {
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// First to clear the current command
		await this.sessionHelper.clearCurrentCommandLine(sessionName);

		// Capture the output before checking
		const beforeOutput = this.sessionHelper.capturePane(sessionName, 20);
		// Send the '/' key to detect changes
		await this.sessionHelper.sendKey(sessionName, '/');
		await new Promise((resolve) => setTimeout(resolve, 2000));
		// Capture the output after sending '/'
		const afterOutput = this.sessionHelper.capturePane(sessionName, 20);

		// Exit the slash command palette without issuing another Ctrl+C so we
		// don't send consecutive interrupts that can terminate the CLI.
		await this.sessionHelper.sendEscape(sessionName);
		await delay(200);
		await this.sessionHelper.sendKey(sessionName, 'C-u');

		const hasOutputChange = afterOutput.length - beforeOutput.length > 5;

		this.logger.debug('Claude detection completed', {
			sessionName,
			hasOutputChange,
			beforeLength: beforeOutput.length,
			afterLength: afterOutput.length,
		});
		return hasOutputChange;
	}

	/**
	 * Fail fast when Crewly runs as root: Claude Code refuses
	 * --dangerously-skip-permissions under root/sudo, which Crewly always
	 * passes, so the agent would never launch and start-up would hang until
	 * every timeout expired. IS_SANDBOX=1 is Claude's own "sandboxed" switch
	 * that allows the flag as root (containers), so root is fine then.
	 *
	 * @throws RuntimeStartupBlockedError (reason `root_user`) when running as root
	 */
	assertCanLaunch(): void {
		const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
		const sandboxed = process.env[CLAUDE_STARTUP_CONSTANTS.SANDBOX_ENV] === '1';
		if (uid === 0 && !sandboxed) {
			throw new RuntimeStartupBlockedError('root_user', CLAUDE_STARTUP_CONSTANTS.MESSAGES.ROOT);
		}
	}

	/**
	 * Refuse to launch Claude Code in a state it cannot start from (root), then
	 * run the normal initialization script.
	 *
	 * @throws RuntimeStartupBlockedError when running as root without IS_SANDBOX=1
	 */
	async executeRuntimeInitScript(
		sessionName: string,
		targetPath?: string,
		runtimeFlags?: string[],
		promptFilePath?: string,
		agentName?: string,
		resumeSessionId?: string
	): Promise<void> {
		this.assertCanLaunch();
		return super.executeRuntimeInitScript(sessionName, targetPath, runtimeFlags, promptFilePath, agentName, resumeSessionId);
	}

	/**
	 * Classify terminal output that means Claude Code cannot become ready
	 * without the user: the root refusal, the first-run theme picker, or a
	 * shell that cannot find `claude`.
	 *
	 * @param output - Terminal output text
	 * @returns The blocking error to throw, or null
	 */
	private detectStartupBlocked(output: string): RuntimeStartupBlockedError | null {
		if (output.includes(CLAUDE_STARTUP_CONSTANTS.ROOT_REFUSAL_MARKER)) {
			return new RuntimeStartupBlockedError('root_user', CLAUDE_STARTUP_CONSTANTS.MESSAGES.ROOT);
		}
		if (CLAUDE_STARTUP_CONSTANTS.FIRST_RUN_MARKERS.some((m) => output.includes(m))) {
			return new RuntimeStartupBlockedError('first_run_setup', CLAUDE_STARTUP_CONSTANTS.MESSAGES.FIRST_RUN);
		}
		// `bash: claude: command not found` (B8 D1): the orchestrator defaulted to
		// Claude on a machine that only has Gemini and waited out every timeout.
		return detectRuntimeCliMissing(output, this.getRuntimeType());
	}

	/**
	 * Detect the Claude Code workspace trust prompt in terminal output.
	 *
	 * Claude Code shows "Is this a project you trust?" on first launch
	 * for untrusted workspaces. This blocks agent initialization.
	 *
	 * @param output - Terminal output text
	 * @returns True if trust prompt is detected
	 * @see https://github.com/stevehuang0115/crewly/issues/144
	 */
	private isClaudeTrustPrompt(output: string): boolean {
		const trustPatterns = [
			'Do you trust the files',
			'Is this a project you trust',
			'Yes, proceed',
			'Trust this folder',
			'trust this project',
		];
		return trustPatterns.some(p => output.includes(p));
	}

	/**
	 * Override waitForRuntimeReady to auto-accept workspace trust prompt (#144).
	 *
	 * Claude Code shows an interactive trust gate on first launch for
	 * untrusted workspaces. Without auto-acceptance, the agent hangs
	 * and enters a crash-restart loop.
	 *
	 * States the user must resolve (root refusal, first-run theme picker) are
	 * detected before the ready patterns and fail fast.
	 *
	 * @throws RuntimeStartupBlockedError when start-up is blocked on the user
	 */
	async waitForRuntimeReady(
		sessionName: string,
		timeout: number,
		checkInterval: number = 2000
	): Promise<boolean> {
		const startTime = Date.now();
		let trustPromptAttempts = 0;

		this.logger.info('Waiting for Claude Code to be ready (with trust prompt detection)', {
			sessionName,
			timeout,
			checkInterval,
		});

		while (Date.now() - startTime < timeout) {
			try {
				const output = this.sessionHelper.capturePane(sessionName);

				// Root refusal / first-run setup: nothing can resolve these by
				// waiting, so fail fast with an actionable error.
				const blocked = this.detectStartupBlocked(output);
				if (blocked) {
					this.logger.error('Claude Code start-up blocked on the user', {
						sessionName,
						reason: blocked.reason,
						totalElapsed: Date.now() - startTime,
					});
					throw blocked;
				}

				// #144: Auto-accept workspace trust prompt
				if (this.isClaudeTrustPrompt(output)) {
					trustPromptAttempts++;
					this.logger.info('Claude Code trust prompt detected, auto-accepting', {
						sessionName,
						attempt: trustPromptAttempts,
					});
					await this.sessionHelper.sendEnter(sessionName);
					await delay(1000);
					continue;
				}

				const readyPatterns = this.getRuntimeReadyPatterns();
				const hasReadySignal = readyPatterns.some(p => output.includes(p));
				if (hasReadySignal) {
					this.logger.info('Claude Code ready', {
						sessionName,
						totalElapsed: Date.now() - startTime,
						trustPromptAttempts,
					});
					return true;
				}

				const errorPatterns = this.getRuntimeErrorPatterns();
				const hasError = errorPatterns.some(p => output.includes(p));
				if (hasError) {
					this.logger.error('Claude Code error during startup', {
						sessionName,
						totalElapsed: Date.now() - startTime,
					});
					return false;
				}
			} catch (error) {
				if (error instanceof RuntimeStartupBlockedError) throw error;
				this.logger.warn('Error checking Claude Code ready state', {
					sessionName,
					error: String(error),
				});
			}

			await delay(checkInterval);
		}

		this.logger.warn('Timeout waiting for Claude Code', { sessionName, timeout });
		return false;
	}

	/**
	 * Claude Code specific ready patterns
	 */
	protected getRuntimeReadyPatterns(): string[] {
		return [
			'Welcome to Claude Code!',
			'claude-code>',
			'Ready to assist',
			'How can I help',
			'/help for help',
			'cwd:',
			'bypass permissions on',
			'✻ Welcome to Claude',
		];
	}

	/**
	 * Claude Code's sign-in screen shows a prompt-like box, so the login
	 * instructions veto readiness until the user has authenticated.
	 *
	 * @returns Claude Code-specific "not ready" markers
	 */
	protected getNotReadyMarkers(): readonly string[] {
		return RUNTIME_INPUT_READY_PATTERNS.CLAUDE_CODE.NOT_READY_MARKERS;
	}

	/**
	 * Claude Code specific exit patterns for runtime exit detection.
	 *
	 * Includes both clean exit patterns (e.g. "Claude Code exited") and
	 * fatal error patterns that indicate the CLI is stuck in an unrecoverable
	 * state (e.g. thinking block corruption).
	 *
	 * @returns Array of RegExp patterns that match runtime exit or fatal output
	 */
	protected getRuntimeExitPatterns(): RegExp[] {
		return [
			// Clean exit patterns
			/Claude\s+(Code\s+)?exited/i,
			/Session\s+ended/i,
			// Fatal error patterns — CLI is running but permanently broken
			...CLAUDE_FATAL_PATTERNS,
		];
	}

	/**
	 * Claude Code specific error patterns
	 */
	protected getRuntimeErrorPatterns(): string[] {
		const commonErrors = ['Permission denied', 'No such file or directory'];
		return [...commonErrors, 'command not found: claude'];
	}

	/**
	 * Check if Claude Code CLI is installed on the system
	 */
	async checkClaudeInstallation(): Promise<{
		installed: boolean;
		version?: string;
		message: string;
	}> {
		try {
			return new Promise((resolve) => {
				const whichProcess = spawn('which', ['claude']);
				let stdout = '';
				let stderr = '';

				whichProcess.stdout.on('data', (data) => {
					stdout += data.toString();
				});

				whichProcess.stderr.on('data', (data) => {
					stderr += data.toString();
				});

				whichProcess.on('close', (code) => {
					if (code === 0 && stdout.trim()) {
						// Claude CLI found, try to get version
						const versionProcess = spawn('claude', ['--version']);
						let versionOutput = '';

						versionProcess.stdout.on('data', (data) => {
							versionOutput += data.toString();
						});

						versionProcess.on('close', (versionCode) => {
							resolve({
								installed: true,
								version: versionCode === 0 ? versionOutput.trim() : 'unknown',
								message: 'Claude Code CLI is available',
							});
						});

						// Timeout for version check
						setTimeout(() => {
							versionProcess.kill();
							resolve({
								installed: true,
								message: 'Claude Code CLI found but version check timed out',
							});
						}, 5000);
					} else {
						resolve({
							installed: false,
							message:
								'Claude Code CLI not found. Please install Claude Code to enable agent functionality.',
						});
					}
				});

				// Timeout for which command
				setTimeout(() => {
					whichProcess.kill();
					resolve({
						installed: false,
						message: 'Claude Code installation check timed out',
					});
				}, 5000);
			});
		} catch (error) {
			return {
				installed: false,
				message: `Failed to check Claude installation: ${
					error instanceof Error ? error.message : 'Unknown error'
				}`,
			};
		}
	}

	/**
	 * Initialize Claude in an existing session (legacy compatibility)
	 */
	async initializeClaudeInSession(sessionName: string): Promise<{
		success: boolean;
		message?: string;
		error?: string;
	}> {
		try {
			this.logger.info('Initializing Claude Code in session', { sessionName });

			// Start Claude Code by sending Enter
			await this.sessionHelper.sendEnter(sessionName);

			// Wait for Claude to be ready
			const isReady = await this.waitForRuntimeReady(sessionName, 45000);

			if (isReady) {
				this.logger.info('Claude Code initialized successfully', { sessionName });
				return {
					success: true,
					message: 'Claude Code initialized and ready',
				};
			} else {
				return {
					success: false,
					error: 'Claude Code failed to initialize within timeout',
				};
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to initialize Claude Code in session', {
				sessionName,
				error: errorMessage,
			});

			return {
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Enhanced Claude detection using slash command with detailed analysis
	 * This is the legacy method that provides more detailed detection than the base detectRuntimeSpecific
	 */
	async detectClaudeWithSlashCommand(
		sessionName: string,
		forceRefresh: boolean = false
	): Promise<boolean> {
		// For now, delegate to the base detectRuntimeWithCommand method
		// which calls our detectRuntimeSpecific implementation
		return await this.detectRuntimeWithCommand(sessionName, forceRefresh);
	}

	/**
	 * Execute Claude initialization script (legacy compatibility)
	 */
	async executeClaudeInitScript(sessionName: string, targetPath?: string): Promise<void> {
		return await this.executeRuntimeInitScript(sessionName, targetPath);
	}

	/**
	 * Post-initialization hook for Claude Code.
	 * Ensures MCP server configuration (e.g., playwright) is present in the project directory.
	 *
	 * @param sessionName - PTY session name
	 * @param targetProjectPath - Optional target project path for MCP config.
	 *                            Falls back to this.projectRoot if not provided.
	 */
	async postInitialize(sessionName: string, targetProjectPath?: string, _additionalAllowlistPaths?: string[], browserAutomationOverride?: boolean): Promise<void> {
		const effectiveProjectPath = targetProjectPath || this.projectRoot;
		this.logger.info('Claude Code post-init: ensuring MCP config', {
			sessionName,
			projectRoot: this.projectRoot,
			targetProjectPath: effectiveProjectPath,
			browserAutomationOverride,
		});

		const result = await this.ensureClaudeMcpConfig(effectiveProjectPath, browserAutomationOverride);

		// Health check: verify the config was written correctly
		if (result.success && result.totalServers > 0) {
			const mcpConfigPath = path.join(effectiveProjectPath, '.mcp.json');
			const verified = await this.verifyMcpConfig(mcpConfigPath, result.serverNames);
			if (verified) {
				this.logger.info('MCP health check passed', {
					sessionName,
					servers: result.serverNames,
				});
			} else {
				this.logger.warn('MCP health check failed: config file does not match expected servers', {
					sessionName,
					expectedServers: result.serverNames,
				});
			}
		} else if (!result.success) {
			this.logger.warn('MCP config setup failed during post-init', {
				sessionName,
				error: result.error,
			});
		}
	}

	/**
	 * Ensure Claude Code MCP server configuration exists in the project directory.
	 *
	 * Creates or merges `.mcp.json` with required MCP servers.
	 * Delegates to the shared `ensureMcpConfig` in the base class.
	 *
	 * @param projectPath - Project directory where `.mcp.json` will be created
	 * @returns Result of the MCP config operation
	 */
	async ensureClaudeMcpConfig(projectPath: string, browserAutomationOverride?: boolean): Promise<McpConfigResult> {
		const mcpConfigPath = path.join(projectPath, '.mcp.json');
		return await this.ensureMcpConfig(mcpConfigPath, projectPath, browserAutomationOverride);
	}
}
