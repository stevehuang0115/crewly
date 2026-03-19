/**
 * Session Backend Interface Module
 *
 * Defines the abstraction layer interfaces for terminal session backends.
 * This enables the Crewly system to use terminal session backends
 * without changing the higher-level code that uses these interfaces.
 *
 * @module session-backend.interface
 */

/**
 * Represents a single terminal session with input/output capabilities.
 *
 * The session provides methods for:
 * - Writing data to the terminal
 * - Subscribing to data output events
 * - Subscribing to exit events
 * - Resizing the terminal
 * - Killing the session
 *
 * @example
 * ```typescript
 * const session = await backend.createSession('my-session', options);
 *
 * // Subscribe to output
 * const unsubscribe = session.onData((data) => {
 *   console.log('Received:', data);
 * });
 *
 * // Write to session
 * session.write('echo hello\n');
 *
 * // Cleanup
 * unsubscribe();
 * session.kill();
 * ```
 */
export interface ISession {
	/**
	 * The unique name identifying this session
	 */
	readonly name: string;

	/**
	 * The process ID of the underlying shell process
	 */
	readonly pid: number;

	/**
	 * The current working directory of the session
	 */
	readonly cwd: string;

	/**
	 * Subscribe to data output from the session.
	 *
	 * @param callback - Function called when data is received from the session
	 * @returns Unsubscribe function to stop receiving data events
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = session.onData((data) => {
	 *   process.stdout.write(data);
	 * });
	 * // Later: unsubscribe();
	 * ```
	 */
	onData(callback: (data: string) => void): () => void;

	/**
	 * Subscribe to the session exit event.
	 *
	 * @param callback - Function called when the session exits with exit code
	 * @returns Unsubscribe function to stop receiving exit events
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = session.onExit((code) => {
	 *   console.log(`Session exited with code ${code}`);
	 * });
	 * ```
	 */
	onExit(callback: (code: number) => void): () => void;

	/**
	 * Write data to the session's stdin.
	 *
	 * @param data - String data to write to the session
	 *
	 * @example
	 * ```typescript
	 * session.write('ls -la\n');
	 * session.write('\x03'); // Send Ctrl+C
	 * ```
	 */
	write(data: string): void;

	/**
	 * Resize the terminal dimensions.
	 *
	 * @param cols - Number of columns (width)
	 * @param rows - Number of rows (height)
	 *
	 * @example
	 * ```typescript
	 * session.resize(120, 40);
	 * ```
	 */
	resize(cols: number, rows: number): void;

	/**
	 * Kill the session and terminate the underlying process.
	 * After calling kill(), the session should not be used anymore.
	 *
	 * @param signal - Optional signal to send (e.g. 'SIGTERM', 'SIGKILL'). Defaults to node-pty default (SIGHUP).
	 *
	 * @example
	 * ```typescript
	 * session.kill();
	 * session.kill('SIGKILL');
	 * ```
	 */
	kill(signal?: string): void;
}

/**
 * Configuration options for creating a new session.
 *
 * @example
 * ```typescript
 * const options: SessionOptions = {
 *   cwd: '/home/user/project',
 *   command: '/bin/bash',
 *   args: ['--login'],
 *   env: { NODE_ENV: 'development' },
 *   cols: 120,
 *   rows: 40,
 * };
 * ```
 */
export interface SessionOptions {
	/**
	 * Working directory for the session.
	 * The session's shell will start in this directory.
	 */
	cwd: string;

	/**
	 * Command to execute in the session.
	 * Typically a shell like '/bin/bash' or '/bin/zsh'.
	 */
	command: string;

	/**
	 * Optional arguments to pass to the command.
	 *
	 * @default []
	 */
	args?: string[];

	/**
	 * Optional environment variables to set in the session.
	 * These are merged with the parent process environment.
	 *
	 * @default {}
	 */
	env?: Record<string, string>;

	/**
	 * Optional number of columns (width) for the terminal.
	 *
	 * @default 80
	 */
	cols?: number;

	/**
	 * Optional number of rows (height) for the terminal.
	 *
	 * @default 24
	 */
	rows?: number;
}

/**
 * Backend interface for managing terminal sessions.
 *
 * The session backend is responsible for:
 * - Creating and managing terminal sessions
 * - Providing access to existing sessions
 * - Capturing session output
 * - Managing session lifecycle
 *
 * Implementations include:
 * - PtySessionBackend: Uses node-pty for direct PTY access
 *
 * @example
 * ```typescript
 * const backend = createSessionBackend('pty');
 *
 * // Create a session
 * const session = await backend.createSession('dev-session', {
 *   cwd: '/home/user/project',
 *   command: '/bin/bash',
 * });
 *
 * // List all sessions
 * const sessions = backend.listSessions();
 * console.log('Active sessions:', sessions);
 *
 * // Clean up
 * await backend.destroy();
 * ```
 */
