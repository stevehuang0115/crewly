/**
 * Where on a start-up screen a runtime error may be read from.
 *
 * A runtime's start-up check used to search the WHOLE captured pane for its
 * error patterns ("No such file or directory", "Permission denied", ...).
 * With `claude --resume` (and `codex resume`) the CLI re-renders the
 * conversation history, and any bash output in that history that contained
 * one of those words killed a perfectly good resume as a "startup error"
 * (ce-nova incident, 2026-10-07).
 *
 * The rule here: an error counts only when the SHELL or the launcher
 * printed it, never when it is text inside the runtime's own UI.
 *
 * - The runtime UI spans from its first UI line (box drawing, logo, tool
 *   bullets) to its last one. Lines inside that span belong to the UI —
 *   including a re-rendered transcript — and are ignored. Lines before it
 *   (the launch command and anything the shell printed) and after it (the
 *   UI exited and the shell is back) are shell output.
 * - Shell/launcher failures (`permission denied`, `no such file or
 *   directory`, `command not found`) count only on a line that starts at
 *   column 0 with a `name:` prefix the way shells print them:
 *   `zsh: command not found: claude`, `bash: cd: /x: No such file or
 *   directory`, `cd: no such file or directory: /x`, `env: node: No such file
 *   or directory`, `/path/run.sh: line 3: ...`. A runtime indents the tool
 *   output it renders, so a transcript line never qualifies.
 * - Runtime-specific patterns (e.g. "Invalid API key") count anywhere in the
 *   shell output, but not inside the UI.
 */

/** A character only a runtime TUI draws (borders, logos, tool bullets). */
const RUNTIME_UI_LINE = /[╭╮╰╯│┃━═⏺⎿✻✳▐▛▜▝▘█░]/;

/** A pattern that describes a shell or launcher failure. */
const SHELL_FAILURE_PATTERN = /permission denied|no such file or directory|command not found/i;

/** A line printed by a shell, a builtin or a script: `zsh: ...`, `cd: ...`, `/x/run.sh: ...`. */
const SHELL_PREFIXED_LINE = /^-?[\w.~@+/-]+:\s/;

/**
 * Whether a pattern describes a shell/launcher failure (as opposed to a
 * runtime-specific message such as "Invalid API key").
 *
 * @param pattern - Error pattern from a runtime's getRuntimeErrorPatterns()
 * @returns True for permission-denied / no-such-file / command-not-found
 */
export function isShellFailurePattern(pattern: string): boolean {
	return SHELL_FAILURE_PATTERN.test(pattern);
}

/**
 * The lines of a captured screen that the shell printed, i.e. everything
 * outside the runtime UI span (see module docs).
 *
 * @param output - Captured pane text
 * @returns The shell-output lines, in screen order
 */
export function shellOutputLines(output: string): string[] {
	const lines = output.split(/\r?\n/);
	let first = -1;
	let last = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!RUNTIME_UI_LINE.test(lines[i])) continue;
		if (first === -1) first = i;
		last = i;
	}
	if (first === -1) return lines;
	return [...lines.slice(0, first), ...lines.slice(last + 1)];
}

/**
 * Find the first error pattern that a start-up screen really shows.
 *
 * @param output - Captured pane text
 * @param patterns - The runtime's error patterns
 * @param options.includes - How a runtime-specific pattern is searched in the shell output
 *   (defaults to a plain substring match; Antigravity also matches across wrapped lines)
 * @returns The matching pattern, or undefined when the screen shows no start-up error
 */
export function findStartupErrorPattern(
	output: string,
	patterns: readonly string[],
	options: { includes?: (text: string, pattern: string) => boolean } = {},
): string | undefined {
	if (patterns.length === 0) return undefined;
	const lines = shellOutputLines(output);
	const shellLines = lines.filter((l) => SHELL_PREFIXED_LINE.test(l)).map((l) => l.toLowerCase());
	const shellText = lines.join('\n');
	const includes = options.includes ?? ((text: string, p: string) => text.includes(p));
	return patterns.find((p) => {
		if (isShellFailurePattern(p)) {
			const needle = p.toLowerCase();
			return shellLines.some((l) => l.includes(needle));
		}
		return includes(shellText, p);
	});
}

/** The consent's heading line. */
const BYPASS_CONSENT_HEADING = /Bypass Permissions mode/;

/** A menu option on a line of its own, with or without the highlight (`❯`, or `>` on Windows). */
const menuOptionLine = (label: string): RegExp => new RegExp(`^\\s*(?:[❯>]\\s*)?${label}\\s*$`);

const BYPASS_DECLINE_LINE = menuOptionLine('No, exit');
const BYPASS_ACCEPT_LINE = menuOptionLine('Yes, I accept');

/** Non-empty lines the consent screen may print below its last option (the key hint). */
const BYPASS_MENU_MAX_LINES_BELOW = 2;

/** How far above the options the heading may be (non-empty lines). */
const BYPASS_MENU_MAX_HEADING_DISTANCE = 14;

/**
 * Whether the screen is showing Claude Code's Bypass Permissions consent
 * menu right now.
 *
 * The words alone prove nothing: a resumed conversation re-renders its
 * history, and an orchestrator that had discussed the consent with the owner
 * ("…选「Yes, I accept」…") was taken for the consent screen itself and
 * refused to start (2026-11-19, 50 minutes down). The menu counts only as
 * the menu: "No, exit" and "Yes, I accept" each alone on a line, one right
 * after the other, the heading a few lines above, and nothing below but the
 * key hint.
 *
 * @param output - Terminal text (a captured pane, or output since a point)
 * @returns True when the consent menu is the last thing on screen
 *
 * @example
 * ```ts
 * showsBypassConsentMenu('WARNING: … Bypass Permissions mode\n ❯ No, exit\n   Yes, I accept\n Enter to confirm'); // true
 * showsBypassConsentMenu('⏺ Reply "Yes, I accept" on the Bypass Permissions mode prompt\n❯ '); // false
 * ```
 */
export function showsBypassConsentMenu(output: string): boolean {
	const lines = output.split('\n').map((line) => line.replace(/\r/g, '')).filter((line) => line.trim().length > 0);
	let accept = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (BYPASS_ACCEPT_LINE.test(lines[i])) {
			accept = i;
			break;
		}
	}
	if (accept < 1) return false;
	if (lines.length - 1 - accept > BYPASS_MENU_MAX_LINES_BELOW) return false;
	if (!BYPASS_DECLINE_LINE.test(lines[accept - 1])) return false;
	const from = Math.max(0, accept - 1 - BYPASS_MENU_MAX_HEADING_DISTANCE);
	return lines.slice(from, accept - 1).some((line) => BYPASS_CONSENT_HEADING.test(line));
}
