import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import * as path from 'path';
import { LIVE_CHECKOUT_GUARD_CONSTANTS } from '../../constants.js';

/**
 * Live-checkout guard: keeps agents from changing the checkout the running
 * Crewly was built from.
 *
 * Incident 2026-10-08/09: an agent edited files in, then `git switch`ed and
 * committed in, the live checkout. On the next restart Crewly refused to
 * start ("STALE BUILD ...") and stayed down until an admin switched it back.
 *
 * The hook (`config/hooks/live-checkout-guard/guard.mjs`) blocks git
 * state-changing subcommands whose target is the live root, and Edit / Write
 * / MultiEdit / shell writes into it. Read-only git and `.crewly/` data
 * directories stay allowed. It rides in the control-plane `--settings` file
 * for Claude Code and in the session `-c hooks.PreToolUse` list for Codex.
 *
 * Coverage gaps (documented, not hidden): Gemini CLI and Antigravity get no
 * live-checkout hook (only the credential guard is wired for them); an
 * interpreter one-liner or a runtime-built path is not seen by any runtime.
 */

const C = LIVE_CHECKOUT_GUARD_CONSTANTS;

/**
 * Whether the guard is on for sessions launched by this backend.
 *
 * @param env - Environment to read (defaults to the backend's process.env)
 * @returns false only when `CREWLY_LIVE_CHECKOUT_GUARD=0`
 */
export function isLiveCheckoutGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[C.KILL_SWITCH_ENV] !== C.KILL_SWITCH_OFF_VALUE;
}

/**
 * Resolve the live roots: the install root and its git toplevel (real paths).
 *
 * @param installRoot - Package root Crewly runs from
 * @returns Distinct absolute real paths, install root first
 */
export function resolveLiveCheckoutRoots(installRoot: string): string[] {
	const real = (p: string): string => {
		try {
			return realpathSync(p);
		} catch {
			return path.resolve(p);
		}
	};
	const roots = [real(installRoot)];
	try {
		const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
			cwd: installRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 5000,
		}).trim();
		if (top) roots.push(real(top));
	} catch {
		/* not a git checkout (npm install): the install root alone is protected */
	}
	return [...new Set(roots)];
}

/**
 * Quote a value for a POSIX shell command line.
 *
 * @param value - Raw string
 * @returns Single-quoted string
 */
function shq(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell command that runs the hook for the given live roots.
 *
 * @param installRoot - Install root holding `config/hooks`
 * @param roots - Live roots from {@link resolveLiveCheckoutRoots}
 * @returns `node '<guard.mjs>' '<root>' ...`
 */
export function buildLiveCheckoutHookCommand(installRoot: string, roots: readonly string[]): string {
	const script = path.join(installRoot, C.HOOK_SCRIPT);
	return [shq(process.execPath), shq(script), ...roots.map(shq)].join(' ');
}

/** Hook command and matchers for one session, or null when the guard is off. */
export interface LiveCheckoutGuard {
	hookCommand: string;
	matcher: string;
	roots: string[];
}

/**
 * Prepare the guard for a session.
 *
 * @param installRoot - Install root
 * @param env - Environment holding the kill switch
 * @returns The hook description, or null when disabled
 */
export function prepareLiveCheckoutGuard(installRoot: string, env: NodeJS.ProcessEnv = process.env): LiveCheckoutGuard | null {
	if (!isLiveCheckoutGuardEnabled(env)) return null;
	const roots = resolveLiveCheckoutRoots(installRoot);
	return { hookCommand: buildLiveCheckoutHookCommand(installRoot, roots), matcher: C.CLAUDE_MATCHER, roots };
}

/**
 * TOML group for Codex's `hooks.PreToolUse` list.
 *
 * @param guard - From {@link prepareLiveCheckoutGuard}
 * @returns `{matcher="...",hooks=[{type="command",command="..."}]}`, or null
 *   when the command cannot be embedded safely (double quote or backslash)
 */
export function codexLiveCheckoutGroup(guard: LiveCheckoutGuard): string | null {
	if (/["\\\n]/.test(guard.hookCommand)) return null;
	return `{matcher="${C.CODEX_MATCHER}",hooks=[{type="command",command="${guard.hookCommand}"}]}`;
}
