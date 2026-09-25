import { CLAUDE_STARTUP_CONSTANTS, RUNTIME_STARTUP_CONSTANTS } from '../../constants.js';

/** Why an agent runtime cannot start without the user acting first. */
export type RuntimeStartupBlockedReason =
	| 'root_user'
	| 'first_run_setup'
	/** The runtime asks the user to sign in (e.g. Gemini with no key and no Google login). */
	| 'auth_required'
	/** The runtime's CLI is not on the session's PATH. */
	| 'runtime_not_installed';

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

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether terminal output shows the shell failing to find `binary`.
 *
 * Covers the wording of the shells an agent PTY runs: bash
 * (`bash: claude: command not found`), zsh (`zsh: command not found: claude`)
 * and dash/sh (`sh: 1: claude: not found`). The runtimes' own error patterns
 * only listed the zsh form, so on a bash login shell (Linux) a missing CLI
 * waited out the whole readiness timeout and every retry.
 *
 * @param output - Terminal output captured from the session
 * @param binary - The CLI command, e.g. `claude`
 * @returns True when the shell reported the command as missing
 */
export function isRuntimeCliMissing(output: string, binary: string): boolean {
	const b = escapeRegExp(binary);
	return new RegExp(`(?:^|[\\s:])${b}: (?:command )?not found|command not found: ${b}(?:\\s|$)`, 'm').test(output);
}

/**
 * Build the blocked error for a runtime whose CLI is missing, or null when the
 * runtime has no CLI binary (e.g. the in-process Crewly Agent) or the output
 * does not show it missing.
 *
 * @param output - Terminal output captured from the session
 * @param runtimeType - The runtime being started
 * @returns The error to throw, or null
 */
export function detectRuntimeCliMissing(output: string, runtimeType: string): RuntimeStartupBlockedError | null {
	const binary = RUNTIME_STARTUP_CONSTANTS.CLI_BINARIES[runtimeType];
	const runtimeLabel = RUNTIME_STARTUP_CONSTANTS.CLI_LABELS[runtimeType] ?? runtimeType;
	if (!binary || !isRuntimeCliMissing(output, binary)) return null;
	return new RuntimeStartupBlockedError(
		'runtime_not_installed',
		`${runtimeLabel} (\`${binary}\`) is not installed on this machine, so the agent cannot start. ${RUNTIME_STARTUP_CONSTANTS.MESSAGES.RUNTIME_NOT_INSTALLED_HINT}`,
	);
}
