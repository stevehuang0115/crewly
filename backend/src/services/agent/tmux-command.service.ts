import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SessionInfo } from '../../types/index.js';
import { CREWLY_CONSTANTS } from '../../constants.js';

/**
 * Service responsible for all direct, low-level interactions with the tmux command-line tool.
 * Abstracts away the details of executing tmux commands.
 * Implements caching and rate limiting to reduce excessive tmux command execution.
 */
export class TmuxCommandService {
	private logger: ComponentLogger;
	private readonly projectRoot: string;

	// DORMANT: tmux is disabled in favor of PTY session backend
	// Set to false to re-enable tmux support
	private readonly tmuxDisabled = true;

	// Cache for session existence checks - expires in 5 seconds
	private sessionCache: Map<string, { exists: boolean; timestamp: number }> = new Map();
	private readonly SESSION_CACHE_TTL = 10000; // 10 seconds (increased for better reliability)

	// Cache for pane captures - expires in 2 seconds for frequent captures
	private paneCache: Map<string, { content: string; timestamp: number }> = new Map();
	private readonly PANE_CACHE_TTL = 2000; // 2 seconds

	// Rate limiting for expensive operations
	private lastListSessions: number = 0;
	private readonly LIST_SESSIONS_THROTTLE = 3000; // 3 seconds between list-sessions calls
	private cachedSessionList: { sessions: SessionInfo[]; timestamp: number } | null = null;

	// Shadow client tracking for TUI input workaround (kept for compatibility but simplified)
	private shadowClients: Set<string> = new Set(); // Sessions with shadow clients
	private shadowClientProcesses: Map<string, ChildProcess> = new Map(); // Track PIDs for cleanup
	private shadowClientLocks: Map<string, Promise<void>> = new Map(); // Prevent race conditions
	private focusEventsEnabled = false; // Track if we've enabled focus events

	constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('TmuxCommandService');

		// Resolve project root - go up from current file to find package.json
		this.projectRoot = this.findProjectRoot();

		// DORMANT: tmux initialization is disabled since we're using PTY session backend
		// To re-enable tmux support, set tmuxDisabled to false and uncomment the following:
		// this.enableFocusEvents().catch((error) => {
		//   this.logger.warn('Failed to enable focus events for shadow clients', { error });
		// });
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
	 * Get path to the tmux_robosend.sh script
	 * @deprecated tmux support has been removed - PTY backend is now used
	 */
	private getTmuxRobosendScriptPath(): string {
		// REMOVED: tmux_robosend.sh script no longer exists
		// This method is kept for backward compatibility but should not be called
		throw new Error('tmux_robosend.sh has been removed - use PTY backend instead');
	}

	/**
	 * Get tmux socket name (default socket)
	 */
	private async getTmuxSocketName(): Promise<string> {
		try {
			const output = await this.executeTmuxCommand(['display', '-p', '#{socket_path}']);
			const socketPath = output.trim();

			// Extract socket name from path (e.g., '/tmp/tmux-501/default' -> 'default')
			const socketName = path.basename(socketPath);

			this.logger.debug('Detected tmux socket', { socketPath, socketName });
			return socketName;
		} catch (error) {
			this.logger.warn('Failed to detect tmux socket, using default', { error });
			return 'default';
		}
	}

