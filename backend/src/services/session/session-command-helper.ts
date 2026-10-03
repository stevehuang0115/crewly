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
import { SESSION_COMMAND_DELAYS, EVENT_DELIVERY_CONSTANTS, PLAN_MODE_DISMISS_PATTERNS, TUI_INPUT_GUARD } from '../../constants.js';
import { delay } from '../../utils/async.utils.js';
import { assertNotSecretEnvKey } from '../../utils/secret-env.js';
import { quietShellLine } from '../../utils/shell-history.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';
import { classifyTuiInput, TuiInputGuardError, type TuiInputReading, type TuiInputStage } from './tui-input-guard.js';
import { noteHarnessWrite } from '../trace/turn-origin.js';

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
	// Function keys — F12 is used to toggle Gemini CLI's error details panel (#130)
	F1: '\x1bOP',
	F2: '\x1bOQ',
	F3: '\x1bOR',
	F4: '\x1bOS',
	F5: '\x1b[15~',
	F6: '\x1b[17~',
	F7: '\x1b[18~',
	F8: '\x1b[19~',
	F9: '\x1b[20~',
	F10: '\x1b[21~',
	F11: '\x1b[23~',
	F12: '\x1b[24~',
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
	 * Send a message to an agent session and submit it with Enter — guarded.
	 *
	 * The harness only submits its own text (2026-10-03 phantom-input
	 * incident: a predicted "owner" message sitting in Claude Code's input
	 * was submitted with a delivery):
	 *
	 * 1. Before typing, the input box must be readable and empty. A leftover
	 *    exact copy of this message (an earlier attempt) is cleared; anything
	 *    else — someone's half-typed text, an unreadable screen — is left
	 *    untouched and nothing is typed.
	 * 2. The message is pasted (bracketed paste) without Enter.
	 * 3. Enter is pressed only when the box holds exactly the message (or the
	 *    runtime's collapsed "[Pasted text …]" marker). Otherwise nothing is
	 *    submitted and nothing is cleared: text we cannot prove is ours is
	 *    never wiped.
	 *
	 * A refusal throws `TuiInputGuardError`; agent delivery keeps the message
	 * queued and retries (AgentRegistrationService). Shell command lines
	 * typed before a runtime starts use {@link sendShellLine} instead.
	 *
	 * @param sessionName - The session to send to
	 * @param message - The message to send
	 * @throws Error if session does not exist
	 * @throws TuiInputGuardError when the box is unreadable or not ours
	 */
	async sendMessage(sessionName: string, message: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);

		this.logger.debug('Sending message to session', {
			sessionName,
			messageLength: message.length,
			isMultiLine: message.includes('\n'),
		});

		// Step 1: the box must be readable and empty before we type.
		let before = this.readInputBox(sessionName, message, 'before-write');
		if (before.state === 'ours') {
			// Our own earlier paste of this very message: safe to clear.
			before = await this.clearInputBox(sessionName, message, before);
		}
		if (before.state !== 'empty') {
			this.logger.warn('Not typing into the input box: it is unreadable or holds text the harness did not write', {
				sessionName,
				state: before.state,
				layout: before.layout,
				inputPreview: before.text.slice(0, 80),
			});
			throw new TuiInputGuardError('before-write', before);
		}

		// Step 2: paste. Wrap the message in bracketed paste markers
		// (\x1b[200~ ... \x1b[201~) so TUI applications (Gemini CLI, Codex CLI,
		// Claude Code) treat it as pasted text rather than typed keystrokes.
		// Without this, special characters like (), $, `, and " can trigger
		// shell mode or be read as key sequences in Gemini CLI (#292, #293).
		session.write(`\x1b[200~${message}\x1b[201~`);

		// Scale delay based on message size: large prompts (e.g. 409-line registration
		// prompts) need more time for Claude Code to process the bracketed paste.
		// Base delay + 1ms per 10 characters, capped at 5 seconds.
		const scaledDelay = Math.min(
			SESSION_COMMAND_DELAYS.MESSAGE_DELAY + Math.ceil(message.length / 10),
			5000
		);
		await delay(scaledDelay);

		// Step 3: submit only our own text.
		let after = this.readInputBox(sessionName, message, 'after-paste');
		for (const waitMs of TUI_INPUT_GUARD.PASTE_RENDER_RETRY_MS) {
			if (after.state !== 'empty') break;
			await delay(waitMs); // the paste may not have rendered yet
			after = this.readInputBox(sessionName, message, 'after-paste');
		}
		if (after.state !== 'ours') {
			this.logger.warn('Input box does not hold exactly our text after the paste — not pressing Enter, not clearing', {
				sessionName,
				state: after.state,
				layout: after.layout,
				inputPreview: after.text.slice(0, 80),
			});
			throw new TuiInputGuardError('before-submit', after);
		}

		// The prompt this Enter submits is a harness delivery: a submitted
		// prompt with no such write before it is recorded as unsolicited.
		noteHarnessWrite(sessionName);

		// Send Enter explicitly as a separate keystroke
		// Use \r (carriage return) which is the standard Enter key in terminals
		session.write('\r');

		// Additional delay for Enter to be processed
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);

		this.logger.debug('Message sent with Enter key', {
			sessionName,
			messageLength: message.length,
			pasteDelay: scaledDelay,
			layout: after.layout,
		});
	}

	/**
	 * Type a command line into a plain shell and run it (paste + Enter).
	 *
	 * Only for the lines Crewly types into a session's login shell before a
	 * runtime starts there (history off, `cd`, PATH, the launch command). It
	 * does not read an input box: a shell has none. Never use it to talk to
	 * an agent — that is {@link sendMessage}.
	 *
	 * @param sessionName - The session
	 * @param line - The command line
	 */
	async sendShellLine(sessionName: string, line: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);
		session.write(`\x1b[200~${line}\x1b[201~`);
		await delay(Math.min(SESSION_COMMAND_DELAYS.MESSAGE_DELAY + Math.ceil(line.length / 10), 5000));
		session.write('\r');
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Read what an agent's input box really holds, relative to a message.
	 *
	 * Uses the backend's faint-free screen view, so ghost text (Claude Code's
	 * prompt suggestion, placeholders) reads as an empty box. Returns
	 * `unknown` when the backend has no styled capture or no input box of a
	 * known layout is on screen.
	 *
	 * @param sessionName - The session to read
	 * @param message - The harness's message to compare against ('' for none)
	 * @param stage - Why it is read (see classifyTuiInput)
	 * @returns The reading
	 */
	readInputBox(sessionName: string, message: string, stage: TuiInputStage = 'recovery'): TuiInputReading {
		const capture = this.backend.captureInputView;
		if (typeof capture !== 'function') return { state: 'unknown', text: '', lineCount: 0 };
		try {
			const view = capture.call(this.backend, sessionName);
			if (!view) return { state: 'unknown', text: '', lineCount: 0 };
			return classifyTuiInput(view, message, stage);
		} catch {
			return { state: 'unknown', text: '', lineCount: 0 };
		}
	}

	/**
	 * Empty the input box — only call it for text proven to be the harness's
	 * own. Sends Ctrl+U then Backspace (clear the line, join the empty line to
	 * the one above), re-reading after each pair, until the box reads empty;
	 * one pair per line plus a margin (verified live on Claude Code, Codex
	 * and Gemini). A box that stops being readable is not "cleared": the
	 * final reading is then `unknown`, and callers treat only `empty` as
	 * success. Never sends Escape (cancels a running Claude Code turn; twice
	 * opens Rewind) or Ctrl+C (twice exits).
	 *
	 * @param sessionName - The session
	 * @param message - The harness's message, for classification
	 * @param current - A reading just taken (saves one re-read)
	 * @returns The final reading (`empty` when cleared)
	 */
	async clearInputBox(sessionName: string, message: string, current?: TuiInputReading): Promise<TuiInputReading> {
		const session = this.getSessionOrThrow(sessionName);
		let reading = current ?? this.readInputBox(sessionName, message, 'before-write');
		if (reading.state === 'empty' || reading.state === 'unknown') return reading;
		const lines = Math.max(reading.lineCount, message.split('\n').length, 1);
		const budget = Math.min(lines + TUI_INPUT_GUARD.CLEAR_PAIRS_EXTRA, TUI_INPUT_GUARD.CLEAR_PAIRS_MAX);
		for (let i = 0; i < budget; i++) {
			session.write(TUI_INPUT_GUARD.CLEAR_KEY);
			session.write(TUI_INPUT_GUARD.JOIN_KEY);
			await delay(TUI_INPUT_GUARD.CLEAR_SETTLE_MS);
			reading = this.readInputBox(sessionName, message, 'before-write');
			if (reading.state === 'empty' || reading.state === 'unknown') break;
		}
		if (reading.state !== 'empty') {
			this.logger.warn('Input box did not clear', { sessionName, state: reading.state, budget });
		}
		return reading;
	}

	/**
	 * Press Enter only when the input box holds exactly the harness's text.
	 * The safe replacement for "press Enter / Tab+Enter to recover a stuck
	 * message": an empty box (which may show a ghost suggestion) or a box
	 * with anyone else's text is never submitted.
	 *
	 * @param sessionName - The session
	 * @param message - The message the harness wrote
	 * @returns The reading; Enter was pressed only when its state is `ours`
	 */
	async submitIfInputIsOurs(sessionName: string, message: string): Promise<TuiInputReading> {
		const reading = this.readInputBox(sessionName, message, 'recovery');
		if (reading.state !== 'ours') {
			this.logger.debug('Not pressing Enter — input box does not hold our text', {
				sessionName,
				state: reading.state,
			});
			return reading;
		}
		const session = this.getSessionOrThrow(sessionName);
		noteHarnessWrite(sessionName);
		session.write('\r');
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
		return reading;
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
	 * Set an environment variable in a session by typing an `export` command.
	 *
	 * Only for non-secret values: the shell echoes the typed line, so the value
	 * ends up in scrollback, the persistent session log and the terminal-output
	 * API. Secrets (API keys, tokens, passwords) belong in the spawn environment
	 * (`createSession(..., { env })`) and are refused here.
	 * Note: This only affects new commands run in the session.
	 *
	 * @param sessionName - Session to type into
	 * @param key - Variable name
	 * @param value - Variable value (not secret)
	 * @throws Error when `key` names a secret (see utils/secret-env) or the session does not exist
	 */
	async setEnvironmentVariable(
		sessionName: string,
		key: string,
		value: string
	): Promise<void> {
		assertNotSecretEnvKey(key);
		const session = this.getSessionOrThrow(sessionName);

		// Export the variable — space-prefixed so the line stays out of shell history
		session.write(`${quietShellLine(`export ${key}="${value}"`)}\r`);
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
