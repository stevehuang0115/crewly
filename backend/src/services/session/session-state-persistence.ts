/**
 * Session State Persistence Module
 *
 * Saves session metadata on shutdown and restores sessions on startup.
 * This compensates for PTY sessions not persisting like tmux sessions do.
 *
 * @module session-state-persistence
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { ISessionBackend, SessionOptions } from './session-backend.interface.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { RuntimeType, RUNTIME_TYPES } from '../../constants.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/** Current version of the state file schema */
const STATE_VERSION = 1;

/**
 * Default state file location.
 *
 * Resolved via {@link getCrewlyHomePath} so test profiles (CREWLY_HOME=/tmp/...)
 * read and write their own session-state.json instead of the user's real
 * `~/.crewly/session-state.json`. Computed lazily inside the function so a
 * test that sets `process.env.CREWLY_HOME` after module load still gets the
 * override; the previous module-level constant captured `homedir()` at
 * import time and silently leaked across profiles.
 */
function defaultStateFile(): string {
  return path.join(getCrewlyHomePath(), 'session-state.json');
}

/**
 * Metadata about a persisted session.
 */
export interface PersistedSessionInfo {
	/** Unique session name */
	name: string;
	/** Working directory for the session */
	cwd: string;
	/** Command to run (e.g., 'claude', 'gemini') */
	command: string;
	/** Command arguments */
	args: string[];
	/** Runtime type for the agent */
	runtimeType: RuntimeType;
	/** Agent role (e.g., 'orchestrator', 'dev', 'qa') */
	role?: string;
	/** Team ID if part of a team */
	teamId?: string;
	/** Member ID if this is a team member session */
	memberId?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Claude session ID for resuming conversations on restart */
	claudeSessionId?: string;
}

/**
 * Structure of the persisted state file.
 */
export interface PersistedState {
	/** Schema version */
	version: number;
	/** ISO timestamp when state was saved */
	savedAt: string;
	/** Array of session metadata */
	sessions: PersistedSessionInfo[];
}

/**
 * Session State Persistence Service
 *
 * Manages saving and restoring session state for PTY-based sessions.
 * Sessions are saved when the backend shuts down and restored on startup.
 *
 * @example
 * ```typescript
 * const persistence = new SessionStatePersistence();
 *
 * // Register a session for persistence
 * persistence.registerSession('my-session', options, 'claude-code', 'dev');
 *
 * // Save state on shutdown
 * await persistence.saveState(backend);
 *
 * // Restore state on startup
 * await persistence.restoreState(backend);
 * ```
 */
export class SessionStatePersistence {
	/** Path to the state file */
	private readonly filePath: string;

	/** Map of session name to metadata for persistence */
	private sessionMetadata: Map<string, PersistedSessionInfo> = new Map();

	/** Set of session names that were restored from the state file on startup */
	private restoredSessionNames = new Set<string>();

	/** Logger instance */
	private logger: ComponentLogger;

	/**
	 * Create a new SessionStatePersistence instance.
	 *
	 * @param filePath - Optional custom path for the state file
	 */
	constructor(filePath?: string) {
		this.filePath = filePath ?? defaultStateFile();
		this.logger = LoggerService.getInstance().createComponentLogger('SessionPersistence');
	}

