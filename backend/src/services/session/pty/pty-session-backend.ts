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
import { RuntimePidRegistry } from '../runtime-pid-registry.service.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Point-in-time PTY/FD health snapshot for observability.
 *
 * Surfaced so an operator (or a future health endpoint) can SEE PTY-FD
 * accumulation early instead of discovering it only when `start-agent` fails
 * with `posix_spawnp failed`. `liveSessions` ≫ `activeSessions` signals dead
 * sessions lingering in the registry; `openFileCount` climbing across the
 * backend lifetime signals the underlying FD leak directly.
 */
export interface PtyDiagnostics {
	/** Total entries in the sessionName→PtySession registry. */
	registrySize: number;
	/** Registry entries whose PtySession is still alive (not killed/exited). */
	activeSessions: number;
	/** Registry entries whose PtySession reports killed (reaper candidates). */
	deadSessions: number;
	/**
	 * Open file descriptors for THIS backend process via `lsof`, or null when
	 * unavailable (lsof missing / non-POSIX). Cheap to read; bounded by timeout.
	 */
	openFileCount: number | null;
}

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
	 * Interval handle for the orphan-PTY reaper sweep. Started in the constructor,
	 * cleared on destroy()/forceDestroyAll(). The sweep tears down any registry
	 * PTY whose owning session is no longer active (defensive FD-leak backstop).
	 */
	private orphanReaperTimer: ReturnType<typeof setInterval> | null = null;

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
		this.startOrphanReaper();
		this.logger.info('PTY session backend initialized');
	}

	/**
	 * Start the periodic orphan-PTY reaper sweep.
	 *
	 * The interval cadence comes from PTY_CONSTANTS.ORPHAN_REAPER_INTERVAL_MS
	 * (never hardcoded). The timer is `unref()`'d so it never keeps the Node
	 * event loop alive on its own. Safe to call repeatedly (no-op if running).
	 */
	private startOrphanReaper(): void {
		if (this.orphanReaperTimer) {
			return;
		}
		this.orphanReaperTimer = setInterval(() => {
			void this.reapOrphanPtys();
		}, PTY_CONSTANTS.ORPHAN_REAPER_INTERVAL_MS);
		// Don't let the reaper interval hold the process open during shutdown.
		this.orphanReaperTimer.unref?.();
	}

	/**
	 * Stop the periodic orphan-PTY reaper sweep (idempotent).
	 */
	private stopOrphanReaper(): void {
		if (this.orphanReaperTimer) {
			clearInterval(this.orphanReaperTimer);
			this.orphanReaperTimer = null;
		}
	}

	/**
	 * Defensive backstop sweep: tear down any registry PTY whose owning session
	 * is no longer active so its `/dev/ptmx` master + `/dev/ttysNNN` slave FDs are
	 * released even if some end path forgot to route through teardownSession.
	 *
	 * A session is considered orphaned when its PtySession reports `isKilled()`
	 * (the shell exited / crashed / was killed) yet it is still present in the
	 * registry. Such an entry only lingers if normal teardown was skipped — the
	 * exact failure mode that accumulated 319 orphaned master FDs over 6 days.
	 * Active, living sessions are left untouched.
	 *
	 * @returns Promise resolving to the number of orphaned PTYs reaped.
	 *
	 * @example
	 * ```typescript
	 * const reaped = await backend.reapOrphanPtys();
	 * ```
	 */
	async reapOrphanPtys(): Promise<number> {
		// Snapshot names first — teardownSession mutates the registry mid-iteration.
		const names = Array.from(this.sessions.keys());
		const orphanNames = names.filter((name) => {
			const session = this.sessions.get(name);
			return session !== undefined && session.isKilled();
		});

		if (orphanNames.length === 0) {
			return 0;
		}

		this.logger.warn('Orphan-PTY reaper found dead sessions still in registry', {
			orphanCount: orphanNames.length,
			orphanNames,
		});

		for (const name of orphanNames) {
			// force:false — the shell is already dead, we only release the FDs.
			await this.teardownSession(name, { force: false });
		}

		this.logger.warn('Orphan-PTY reaper finished', {
			reaped: orphanNames.length,
			remainingSessions: this.sessions.size,
		});

		return orphanNames.length;
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
			PtyActivityTrackerService.getInstance().recordFilteredActivity(name, data);
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

		// Record the spawned PID so a non-graceful backend death can be cleaned
		// up at the next boot (issue #715). Removed again on clean teardown.
		RuntimePidRegistry.getInstance().record(
			session.pid,
			name,
			options.command,
			options.args ?? [],
		);

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
		await this.teardownSession(name, { force: true });
	}

	/**
	 * Centralized PTY teardown — the SINGLE path every session-end route funnels
	 * through (explicit stop/terminate, idle-exit, dropout, crash, natural exit,
	 * and the orphan reaper). Given a session name it:
	 *   1. looks the PtySession up in the registry (the always-present reference
	 *      that prevents the "orphan with no reference" leak),
	 *   2. force-kills the child shell AND closes the node-pty master/slave FDs
	 *      (via PtySession.forceKill → closePty, or closePty directly for an
	 *      already-dead session),
	 *   3. deletes it from every per-session Map (registry, buffers, byte
	 *      counters, log streams),
	 *   4. drops it from the cross-boot orphan PID registry.
	 *
	 * Idempotent and safe to call twice: a missing session simply cleans up any
	 * residual per-session resources and returns. This is the function whose
	 * absence caused 319 orphaned /dev/ptmx FDs to accumulate.
	 *
	 * @param name - Name of the session to tear down.
	 * @param options - `force: true` escalates SIGTERM→SIGKILL (default true);
	 *   `force: false` performs an FD-only close for a session already known dead.
	 * @returns Promise that resolves when teardown + cleanup completes.
	 *
	 * @example
	 * ```typescript
	 * await backend.teardownSession('agent-leo'); // stop/terminate/idle-exit/crash
	 * await backend.teardownSession('agent-leo'); // calling again is a safe no-op
	 * ```
	 */
	private async teardownSession(
		name: string,
		options: { force?: boolean } = {},
	): Promise<void> {
		const force = options.force ?? true;
		const session = this.sessions.get(name);
		const terminalBuffer = this.terminalBuffers.get(name);

		if (session) {
			if (force && !session.isKilled()) {
				this.logger.info('Tearing down session with forceKill (SIGTERM → SIGKILL)', { name });
				await session.forceKill();
			} else {
				// Session already dead (exit/crash) or non-force reaper sweep: we
				// only need to release the lingering PTY master/slave FDs.
				this.logger.info('Tearing down session — releasing PTY file descriptors', { name });
				session.closePty();
			}
			this.sessions.delete(name);
		}

		if (terminalBuffer) {
			terminalBuffer.dispose();
			this.terminalBuffers.delete(name);
		}

		// We reaped this process ourselves — drop it from the orphan registry.
		RuntimePidRegistry.getInstance().remove(name);

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
	 * Get the serialized visual state of the terminal as plain text.
	 *
	 * Unlike getRawHistory() which returns raw bytes including cursor movement
	 * sequences that cause corruption when replayed at different terminal
	 * dimensions, this returns the rendered visual state — the final text after
	 * all cursor movements and erases have been processed by the headless terminal.
	 *
	 * Flushes pending terminal writes before reading to ensure completeness.
	 *
	 * @param name - Name of the session
	 * @returns Promise resolving to serialized terminal state safe for any dimensions
	 */
	async getSerializedState(name: string): Promise<string> {
		const terminalBuffer = this.terminalBuffers.get(name);
		if (!terminalBuffer) {
			return '';
		}

		return terminalBuffer.serializeAsync();
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

		// Stop the reaper first so it can't race with the teardown loop below.
		this.stopOrphanReaper();

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

		// Stop the reaper so it can't race with the clear() below.
		this.stopOrphanReaper();

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

		// Step 5: Release every session's PTY master/slave FDs before dropping the
		// references. SIGKILL above bypassed node-pty's own exit handling, so the
		// master fd sockets would otherwise leak; closePty() is idempotent so the
		// sessions whose SIGTERM in Step 2 already closed them are unaffected.
		for (const session of this.sessions.values()) {
			session.closePty();
		}

		// Clean up internal maps
		for (const terminalBuffer of this.terminalBuffers.values()) {
			terminalBuffer.dispose();
		}
		const logStreamNames = Array.from(this.sessionLogStreams.keys());
		for (const name of logStreamNames) {
			this.closeSessionLogStream(name);
		}
		this.sessions.clear();
		this.terminalBuffers.clear();
		this.cumulativeOutputBytes.clear();

		// We just reaped every tracked process + group — clear the orphan
		// registry so the next boot doesn't try to re-reap these PIDs.
		RuntimePidRegistry.getInstance().clear();

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
	 * Read the open file descriptor count for THIS backend process.
	 *
	 * Uses `lsof -p <pid> | wc -l` on POSIX. Bounded by a short timeout and
	 * exception-safe — returns null rather than throwing when lsof is missing or
	 * the platform is unsupported, so callers can always include it in a
	 * diagnostics payload without guarding.
	 *
	 * @returns The open-fd count, or null when it cannot be measured.
	 */
	private readOpenFileCount(): number | null {
		if (process.platform !== 'linux' && process.platform !== 'darwin') {
			return null;
		}
		try {
			const out = execSync(`lsof -p ${process.pid} 2>/dev/null | wc -l`, {
				encoding: 'utf8',
				timeout: 1500,
			});
			const n = parseInt(out.trim(), 10);
			return Number.isFinite(n) ? n : null;
		} catch {
			return null;
		}
	}

	/**
	 * Produce a PTY/FD health snapshot for observability (registry occupancy +
	 * process open-fd count). Intended for the diagnostics/health surface so PTY
	 * file-descriptor accumulation is VISIBLE next time instead of only manifesting
	 * as a `posix_spawnp failed` spawn error near the open-file ceiling.
	 *
	 * @returns A {@link PtyDiagnostics} snapshot.
	 *
	 * @example
	 * ```typescript
	 * const d = backend.getPtyDiagnostics();
	 * logger.info('PTY health', d);
	 * // { registrySize: 1, activeSessions: 1, deadSessions: 0, openFileCount: 142 }
	 * ```
	 */
	getPtyDiagnostics(): PtyDiagnostics {
		let activeSessions = 0;
		let deadSessions = 0;
		for (const session of this.sessions.values()) {
			if (session.isKilled()) {
				deadSessions++;
			} else {
				activeSessions++;
			}
		}
		return {
			registrySize: this.sessions.size,
			activeSessions,
			deadSessions,
			openFileCount: this.readOpenFileCount(),
		};
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
