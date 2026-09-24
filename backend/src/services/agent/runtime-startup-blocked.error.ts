import { CLAUDE_STARTUP_CONSTANTS } from '../../constants.js';

/** Why an agent runtime cannot start without the user acting first. */
export type RuntimeStartupBlockedReason = 'root_user' | 'first_run_setup';

/**
 * Thrown when an agent runtime cannot start until the user does something:
 * for example Claude Code as root, or a Claude Code that was never set up.
 * Retrying cannot help, so the start-up fallback chain and the orchestrator
 * auto-start stop on it and surface {@link RuntimeStartupBlockedError.message}
 * to the user unchanged.
 */
export class RuntimeStartupBlockedError extends Error {
	/** Stable machine-readable code. */
	readonly code: string = CLAUDE_STARTUP_CONSTANTS.BLOCKED_ERROR_CODE;

	/**
	 * @param reason - Which blocking condition was hit
	 * @param message - Actionable, user-facing explanation
	 */
	constructor(readonly reason: RuntimeStartupBlockedReason, message: string) {
		super(message);
		this.name = 'RuntimeStartupBlockedError';
	}
}

/**
 * Type guard for {@link RuntimeStartupBlockedError}, also matching errors that
 * crossed a module boundary as plain Errors carrying the code.
 *
 * @param err - Anything caught
 * @returns True when the error means "start-up is blocked, do not retry"
 */
export function isRuntimeStartupBlockedError(err: unknown): err is RuntimeStartupBlockedError {
	return (
		err instanceof RuntimeStartupBlockedError ||
		(err instanceof Error && (err as Error & { code?: unknown }).code === CLAUDE_STARTUP_CONSTANTS.BLOCKED_ERROR_CODE)
	);
}
