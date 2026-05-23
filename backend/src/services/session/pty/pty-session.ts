/**
 * PTY Session Module
 *
 * Implements the ISession interface using node-pty for direct PTY access.
 * This provides better input reliability and Windows support compared to tmux.
 *
 * @module pty-session
 */

import * as pty from 'node-pty';
import { execSync } from 'child_process';
import type { ISession, SessionOptions } from '../session-backend.interface.js';
import {
	DEFAULT_TERMINAL_COLS,
	DEFAULT_TERMINAL_ROWS,
} from '../session-backend.interface.js';
import { PTY_CONSTANTS } from '../../../constants.js';
import { LoggerService, ComponentLogger } from '../../core/logger.service.js';

/**
 * Test affordance: lets `pty-session.test.ts` swap in a stub instead of
 * calling the real `pty.spawn`. Production code path is identical.
 */
let ptySpawnImpl: typeof pty.spawn = pty.spawn;
export function _setPtySpawnImplForTesting(
	impl: typeof pty.spawn,
): () => void {
	const previous = ptySpawnImpl;
	ptySpawnImpl = impl;
	return () => {
		ptySpawnImpl = previous;
	};
}

/**
 * Retry policy for transient `pty.spawn` failures. The native node-pty
 * binding throws a generic `Error("posix_spawnp failed.")` with no errno
 * detail — on macOS this is usually EAGAIN (process table briefly
 * saturated by Chrome helpers / VS Code extensions / build spawns) and
 * retrying after a short pause succeeds. We give up after the 4th
 * attempt and throw a richer diagnostic.
 *
 * Sync sleep uses `Atomics.wait` on an ephemeral SharedArrayBuffer —
 * blocks the thread without spawning a `sleep(1)` subprocess (which
 * would compound the very problem we're working around).
 */
const PTY_SPAWN_RETRY_BACKOFFS_MS = [0, 150, 400, 1000] as const;
const PTY_TRANSIENT_ERROR_MARKERS = [
	'posix_spawnp',
	'EAGAIN',
	'ENOMEM',
	'EMFILE',
	'ENFILE',
];

function isTransientSpawnError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return PTY_TRANSIENT_ERROR_MARKERS.some((m) => msg.includes(m));
}

function syncSleepMs(ms: number): void {
	if (ms <= 0) return;
	const buf = new SharedArrayBuffer(4);
	const view = new Int32Array(buf);
	// Wait returns 'timed-out' after `ms` regardless of view[0] (which
	// nobody writes to). This is the modern synchronous sleep pattern
	// recommended for situations where a busy-wait would burn CPU.
	Atomics.wait(view, 0, 0, ms);
}

/**
 * Read current user process count cheaply. Used in the spawn-failure
 * diagnostic to tell the user if they're near macOS `kern.maxprocperuid`.
 */
