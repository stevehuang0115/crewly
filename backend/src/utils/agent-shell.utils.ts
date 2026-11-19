/**
 * Which shell an agent's terminal session runs.
 *
 * @module utils/agent-shell
 */
import { existsSync } from 'fs';
import path from 'path';

/** The shell used when nothing else is known (macOS, Linux). */
export const POSIX_FALLBACK_SHELL = '/bin/bash';

/** Environment variables that name the shell explicitly, in order of precedence. */
export const AGENT_SHELL_ENV_KEYS = ['CREWLY_SHELL', 'SHELL'] as const;

/** Claude Code's own setting for the Git Bash path on Windows; honoured so both agree. */
export const CLAUDE_GIT_BASH_ENV_KEY = 'CLAUDE_CODE_GIT_BASH_PATH';

/** Git for Windows' bash, relative to its install directory. */
const GIT_BASH_RELATIVE = ['bin', 'bash.exe'] as const;

/** What {@link resolveAgentShell} reads; injected in tests. */
export interface AgentShellDeps {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (file: string) => boolean;
}

/**
 * Where Git for Windows may have put `bash.exe`, most likely first.
 *
 * `C:\Windows\System32\bash.exe` is deliberately absent: it is the WSL
 * launcher, not a shell that can run Crewly's skills against this machine.
 *
 * @param env - Environment
 * @returns Candidate absolute paths
 */
export function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
	const roots = [env['ProgramFiles'], env['ProgramW6432'], env['ProgramFiles(x86)'], env['LOCALAPPDATA'] ? path.win32.join(env['LOCALAPPDATA'], 'Programs') : undefined];
	const out: string[] = [];
	for (const root of roots) {
		if (!root) continue;
		const file = path.win32.join(root, 'Git', ...GIT_BASH_RELATIVE);
		if (!out.includes(file)) out.push(file);
	}
	return out;
}

/**
 * The shell an agent session is started with.
 *
 * Crewly drives a session by typing bash syntax into it (`export`, `&&`,
 * `bash …/execute.sh`), so the shell must be bash everywhere. On macOS and
 * Linux that is `$SHELL`, else `/bin/bash`. On Windows `$SHELL` is normally
 * unset and `/bin/bash` does not exist (node-pty: "File not found"), so Git
 * for Windows' `bash.exe` is used — the same shell Claude Code needs there.
 *
 * @param deps - Platform, environment and file check (defaults: the process's)
 * @returns The shell command; on Windows without Git Bash, `bash.exe` (resolved on PATH by the caller)
 *
 * @example
 * ```typescript
 * resolveAgentShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' } }); // '/bin/zsh'
 * resolveAgentShell({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: () => true });
 * // 'C:\\Program Files\\Git\\bin\\bash.exe'
 * ```
 */
export function resolveAgentShell(deps: AgentShellDeps = {}): string {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const exists = deps.exists ?? existsSync;
	if (platform !== 'win32') return env['SHELL'] || POSIX_FALLBACK_SHELL;
	for (const key of [...AGENT_SHELL_ENV_KEYS, CLAUDE_GIT_BASH_ENV_KEY]) {
		const named = env[key];
		// A POSIX-style $SHELL (`/usr/bin/bash`, set inside Git Bash) is not a Windows path.
		if (named && path.win32.isAbsolute(named) && exists(named)) return named;
	}
	return gitBashCandidates(env).find((file) => exists(file)) ?? 'bash.exe';
}