export interface ISessionBackend {
	/**
	 * Create a new terminal session.
	 *
	 * @param name - Unique name for the session
	 * @param options - Configuration options for the session
	 * @returns Promise resolving to the created session
	 * @throws Error if session creation fails or name already exists
	 *
	 * @example
	 * ```typescript
	 * const session = await backend.createSession('my-session', {
	 *   cwd: '/home/user',
	 *   command: '/bin/bash',
	 * });
	 * ```
	 */
	createSession(name: string, options: SessionOptions): Promise<ISession>;

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
	getSession(name: string): ISession | undefined;

	/**
	 * Kill a session by name.
	 *
	 * @param name - Name of the session to kill
	 * @returns Promise that resolves when the session is killed
	 * @throws Error if session does not exist
	 *
	 * @example
	 * ```typescript
	 * await backend.killSession('my-session');
	 * ```
	 */
	killSession(name: string): Promise<void>;

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
	listSessions(): string[];

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
	sessionExists(name: string): boolean;

	/**
	 * Capture recent output from a session.
	 *
	 * @param name - Name of the session
	 * @param lines - Optional number of lines to capture (default: 100)
	 * @returns Captured output as a string
	 * @throws Error if session does not exist
	 *
	 * @example
	 * ```typescript
	 * const output = backend.captureOutput('my-session', 50);
	 * console.log('Recent output:', output);
	 * ```
	 */
	captureOutput(name: string, lines?: number): string;

	/**
	 * Get the full terminal buffer content for a session.
	 *
	 * @param name - Name of the session
	 * @returns Full buffer content as a string
	 * @throws Error if session does not exist
	 *
	 * @example
	 * ```typescript
	 * const buffer = backend.getTerminalBuffer('my-session');
	 * console.log('Full buffer:', buffer);
	 * ```
	 */
	getTerminalBuffer(name: string): string;

	/**
	 * Get raw output history with ANSI escape codes preserved.
	 *
	 * This returns the raw data that was written to the terminal,
	 * including all ANSI escape sequences for colors, cursor movement, etc.
	 * Use this when you need to replay the terminal output with colors intact.
	 *
	 * @param name - Name of the session
	 * @returns Raw output history as a string with ANSI codes
	 * @throws Error if session does not exist
	 *
	 * @example
	 * ```typescript
	 * const rawHistory = backend.getRawHistory('my-session');
	 * // Can be written to another terminal for replay with colors
	 * terminal.write(rawHistory);
	 * ```
	 */
	getRawHistory(name: string): string;

	/**
	 * Get the cumulative output bytes for a session since last reset.
	 * Used for proactive context window compaction.
	 *
	 * @param name - Name of the session
	 * @returns Cumulative output bytes, or 0 if not tracked
	 */
	getCumulativeOutputBytes?(name: string): number;

	/**
	 * Reset the cumulative output byte counter for a session.
	 *
	 * @param name - Name of the session
	 */
	resetCumulativeOutput?(name: string): void;

	/**
	 * Check if a child process is alive inside a session's PTY shell.
	 *
	 * This is optional because not all backends may support process tree
	 * inspection. When available, it uses pgrep to detect whether the
	 * runtime (e.g. Claude Code) is still running inside the shell.
	 *
	 * @param name - Name of the session to check
	 * @returns true if the session has a living child process
	 */
	isChildProcessAlive?(name: string): boolean;

	/**
	 * Get the serialized visual state of the terminal with colors preserved.
	 * Unlike getRawHistory(), the output contains no cursor movement sequences
	 * and is safe for replay at any terminal dimensions.
	 *
	 * @param name - Name of the session
	 * @returns Serialized terminal state as ANSI text
	 */
	getSerializedState?(name: string): Promise<string>;

	/**
	 * Resize a session's terminal dimensions.
	 * Resizes both the PTY process and the headless terminal buffer.
	 *
	 * @param name - Name of the session
	 * @param cols - New column count
	 * @param rows - New row count
	 */
	resizeSession?(name: string, cols: number, rows: number): void;

	/**
	 * Destroy the backend and clean up all resources.
	 * Kills all active sessions and releases any held resources.
	 *
	 * @returns Promise that resolves when cleanup is complete
	 *
	 * @example
	 * ```typescript
	 * await backend.destroy();
	 * ```
	 */
	destroy(): Promise<void>;
}

/**
 * Supported session backend types.
 *
 * - 'pty': Uses node-pty for direct PTY access (preferred for cross-platform support)
 */
export type SessionBackendType = 'pty';

/**
 * Default terminal dimensions
 */
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;

/**
 * Default shell command based on platform
 */
export const DEFAULT_SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
