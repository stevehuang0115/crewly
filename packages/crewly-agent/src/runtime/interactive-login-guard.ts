/**
 * Interactive harness login guard for the `bash_exec` tool.
 *
 * `claude setup-token`, `claude /login`, `claude auth login`, `codex login`
 * and an Antigravity (`agy`) login print a link and then wait for the user
 * to paste a code into the same process. `bash_exec` is one-shot: the
 * process is killed when the tool call returns (or times out), so a code the
 * owner pastes back later can never be redeemed.
 *
 * Incident 2026-09-26: the orchestrator ran `claude setup-token` this way,
 * sent the owner the link, and every authorization code the owner pasted
 * back went stale. Crewly's login broker keeps the login alive in its own
 * terminal; the orchestrator reaches it with the `harness-login` skill.
 *
 * Status checks (`claude auth status`, `codex login status`) stay allowed.
 *
 * @module runtime/interactive-login-guard
 */

/** Where a command word may start: line start, a separator, a quote, or a path slash. */
const CMD_START = String.raw`(?:^|[\s;&|()'"\x60/])`;

/** Flags without values between the command and its subcommand (`codex --verbose login`). */
const FLAGS = String.raw`(?:-{1,2}[\w-]+\s+)*`;

/** Interactive login commands, each with a label for the refusal message. */
const INTERACTIVE_LOGIN_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
	{ pattern: new RegExp(`${CMD_START}claude\\s[^\\n;&|]*?\\bsetup-token\\b`, 'i'), label: 'claude setup-token' },
	{ pattern: new RegExp(`${CMD_START}claude(?=\\s)[^\\n;&|]*?[\\s'"]/login\\b`, 'i'), label: 'claude /login' },
	{ pattern: new RegExp(`${CMD_START}claude\\s+${FLAGS}(?:auth\\s+)?login\\b`, 'i'), label: 'claude auth login' },
	// `/login` typed into claude through a pipe: `echo /login | claude`.
	{ pattern: new RegExp(`/login\\b[^\\n;&]*\\|\\s*(?:\\S*/)?claude\\b`, 'i'), label: 'claude /login' },
	{ pattern: new RegExp(`${CMD_START}codex\\s+${FLAGS}login\\b(?!\\s+status\\b)`, 'i'), label: 'codex login' },
	{ pattern: new RegExp(`${CMD_START}(?:agy|antigravity)\\s+${FLAGS}(?:auth\\s+)?login\\b`, 'i'), label: 'agy login' },
];

/** Where the orchestrator's login skill lives (relative to the Crewly project root). */
export const HARNESS_LOGIN_SKILL_PATH = 'config/skills/orchestrator/harness-login/execute.sh';

/**
 * Which interactive harness login a shell command starts, if any.
 *
 * @param command - Raw shell command
 * @returns A label such as "claude setup-token", or null when the command is not one
 *
 * @example
 * ```ts
 * detectInteractiveLogin('claude setup-token');   // 'claude setup-token'
 * detectInteractiveLogin('codex login status');   // null
 * ```
 */
export function detectInteractiveLogin(command: string): string | null {
	if (typeof command !== 'string' || !command) return null;
	for (const { pattern, label } of INTERACTIVE_LOGIN_PATTERNS) {
		if (pattern.test(command)) return label;
	}
	return null;
}

/**
 * The refusal `bash_exec` returns for an interactive harness login, or null
 * when the command may run.
 *
 * @param command - Raw shell command
 * @returns Refusal message pointing at the `harness-login` skill, or null
 */
export function checkInteractiveLoginCommand(command: string): string | null {
	const label = detectInteractiveLogin(command);
	if (!label) return null;
	return (
		`Refused: \`${label}\` is an interactive login. It would be killed when this tool call returns, so the code the owner pastes back would be stale. ` +
		`Use the harness-login skill instead: bash ${HARNESS_LOGIN_SKILL_PATH} --harness claude|codex [--switch-account] ` +
		'(orchestrator only — any other agent asks the orchestrator). Crewly keeps the login alive, sends the owner the link and types in the code they paste. ' +
		'Do not retry this command or a variation.'
	);
}
