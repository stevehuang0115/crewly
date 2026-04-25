import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as path from 'path';
import { SessionInfo, TeamMemberSessionConfig, TerminalOutput } from '../../types/index.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { TmuxCommandService } from './tmux-command.service.js';
import { RuntimeAgentService } from './runtime-agent.service.abstract.js';
import { RuntimeServiceFactory } from './runtime-service.factory.js';
import { AgentRegistrationService, OrchestratorConfig } from './agent-registration.service.js';
import { PromptBuilderService } from '../ai/prompt-builder.service.js';
import { StorageService } from '../core/storage.service.js';
import { ENV_CONSTANTS, AGENT_TIMEOUTS, ORCHESTRATOR_ROLE } from '../../constants.js';

/**
 * Refactored TmuxService that acts as a facade, coordinating specialized services
 * to provide a high-level API for tmux session management and agent initialization.
 * 
 * This service retains the public-facing API while delegating actual work to specialized services:
 * - TmuxCommandService: Low-level tmux operations
 * - RuntimeServiceFactory: Creates runtime-specific services
 * - AgentRegistrationService: Agent initialization and registration
 * - PromptBuilderService: Prompt generation and management
 */
export class TmuxService extends EventEmitter {
	private sessions: Map<string, any> = new Map();
	private outputBuffers: Map<string, string[]> = new Map();
	private logger: ComponentLogger;

	// Specialized services
	private tmuxCommand: TmuxCommandService;
	private agentRegistration: AgentRegistrationService;
	private promptBuilder: PromptBuilderService;
	private storageService: StorageService;

	// Memory management
	private cleanupInterval: NodeJS.Timeout;
	private readonly MAX_BUFFER_SIZE = 100; // Max lines per session buffer
	private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

	// Session creation queue to prevent concurrent session creation conflicts
	private sessionCreationQueue: Array<() => Promise<any>> = [];
	private isProcessingQueue = false;
	private readonly SESSION_CREATION_DELAY = 3000; // 3 seconds between sessions

	// Concurrency controls to prevent system overload
	private readonly MAX_CONCURRENT_INITIALIZING = 2; // Max sessions initializing simultaneously
	private activeSessions = new Set<string>(); // Track sessions currently initializing

	// Project root path resolution
	private readonly projectRoot: string;

	constructor() {
		super();
		this.logger = LoggerService.getInstance().createComponentLogger('TmuxService');

		// Resolve project root - go up from current file to find package.json
		this.projectRoot = this.findProjectRoot();

		// Initialize specialized services
		this.tmuxCommand = new TmuxCommandService();
		this.storageService = StorageService.getInstance();
		// AgentRegistrationService now uses factory pattern internally
		this.agentRegistration = new AgentRegistrationService(this.tmuxCommand, this.projectRoot, this.storageService);
		this.promptBuilder = new PromptBuilderService(this.projectRoot);

		// Start periodic cleanup to prevent memory leaks
		this.cleanupInterval = setInterval(() => {
			this.cleanupMemory();
		}, this.CLEANUP_INTERVAL);
	}

	/**
	 * Find the project root by looking for package.json.
	 * Walks up from process.cwd() to locate the nearest package.json.
	 */
	private findProjectRoot(): string {
		let dir = process.cwd();
		while (dir !== path.dirname(dir)) {
			try {
				const packagePath = path.join(dir, 'package.json');
				require('fs').accessSync(packagePath);
				return dir;
			} catch {
				dir = path.dirname(dir);
			}
		}
		return process.cwd();
	}