	/**
	 * Register a session for persistence tracking.
	 *
	 * @param name - Session name
	 * @param options - Session options used to create the session
	 * @param runtimeType - Type of runtime (claude-code, gemini-cli, codex-cli)
	 * @param role - Optional role for the agent
	 * @param teamId - Optional team ID
	 * @param memberId - Optional member ID for team member sessions
	 */
	registerSession(
		name: string,
		options: SessionOptions,
		runtimeType: RuntimeType,
		role?: string,
		teamId?: string,
		memberId?: string
	): void {
		this.sessionMetadata.set(name, {
			name,
			cwd: options.cwd,
			command: options.command,
			args: options.args ?? [],
			runtimeType,
			role,
			teamId,
			memberId,
			env: options.env,
		});

		this.logger.debug('Registered session for persistence', { name, runtimeType, role });
		this.autoSave().catch((err) => {
			this.logger.warn('Auto-save after register failed', {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/**
	 * Remove a session from persistence tracking.
	 *
	 * @param name - Session name to unregister
	 */
	unregisterSession(name: string): void {
		const deleted = this.sessionMetadata.delete(name);
		if (deleted) {
			this.logger.debug('Unregistered session from persistence', { name });
			this.autoSave().catch((err) => {
				this.logger.warn('Auto-save after unregister failed', {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
	}

	/**
	 * Check if a session is registered for persistence.
	 *
	 * @param name - Session name to check
	 * @returns true if the session is registered
	 */
	isSessionRegistered(name: string): boolean {
		return this.sessionMetadata.has(name);
	}

	/**
	 * Get metadata for a registered session.
	 *
	 * @param name - Session name
	 * @returns Session metadata or undefined if not registered
	 */
	getSessionMetadata(name: string): PersistedSessionInfo | undefined {
		return this.sessionMetadata.get(name);
	}

	/**
	 * Update the Claude session ID for a registered session.
	 * Called when an agent registers via MCP and reports its session ID.
	 *
	 * @param name - Session name
	 * @param claudeSessionId - The Claude conversation/session ID
	 */
	updateSessionId(name: string, claudeSessionId: string): void {
		const metadata = this.sessionMetadata.get(name);
		if (metadata) {
			metadata.claudeSessionId = claudeSessionId;
			this.logger.info('Updated Claude session ID for persistence', { name, claudeSessionId });
			this.autoSave().catch((err) => {
				this.logger.warn('Auto-save after session ID update failed', {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		} else {
			this.logger.warn('Cannot update session ID - session not registered', { name });
		}
	}

	/**
	 * Get the Claude session ID for a registered session.
	 *
	 * @param name - Session name
	 * @returns Claude session ID or undefined
	 */
	getSessionId(name: string): string | undefined {
		return this.sessionMetadata.get(name)?.claudeSessionId;
	}

	/**
	 * Check if a session was restored from the state file on startup.
	 *
	 * Sessions loaded during restoreState() are tracked separately from
	 * newly created sessions. This allows the resume logic to determine
	 * whether an agent was running before the backend restart.
	 *
	 * @param name - Session name to check
	 * @returns true if the session was restored from persisted state
	 */
	isRestoredSession(name: string): boolean {
		return this.restoredSessionNames.has(name);
	}

	/**
	 * Get all registered session names.
	 *
	 * @returns Array of registered session names
	 */
	getRegisteredSessions(): string[] {
		return Array.from(this.sessionMetadata.keys());
	}

	/**
	 * Get all registered session metadata as a Map.
	 *
	 * @returns Map of session name to metadata
	 */
	getRegisteredSessionsMap(): Map<string, PersistedSessionInfo> {
		return new Map(this.sessionMetadata);
	}

	/**
	 * Build the current persisted state object from in-memory metadata.
	 *
	 * @returns PersistedState snapshot
	 */
	private buildState(): PersistedState {
		return {
			version: STATE_VERSION,
			savedAt: new Date().toISOString(),
			sessions: Array.from(this.sessionMetadata.values()),
		};
	}

	/**
	 * Auto-save current session metadata to disk.
	 * Called after register/unregister/updateSessionId to keep the state file
	 * in sync with in-memory metadata at all times. This ensures the state file
	 * is always up-to-date even if the process is killed before graceful shutdown.
	 */
	private async autoSave(): Promise<void> {
		try {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });
			await atomicWriteJson(this.filePath, this.buildState());
		} catch (error) {
			this.logger.warn('Failed to auto-save session state', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Save current session state to disk.
	 *
	 * Saves all sessions registered in sessionMetadata, which is the source
	 * of truth for what should persist.
	 *
	 * @param backend - Session backend (kept for backward compatibility, no longer used)
	 * @returns Number of sessions saved
	 */
	async saveState(backend: ISessionBackend): Promise<number> {
		try {
			await this.autoSave();
			const count = this.sessionMetadata.size;

			this.logger.info('Saved session state', {
				count,
				sessions: Array.from(this.sessionMetadata.keys()),
			});

			return count;
		} catch (error) {
			this.logger.error('Failed to save session state', {
				error: error instanceof Error ? error.message : String(error),
			});
			return 0;
		}
	}

	/**
	 * Restore sessions from saved state.
	 *
	 * For Claude sessions, uses --resume flag to restore conversation context.
	 *
	 * @param backend - Session backend to create sessions in
	 * @returns Number of sessions successfully restored
	 */
	async restoreState(backend: ISessionBackend): Promise<number> {
		try {
			const state = await safeReadJson<PersistedState | null>(this.filePath, null, this.logger);

			if (!state) {
				this.logger.info('No saved session state found');
				return 0;
			}

			if (state.version !== STATE_VERSION) {
				this.logger.warn('Unknown state version, skipping restore', {
					version: state.version,
					expected: STATE_VERSION,
				});
				return 0;
			}

			let restored = 0;
			const failed: string[] = [];

			for (const sessionInfo of state.sessions) {
				try {
					// For Claude, always use --resume to restore conversation
					const args = this.getRestoreArgs(sessionInfo);

					await backend.createSession(sessionInfo.name, {
						cwd: sessionInfo.cwd,
						command: sessionInfo.command,
						args,
						env: sessionInfo.env,
					});

					// Re-register metadata for future saves
					this.sessionMetadata.set(sessionInfo.name, sessionInfo);
					this.restoredSessionNames.add(sessionInfo.name);
					restored++;

					this.logger.info('Restored session', {
						name: sessionInfo.name,
						runtimeType: sessionInfo.runtimeType,
						hasClaudeSessionId: !!sessionInfo.claudeSessionId,
					});
				} catch (error) {
					failed.push(sessionInfo.name);
					this.logger.error('Failed to restore session', {
						name: sessionInfo.name,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			this.logger.info('Session restore complete', {
				restored,
				total: state.sessions.length,
				failed: failed.length > 0 ? failed : undefined,
			});

			return restored;
		} catch (error) {
			this.logger.error('Failed to restore session state', {
				error: error instanceof Error ? error.message : String(error),
			});
			return 0;
		}
	}

	/**
	 * Get the arguments to use when restoring a session.
	 *
	 * The persisted command is the shell (e.g. /bin/zsh), not the Claude binary.
	 * Claude Code is launched inside the shell by initializeAgentWithRegistration,
	 * so we must NOT add --resume to the shell args — it would cause
	 * "/bin/zsh: no such option: resume".
	 *
	 * @param sessionInfo - Session metadata
	 * @returns Arguments array for session creation
	 */
	private getRestoreArgs(sessionInfo: PersistedSessionInfo): string[] {
		// Return original args as-is. The persisted command is the shell,
		// not the runtime binary — flags like --resume belong on the runtime
		// command which is launched separately during initialization.
		return [...sessionInfo.args];
	}

	/**
	 * Clear the saved state file.
	 */
	async clearState(): Promise<void> {
		try {
			await fs.unlink(this.filePath);
			this.logger.info('Cleared session state file');
		} catch (error) {
			const errno = error as NodeJS.ErrnoException;
			if (errno.code !== 'ENOENT') {
				this.logger.error('Failed to clear session state file', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Clear both in-memory metadata and the state file on disk.
	 * Used when the user dismisses the session resume popup.
	 */
	async clearStateAndMetadata(): Promise<void> {
		this.sessionMetadata.clear();
		this.restoredSessionNames.clear();
		await this.clearState();
		this.logger.info('Cleared session metadata and state file');
	}

	/**
	 * Clear all registered session metadata (in-memory only).
	 */
	clearMetadata(): void {
		this.sessionMetadata.clear();
		this.restoredSessionNames.clear();
		this.logger.debug('Cleared session metadata');
	}

	/**
	 * Get the path to the state file.
	 *
	 * @returns State file path
	 */
	getFilePath(): string {
		return this.filePath;
	}

	/**
	 * Load state from file without restoring sessions.
	 *
	 * @returns Persisted state or null if not found/invalid
	 */
	async loadState(): Promise<PersistedState | null> {
		const state = await safeReadJson<PersistedState | null>(this.filePath, null, this.logger);

		if (!state) {
			return null;
		}

		if (state.version !== STATE_VERSION) {
			this.logger.warn('Unknown state version', { version: state.version });
			return null;
		}

		return state;
	}
}

/** Singleton instance for application-wide use */
let _instance: SessionStatePersistence | null = null;

/**
 * Get the singleton SessionStatePersistence instance.
 *
 * @returns SessionStatePersistence instance
 */
export function getSessionStatePersistence(): SessionStatePersistence {
	if (!_instance) {
		_instance = new SessionStatePersistence();
	}
	return _instance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetSessionStatePersistence(): void {
	_instance = null;
}
