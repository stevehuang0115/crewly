/**
 * Session Command Helper
 *
 * Provides high-level terminal command operations using the ISessionBackend abstraction.
 * This helper bridges the gap between low-level PTY operations and the higher-level
 * commands that services like AgentRegistrationService need.
 *
 * Key mappings from TmuxCommandService:
 * - sendMessage → write(message + '\r')
 * - sendKey → write(keyCode)
 * - sendCtrlC → write('\x03')
 * - sendEnter → write('\r')
 * - clearCurrentCommandLine → write('\x03\x15') (Ctrl+C then Ctrl+U)
 * - capturePane → captureOutput()
 *
 * @module session-command-helper
 */

import type { ISession, ISessionBackend } from './session-backend.interface.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SESSION_COMMAND_DELAYS, EVENT_DELIVERY_CONSTANTS, TERMINAL_PATTERNS, PLAN_MODE_DISMISS_PATTERNS } from '../../constants.js';
import { delay } from '../../utils/async.utils.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';

/**
 * Key code mappings for special keys
 */
export const KEY_CODES: Record<string, string> = {
	Enter: '\r',
	'C-c': '\x03', // Ctrl+C
	'C-u': '\x15', // Ctrl+U (clear line)
	'C-l': '\x0c', // Ctrl+L (clear screen)
	'C-d': '\x04', // Ctrl+D (EOF)
	Escape: '\x1b',
	Tab: '\t',
	'S-Tab': '\x1b[Z', // Shift+Tab (reverse tab / focus previous in TUI)
	Backspace: '\x7f',
	Delete: '\x1b[3~',
	Up: '\x1b[A',
	Down: '\x1b[B',
	Right: '\x1b[C',
	Left: '\x1b[D',
	Home: '\x1b[H',
	End: '\x1b[F',
	PageUp: '\x1b[5~',
	PageDown: '\x1b[6~',
};

/**
 * Session Command Helper class
 *
 * Provides a unified interface for terminal commands that works with both
 * PTY and tmux backends through the ISessionBackend abstraction.
 */
export class SessionCommandHelper {
	private logger: ComponentLogger;
	private backend: ISessionBackend;

	constructor(backend: ISessionBackend) {
		this.logger = LoggerService.getInstance().createComponentLogger('SessionCommandHelper');
		this.backend = backend;
	}

	/**
	 * Get a session by name, throwing an error if it doesn't exist.
	 *
	 * @param sessionName - The name of the session to retrieve
	 * @returns The session instance
	 * @throws Error if the session does not exist
	 */
	private getSessionOrThrow(sessionName: string): ISession {
		const session = this.backend.getSession(sessionName);
		if (!session) {
			throw new Error(`Session '${sessionName}' does not exist`);
		}
		return session;
	}

	/**
	 * Check if a session exists
	 */
	sessionExists(sessionName: string): boolean {
		return this.backend.sessionExists(sessionName);
	}

	/**
	 * Get a session by name
	 */
	getSession(sessionName: string): ISession | undefined {
		return this.backend.getSession(sessionName);
	}

	/**
	 * Send a message to a session with Enter key.
	 * For multi-line messages, sends the text first then Enter separately
	 * to avoid bracketed paste mode issues where Enter is treated as part of the paste.
	 *
	 * @param sessionName - The session to send to
	 * @param message - The message to send
	 * @throws Error if session does not exist
	 */
	async sendMessage(sessionName: string, message: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);

		this.logger.debug('Sending message to session', {
			sessionName,
			messageLength: message.length,
			isMultiLine: message.includes('\n'),
		});

		// For multi-line messages, terminal may enter bracketed paste mode
		// Send text first, then Enter separately to ensure submission
		session.write(message);

		// Scale delay based on message size: large prompts (e.g. 409-line registration
		// prompts) need more time for Claude Code to process the bracketed paste.
		// Base delay + 1ms per 10 characters, capped at 5 seconds.
		const scaledDelay = Math.min(
			SESSION_COMMAND_DELAYS.MESSAGE_DELAY + Math.ceil(message.length / 10),
			5000
		);
		await delay(scaledDelay);

		// Send Enter explicitly as a separate keystroke
		// Use \r (carriage return) which is the standard Enter key in terminals
		session.write('\r');

