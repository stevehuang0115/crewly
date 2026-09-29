/**
 * Keeps agent shells out of the user's shell history.
 *
 * Crewly used to type `export GEMINI_API_KEY=…` into agent shells, and bash
 * wrote those lines to ~/.bash_history hundreds of times. Secrets now travel
 * only in the spawn env (utils/secret-env), and on top of that agent shells
 * never write a history file at all:
 *
 * - historyOffSpawnEnv() goes into every PTY's spawn environment;
 * - shellHistoryDisableLine() is typed first by the runtime init sequence,
 *   after the rc files ran (they may set HISTFILE themselves);
 * - quietShellLine() prefixes every other typed line with a space, which
 *   bash (HISTCONTROL=ignorespace) and zsh (HIST_IGNORE_SPACE) skip.
 *
 * See SHELL_HISTORY_CONSTANTS for why HISTSIZE/HISTFILESIZE are not touched.
 *
 * @module utils/shell-history
 */

import * as path from 'path';
import { SHELL_HISTORY_CONSTANTS } from '../constants.js';

/**
 * Env vars that keep a freshly spawned bash/zsh from writing history.
 *
 * @returns A fresh copy (callers may spread or mutate it)
 */
export function historyOffSpawnEnv(): Record<string, string> {
	return { ...SHELL_HISTORY_CONSTANTS.SPAWN_ENV };
}

/**
 * Prefixes a line typed into a shell with a space so it is not recorded.
 * Already-prefixed lines are returned unchanged.
 *
 * @param line - Shell command line
 * @returns The line, space-prefixed
 */
export function quietShellLine(line: string): string {
	const prefix = SHELL_HISTORY_CONSTANTS.TYPED_LINE_PREFIX;
	return line.startsWith(prefix) ? line : `${prefix}${line}`;
}

/**
 * The (space-prefixed) line that turns history off inside a running shell.
 *
 * @param shell - Shell binary path (defaults to $SHELL, then /bin/bash — what
 *   agent PTYs are spawned with)
 * @returns The line to type, or null for a shell we do not know how to quiet
 */
export function shellHistoryDisableLine(shell: string | undefined = process.env.SHELL || '/bin/bash'): string | null {
	const name = path.basename(shell || '').toLowerCase();
	if (SHELL_HISTORY_CONSTANTS.POSIX_SHELLS.includes(name)) {
		return quietShellLine(SHELL_HISTORY_CONSTANTS.DISABLE_COMMAND);
	}
	if (name === 'fish') return quietShellLine(SHELL_HISTORY_CONSTANTS.FISH_DISABLE_COMMAND);
	return null;
}

/**
 * Quotes a value for a POSIX shell word (single quotes).
 *
 * @param value - Raw value
 * @returns Single-quoted value safe for `sh -c`
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
