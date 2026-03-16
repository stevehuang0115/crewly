/**
 * Session Module
 *
 * Provides session backend abstraction for terminal session management.
 * This module enables switching between different session backends (PTY, tmux)
 * without changing higher-level code.
 *
 * @module session
 *
 * @example
 * ```typescript
 * import {
 *   createSessionBackend,
 *   getSessionBackend,
 *   type ISession,
 *   type ISessionBackend,
 *   type SessionOptions,
 * } from './services/session';
 *
 * // Create or get the backend
 * const backend = await createSessionBackend('pty');
 *
 * // Create a session
 * const session = await backend.createSession('my-session', {
 *   cwd: '/home/user/project',
 *   command: '/bin/bash',
 * });
 *
 * // Subscribe to output
 * session.onData((data) => console.log(data));
 *
 * // Write to session
 * session.write('ls -la\n');
 * ```
 */

// Re-export interfaces and types
export type {
	ISession,
	ISessionBackend,
	SessionOptions,
	SessionBackendType,
} from './session-backend.interface.js';

// Re-export constants
export {
	DEFAULT_TERMINAL_COLS,
	DEFAULT_TERMINAL_ROWS,
	DEFAULT_SHELL,
} from './session-backend.interface.js';

// Re-export factory functions
export {
	createSessionBackend,
	getSessionBackend,
	getSessionBackendSync,
	getSessionBackendType,
	destroySessionBackend,
	isSessionBackendInitialized,
	resetSessionBackendFactory,
	setSessionBackendForTesting,
} from './session-backend.factory.js';

// Re-export PTY implementations
export { PtySession, PtySessionBackend, PtyTerminalBuffer } from './pty/index.js';

// Re-export session command helper
export {
	SessionCommandHelper,
	createSessionCommandHelper,
	KEY_CODES,
} from './session-command-helper.js';

// Re-export session state persistence
export {
	SessionStatePersistence,
	getSessionStatePersistence,
	resetSessionStatePersistence,
} from './session-state-persistence.js';

export type { PersistedSessionInfo, PersistedState } from './session-state-persistence.js';

// Re-export session handoff service
export { SessionHandoffService } from './session-handoff.service.js';
export type {
	ActiveThread,
	ActiveAgentInfo,
	HandoffSummary,
	AgentMessageSender,
	TeamDataReader,
} from './session-handoff.service.js';

// Re-export log rotation service
export { LogRotationService } from './log-rotation.service.js';
export type {
	LogFileInfo,
	RotationRunResult,
	LogRotationStatus,
} from './log-rotation.service.js';