		// Additional delay for Enter to be processed
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);

		// Log that we finished sending
		this.logger.debug('Message sent with Enter key', {
			sessionName,
			messageLength: message.length,
			pasteDelay: scaledDelay,
		});
	}

	/**
	 * Send a key to a session
	 *
	 * @param sessionName - The session to send to
	 * @param key - The key name (e.g., 'Enter', 'C-c', 'Escape')
	 * @throws Error if session does not exist or key is unknown
	 */
	async sendKey(sessionName: string, key: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);

		const keyCode = KEY_CODES[key];
		if (!keyCode) {
			// If not a special key, send as literal
			session.write(key);
		} else {
			session.write(keyCode);
		}

		this.logger.debug('Sent key to session', {
			sessionName,
			key,
			isSpecialKey: !!keyCode,
		});

		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Send Ctrl+C to a session
	 */
	async sendCtrlC(sessionName: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);
		session.write('\x03');
		this.logger.debug('Sent Ctrl+C to session', { sessionName });
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Send Enter key to a session
	 */
	async sendEnter(sessionName: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);
		session.write('\r');
		this.logger.debug('Sent Enter to session', { sessionName });
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Send Escape key to a session
	 */
	async sendEscape(sessionName: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);
		session.write('\x1b');
		this.logger.debug('Sent Escape to session', { sessionName });
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Detect and dismiss interactive prompts (e.g., plan mode) before message delivery.
	 * Checks the last terminal output for plan mode patterns and sends Escape to exit
	 * if detected. This prevents agents from getting permanently stuck in plan mode.
	 *
	 * @param sessionName - The session to check
	 * @returns True if an interactive prompt was detected and dismissed
	 */
	async dismissInteractivePromptIfNeeded(sessionName: string): Promise<boolean> {
		const output = this.capturePane(sessionName);

		// Guard: do NOT send ESC if the agent is actively processing.
		// ESC during processing triggers Claude Code's Rewind mode, which
		// permanently blocks input. Two ESCs = unrecoverable Rewind UI takeover.
		// Use PTY idle time for robust cross-runtime detection instead of regex.
		const idleMs = PtyActivityTrackerService.getInstance().getIdleTimeMs(sessionName);
		const isBusy = idleMs < SESSION_COMMAND_DELAYS.AGENT_BUSY_IDLE_THRESHOLD_MS;
		if (isBusy) {
			this.logger.debug('Skipping plan mode dismissal — agent is busy', {
				sessionName,
			});
			return false;
		}

		// Restrict plan mode detection to the last 500 chars to avoid
		// false-positives from historical output further up the buffer.
		const recentOutput = output.slice(-500);
		const isPlanMode = PLAN_MODE_DISMISS_PATTERNS.some(pattern => pattern.test(recentOutput));

		if (isPlanMode) {
			this.logger.warn('Plan mode detected in session, sending Escape to dismiss', {
				sessionName,
			});
			await this.sendEscape(sessionName);
			await delay(SESSION_COMMAND_DELAYS.CLAUDE_RECOVERY_DELAY);
			return true;
		}

		return false;
	}

	/**
	 * Clear the current command line in a session
	 * Sends Ctrl+C followed by Ctrl+U to cancel any input and clear the line
	 */
	async clearCurrentCommandLine(sessionName: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);

		// Ctrl+C to cancel any running command
		session.write('\x03');
		await delay(SESSION_COMMAND_DELAYS.CLEAR_COMMAND_DELAY);

		// Ctrl+U to clear the current line
		session.write('\x15');

		this.logger.debug('Cleared command line', { sessionName });
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Capture terminal output from a session.
	 *
	 * Strips trailing empty lines that result from empty terminal rows below
	 * the actual content. Large terminals (e.g., maximized browser windows)
	 * can have 50+ empty rows below the prompt, which would cause prompt
	 * detection to fail if the capture window is too small.
	 *
	 * @param sessionName - The session to capture from
	 * @param lines - Number of lines to capture (default: 200)
	 * @returns The captured terminal content with trailing empty lines removed
	 */
	capturePane(sessionName: string, lines: number = 200): string {
		const output = this.backend.captureOutput(sessionName, lines);
		// Strip trailing empty/whitespace-only lines from terminal buffer.
		// xterm.js returns empty rows for unused terminal space below content.
		// NOTE: The previous regex /(\n\s*)+$/ caused catastrophic backtracking
		// (ReDoS) because \s* includes \n, creating exponential backtracking on
		// long terminal output with many trailing blank lines. This iterative
		// approach is O(n) and immune to ReDoS.
		const outputLines = output.split('\n');
		let lastContentLine = outputLines.length - 1;
		while (lastContentLine >= 0 && outputLines[lastContentLine].trim() === '') {
			lastContentLine--;
		}
		if (lastContentLine < 0) return '\n';
		return outputLines.slice(0, lastContentLine + 1).join('\n') + '\n';
	}

	/**
	 * Get raw output history with ANSI escape codes preserved.
	 *
	 * @param sessionName - The session to get history from
	 * @returns Raw output history with ANSI codes
	 */
	getRawHistory(sessionName: string): string {
		return this.backend.getRawHistory(sessionName);
	}

	/**
	 * List all active sessions
	 */
	listSessions(): string[] {
		return this.backend.listSessions();
	}

	/**
	 * Kill a session
	 */
	async killSession(sessionName: string): Promise<void> {
		await this.backend.killSession(sessionName);
		this.logger.info('Session killed', { sessionName });
	}

	/**
	 * Create a new session
	 *
	 * @param sessionName - Unique name for the session
	 * @param cwd - Working directory for the session
	 * @param options - Additional session options
	 * @returns The created session
	 */
	async createSession(
		sessionName: string,
		cwd: string,
		options?: {
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			cols?: number;
			rows?: number;
		}
	): Promise<ISession> {
		this.logger.info('Creating session', { sessionName, cwd });

		// Default to shell if no command specified
		const command = options?.command || process.env.SHELL || '/bin/bash';

		const session = await this.backend.createSession(sessionName, {
			cwd,
			command,
			args: options?.args,
			env: options?.env,
			cols: options?.cols,
			rows: options?.rows,
		});

		this.logger.info('Session created', { sessionName, pid: session.pid });
		return session;
	}

	/**
	 * Set an environment variable in a session by executing export command
	 * Note: This only affects new commands run in the session
	 */
	async setEnvironmentVariable(
		sessionName: string,
		key: string,
		value: string
	): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);

		// Export the variable
		session.write(`export ${key}="${value}"\r`);
		this.logger.debug('Set environment variable', { sessionName, key });
		await delay(SESSION_COMMAND_DELAYS.ENV_VAR_DELAY);
	}

	/**
	 * Resize a session's terminal
	 */
	resizeSession(sessionName: string, cols: number, rows: number): void {
		const session = this.getSessionOrThrow(sessionName);
		session.resize(cols, rows);
		this.logger.debug('Session resized', { sessionName, cols, rows });
	}

	/**
	 * Get the underlying backend
	 */
	getBackend(): ISessionBackend {
		return this.backend;
	}

	/**
	 * Subscribe to session output events.
	 *
	 * This method provides direct access to the terminal output stream,
	 * enabling event-driven processing instead of polling.
	 *
	 * @param sessionName - The session to subscribe to
	 * @param callback - Function called on each data event
	 * @returns Unsubscribe function to stop receiving events
	 * @throws Error if session does not exist
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = helper.subscribeToOutput('my-session', (data) => {
	 *   console.log('Received:', data);
	 * });
	 * // Later: unsubscribe();
	 * ```
	 */
	subscribeToOutput(sessionName: string, callback: (data: string) => void): () => void {
		const session = this.getSessionOrThrow(sessionName);
		this.logger.debug('Subscribing to session output', { sessionName });
		return session.onData(callback);
	}

	/**
	 * Subscribe to session exit events.
	 *
	 * @param sessionName - The session to subscribe to
	 * @param callback - Function called when session exits with exit code
	 * @returns Unsubscribe function to stop receiving events
	 * @throws Error if session does not exist
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = helper.subscribeToExit('my-session', (code) => {
	 *   console.log('Session exited with code:', code);
	 * });
	 * ```
	 */
	subscribeToExit(sessionName: string, callback: (code: number) => void): () => void {
		const session = this.getSessionOrThrow(sessionName);
		this.logger.debug('Subscribing to session exit', { sessionName });
		return session.onExit(callback);
	}

	/**
	 * Wait for a pattern to appear in session output.
	 *
	 * Subscribes to the output stream and resolves when the pattern is found.
	 * Useful for waiting for specific prompts or indicators.
	 *
	 * @param sessionName - The session to monitor
	 * @param pattern - RegExp or string to match against output
	 * @param timeoutMs - Maximum time to wait (default: 30 seconds)
	 * @returns Promise resolving to the accumulated buffer when pattern matches
	 * @throws Error if timeout or session does not exist
	 *
	 * @example
	 * ```typescript
	 * // Wait for Claude prompt
	 * const output = await helper.waitForPattern('agent-1', />\s*$/, 10000);
	 * console.log('Claude is ready:', output);
	 * ```
	 */
	async waitForPattern(
		sessionName: string,
		pattern: RegExp | string,
		timeoutMs: number = EVENT_DELIVERY_CONSTANTS.DEFAULT_PATTERN_TIMEOUT
	): Promise<string> {
		const session = this.getSessionOrThrow(sessionName);

		return new Promise<string>((resolve, reject) => {
			let buffer = '';
			let resolved = false;

			const cleanup = () => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeoutId);
					unsubscribe();
				}
			};

			const timeoutId = setTimeout(() => {
				cleanup();
				this.logger.debug('waitForPattern timed out', {
					sessionName,
					pattern: pattern.toString(),
					bufferLength: buffer.length,
				});
				reject(new Error(`Timeout waiting for pattern: ${pattern}`));
			}, timeoutMs);

			const unsubscribe = session.onData((data) => {
				if (resolved) return;

				buffer += data;

				const match =
					typeof pattern === 'string' ? buffer.includes(pattern) : pattern.test(buffer);

				if (match) {
					this.logger.debug('Pattern matched in output', {
						sessionName,
						pattern: pattern.toString(),
						bufferLength: buffer.length,
					});
					cleanup();
					resolve(buffer);
				}
			});
		});
	}

	/**
	 * Wait for any of multiple patterns to appear in session output.
	 *
	 * Useful when multiple outcomes are possible (e.g., success or error).
	 *
	 * @param sessionName - The session to monitor
	 * @param patterns - Array of patterns with identifiers
	 * @param timeoutMs - Maximum time to wait
	 * @returns Promise resolving to which pattern matched and the buffer
	 *
	 * @example
	 * ```typescript
	 * const result = await helper.waitForAnyPattern('agent-1', [
	 *   { id: 'prompt', pattern: />\s*$/ },
	 *   { id: 'error', pattern: /error:/i },
	 * ], 10000);
	 *
	 * if (result.matchedId === 'error') {
	 *   console.log('Error occurred:', result.buffer);
	 * }
	 * ```
	 */
	async waitForAnyPattern(
		sessionName: string,
		patterns: Array<{ id: string; pattern: RegExp | string }>,
		timeoutMs: number = EVENT_DELIVERY_CONSTANTS.DEFAULT_PATTERN_TIMEOUT
	): Promise<{ matchedId: string; buffer: string }> {
		const session = this.getSessionOrThrow(sessionName);

		return new Promise((resolve, reject) => {
			let buffer = '';
			let resolved = false;

			const cleanup = () => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeoutId);
					unsubscribe();
				}
			};

			const timeoutId = setTimeout(() => {
				cleanup();
				this.logger.debug('waitForAnyPattern timed out', {
					sessionName,
					patternCount: patterns.length,
					bufferLength: buffer.length,
				});
				reject(new Error(`Timeout waiting for any pattern`));
			}, timeoutMs);

			const unsubscribe = session.onData((data) => {
				if (resolved) return;

				buffer += data;

				for (const { id, pattern } of patterns) {
					const match =
						typeof pattern === 'string' ? buffer.includes(pattern) : pattern.test(buffer);

					if (match) {
						this.logger.debug('Pattern matched in waitForAnyPattern', {
							sessionName,
							matchedId: id,
							pattern: pattern.toString(),
						});
						cleanup();
						resolve({ matchedId: id, buffer });
						return;
					}
				}
			});
		});
	}

	/**
	 * Send message and wait for delivery confirmation via events.
	 *
	 * This is the core event-driven message delivery method. It:
	 * 1. Sends the message to the terminal
	 * 2. Subscribes to output to detect confirmation patterns
	 * 3. Resolves when confirmation is detected or timeout occurs
	 *
	 * @param sessionName - The session to send to
	 * @param message - The message to send
	 * @param confirmationPattern - Pattern indicating successful delivery
	 * @param timeoutMs - Maximum time to wait for confirmation
	 * @returns Promise resolving to true if confirmed, false if timeout
	 *
	 * @example
	 * ```typescript
	 * // Send message and wait for processing indicator
	 * const confirmed = await helper.sendMessageWithConfirmation(
	 *   'agent-1',
	 *   'Hello Claude',
	 *   /⠋|⠙|⠹|Thinking/,
	 *   5000
	 * );
	 * ```
	 */
	async sendMessageWithConfirmation(
		sessionName: string,
		message: string,
		confirmationPattern: RegExp | string,
		timeoutMs: number = EVENT_DELIVERY_CONSTANTS.DELIVERY_CONFIRMATION_TIMEOUT
	): Promise<boolean> {
		const session = this.getSessionOrThrow(sessionName);

		return new Promise<boolean>((resolve) => {
			let confirmed = false;
			let resolved = false;

			const cleanup = () => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeoutId);
					unsubscribe();
				}
			};

			const timeoutId = setTimeout(() => {
				this.logger.debug('sendMessageWithConfirmation timed out', {
					sessionName,
					messageLength: message.length,
					confirmed,
				});
				cleanup();
				resolve(confirmed);
			}, timeoutMs);

			const unsubscribe = session.onData((data) => {
				if (resolved) return;

				const match =
					typeof confirmationPattern === 'string'
						? data.includes(confirmationPattern)
						: confirmationPattern.test(data);

				if (match) {
					this.logger.debug('Message delivery confirmed', {
						sessionName,
						pattern: confirmationPattern.toString(),
					});
					confirmed = true;
					cleanup();
					resolve(true);
				}
			});

			// Send the message
			this.logger.debug('Sending message with confirmation tracking', {
				sessionName,
				messageLength: message.length,
			});

			session.write(message);

			// Send Enter after a brief delay (for bracketed paste mode)
			setTimeout(() => {
				if (!resolved) {
					session.write('\r');
				}
			}, SESSION_COMMAND_DELAYS.MESSAGE_DELAY);
		});
	}

	/**
	 * Smart message sending with event-driven paste detection.
	 *
	 * This method intelligently handles bracketed paste mode by:
	 * 1. Sending the message text
	 * 2. Waiting for "[Pasted text" indicator (paste received)
	 * 3. Sending Enter key only after paste is confirmed
	 * 4. Optionally waiting for processing indicators
	 *
	 * This is much more reliable than fixed delays because it detects
	 * the actual terminal state rather than guessing timing.
	 *
	 * @param sessionName - The session to send to
	 * @param message - The message to send
	 * @param options - Configuration options
	 * @returns Promise with delivery result
	 *
	 * @example
	 * ```typescript
	 * const result = await helper.sendMessageSmart('agent-1', 'Hello', {
	 *   waitForProcessing: true,
	 *   pasteTimeout: 3000,
	 * });
	 * if (result.pasteDetected && result.processingStarted) {
	 *   console.log('Message delivered and being processed');
	 * }
	 * ```
	 */
	async sendMessageSmart(
		sessionName: string,
		message: string,
		options: {
			/** Timeout for detecting paste confirmation (ms) */
			pasteTimeout?: number;
			/** Timeout for detecting processing start (ms) */
			processingTimeout?: number;
			/** Whether to wait for processing indicators after sending */
			waitForProcessing?: boolean;
			/** Custom pattern for paste detection (default: /\[Pasted text/) */
			pastePattern?: RegExp;
			/** Custom pattern for processing detection (default: spinner/thinking) */
			processingPattern?: RegExp;
			/** Fallback delay if paste not detected (ms) - sends Enter anyway */
			fallbackDelay?: number;
		} = {}
	): Promise<{
		pasteDetected: boolean;
		enterSent: boolean;
		processingStarted: boolean;
		usedFallback: boolean;
	}> {
		const session = this.getSessionOrThrow(sessionName);
		const {
			pasteTimeout = 3000,
			processingTimeout = 5000,
			waitForProcessing = false,
			pastePattern = TERMINAL_PATTERNS.PASTE_INDICATOR,
			processingPattern = TERMINAL_PATTERNS.PROCESSING,
			fallbackDelay = 1500,
		} = options;

		const result = {
			pasteDetected: false,
			enterSent: false,
			processingStarted: false,
			usedFallback: false,
		};

		this.logger.debug('Smart message send starting', {
			sessionName,
			messageLength: message.length,
			isMultiLine: message.includes('\n'),
		});

		// Step 1: Send the message text (without Enter)
		session.write(message);

		// Step 2: Wait for paste detection or fallback
		try {
			await this.waitForPattern(sessionName, pastePattern, pasteTimeout);
			result.pasteDetected = true;
			this.logger.debug('Paste detected via pattern', { sessionName });
		} catch {
			// Paste pattern not detected within timeout - use fallback delay
			this.logger.debug('Paste pattern not detected, using fallback delay', {
				sessionName,
				fallbackDelay,
			});
			await delay(fallbackDelay);
			result.usedFallback = true;
		}

		// Step 3: Send Enter key
		session.write('\r');
		result.enterSent = true;
		this.logger.debug('Enter key sent', { sessionName });

		// Step 4: Optionally wait for processing indicators
		if (waitForProcessing) {
			try {
				await this.waitForPattern(sessionName, processingPattern, processingTimeout);
				result.processingStarted = true;
				this.logger.debug('Processing started', { sessionName });
			} catch {
				this.logger.debug('Processing pattern not detected within timeout', {
					sessionName,
				});
			}
		}

		this.logger.debug('Smart message send complete', {
			sessionName,
			result,
		});

		return result;
	}

	/**
	 * Send message with retry logic using smart detection.
	 *
	 * Attempts to deliver a message with intelligent retry behavior:
	 * - Uses event-driven paste detection
	 * - Retries with Enter key if message appears stuck
	 * - Detects common failure modes (prompt still visible, no response)
	 *
	 * @param sessionName - The session to send to
	 * @param message - The message to send
	 * @param maxRetries - Maximum number of retry attempts
	 * @returns Promise resolving to true if message was successfully processed
	 */
	async sendMessageWithSmartRetry(
		sessionName: string,
		message: string,
		maxRetries: number = 3
	): Promise<boolean> {
		const session = this.getSessionOrThrow(sessionName);

		// Dismiss plan mode if detected before attempting message delivery
		await this.dismissInteractivePromptIfNeeded(sessionName);

		// Use centralized patterns for consistency
		const stuckPattern = TERMINAL_PATTERNS.PASTE_STUCK;
		const processingPattern = TERMINAL_PATTERNS.PROCESSING;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			this.logger.debug('Smart retry attempt', { sessionName, attempt, maxRetries });

			if (attempt === 1) {
				// First attempt: use smart send
				const result = await this.sendMessageSmart(sessionName, message, {
					waitForProcessing: true,
					pasteTimeout: 3000,
					processingTimeout: 5000,
				});

				if (result.processingStarted) {
					this.logger.debug('Message delivered on first attempt', { sessionName });
					return true;
				}
			} else {
				// Retry attempts: just send Enter and check
				this.logger.debug('Sending retry Enter', { sessionName, attempt });
				session.write('\r');
			}

			// Wait a moment and check terminal state
			await delay(1000);

			// Capture current output to check state
			const output = this.backend.captureOutput(sessionName, 10);

			// Check if stuck (paste indicator still visible)
			if (stuckPattern.test(output)) {
				this.logger.debug('Message appears stuck, will retry with Enter', {
					sessionName,
					attempt,
				});
				continue;
			}

			// Check if processing started
			if (processingPattern.test(output)) {
				this.logger.debug('Processing detected after retry', { sessionName, attempt });
				return true;
			}

			// Check if prompt appeared (message may have been processed already)
			if (output.includes('❯') && !output.includes('[Pasted text')) {
				this.logger.debug('Prompt visible without paste indicator - likely processed', {
					sessionName,
					attempt,
				});
				return true;
			}
		}

		this.logger.warn('Message delivery failed after all retries', {
			sessionName,
			maxRetries,
		});
		return false;
	}

	/**
	 * Write raw data to session without Enter key.
	 *
	 * Useful for sending partial input or special key sequences.
	 *
	 * @param sessionName - The session to write to
	 * @param data - Data to write
	 * @throws Error if session does not exist
	 */
	writeRaw(sessionName: string, data: string): void {
		const session = this.getSessionOrThrow(sessionName);
		session.write(data);
		this.logger.debug('Wrote raw data to session', {
			sessionName,
			dataLength: data.length,
		});
	}

}

/**
 * Create a SessionCommandHelper instance
 */
export function createSessionCommandHelper(backend: ISessionBackend): SessionCommandHelper {
	return new SessionCommandHelper(backend);
}