function readUserProcessCount(): number | null {
	try {
		const out = execSync('ps -u "$(id -un)" 2>/dev/null | wc -l', {
			encoding: 'utf8',
			timeout: 800,
		});
		const n = parseInt(out.trim(), 10);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

/** Read kern.maxprocperuid. macOS-specific; returns null on non-Darwin. */
function readMaxProcPerUid(): number | null {
	if (process.platform !== 'darwin') return null;
	try {
		const out = execSync('sysctl -n kern.maxprocperuid', {
			encoding: 'utf8',
			timeout: 500,
		});
		const n = parseInt(out.trim(), 10);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

/**
 * Wraps `pty.spawn` with retry-on-transient + actionable error.
 *
 * On the 4th and final failure, throws `PtySpawnExhaustedError` with a
 * human-readable message + machine-readable diagnostics. Callers should
 * surface the .message to the user (e.g. ORC → Slack).
 */
class PtySpawnExhaustedError extends Error {
	constructor(
		message: string,
		public readonly diagnostics: {
			attempts: number;
			lastError: string;
			userProcessCount: number | null;
			maxProcPerUid: number | null;
			command: string;
			platform: string;
		},
	) {
		super(message);
		this.name = 'PtySpawnExhaustedError';
	}
}

function spawnPtyWithRetry(
	command: string,
	args: string[],
	options: Parameters<typeof pty.spawn>[2],
	logger: ComponentLogger,
): pty.IPty {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < PTY_SPAWN_RETRY_BACKOFFS_MS.length; attempt++) {
		const backoffMs = PTY_SPAWN_RETRY_BACKOFFS_MS[attempt];
		if (backoffMs > 0) {
			logger.warn('PTY spawn retry — sleeping then retrying', {
				attempt,
				backoffMs,
				command,
			});
			syncSleepMs(backoffMs);
		}
		try {
			return ptySpawnImpl(command, args, options);
		} catch (err) {
			lastError = err;
			if (!isTransientSpawnError(err)) {
				// Non-transient (e.g. ENOENT — command not found): fail fast.
				throw err;
			}
			// Else loop — backoff already happened next iter.
		}
	}

	// Exhausted retries — build an actionable message.
	const userProcessCount = readUserProcessCount();
	const maxProcPerUid = readMaxProcPerUid();
	const errMsg = lastError instanceof Error ? lastError.message : String(lastError);

	let humanHint = '';
	if (
		userProcessCount !== null &&
		maxProcPerUid !== null &&
		userProcessCount > maxProcPerUid * 0.75
	) {
		humanHint = ` Your user process count is ${userProcessCount} / ${maxProcPerUid} (>75% of limit). Close some Chrome tabs / VS Code windows / other agent sessions and retry.`;
	} else if (process.platform === 'darwin') {
		humanHint =
			' Likely a transient kernel-level process-table spike (Chrome / VS Code / build tools spawning many helpers). Wait ~30 s and the next attempt should succeed; the OSS will auto-retry on the next user trigger.';
	} else {
		humanHint = ' Transient spawn failure — retry shortly.';
	}

	const message = `PTY spawn failed after ${PTY_SPAWN_RETRY_BACKOFFS_MS.length} attempts (${errMsg}).${humanHint}`;
	throw new PtySpawnExhaustedError(message, {
		attempts: PTY_SPAWN_RETRY_BACKOFFS_MS.length,
		lastError: errMsg,
		userProcessCount,
		maxProcPerUid,
		command,
		platform: process.platform,
	});
}

export { PtySpawnExhaustedError };

/**
 * PTY Session implementation using node-pty.
 *
 * Provides a direct PTY-based terminal session with the following capabilities:
 * - Spawn shell processes with configurable environment
 * - Write input and receive output via callbacks
 * - Resize terminal dimensions
 * - Graceful termination
 *
 * @example
 * ```typescript
 * const session = new PtySession('my-session', '/home/user', {
 *   cwd: '/home/user',
 *   command: '/bin/bash',
 *   cols: 120,
 *   rows: 40,
 * });
 *
 * session.onData((data) => console.log(data));
 * session.write('echo hello\n');
 * session.kill();
 * ```
 */
export class PtySession implements ISession {
	/**
	 * The underlying node-pty process
	 */
	private ptyProcess: pty.IPty;

	/**
	 * Set of data listeners for output events (O(1) add/remove)
	 */
	private dataListeners: Set<(data: string) => void> = new Set();

	/**
	 * Set of exit listeners for process termination events (O(1) add/remove)
	 */
	private exitListeners: Set<(code: number) => void> = new Set();

	/**
	 * Flag indicating whether the session has been killed
	 */
	private killed = false;

	/**
	 * Logger for this session
	 */
	private logger: ComponentLogger;

	/**
	 * Create a new PTY session.
	 *
	 * @param name - Unique name for this session
	 * @param cwd - Current working directory for the session
	 * @param options - Session configuration options
	 * @throws Error if PTY process spawn fails
	 *
	 * @example
	 * ```typescript
	 * const session = new PtySession('dev-session', '/home/user/project', {
	 *   cwd: '/home/user/project',
	 *   command: '/bin/bash',
	 *   args: ['--login'],
	 *   env: { NODE_ENV: 'development' },
	 *   cols: 120,
	 *   rows: 40,
	 * });
	 * ```
	 */
	constructor(
		public readonly name: string,
		public readonly cwd: string,
		options: SessionOptions
	) {
		this.logger = LoggerService.getInstance().createComponentLogger(`PtySession:${name}`);

		this.logger.info('Creating PTY session', {
			name,
			cwd,
			command: options.command,
			args: options.args,
			cols: options.cols ?? DEFAULT_TERMINAL_COLS,
			rows: options.rows ?? DEFAULT_TERMINAL_ROWS,
		});

		// Merge process environment with session-specific environment
		const sessionEnv: Record<string, string> = {
			...this.sanitizeEnv(process.env),
			...options.env,
			// Set TERM for proper terminal emulation
			TERM: 'xterm-256color',
		};

		try {
			// Spawn the PTY process — wrapped in retry-with-backoff so that
			// transient `posix_spawnp failed` errors (typical on macOS when
			// Chrome / VS Code briefly saturate the process table) don't
			// turn into user-visible spawn failures. See spawnPtyWithRetry
			// for the policy + sync sleep pattern.
			this.ptyProcess = spawnPtyWithRetry(
				options.command,
				options.args ?? [],
				{
					name: 'xterm-256color',
					cols: options.cols ?? DEFAULT_TERMINAL_COLS,
					rows: options.rows ?? DEFAULT_TERMINAL_ROWS,
					cwd: options.cwd,
					env: sessionEnv,
				},
				this.logger,
			);

			this.logger.info('PTY process spawned successfully', {
				name,
				pid: this.ptyProcess.pid,
				command: options.command,
			});
		} catch (spawnError) {
			// `PtySpawnExhaustedError` carries the actionable hint already
			// in its .message; other errors (e.g. ENOENT — command not
			// found) propagate as-is. Either way we log richer context.
			const errMsg = spawnError instanceof Error ? spawnError.message : String(spawnError);
			const diagnostics =
				spawnError instanceof PtySpawnExhaustedError
					? spawnError.diagnostics
					: undefined;
			this.logger.error('Failed to spawn PTY process', {
				name,
				command: options.command,
				cwd: options.cwd,
				error: errMsg,
				diagnostics,
				stack: spawnError instanceof Error ? spawnError.stack : undefined,
			});
			throw spawnError;
		}

		// Set up event handlers
		this.setupEventHandlers();
	}

	/**
	 * The process ID of the underlying PTY process.
	 */
	get pid(): number {
		return this.ptyProcess.pid;
	}

	/**
	 * Subscribe to data output from the session.
	 *
	 * @param callback - Function called when data is received
	 * @returns Unsubscribe function to remove the listener
	 * @throws Error if maximum listener count is exceeded
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = session.onData((data) => {
	 *   process.stdout.write(data);
	 * });
	 * // Later: unsubscribe();
	 * ```
	 */
	onData(callback: (data: string) => void): () => void {
		if (this.dataListeners.size >= PTY_CONSTANTS.MAX_DATA_LISTENERS) {
			throw new Error(
				`Maximum data listener count (${PTY_CONSTANTS.MAX_DATA_LISTENERS}) exceeded for session ${this.name}`
			);
		}

		this.dataListeners.add(callback);

		// Return O(1) unsubscribe function
		return () => {
			this.dataListeners.delete(callback);
		};
	}

	/**
	 * Subscribe to the session exit event.
	 *
	 * @param callback - Function called when the process exits
	 * @returns Unsubscribe function to remove the listener
	 * @throws Error if maximum listener count is exceeded
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = session.onExit((code) => {
	 *   console.log(`Session exited with code ${code}`);
	 * });
	 * ```
	 */
	onExit(callback: (code: number) => void): () => void {
		if (this.exitListeners.size >= PTY_CONSTANTS.MAX_EXIT_LISTENERS) {
			throw new Error(
				`Maximum exit listener count (${PTY_CONSTANTS.MAX_EXIT_LISTENERS}) exceeded for session ${this.name}`
			);
		}

		this.exitListeners.add(callback);

		// Return O(1) unsubscribe function
		return () => {
			this.exitListeners.delete(callback);
		};
	}

	/**
	 * Write data to the session's stdin.
	 *
	 * @param data - String data to write to the session
	 * @throws Error if session has been killed
	 *
	 * @example
	 * ```typescript
	 * session.write('ls -la\n');
	 * session.write('\x03'); // Send Ctrl+C
	 * ```
	 */
	write(data: string): void {
		if (this.killed) {
			throw new Error(`Cannot write to killed session ${this.name}`);
		}
		this.ptyProcess.write(data);
	}

	/**
	 * Resize the terminal dimensions.
	 *
	 * @param cols - Number of columns (width)
	 * @param rows - Number of rows (height)
	 * @throws Error if session has been killed
	 *
	 * @example
	 * ```typescript
	 * session.resize(120, 40);
	 * ```
	 */
	resize(cols: number, rows: number): void {
		if (this.killed) {
			throw new Error(`Cannot resize killed session ${this.name}`);
		}

		// Validate dimensions
		if (cols <= 0 || rows <= 0 || !Number.isInteger(cols) || !Number.isInteger(rows)) {
			throw new Error(`Invalid dimensions: cols=${cols}, rows=${rows}. Values must be positive integers.`);
		}

		// Cap at reasonable maximums to prevent resource exhaustion
		if (cols > PTY_CONSTANTS.MAX_RESIZE_COLS || rows > PTY_CONSTANTS.MAX_RESIZE_ROWS) {
			throw new Error(
				`Dimensions exceed maximum: cols=${cols} (max ${PTY_CONSTANTS.MAX_RESIZE_COLS}), ` +
					`rows=${rows} (max ${PTY_CONSTANTS.MAX_RESIZE_ROWS})`
			);
		}

		this.ptyProcess.resize(cols, rows);
	}

	/**
	 * Kill the session and terminate the underlying process.
	 *
	 * After calling kill(), the session cannot be used anymore.
	 * All listeners will be cleared and subsequent write/resize calls will throw.
	 *
	 * @param signal - Optional signal to send (e.g. 'SIGTERM', 'SIGKILL'). Defaults to node-pty default (SIGHUP).
	 *
	 * @example
	 * ```typescript
	 * session.kill();
	 * session.kill('SIGKILL');
	 * ```
	 */
	kill(signal?: string): void {
		if (this.killed) {
			return; // Already killed, no-op
		}

		this.killed = true;
		this.ptyProcess.kill(signal);

		// Clear all listeners to prevent memory leaks
		this.dataListeners.clear();
		this.exitListeners.clear();
	}

	/**
	 * Forcefully kill the session with SIGTERM → SIGKILL escalation.
	 *
	 * Sends SIGTERM first, then after a delay escalates to SIGKILL on both
	 * the process and its process group to ensure all child processes are terminated.
	 * This is necessary because Claude Code and Gemini CLI may catch/ignore SIGHUP and SIGTERM.
	 *
	 * @returns Promise that resolves after the kill sequence completes
	 *
	 * @example
	 * ```typescript
	 * await session.forceKill();
	 * ```
	 */
	async forceKill(): Promise<void> {
		const pid = this.ptyProcess.pid;

		this.logger.info('Force-killing session', { name: this.name, pid });

		// Step 1: Send SIGTERM via node-pty
		if (!this.killed) {
			this.killed = true;
			try {
				this.ptyProcess.kill('SIGTERM');
			} catch (err) {
				this.logger.debug('Error sending SIGTERM via node-pty (process may already be dead)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Step 2: Wait, then escalate to SIGKILL
		await new Promise<void>((resolve) => setTimeout(resolve, PTY_CONSTANTS.FORCE_KILL_ESCALATION_DELAY));

		// SIGKILL the process directly
		try {
			process.kill(pid, 'SIGKILL');
			this.logger.debug('Sent SIGKILL to process', { pid });
		} catch {
			// ESRCH = process already gone, which is fine
		}

		// SIGKILL the entire process group (negative PID)
		try {
			process.kill(-pid, 'SIGKILL');
			this.logger.debug('Sent SIGKILL to process group', { pgid: -pid });
		} catch {
			// ESRCH = process group already gone, which is fine
		}

		// Clear all listeners to prevent memory leaks
		this.dataListeners.clear();
		this.exitListeners.clear();
	}

	/**
	 * Check if the session has been killed.
	 *
	 * @returns true if the session has been killed
	 */
	isKilled(): boolean {
		return this.killed;
	}

	/**
	 * Check if a child process (e.g. Claude Code) is alive inside this PTY shell.
	 *
	 * Uses `pgrep -P <shellPid>` to detect child processes of the shell.
	 * Returns false if the shell has no children (Claude Code exited) or if
	 * the check itself fails (shell already dead).
	 *
	 * @returns true if at least one child process is running inside the shell
	 */
	isChildProcessAlive(): boolean {
		if (this.killed) {
			return false;
		}

		try {
			const pid = this.ptyProcess.pid;
			// pgrep -P <pid> lists child PIDs; exits 0 if found, 1 if none
			execSync(`pgrep -P ${pid}`, { stdio: 'pipe', timeout: 3000 });
			return true;
		} catch {
			// pgrep exits with code 1 when no children found, or command fails
			return false;
		}
	}

	/**
	 * Set up event handlers for the PTY process.
	 */
	private setupEventHandlers(): void {
		// Handle data output
		this.ptyProcess.onData((data) => {
			if (!this.killed) {
				// Copy listeners set to avoid issues with modifications during iteration
				const listeners = [...this.dataListeners];
				for (const callback of listeners) {
					try {
						callback(data);
					} catch (error) {
						// Log error but don't let one bad listener break others
						this.logger.error('Error in data listener', {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
		});

		// Handle process exit
		this.ptyProcess.onExit(({ exitCode }) => {
			// Copy listeners set to avoid issues with modifications during iteration
			const listeners = [...this.exitListeners];
			for (const callback of listeners) {
				try {
					callback(exitCode);
				} catch (error) {
					// Log error but don't let one bad listener break others
					this.logger.error('Error in exit listener', {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			// Mark as killed after exit
			this.killed = true;
			this.dataListeners.clear();
			this.exitListeners.clear();
		});
	}

	/**
	 * Sanitize environment variables, removing undefined values.
	 *
	 * @param env - Environment variables object
	 * @returns Sanitized environment object with string values only
	 */
	private sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(env)) {
			if (value !== undefined) {
				result[key] = value;
			}
		}
		return result;
	}
}