	/**
	 * Execute a tmux command with bashrc sourced first
	 */
	async executeTmuxCommand(args: string[]): Promise<string> {
		// Debug logging for all tmux commands
		this.logger.debug('🔍 TMUX Command:', {
			command: `tmux ${args.join(' ')}`,
			args: args,
			argsLength: args.length,
			firstArg: args[0] || 'undefined',
			secondArg: args[1] || 'undefined',
			thirdArg: args[2] || 'undefined',
		});

		return new Promise((resolve, reject) => {
			// FINAL DEBUG: Log the exact arguments right before spawn
			this.logger.debug('🔍 FINAL SPAWN ARGS BEFORE EXECUTION:', {
				executable: 'tmux',
				args: args,
				argsJson: JSON.stringify(args),
				argsLength: args.length,
				commandString: `tmux ${args.join(' ')}`,
				containsP: args.includes('-p'),
				containsSendKeys: args.includes('send-keys'),
				isSendKeysWithP: args[0] === 'send-keys' && args.includes('-p'),
				timestamp: new Date().toISOString(),
			});

			// Use spawn directly with tmux to avoid shell escaping issues
			const process = spawn('tmux', args);

			let output = '';
			let error = '';

			process.stdout.on('data', (data) => {
				output += data.toString();
			});

			process.stderr.on('data', (data) => {
				error += data.toString();
			});

			process.on('close', (code) => {
				if (code === 0) {
					resolve(output);
				} else {
					// DETAILED ERROR LOGGING: Capture all failure info
					this.logger.error('🚨 TMUX COMMAND FAILED WITH ERROR:', {
						exitCode: code,
						error: error,
						output: output,
						originalArgs: args,
						commandString: `tmux ${args.join(' ')}`,
						executable: 'tmux',
						containsP: args.includes('-p'),
						containsSendKeys: args.includes('send-keys'),
						isSendKeysWithP: args[0] === 'send-keys' && args.includes('-p'),
						timestamp: new Date().toISOString(),
						stackTrace: new Error().stack,
					});
					reject(new Error(`tmux command failed: ${error || `exit code ${code}`}`));
				}
			});

			process.on('error', (err) => {
				reject(new Error(`Failed to spawn bash for tmux: ${err.message}`));
			});
		});
	}

	/**
	 * Execute a shell command using bash (for commands that need shell interpretation like semicolons)
	 */
	private async executeShellCommand(command: string): Promise<string> {
		this.logger.debug('🔍 Executing shell command:', { command });

		return new Promise((resolve, reject) => {
			const childProcess = spawn('bash', ['-c', command], {
				env: process.env,
			});

			let output = '';
			let error = '';

			childProcess.stdout.on('data', (data) => {
				output += data.toString();
			});

			childProcess.stderr.on('data', (data) => {
				error += data.toString();
			});

			childProcess.on('close', (code) => {
				this.logger.debug('Shell command completed', {
					command,
					exitCode: code,
					outputLength: output.length,
					errorLength: error.length,
				});

				if (code === 0) {
					resolve(output);
				} else {
					this.logger.error('Shell command failed', {
						command,
						exitCode: code,
						error,
						output,
					});
					reject(new Error(`Shell command failed: ${error || `exit code ${code}`}`));
				}
			});

			childProcess.on('error', (err) => {
				this.logger.error('Failed to spawn shell command', {
					command,
					error: err.message,
				});
				reject(new Error(`Failed to spawn shell command: ${err.message}`));
			});
		});
	}

