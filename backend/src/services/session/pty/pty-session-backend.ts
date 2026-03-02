/**
 * PTY Session Backend Module
 *
 * Implements the ISessionBackend interface using node-pty and @xterm/headless.
 * Provides a full terminal emulation backend with memory-bounded output buffers.
 *
 * @module pty-session-backend
 */

import type { ISessionBackend, ISession, SessionOptions } from '../session-backend.interface.js';
import {
	DEFAULT_TERMINAL_COLS,
	DEFAULT_TERMINAL_ROWS,
} from '../session-backend.interface.js';
import { PtySession } from './pty-session.js';
import { PtyTerminalBuffer } from './pty-terminal-buffer.js';
import { LoggerService, ComponentLogger } from '../../core/logger.service.js';
import { PTY_CONSTANTS, CREWLY_CONSTANTS } from '../../../constants.js';
import { PtyActivityTrackerService } from '../../agent/pty-activity-tracker.service.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * PTY Session Backend implementation.
 *
 * Manages terminal sessions using node-pty for process spawning and
 * @xterm/headless for terminal emulation and output buffering.
 *
 * Features:
 * - In-memory session management via Map
 * - Terminal emulation with xterm.js headless
 * - Memory-bounded output buffers (max 10MB)
 * - Proper cleanup on session termination
 *
 * @example
 * ```typescript
 * const backend = new PtySessionBackend();
 *
 * // Create a session
 * const session = await backend.createSession('dev', {
 *   cwd: '/home/user/project',
 *   command: '/bin/bash',
 * });
 *
 * // Capture output
 * const output = backend.captureOutput('dev', 50);
 *
 * // Cleanup
 * await backend.destroy();
 * ```
 */
export class PtySessionBackend implements ISessionBackend {
	/**
	 * Map of session names to PtySession instances
	 */
	private sessions: Map<string, PtySession> = new Map();

	/**
	 * Map of session names to PtyTerminalBuffer instances
	 */
	private terminalBuffers: Map<string, PtyTerminalBuffer> = new Map();

	/**
	 * Map of session names to cumulative output bytes since last compact
	 */
	private cumulativeOutputBytes: Map<string, number> = new Map();

	/**
	 * Map of session names to writable file streams for persistent session logs
	 */
	private sessionLogStreams: Map<string, fs.WriteStream> = new Map();

	/**
	 * Directory for persistent session log files
	 */
	private sessionLogsDir: string;

	/**
	 * Logger for this backend
	 */
	private logger: ComponentLogger;