	/**
	 * Clean up memory to prevent accumulation of old data
	 */
	private cleanupMemory(): void {
		try {
			// Trim output buffers to prevent excessive memory usage
			for (const [sessionName, buffer] of this.outputBuffers.entries()) {
				if (buffer.length > this.MAX_BUFFER_SIZE) {
					// Keep only the most recent lines
					const trimmedBuffer = buffer.slice(-this.MAX_BUFFER_SIZE);
					this.outputBuffers.set(sessionName, trimmedBuffer);
				}
			}

			// Clean up detection cache in runtime services (handled automatically by factory caching)

			// Clean up buffers for sessions that no longer exist
			const activeSessions = new Set(this.sessions.keys());
			for (const sessionName of this.outputBuffers.keys()) {
				if (!activeSessions.has(sessionName)) {
					this.outputBuffers.delete(sessionName);
				}
			}

			this.logger.debug('Memory cleanup completed', {
				outputBuffersCount: this.outputBuffers.size,
				activeSessionsCount: this.sessions.size,
			});
		} catch (error: any) {
			this.logger.error('Error during memory cleanup', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Destroy the service and clean up resources
	 */
	public destroy(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}

		// Clean up all buffers
		this.outputBuffers.clear();
		this.sessions.clear();

		this.logger.info('TmuxService destroyed and resources cleaned up');
	}

	/**
	 * Force immediate memory cleanup (for emergency situations)
	 */
	public forceCleanup(): void {
		this.cleanupMemory();

		// More aggressive cleanup if needed
		if (global.gc) {
			global.gc();
			this.logger.info('Forced garbage collection completed');
		}
	}

	/**
	 * Initialize tmux server if not running
	 *
	 * DORMANT: tmux initialization is disabled since we're using PTY session backend.
	 * This method is kept for backward compatibility but does nothing.
	 * To re-enable tmux support, restore the call to ensureTmuxServer().
	 */
	async initialize(): Promise<void> {
		// DORMANT: PTY backend is now the primary session backend
		// await this.ensureTmuxServer();
		this.logger.debug('TmuxService.initialize() skipped - using PTY session backend');
	}

	/**
	 * Ensure tmux server is running using the initialize_tmux.sh script
	 *
	 * DORMANT: This method is not called when using PTY session backend.
	 */
	private async ensureTmuxServer(): Promise<void> {
		try {
			this.logger.info('Initializing tmux server using script...');
			await this.executeTmuxInitScript();
			this.logger.info('tmux server initialization script completed');
		} catch (error: any) {
			this.logger.error('Failed to initialize tmux server', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Create orchestrator session for project management
	 */
	async createOrchestratorSession(config: OrchestratorConfig): Promise<{
		success: boolean;
		sessionName: string;
		message?: string;
		error?: string;
	}> {
		try {
			this.logger.info('Creating orchestrator session', {
				sessionName: config.sessionName,
				projectPath: config.projectPath,
			});

			// Check if session already exists
			if (await this.tmuxCommand.sessionExists(config.sessionName)) {
				this.logger.info('Orchestrator session already exists', {
					sessionName: config.sessionName,
				});
				return {
					success: true,
					sessionName: config.sessionName,
					message: 'Orchestrator session already running',
				};
			}

			// Create new tmux session for orchestrator
			await this.tmuxCommand.createSession(
				config.sessionName,
				config.projectPath,
				config.windowName
			);

			this.logger.info('Orchestrator session created', { sessionName: config.sessionName });

			// Read orchestrator configuration from teams.json to get runtime type
			const orchestratorConfig = await this.storageService.getOrchestratorStatus();
			const runtimeType = orchestratorConfig?.runtimeType || 'claude-code';

			// Initialize runtime in the orchestrator session using the configured runtime type
			this.logger.info('Initializing runtime in orchestrator session', { 
				sessionName: config.sessionName,
				runtimeType 
			});
			
			const runtimeService = RuntimeServiceFactory.create(runtimeType, this.tmuxCommand, this.projectRoot);
			await runtimeService.executeRuntimeInitScript(config.sessionName, config.projectPath);
			
			this.logger.info('Runtime initialized successfully in orchestrator session', { 
				sessionName: config.sessionName,
				runtimeType 
			});

			return {
				success: true,
				sessionName: config.sessionName,
				message: 'Orchestrator session created successfully',
			};
		} catch (error: any) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to create orchestrator session', {
				sessionName: config.sessionName,
				error: errorMessage,
			});

			return {
				success: false,
				sessionName: config.sessionName,
				error: errorMessage,
			};
		}
	}

	/**
	 * Initialize orchestrator session with appropriate runtime
	 */
	async initializeOrchestrator(
		sessionName: string,
		timeout: number = AGENT_TIMEOUTS.ORCHESTRATOR_INITIALIZATION
	): Promise<{
		success: boolean;
		message?: string;
		error?: string;
	}> {
		// Get orchestrator's runtime type from storage
		let runtimeType = 'claude-code'; // Default fallback
		try {
			const orchestratorStatus = await this.storageService.getOrchestratorStatus();
			if (orchestratorStatus?.runtimeType) {
				runtimeType = orchestratorStatus.runtimeType;
				this.logger.info('Using orchestrator runtime type from storage', { 
					sessionName,
					runtimeType 
				});
			} else {
				this.logger.warn('No runtime type found in orchestrator status, using default', {
					sessionName,
					runtimeType
				});
			}
		} catch (error) {
			this.logger.warn('Failed to get orchestrator runtime type from storage, using default', {
				sessionName,
				runtimeType,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		// Use the agent registration system with orchestrator role and runtime type
		const projectPath = process.cwd(); // Orchestrator works from current project directory
		return await this.agentRegistration.initializeAgentWithRegistration(
			sessionName,
			ORCHESTRATOR_ROLE,
			projectPath,
			timeout,
			undefined, // memberId (not used for orchestrator)
			runtimeType as any // Cast to RuntimeType
		);
	}

	/**
	 * Send project start prompt to orchestrator
	 */
	async sendProjectStartPrompt(
		sessionName: string,
		projectData: {
			projectName: string;
			projectPath: string;
			teamDetails: any;
			requirements?: string;
		}
	): Promise<{
		success: boolean;
		message?: string;
		error?: string;
	}> {
		try {
			this.logger.info('Sending project start prompt to orchestrator', {
				sessionName,
				projectName: projectData.projectName,
			});

			// Check if session exists
			if (!(await this.tmuxCommand.sessionExists(sessionName))) {
				return {
					success: false,
					error: `Session '${sessionName}' does not exist`,
				};
			}

			// Build the orchestrator prompt using the prompt builder
			const prompt = this.promptBuilder.buildOrchestratorPrompt(projectData);

			// Send the prompt to Claude
			await this.sendMessage(sessionName, prompt);

			this.logger.info('Project start prompt sent successfully', {
				sessionName,
				projectName: projectData.projectName,
			});

			return {
				success: true,
				message: 'Project start prompt sent to orchestrator',
			};
		} catch (error: any) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to send project start prompt', {
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
	 * Check if Claude Code CLI is installed
	 */
	async checkClaudeInstallation(): Promise<{
		installed: boolean;
		version?: string;
		message: string;
	}> {
		const claudeService = RuntimeServiceFactory.create('claude-code', this.tmuxCommand, this.projectRoot);
		return await (claudeService as any).checkClaudeInstallation();
	}

	/**
	 * Initialize Claude Code in an existing session
	 */
	async initializeClaudeInSession(sessionName: string): Promise<{
		success: boolean;
		message?: string;
		error?: string;
	}> {
		const claudeService = RuntimeServiceFactory.create('claude-code', this.tmuxCommand, this.projectRoot);
		return await (claudeService as any).initializeClaudeInSession(sessionName);
	}

	/**
	 * Create a new tmux session for a team member (queued to prevent concurrent creation conflicts)
	 */
	async createTeamMemberSession(
		config: TeamMemberSessionConfig,
		sessionName: string
	): Promise<{
		success: boolean;
		sessionName?: string;
		message?: string;
		error?: string;
	}> {
		return new Promise((resolve, reject) => {
			this.sessionCreationQueue.push(async () => {
				try {
					const result = await this.createTeamMemberSessionInternal(config, sessionName);
					resolve(result);
				} catch (error) {
					reject(error);
				}
			});
			this.processSessionCreationQueue();
		});
	}

	/**
	 * Internal method for creating team member session (called by queue processor)
	 */
	private async createTeamMemberSessionInternal(
		config: TeamMemberSessionConfig,
		sessionName: string
	): Promise<{
		success: boolean;
		sessionName?: string;
		message?: string;
		error?: string;
	}> {
		// Add concurrency control - wait if too many sessions are initializing
		while (this.activeSessions.size >= this.MAX_CONCURRENT_INITIALIZING) {
			this.logger.info('Waiting for session slot to become available', {
				sessionName,
				activeCount: this.activeSessions.size,
				maxAllowed: this.MAX_CONCURRENT_INITIALIZING,
			});
			await new Promise(resolve => setTimeout(resolve, 2000));
		}

		this.activeSessions.add(sessionName);
		try {
			this.logger.info('Creating team member session (queued with concurrency control)', { 
				sessionName, 
				role: config.role,
				activeSessionsCount: this.activeSessions.size,
			});

			// Kill existing session if it exists to ensure clean initialization
			if (await this.tmuxCommand.sessionExists(sessionName)) {
				this.logger.info('Team member session already exists, killing for clean restart', {
					sessionName,
				});
			}
			await this.tmuxCommand.killSession(sessionName);

			// Wait for cleanup
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Create new tmux session
			await this.tmuxCommand.createSession(
				sessionName,
				config.projectPath || process.cwd()
			);

			// Set environment variables for MCP connection
			await this.tmuxCommand.setEnvironmentVariable(sessionName, ENV_CONSTANTS.CREWLY_SESSION_NAME, sessionName);
			await this.tmuxCommand.setEnvironmentVariable(sessionName, ENV_CONSTANTS.CREWLY_ROLE, config.role);

			// Use the optimized agent registration system for initialization
			const initResult = await this.agentRegistration.initializeAgentWithRegistration(
				sessionName,
				config.role,
				config.projectPath,
				AGENT_TIMEOUTS.REGULAR_AGENT_INITIALIZATION,
				config.memberId,
				config.runtimeType || 'claude-code' // Use configured runtime type, fallback to claude-code
			);

			if (!initResult.success) {
				throw new Error(`Agent initialization failed: ${initResult.error}`);
			}

			this.logger.info('Agent initialized successfully with registration', {
				sessionName,
				role: config.role,
				message: initResult.message,
			});

			// Start optimized streaming output
			this.startOutputStreaming(sessionName);

			this.logger.info('Team member session created successfully', {
				sessionName,
				role: config.role,
			});

			return {
				success: true,
				sessionName,
				message: 'Team member session created successfully',
			};
		} catch (error: any) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to create team member session', {
				sessionName,
				role: config.role,
				error: errorMessage,
			});

			return {
				success: false,
				sessionName,
				error: errorMessage,
			};
		} finally {
			// Always remove from active sessions when done (success or failure)
			this.activeSessions.delete(sessionName);
			this.logger.debug('Released session slot', {
				sessionName,
				remainingActiveCount: this.activeSessions.size,
			});
		}
	}

	/**
	 * Process the session creation queue to serialize session creation
	 */
	private async processSessionCreationQueue(): Promise<void> {
		if (this.isProcessingQueue || this.sessionCreationQueue.length === 0) {
			return;
		}

		this.isProcessingQueue = true;
		this.logger.info('Starting session creation queue processing', {
			queueLength: this.sessionCreationQueue.length,
		});

		while (this.sessionCreationQueue.length > 0) {
			const sessionCreator = this.sessionCreationQueue.shift()!;
			
			try {
				await sessionCreator();
				this.logger.debug('Session creation completed, waiting before next session', {
					remainingInQueue: this.sessionCreationQueue.length,
					delayMs: this.SESSION_CREATION_DELAY,
				});
				
				// Add delay between sessions to prevent resource conflicts
				if (this.sessionCreationQueue.length > 0) {
					await new Promise(resolve => setTimeout(resolve, this.SESSION_CREATION_DELAY));
				}
			} catch (error: any) {
				this.logger.error('Session creation failed in queue', {
					error: error instanceof Error ? error.message : String(error),
					remainingInQueue: this.sessionCreationQueue.length,
				});
			}
		}

		this.isProcessingQueue = false;
		this.logger.info('Session creation queue processing completed');
	}

	/**
	 * Create a new tmux session with Claude Code (legacy compatibility)
	 */
	async createSession(config: TeamMemberSessionConfig): Promise<string> {
		try {
			const sessionName = config.name.replace(/\s+/g, '_').toLowerCase();

			// Kill existing session if it exists
			await this.tmuxCommand.killSession(sessionName);

			// Create new tmux session
			await this.tmuxCommand.createSession(
				sessionName,
				config.projectPath || process.cwd()
			);

			// Set environment variables for MCP connection
			await this.tmuxCommand.setEnvironmentVariable(sessionName, ENV_CONSTANTS.CREWLY_SESSION_NAME, sessionName);
			await this.tmuxCommand.setEnvironmentVariable(sessionName, ENV_CONSTANTS.CREWLY_ROLE, config.role);

			// Get runtime type from config or default to claude-code
			const runtimeType = config.runtimeType || 'claude-code';

			// Initialize runtime using the configured runtime type
			this.logger.info('Initializing runtime in team member session', { 
				sessionName,
				runtimeType,
				memberRole: config.role
			});
			
			const runtimeService = RuntimeServiceFactory.create(runtimeType, this.tmuxCommand, this.projectRoot);
			await runtimeService.executeRuntimeInitScript(sessionName, config.projectPath);

			// Start streaming output
			this.startOutputStreaming(sessionName);

			return sessionName;
		} catch (error: any) {
			this.logger.error('Error creating tmux session:', error);
			throw error;
		}
	}

	/**
	 * Check if a tmux session is attached
	 */
	async isSessionAttached(sessionName: string): Promise<boolean> {
		try {
			const result = await this.tmuxCommand.executeTmuxCommand([
				'display-message',
				'-p',
				'-t',
				sessionName,
				'#{?session_attached,attached,detached}'
			]);

			const status = result.trim();
			this.logger.debug('Session attachment status checked', {
				sessionName,
				status,
				isAttached: status === 'attached'
			});

			return status === 'attached';
		} catch (error: any) {
			this.logger.warn('Failed to check session attachment status', {
				sessionName,
				error: error.message
			});
			// Default to detached if we can't determine status
			return false;
		}
	}

	/**
	 * Send message directly using send-keys (for attached sessions)
	 */
	async sendMessageDirectly(sessionName: string, message: string): Promise<void> {
		try {
			// Clear current command line first
			await this.tmuxCommand.clearCurrentCommandLine(sessionName);

			// Send message using direct send-keys approach with consistent 1000ms timing
			// First: send the message content
			await this.tmuxCommand.executeTmuxCommand([
				'send-keys',
				'-t',
				sessionName,
				'-l',
				'--',
				message
			]);

			// Wait 1000ms for consistent timing with detached sessions
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Second: send Enter to execute
			await this.tmuxCommand.executeTmuxCommand([
				'send-keys',
				'-t',
				sessionName,
				'Enter'
			]);

			this.emit('message_sent', { sessionName, message, method: 'direct' });
			this.logger.debug('Message sent directly via send-keys with 1000ms delay', {
				sessionName,
				messageLength: message.length,
			});
		} catch (error: any) {
			this.logger.error('Error sending message directly to tmux session:', error);
			throw error;
		}
	}

	/**
	 * Send a message to a specific tmux session
	 * Uses robust tmux_robosend.sh script for all sessions (attached and detached)
	 */
	async sendMessage(sessionName: string, message: string): Promise<void> {
		try {
			this.logger.debug('Sending message using robust tmux_robosend.sh script', {
				sessionName,
				messageLength: message.length,
			});

			// Always use the robust script approach for consistency and reliability
			// The script handles both attached and detached sessions with shadow clients
			await this.tmuxCommand.clearCurrentCommandLine(sessionName);
			await this.tmuxCommand.sendMessage(sessionName, message);
			// Note: sendMessage already includes Enter key with proper timing, no need for duplicate sendEnter
			this.emit('message_sent', { sessionName, message, method: 'robust_script' });

			this.logger.debug('Message sent successfully', {
				sessionName,
				messageLength: message.length,
				method: 'robust_script',
			});
		} catch (error: any) {
			this.logger.error('Error sending message to tmux session:', error);
			throw error;
		}
	}

	/**
	 * Send individual key to a specific tmux session (without Enter)
	 */
	async sendKey(sessionName: string, key: string): Promise<void> {
		await this.tmuxCommand.sendKey(sessionName, key);
		this.emit('key_sent', { sessionName, key });
	}

	/**
	 * Capture terminal output from a session
	 */
	async capturePane(sessionName: string, lines: number = 100): Promise<string> {
		return await this.tmuxCommand.capturePane(sessionName, lines);
	}

	/**
	 * Kill a tmux session
	 */
	async killSession(sessionName: string): Promise<void> {
		await this.tmuxCommand.killSession(sessionName);

		// Clean up local tracking
		this.sessions.delete(sessionName);
		this.outputBuffers.delete(sessionName);

		this.emit('session_killed', { sessionName });
	}

	/**
	 * List all tmux sessions
	 */
	async listSessions(): Promise<SessionInfo[]> {
		return await this.tmuxCommand.listSessions();
	}

	/**
	 * Check if a session exists
	 */
	async sessionExists(sessionName: string): Promise<boolean> {
		return await this.tmuxCommand.sessionExists(sessionName);
	}

	/**
	 * Check multiple sessions at once (highly optimized for bulk checking)
	 * Returns a Map with sessionName -> boolean for each session
	 */
	async bulkSessionExists(sessionNames: string[]): Promise<Map<string, boolean>> {
		return await this.tmuxCommand.bulkSessionExists(sessionNames);
	}

	/**
	 * Start streaming output for an existing session (public method)
	 */
	public enableOutputStreaming(sessionName: string): void {
		this.startOutputStreaming(sessionName);
	}

	/**
	 * Start optimized streaming output from a session with reduced frequency and jitter
	 */
	private startOutputStreaming(sessionName: string): void {
		// Add jitter to prevent synchronized polling across multiple sessions
		const baseInterval = 3000; // Increased from 1000ms to 3000ms to reduce load
		const jitter = Math.random() * 1000; // Random 0-1000ms jitter
		const pollInterval = baseInterval + jitter;

		this.logger.debug('Starting output streaming with optimized timing', {
			sessionName,
			pollInterval: Math.round(pollInterval),
		});

		// Create a recurring capture to stream output
		const interval = setInterval(async () => {
			try {
				if (!(await this.tmuxCommand.sessionExists(sessionName))) {
					this.logger.debug('Session no longer exists, stopping output streaming', {
						sessionName,
					});
					clearInterval(interval);
					return;
				}

				const output = await this.tmuxCommand.capturePane(sessionName, 10);
				const previousBuffer = this.outputBuffers.get(sessionName) || [];
				const currentLines = output.split('\n');

				// Only emit new lines and prevent excessive buffer growth
				if (JSON.stringify(currentLines) !== JSON.stringify(previousBuffer)) {
					// Trim buffer to prevent memory accumulation
					const trimmedLines =
						currentLines.length > this.MAX_BUFFER_SIZE
							? currentLines.slice(-this.MAX_BUFFER_SIZE)
							: currentLines;
					this.outputBuffers.set(sessionName, trimmedLines);

					const terminalOutput: TerminalOutput = {
						sessionName,
						content: output,
						timestamp: new Date().toISOString(),
						type: 'stdout',
					};

					this.emit('output', terminalOutput);
				}
			} catch (error: any) {
				this.logger.error(`Error streaming output for session ${sessionName}:`, error);
				clearInterval(interval);
			}
		}, pollInterval);
	}

	/**
	 * Execute tmux initialization script
	 * @deprecated tmux support has been removed - PTY backend is now used
	 */
	private async executeTmuxInitScript(): Promise<void> {
		// REMOVED: initialize_tmux.sh script no longer exists
		// This method is kept for backward compatibility but should not be called
		throw new Error('initialize_tmux.sh has been removed - use PTY backend instead');
	}

	/**
	 * Get the underlying TmuxCommandService instance for specialized operations
	 * @returns TmuxCommandService instance
	 */
	public getTmuxCommandService(): TmuxCommandService {
		return this.tmuxCommand;
	}
}

// Export the OrchestratorConfig interface for compatibility
export { OrchestratorConfig };