	/**
	 * Enable focus events for tmux (one-time setup for shadow client support)
	 */
	private async enableFocusEvents(): Promise<void> {
		if (this.focusEventsEnabled) return;

		try {
			await this.executeTmuxCommand(['set', '-g', 'focus-events', 'on']);
			this.focusEventsEnabled = true;
			this.logger.debug('Enabled tmux focus events for shadow client support');
		} catch (error) {
			this.logger.error('Failed to enable focus events', {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * Find the pane ID for a given session name
	 * Since we only have one window per session, we look for session:0.0
	 */
	private async findSessionPaneId(sessionName: string): Promise<string> {
		try {
			// tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{pane_current_command}'
			const output = await this.executeTmuxCommand([
				'list-panes',
				'-a',
				'-F',
				'#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{pane_current_command}',
			]);

			const lines = output.trim().split('\n');
			for (const line of lines) {
				const parts = line.trim().split(/\s+/);
				if (parts.length >= 3) {
					const sessionWindow = parts[0]; // session:0.0
					const paneId = parts[1]; // %0, %1, etc.
					const command = parts[2]; // node, bash, etc.

					// Match our session (session:0.0 format)
					if (sessionWindow === `${sessionName}:0.0`) {
						this.logger.debug('Found pane for session', {
							sessionName,
							sessionWindow,
							paneId,
							command,
						});
						return paneId;
					}
				}
			}

			throw new Error(`No pane found for session ${sessionName}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to find pane for session', {
				sessionName,
				error: errorMessage,
			});
			throw new Error(`Pane lookup failed for ${sessionName}: ${errorMessage}`);
		}
	}

	/**
	 * Ensure shadow client is attached to session for TUI input reliability
	 * This prevents TUI applications from ignoring input when no client is attached
	 */
	private async ensureShadowClient(sessionName: string): Promise<void> {
		// Check if we already have a shadow client or one is being created
		if (this.shadowClients.has(sessionName)) return;

		// Use locking to prevent race conditions
		const existingLock = this.shadowClientLocks.get(sessionName);
		if (existingLock) {
			await existingLock;
			return;
		}

		// Create new lock
		const lock = this.ensureShadowClientInternal(sessionName);
		this.shadowClientLocks.set(sessionName, lock);

		try {
			await lock;
		} finally {
			this.shadowClientLocks.delete(sessionName);
		}
	}

	/**
	 * Internal implementation of shadow client creation
	 */
	private async ensureShadowClientInternal(sessionName: string): Promise<void> {
		try {
			// Check if session has any attached clients
			const attached = await this.executeTmuxCommand([
				'display-message',
				'-p',
				'-t',
				sessionName,
				'#{session_attached}',
			]);

			const attachedCount = parseInt(attached.trim());
			if (attachedCount > 0) {
				this.logger.debug('Session already has attached clients, skipping shadow client', {
					sessionName,
					attachedCount,
				});
				return;
			}

			this.logger.debug('Creating shadow client for detached session', { sessionName });

			// Start shadow client using bash shell for proper redirection and backgrounding
			// tmux -C attach -t session </dev/null >/tmp/tmux-session.ctrl.log 2>&1 &
			const logPath = `/tmp/tmux-${sessionName}.ctrl.log`;
			const shellCommand = `tmux -C attach -t ${sessionName} </dev/null >/tmp/tmux-${sessionName}.ctrl.log 2>&1 &`;

			// Match the working approach: don't ignore stdio, let the shell redirection handle it
			// The shell command already has proper redirection: </dev/null >/tmp/log 2>&1 &
			const shadowProcess = spawn('bash', ['-c', shellCommand], {
				detached: true,
				stdio: 'ignore', // Let the shell handle redirection instead of forcing ignore
				env: process.env,
			});

			// Track the process for cleanup
			this.shadowClientProcesses.set(sessionName, shadowProcess);
			this.shadowClients.add(sessionName);

			// Unref so it doesn't prevent Node.js exit
			shadowProcess.unref();

			// Handle process events
			shadowProcess.on('error', (error) => {
				this.logger.error('Shadow client process error', { sessionName, error });
				this.cleanupShadowClient(sessionName);
				throw new Error(
					`Failed to start shadow client for ${sessionName}: ${error.message}`
				);
			});

			shadowProcess.on('exit', (code, signal) => {
				this.logger.debug('Shadow client process exited', { sessionName, code, signal });
				this.cleanupShadowClient(sessionName);
			});

			// Give the shadow client more time to attach (500ms grace period)
			// The manual approach may need more time for proper attachment
			await new Promise((resolve) => setTimeout(resolve, 500));

			this.logger.debug('Shadow client created successfully', {
				sessionName,
				pid: shadowProcess.pid,
				logPath,
				shellCommand,
			});
		} catch (error) {
			this.cleanupShadowClient(sessionName);
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('Failed to create shadow client', {
				sessionName,
				error: errorMessage,
			});
			throw new Error(`Shadow client creation failed for ${sessionName}: ${errorMessage}`);
		}
	}

	/**
	 * Clean up shadow client tracking for a session
	 */
	private cleanupShadowClient(sessionName: string): void {
		this.shadowClients.delete(sessionName);

		const process = this.shadowClientProcesses.get(sessionName);
		if (process && !process.killed) {
			try {
				process.kill('SIGTERM');
			} catch (error) {
				// Process might already be dead, ignore
			}
		}
		this.shadowClientProcesses.delete(sessionName);
	}

	/**
	 * Check if a tmux session exists (optimized to use listSessions instead of individual has-session calls)
	 *
	 * DORMANT: Returns false when tmux is disabled (PTY backend is active)
	 */
	async sessionExists(sessionName: string): Promise<boolean> {
		// DORMANT: Skip tmux operations when using PTY backend
		if (this.tmuxDisabled) {
			return false;
		}

		const now = Date.now();
		const cacheKey = sessionName;

		// Check cache first
		const cached = this.sessionCache.get(cacheKey);
		if (cached && now - cached.timestamp < this.SESSION_CACHE_TTL) {
			this.logger.debug('Using cached session existence result', {
				sessionName,
				exists: cached.exists,
			});
			return cached.exists;
		}

		try {
			// Use listSessions instead of individual has-session calls for efficiency
			// This leverages the existing caching and rate limiting in listSessions()
			const sessions = await this.listSessions();
			const exists = sessions.some((session) => session.sessionName === sessionName);

			// Cache the result
			this.sessionCache.set(cacheKey, { exists, timestamp: now });

			// Clean up old cache entries (keep only last 20)
			if (this.sessionCache.size > 20) {
				const entries = Array.from(this.sessionCache.entries());
				entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
				for (let i = 0; i < entries.length - 20; i++) {
					this.sessionCache.delete(entries[i][0]);
				}
			}

			this.logger.debug('Session existence checked via listSessions', {
				sessionName,
				exists,
				totalSessions: sessions.length,
			});
			return exists;
		} catch (error) {
			this.logger.warn(
				'Error checking session existence via listSessions, fallback to has-session',
				{
					sessionName,
					error: error instanceof Error ? error.message : String(error),
				}
			);

			// Fallback to individual has-session call if listSessions fails
			try {
				await this.executeTmuxCommand(['has-session', '-t', sessionName]);
				this.sessionCache.set(cacheKey, { exists: true, timestamp: now });
				return true;
			} catch (fallbackError) {
				this.sessionCache.set(cacheKey, { exists: false, timestamp: now });
				return false;
			}
		}
	}

	/**
	 * Check multiple sessions at once (highly optimized for bulk checking)
	 * Returns a Map with sessionName -> boolean for each session
	 *
	 * DORMANT: Returns map with all false when tmux is disabled (PTY backend is active)
	 */
	async bulkSessionExists(sessionNames: string[]): Promise<Map<string, boolean>> {
		if (sessionNames.length === 0) {
			return new Map();
		}

		// DORMANT: Skip tmux operations when using PTY backend
		if (this.tmuxDisabled) {
			const result = new Map<string, boolean>();
			for (const name of sessionNames) {
				result.set(name, false);
			}
			return result;
		}

		const now = Date.now();
		const result = new Map<string, boolean>();
		const uncachedSessions: string[] = [];

		// First check cache for all sessions
		for (const sessionName of sessionNames) {
			const cached = this.sessionCache.get(sessionName);
			if (cached && now - cached.timestamp < this.SESSION_CACHE_TTL) {
				result.set(sessionName, cached.exists);
				this.logger.debug('Using cached session existence result', {
					sessionName,
					exists: cached.exists,
				});
			} else {
				uncachedSessions.push(sessionName);
			}
		}

		// If all sessions were cached, return early
		if (uncachedSessions.length === 0) {
			return result;
		}

		try {
			// Get all sessions with a single listSessions call
			const allSessions = await this.listSessions();
			const activeSessionNames = new Set(allSessions.map((s) => s.sessionName));

			// Check existence for all uncached sessions
			for (const sessionName of uncachedSessions) {
				const exists = activeSessionNames.has(sessionName);
				result.set(sessionName, exists);

				// Cache the result
				this.sessionCache.set(sessionName, { exists, timestamp: now });
			}

			// Clean up old cache entries (keep only last 20)
			if (this.sessionCache.size > 20) {
				const entries = Array.from(this.sessionCache.entries());
				entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
				for (let i = 0; i < entries.length - 20; i++) {
					this.sessionCache.delete(entries[i][0]);
				}
			}

			this.logger.debug('Bulk session existence check completed', {
				checkedSessions: uncachedSessions.length,
				cachedSessions: sessionNames.length - uncachedSessions.length,
				totalActiveSessions: allSessions.length,
			});
		} catch (error) {
			this.logger.warn('Error in bulk session check, using individual fallback', {
				sessionCount: uncachedSessions.length,
				error: error instanceof Error ? error.message : String(error),
			});

			// Fallback to individual checks for uncached sessions
			for (const sessionName of uncachedSessions) {
				try {
					const exists = await this.sessionExists(sessionName);
					result.set(sessionName, exists);
				} catch (individualError) {
					this.logger.warn('Individual session check failed', {
						sessionName,
						error: individualError,
					});
					result.set(sessionName, false);
				}
			}
		}

		return result;
	}

	/**
	 * Kill a tmux session
	 */
	async killSession(sessionName: string): Promise<void> {
		try {
			await this.executeTmuxCommand(['kill-session', '-t', sessionName]);

			// Clear caches for the killed session
			this.clearSessionCache(sessionName);

			// Clean up shadow client tracking for the killed session
			this.cleanupShadowClient(sessionName);

			this.logger.info('Session killed successfully', { sessionName });
		} catch (error) {
			// Session might not exist, that's ok
			this.logger.debug(`Session ${sessionName} does not exist or was already killed`);
			// Still clean up shadow client tracking in case of partial failure
			this.cleanupShadowClient(sessionName);
		}
	}

	/**
	 * Send a message to a specific tmux session using the robust tmux_robosend.sh script
	 */
	async sendMessage(sessionName: string, message: string): Promise<void> {
		let cleanMessage = message
			.replace(/\r\n/g, '\n') // Normalize line endings
			.replace(/\r/g, '\n') // Handle Mac line endings
			.trim(); // Remove leading/trailing whitespace

		// Escape exclamation marks for ALL sessions to prevent shell mode activation
		// Many AI CLIs (like Gemini CLI) activate shell mode when they see '!' characters
		const originalLength = cleanMessage.length;
		cleanMessage = cleanMessage.replace(/!/g, ' ');

		if (cleanMessage.length !== originalLength) {
			this.logger.debug('Escaped exclamation marks to prevent shell mode activation', {
				sessionName,
				originalLength,
				newLength: cleanMessage.length,
			});
		}

		// Debug logging for message sending
		this.logger.debug('🔍 Sending message to tmux session using robosend script:', {
			sessionName,
			messageLength: cleanMessage.length,
			preview: cleanMessage.slice(0, 100) + (cleanMessage.length > 100 ? '...' : ''),
		});

		try {
			// Get script path and socket name
			const scriptPath = this.getTmuxRobosendScriptPath();
			const socketName = await this.getTmuxSocketName();

			// Build command arguments for the script
			// Format: bash tmux_robosend.sh --shadow -L socketName sessionName "message"
			const scriptArgs = [
				scriptPath,
				'--shadow', // Use shadow client for detached sessions
				'-L',
				socketName,
				sessionName,
				cleanMessage,
			];

			this.logger.debug('🔍 Executing tmux_robosend script:', {
				scriptPath,
				socketName,
				sessionName,
				messageLength: cleanMessage.length,
				command: `bash ${scriptArgs.join(' ')}`,
			});

			// Execute the script using bash
			// Escape both double quotes and backticks to prevent bash interpretation
			const escapedMessage = cleanMessage
				.replace(/\\/g, '\\\\')  // Escape backslashes first
				.replace(/"/g, '\\"')    // Escape double quotes
				.replace(/`/g, '\\`')    // Escape backticks to prevent command substitution
				.replace(/\$/g, '\\$');  // Escape dollar signs to prevent variable expansion

			await this.executeShellCommand(
				`bash "${scriptPath}" --shadow -L "${socketName}" "${sessionName}" "${escapedMessage}"`
			);

			this.logger.debug('✅ Message sent successfully via robosend script', {
				sessionName,
				messageLength: cleanMessage.length,
			});
		} catch (error) {
			this.logger.error('Error sending message via robosend script', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * Send individual key to a specific tmux session
	 */
	async sendKey(sessionName: string, key: string, allowRetry: boolean = false): Promise<void> {
		try {
			// Ensure shadow client is attached for TUI input reliability
			await this.ensureShadowClient(sessionName);

			let beforeOutput = '',
				afterOutput = '',
				needRetry = false;
			if (allowRetry) {
				beforeOutput = await this.capturePane(sessionName, 20);
			}
			await this.executeTmuxCommand(['send-keys', '-t', sessionName, key]);
			await new Promise((resolve) => setTimeout(resolve, 5000));

			if (allowRetry) {
				afterOutput = await this.capturePane(sessionName, 20);
				if (afterOutput.length - beforeOutput.length < key.length) {
					needRetry = true;
				}
			}

			if (needRetry) {
				await this.executeTmuxCommand(['send-keys', '-t', sessionName, key]);
				await new Promise((resolve) => setTimeout(resolve, 500));
			}

			this.logger.debug('Key sent successfully', { sessionName, key });
		} catch (error) {
			this.logger.error('Error sending key', {
				sessionName,
				key,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * To clear the commandline commands regardless it is in coding agent runtime or regular terminal
	 * @param sessionName
	 */
	async clearCurrentCommandLine(sessionName: string): Promise<void> {
		await this.sendCtrlC(sessionName);
		await this.sendEnter(sessionName);
		await this.sendEscape(sessionName);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await this.sendEscape(sessionName);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await this.sendEscape(sessionName);
		await this.sendEnter(sessionName);
	}

	/**
	 * Send control keys to a session using enhanced approach with session focusing
	 * Leverages some benefits of the robust script approach
	 */
	private async sendControlKey(sessionName: string, key: string): Promise<void> {
		try {
			// Get script path and socket name for consistent session handling
			const socketName = await this.getTmuxSocketName();

			// Use enhanced tmux command with socket consistency
			const args = ['-L', socketName, 'send-keys', '-t', sessionName, key];
			await this.executeTmuxCommand(args);
			await new Promise((resolve) => setTimeout(resolve, 100));
		} catch (error) {
			// Fallback to basic approach if enhanced method fails
			this.logger.debug('Enhanced control key method failed, using fallback', {
				sessionName,
				key,
				error,
			});
			await this.executeTmuxCommand(['send-keys', '-t', sessionName, key]);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	/**
	 * Send Enter key to a session
	 */
	async sendEnter(sessionName: string): Promise<void> {
		await this.sendControlKey(sessionName, 'Enter');
	}

	/**
	 * Send Ctrl+C to a session
	 */
	async sendCtrlC(sessionName: string): Promise<void> {
		await this.sendControlKey(sessionName, 'C-c');
	}

	/**
	 * Send Escape key to a session
	 */
	async sendEscape(sessionName: string): Promise<void> {
		await this.sendControlKey(sessionName, 'Escape');
	}

	/**
	 * Capture terminal output from a session (cached for 2 seconds to reduce frequent calls)
	 */
	async capturePane(sessionName: string, lines: number = 100): Promise<string> {
		const now = Date.now();
		const cacheKey = `${sessionName}:${lines}`;

		// Check cache first for frequent capture requests
		const cached = this.paneCache.get(cacheKey);
		if (cached && now - cached.timestamp < this.PANE_CACHE_TTL) {
			this.logger.debug('Using cached pane content', {
				sessionName,
				lines,
				age: now - cached.timestamp,
			});
			return cached.content;
		}

		try {
			// First check if session exists to avoid timing issues
			const sessionExists = await this.sessionExists(sessionName);
			if (!sessionExists) {
				this.logger.debug('Session does not exist for capture', { sessionName });
				return '';
			}

			// Small delay to ensure pane is ready after session creation
			await new Promise((resolve) => setTimeout(resolve, 100));

			const output = await this.executeTmuxCommand([
				'capture-pane',
				'-t',
				sessionName,
				'-p',
				'-S',
				`-${lines}`,
			]);

			// Cache the result
			this.paneCache.set(cacheKey, { content: output.trim(), timestamp: now });

			// Clean up old cache entries (keep only last 15)
			if (this.paneCache.size > 15) {
				const entries = Array.from(this.paneCache.entries());
				entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
				for (let i = 0; i < entries.length - 15; i++) {
					this.paneCache.delete(entries[i][0]);
				}
			}

			// Debug logging to see what's in the tmux pane
			this.logger.debug('🔍 Tmux pane capture:', {
				sessionName,
				lines: lines,
				outputLength: output.length,
				preview: output.slice(0, 200) + (output.length > 200 ? '...' : ''),
			});

			return output.trim();
		} catch (error) {
			// Check if it's a "can't find pane" error - this is usually temporary
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (errorMessage.includes("can't find pane")) {
				this.logger.debug('Pane not ready yet for capture', {
					sessionName,
					error: errorMessage,
				});
				// Return empty string without logging error - this is expected during session startup
				return '';
			}

			// Log other errors as they may be more serious
			this.logger.warn('Error capturing pane', { sessionName, error: errorMessage });
			return '';
		}
	}

	/**
	 * List all tmux sessions (rate limited and cached for 3 seconds)
	 *
	 * DORMANT: Returns empty array when tmux is disabled (PTY backend is active)
	 */
	async listSessions(): Promise<SessionInfo[]> {
		// DORMANT: Skip tmux operations when using PTY backend
		if (this.tmuxDisabled) {
			return [];
		}

		const now = Date.now();

		// Check if we have cached results
		if (
			this.cachedSessionList &&
			now - this.cachedSessionList.timestamp < this.LIST_SESSIONS_THROTTLE
		) {
			this.logger.debug('Using cached session list', {
				age: now - this.cachedSessionList.timestamp,
			});
			return this.cachedSessionList.sessions;
		}

		// Rate limiting: don't call list-sessions too frequently
		if (now - this.lastListSessions < this.LIST_SESSIONS_THROTTLE) {
			// Return cached data if available, empty array otherwise
			if (this.cachedSessionList) {
				this.logger.debug('Rate limited list-sessions, using cached data');
				return this.cachedSessionList.sessions;
			}
			return [];
		}

		this.lastListSessions = now;

		try {
			const output = await this.executeTmuxCommand([
				'list-sessions',
				'-F',
				'#{session_name}:#{session_created}:#{session_attached}:#{session_windows}',
			]);

			if (!output.trim()) {
				const emptyResult: SessionInfo[] = [];
				this.cachedSessionList = { sessions: emptyResult, timestamp: now };
				return emptyResult;
			}

			const sessions = output
				.trim()
				.split('\n')
				.map((line) => {
					const [sessionName, created, attached, windows] = line.split(':');
					return {
						sessionName,
						pid: 0, // tmux doesn't provide PID in this format
						windows: parseInt(windows) || 1,
						created: new Date(parseInt(created) * 1000).toISOString(),
						attached: attached === '1',
					};
				});

			// Cache the result
			this.cachedSessionList = { sessions, timestamp: now };

			this.logger.debug('Listed tmux sessions', {
				count: sessions.length,
				sessions: sessions.map((s) => s.sessionName),
			});

			return sessions;
		} catch (error) {
			this.logger.error('Error listing sessions', {
				error: error instanceof Error ? error.message : String(error),
			});
			// Don't cache errors, return cached data if available
			if (this.cachedSessionList) {
				return this.cachedSessionList.sessions;
			}
			return [];
		}
	}

	/**
	 * Create a new tmux session
	 */
	async createSession(
		sessionName: string,
		workingDirectory: string,
		windowName?: string
	): Promise<void> {
		const shell = CREWLY_CONSTANTS.SESSIONS.DEFAULT_SHELL;
		const createCommand = [
			'new-session',
			'-d',
			'-s',
			sessionName,
			'-c',
			workingDirectory,
			shell,
		];

		await this.executeTmuxCommand(createCommand);
		this.logger.info('Session created', { sessionName, workingDirectory, shell });

		// Wait for session to fully initialize to prevent race conditions
		// tmux session creation is asynchronous internally, so we need to ensure
		// the session is ready before executing subsequent commands
		const initializationDelay = process.env.NODE_ENV === 'test' ? 500 : 2000; // Shorter delay in tests
		await new Promise((resolve) => setTimeout(resolve, initializationDelay));

		// Validate session is ready for commands
		await this.validateSessionReady(sessionName);

		// Rename the window if specified
		if (windowName) {
			await this.executeTmuxCommand(['rename-window', '-t', `${sessionName}:0`, windowName]);
			this.logger.info('Window renamed', { sessionName, windowName });
		}
	}

	/**
	 * Validate that a session is ready for commands
	 * This helps prevent race conditions after session creation
	 */
	async validateSessionReady(sessionName: string): Promise<boolean> {
		const maxAttempts = 5;
		const retryDelay = process.env.NODE_ENV === 'test' ? 200 : 500; // Shorter delay in tests

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				// Try to list the specific session to verify it's responsive
				const output = await this.executeTmuxCommand([
					'list-sessions',
					'-F',
					'#{session_name}',
					'-f',
					`#{==:${sessionName},#{session_name}}`,
				]);

				// Check if session is listed and responsive
				if (output.trim() === sessionName) {
					// Additional check: try to capture pane to ensure it's fully ready
					await this.executeTmuxCommand(['capture-pane', '-t', sessionName, '-p']);
					this.logger.debug('Session validation successful', { sessionName, attempt });
					return true;
				}
			} catch (error) {
				this.logger.debug('Session validation attempt failed', {
					sessionName,
					attempt,
					maxAttempts,
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Wait before next attempt
			if (attempt < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, retryDelay));
			}
		}

		this.logger.warn('Session validation failed after all attempts', {
			sessionName,
			maxAttempts,
		});
		return false;
	}

	/**
	 * Set environment variable in a tmux session
	 */
	async setEnvironmentVariable(sessionName: string, key: string, value: string): Promise<void> {
		this.logger.debug('🔍 Setting environment variable:', { sessionName, key, value });
		// Use robust script approach for reliable message sending (includes Enter key automatically)
		await this.sendMessage(sessionName, `export ${key}="${value}"`);
		this.logger.info('✅ Environment variable set successfully', { sessionName, key });
	}

	/**
	 * Clear all caches for a specific session
	 */
	clearSessionCache(sessionName: string): void {
		// Clear session existence cache
		this.sessionCache.delete(sessionName);

		// Clear pane capture cache for this session (all line counts)
		const keysToDelete: string[] = [];
		for (const key of this.paneCache.keys()) {
			if (key.startsWith(`${sessionName}:`)) {
				keysToDelete.push(key);
			}
		}
		keysToDelete.forEach((key) => this.paneCache.delete(key));

		this.logger.debug('Cleared caches for session', {
			sessionName,
			clearedKeys: keysToDelete.length,
		});
	}

	/**
	 * Force clear all caches (useful for debugging or when cache becomes stale)
	 */
	clearAllCaches(): void {
		const sessionCacheSize = this.sessionCache.size;
		const paneCacheSize = this.paneCache.size;

		this.sessionCache.clear();
		this.paneCache.clear();
		this.cachedSessionList = null;

		this.logger.info('Cleared all tmux caches', {
			clearedSessionCache: sessionCacheSize,
			clearedPaneCache: paneCacheSize,
		});
	}

	/**
	 * Get cache statistics for monitoring
	 */
	getCacheStats(): {
		sessionCache: { size: number; entries: string[] };
		paneCache: { size: number; entries: string[] };
		sessionList: { cached: boolean; age?: number };
	} {
		return {
			sessionCache: {
				size: this.sessionCache.size,
				entries: Array.from(this.sessionCache.keys()),
			},
			paneCache: {
				size: this.paneCache.size,
				entries: Array.from(this.paneCache.keys()),
			},
			sessionList: {
				cached: this.cachedSessionList !== null,
				age: this.cachedSessionList
					? Date.now() - this.cachedSessionList.timestamp
					: undefined,
			},
		};
	}
}