	/**
	 * Regex patterns for stripping ANSI escape codes from terminal output
	 */
	private static readonly ANSI_STRIP_PATTERNS = [
		/\x1B\[[0-9;]*[a-zA-Z]/g,  // CSI sequences (colors, cursor, etc.)
		/\x1B\][^\x07]*\x07/g,     // OSC sequences (title, etc.)
		/\x1B\[\?[0-9;]*[hl]/g,    // Private mode set/reset
		/\x1B[()][AB012]/g,         // Character set selection
		/\x1B\[?[0-9;]*[JKH]/g,    // Erase and cursor positioning
	];

	/**
	 * Create a new PTY session backend.
	 */
	constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('PtySessionBackend');
		this.sessionLogsDir = path.join(
			os.homedir(),
			CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
			CREWLY_CONSTANTS.PATHS.LOGS_DIR,
			CREWLY_CONSTANTS.PATHS.SESSION_LOGS_DIR
		);
		// Ensure session logs directory exists
		try {
			fs.mkdirSync(this.sessionLogsDir, { recursive: true });
		} catch {
			// Non-fatal: logging will be skipped if dir can't be created
		}
		this.logger.info('PTY session backend initialized');
	}

	/**
	 * Create a new terminal session.
	 *
	 * @param name - Unique name for the session
	 * @param options - Session configuration options
	 * @returns Promise resolving to the created session
	 * @throws Error if session name already exists
	 *
	 * @example
	 * ```typescript
	 * const session = await backend.createSession('my-session', {
	 *   cwd: '/home/user',
	 *   command: '/bin/bash',
	 *   args: ['--login'],
	 *   env: { NODE_ENV: 'development' },
	 *   cols: 120,
	 *   rows: 40,
	 * });
	 * ```
	 */
	async createSession(name: string, options: SessionOptions): Promise<ISession> {
		if (this.sessions.has(name)) {
			this.logger.warn('Session already exists, killing before recreation', { name });
			await this.killSession(name);
		}

		this.logger.info('Creating PTY session', {
			name,
			command: options.command,
			cwd: options.cwd,
		});

		// Create the PTY session
		const session = new PtySession(name, options.cwd, options);

		// Create terminal buffer for output buffering and history
		const cols = options.cols ?? DEFAULT_TERMINAL_COLS;
		const rows = options.rows ?? DEFAULT_TERMINAL_ROWS;
		const terminalBuffer = new PtyTerminalBuffer(cols, rows);

		// Open persistent session log file stream (append mode with restart separator)
		this.openSessionLogStream(name);

		// Pipe session output to terminal buffer and record activity for idle detection.
		// Recording here (at session creation) ensures activity is tracked even when
		// no WebSocket client is viewing the terminal UI.
		session.onData((data) => {
			terminalBuffer.write(data);
			PtyActivityTrackerService.getInstance().recordActivity(name);
			// Track cumulative output for proactive compact triggering
			const current = this.cumulativeOutputBytes.get(name) ?? 0;
			this.cumulativeOutputBytes.set(name, current + data.length);
			// Write ANSI-stripped output to persistent session log file
			this.writeToSessionLog(name, data);
		});

		// Clean up on session exit
		session.onExit((code) => {
			this.logger.info('Session exited', { name, exitCode: code });
			// Don't delete here - let the session remain accessible until explicitly killed
		});

		// Store session and terminal buffer
		this.sessions.set(name, session);
		this.terminalBuffers.set(name, terminalBuffer);

		this.logger.info('PTY session created', {
			name,
			pid: session.pid,
			cols,
			rows,
		});

		return session;
	}

	/**
	 * Get an existing session by name.
	 *
	 * @param name - Name of the session to retrieve
	 * @returns The session if found, undefined otherwise
	 *
	 * @example
	 * ```typescript
	 * const session = backend.getSession('my-session');
	 * if (session) {
	 *   session.write('echo hello\n');
	 * }
	 * ```
	 */
	getSession(name: string): ISession | undefined {
		return this.sessions.get(name);
	}

	/**
	 * Kill a session by name.
	 *
	 * @param name - Name of the session to kill
	 * @returns Promise that resolves when the session is killed
	 *
	 * @example
	 * ```typescript
	 * await backend.killSession('my-session');
	 * ```
	 */
	async killSession(name: string): Promise<void> {
		const session = this.sessions.get(name);
		const terminalBuffer = this.terminalBuffers.get(name);

		if (session) {
			this.logger.info('Killing session', { name });
			session.kill();
			this.sessions.delete(name);
		}

		if (terminalBuffer) {
			terminalBuffer.dispose();
			this.terminalBuffers.delete(name);
		}

		this.cumulativeOutputBytes.delete(name);
		this.closeSessionLogStream(name);
		this.logger.debug('Session resources cleaned up', { name });
	}

	/**
	 * List all active session names.
	 *
	 * @returns Array of session names
	 *
	 * @example
	 * ```typescript
	 * const sessions = backend.listSessions();
	 * console.log('Active sessions:', sessions);
	 * ```
	 */
	listSessions(): string[] {
		return Array.from(this.sessions.keys());
	}

	/**
	 * Check if a session exists by name.
	 *
	 * @param name - Name of the session to check
	 * @returns true if the session exists, false otherwise
	 *
	 * @example
	 * ```typescript
	 * if (backend.sessionExists('my-session')) {
	 *   console.log('Session is running');
	 * }
	 * ```
	 */
	sessionExists(name: string): boolean {
		return this.sessions.has(name);
	}

	/**
	 * Get the cumulative output bytes for a session since last reset.
	 * Used by ContextWindowMonitorService for proactive compaction.
	 *
	 * @param name - Name of the session
	 * @returns Cumulative output bytes, or 0 if session not tracked
	 */
	getCumulativeOutputBytes(name: string): number {
		return this.cumulativeOutputBytes.get(name) ?? 0;
	}

	/**
	 * Reset the cumulative output byte counter for a session.
	 * Called after a proactive compact is triggered.
	 *
	 * @param name - Name of the session
	 */
	resetCumulativeOutput(name: string): void {
		this.cumulativeOutputBytes.set(name, 0);
	}

	/**
	 * Capture recent output from a session.
	 *
	 * @param name - Name of the session
	 * @param lines - Number of lines to capture (default: 100)
	 * @returns Captured output as a string
	 *
	 * @example
	 * ```typescript
	 * const output = backend.captureOutput('my-session', 50);
	 * console.log('Recent output:', output);
	 * ```
	 */
	captureOutput(name: string, lines = 100): string {
		const terminalBuffer = this.terminalBuffers.get(name);
		if (!terminalBuffer) {
			return '';
		}

		return terminalBuffer.getContent(lines);
	}

	/**
	 * Get the full terminal buffer content for a session.
	 *
	 * @param name - Name of the session
	 * @returns Full buffer content as a string
	 *
	 * @example
	 * ```typescript
	 * const buffer = backend.getTerminalBuffer('my-session');
	 * console.log('Full buffer:', buffer);
	 * ```
	 */
	getTerminalBuffer(name: string): string {
		const terminalBuffer = this.terminalBuffers.get(name);
		if (!terminalBuffer) {
			return '';
		}

		return terminalBuffer.getAllContent();
	}

	/**
	 * Get raw output history with ANSI escape codes preserved.
	 *
	 * @param name - Name of the session
	 * @returns Raw output history as a string with ANSI codes
	 *
	 * @example
	 * ```typescript
	 * const rawHistory = backend.getRawHistory('my-session');
	 * terminal.write(rawHistory);
	 * ```
	 */
	getRawHistory(name: string): string {
		const terminalBuffer = this.terminalBuffers.get(name);
		if (!terminalBuffer) {
			return '';
		}

		return terminalBuffer.getHistoryAsString();
	}

	/**
	 * Get the PIDs of all active sessions.
	 *
	 * @returns Array of process IDs for all active sessions
	 *
	 * @example
	 * ```typescript
	 * const pids = backend.getAllSessionPids();
	 * console.log('Active PIDs:', pids);
	 * ```
	 */
	getAllSessionPids(): number[] {
		const pids: number[] = [];
		for (const session of this.sessions.values()) {
			if (!session.isKilled()) {
				try {
					pids.push(session.pid);
				} catch {
					// PID may not be accessible if process already exited
				}
			}
		}
		return pids;
	}

	/**
	 * Destroy the backend and clean up all resources.
	 *
	 * @returns Promise that resolves when cleanup is complete
	 *
	 * @example
	 * ```typescript
	 * await backend.destroy();
	 * ```
	 */
	async destroy(): Promise<void> {
		this.logger.info('Destroying PTY session backend', {
			sessionCount: this.sessions.size,
		});

		// Kill all sessions
		const sessionNames = Array.from(this.sessions.keys());
		for (const name of sessionNames) {
			await this.killSession(name);
		}

		this.logger.info('PTY session backend destroyed');
	}

	/**
	 * Forcefully destroy all sessions with SIGTERM → SIGKILL escalation.
	 *
	 * This method is designed for shutdown scenarios where child processes
	 * (Claude Code, Gemini CLI) may catch or ignore SIGHUP/SIGTERM.
	 * It collects all PIDs upfront, sends SIGTERM, waits, then SIGKILLs
	 * each process and its process group.
	 *
	 * @returns Promise that resolves after the force-kill sequence completes
	 *
	 * @example
	 * ```typescript
	 * await backend.forceDestroyAll();
	 * ```
	 */
	async forceDestroyAll(): Promise<void> {
		const sessionCount = this.sessions.size;
		if (sessionCount === 0) {
			this.logger.debug('No sessions to force-destroy');
			return;
		}

		this.logger.info('Force-destroying all PTY sessions', { sessionCount });

		// Step 1: Collect all PIDs before sending any signals
		const pids = this.getAllSessionPids();
		this.logger.info('Collected PIDs for force-kill', { pids });

		// Step 2: Send SIGTERM to each session via node-pty
		for (const session of this.sessions.values()) {
			try {
				if (!session.isKilled()) {
					session.kill('SIGTERM');
				}
			} catch (err) {
				this.logger.debug('Error sending SIGTERM to session', {
					name: session.name,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Step 3: Wait for processes to exit gracefully
		await new Promise<void>((resolve) => setTimeout(resolve, PTY_CONSTANTS.FORCE_DESTROY_ESCALATION_DELAY));

		// Step 4: SIGKILL each PID and its process group
		for (const pid of pids) {
			try {
				process.kill(pid, 'SIGKILL');
				this.logger.debug('Sent SIGKILL to process', { pid });
			} catch {
				// ESRCH = process already gone
			}

			try {
				process.kill(-pid, 'SIGKILL');
				this.logger.debug('Sent SIGKILL to process group', { pgid: -pid });
			} catch {
				// ESRCH = process group already gone
			}
		}

		// Step 5: Clean up internal maps
		for (const terminalBuffer of this.terminalBuffers.values()) {
			terminalBuffer.dispose();
		}
		for (const [name] of this.sessionLogStreams) {
			this.closeSessionLogStream(name);
		}
		this.sessions.clear();
		this.terminalBuffers.clear();
		this.cumulativeOutputBytes.clear();

		this.logger.info('Force-destroyed all PTY sessions');
	}

	/**
	 * Check if a child process is alive inside a session's PTY shell.
	 *
	 * Delegates to PtySession.isChildProcessAlive() to detect whether
	 * the runtime (e.g. Claude Code) is still running inside the shell.
	 *
	 * @param name - Name of the session to check
	 * @returns true if the session exists and has a living child process
	 */
	isChildProcessAlive(name: string): boolean {
		const session = this.sessions.get(name);
		if (!session) {
			return false;
		}
		return session.isChildProcessAlive();
	}

	/**
	 * Get the number of active sessions.
	 *
	 * @returns Number of active sessions
	 */
	getSessionCount(): number {
		return this.sessions.size;
	}

	/**
	 * Resize a session's terminal.
	 *
	 * @param name - Name of the session
	 * @param cols - Number of columns
	 * @param rows - Number of rows
	 * @throws Error if session does not exist
	 */
	resizeSession(name: string, cols: number, rows: number): void {
		const session = this.sessions.get(name);
		const terminalBuffer = this.terminalBuffers.get(name);

		if (!session) {
			throw new Error(`Session '${name}' does not exist`);
		}

		session.resize(cols, rows);
		if (terminalBuffer) {
			terminalBuffer.resize(cols, rows);
		}

		this.logger.debug('Session resized', { name, cols, rows });
	}

	/**
	 * Get the raw output history for a session.
	 *
	 * This returns the raw bytes written to the terminal, including ANSI
	 * sequences. Useful for replaying the session.
	 *
	 * @param name - Name of the session
	 * @returns Raw output history as a string
	 *
	 * @example
	 * ```typescript
	 * const history = backend.getSessionHistory('my-session');
	 * ```
	 */
	getSessionHistory(name: string): string {
		const terminalBuffer = this.terminalBuffers.get(name);
		if (!terminalBuffer) {
			return '';
		}

		return terminalBuffer.getHistoryAsString();
	}

	/**
	 * Get the terminal buffer instance for a session.
	 *
	 * @param name - Name of the session
	 * @returns The PtyTerminalBuffer instance if found, undefined otherwise
	 */
	getTerminalBufferInstance(name: string): PtyTerminalBuffer | undefined {
		return this.terminalBuffers.get(name);
	}

	/**
	 * Get the file path for a session's persistent log file.
	 *
	 * @param sessionName - Name of the session
	 * @returns Absolute path to the session log file
	 */
	getSessionLogPath(sessionName: string): string {
		return path.join(this.sessionLogsDir, `${sessionName}.log`);
	}

	/**
	 * Open a writable file stream for a session log.
	 * If a log file already exists (from a previous run), appends a restart separator.
	 *
	 * @param sessionName - Name of the session
	 */
	private openSessionLogStream(sessionName: string): void {
		try {
			// Close any existing stream for this session
			this.closeSessionLogStream(sessionName);

			const logPath = this.getSessionLogPath(sessionName);
			const fileExists = fs.existsSync(logPath);

			const stream = fs.createWriteStream(logPath, { flags: 'a' });
			stream.on('error', (err) => {
				this.logger.warn('Session log stream error', {
					sessionName,
					error: err.message,
				});
			});

			// Write restart separator if file already exists
			if (fileExists) {
				stream.write(`\n--- SESSION RESTARTED at ${new Date().toISOString()} ---\n\n`);
			} else {
				stream.write(`--- SESSION STARTED at ${new Date().toISOString()} ---\n\n`);
			}

			this.sessionLogStreams.set(sessionName, stream);
		} catch (err) {
			this.logger.warn('Failed to open session log stream', {
				sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Write ANSI-stripped terminal data to a session's persistent log file.
	 *
	 * @param sessionName - Name of the session
	 * @param data - Raw terminal data (with ANSI codes)
	 */
	private writeToSessionLog(sessionName: string, data: string): void {
		const stream = this.sessionLogStreams.get(sessionName);
		if (!stream || stream.destroyed) return;

		// Strip ANSI escape codes for readable log output
		let stripped = data;
		for (const pattern of PtySessionBackend.ANSI_STRIP_PATTERNS) {
			stripped = stripped.replace(pattern, '');
		}

		// Only write if there's content after stripping
		if (stripped.length > 0) {
			stream.write(stripped);
		}
	}

	/**
	 * Close and remove the file stream for a session log.
	 *
	 * @param sessionName - Name of the session
	 */
	private closeSessionLogStream(sessionName: string): void {
		const stream = this.sessionLogStreams.get(sessionName);
		if (stream) {
			try {
				if (!stream.destroyed) {
					stream.end();
				}
			} catch {
				// Ignore close errors
			}
			this.sessionLogStreams.delete(sessionName);
		}
	}
}
