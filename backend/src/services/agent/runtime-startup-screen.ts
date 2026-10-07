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
