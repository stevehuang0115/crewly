/**
 * Claude Code's own login state: is a config dir (or the default login)
 * signed in through Claude Code itself?
 *
 * Crewly does not collect, store or intermediate Claude.ai credentials
 * (Anthropic's Claude Code legal page). Claude Code keeps its own login in
 * `<config dir>/.credentials.json` or, on macOS, in the keychain, so a file
 * check alone is wrong on a Mac: the default login of a Mac has no
 * `.credentials.json` at all. Two questions are therefore asked of the CLI
 * itself, always with Crewly's own env (no `CLAUDE_CODE_OAUTH_TOKEN`, no API
 * key) so a token can never make a login look native:
 *
 * - {@link readClaudeAuthStatus}: `claude auth status --json`, the CLI's own
 *   record (`loggedIn`). Cheap, no network turn, but it keeps saying
 *   `loggedIn: true` for an expired login. Feeds the sync "signed in" flag.
 * - {@link probeClaudeNativeLogin}: one tiny real turn. This is the
 *   verification the token migration waits for before it deletes anything.
 *
 * Neither prints or reads a credential: only the exit code and the output
 * of the CLI are looked at.
 *
 * @module services/harness/claude-native-login
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { detectUsageLimit, isExhaustingKind } from '../runtime-fallback/usage-limit-rules.js';
import { buildHarnessPath, resolveExecutable, runCommand } from './harness-exec.utils.js';
import type { LoginState, RunCommand } from './harness.types.js';
import { detectLoginExpiry } from './login-expiry-rules.js';

/** Injectable dependencies. */
export interface ClaudeNativeLoginDeps {
	run?: RunCommand;
	/** Base env (default process.env) */
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	/** PATH lookup of the `claude` binary */
	resolveCommand?: (command: string) => string | null;
	/** Scratch directory the probe turn runs in */
	scratchDir?: string;
	timeoutMs?: number;
	now?: () => number;
}

/** Env that would nest the run in a Claude session or leak Crewly's API token. */
const NESTED_ENV = ['CREWLY_API_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'] as const;

/** Cache key of the default login. */
const DEFAULT_KEY = '';

/** Last `claude auth status` answer per account (`''` = the default login). */
const statusCache = new Map<string, { loggedIn: boolean; at: number }>();

/**
 * Env to ask Claude Code about its OWN login: the caller's env without any
 * token or key, pointed at a config dir (or the default login's).
 *
 * @param baseEnv - Starting env
 * @param configDir - A named account's config dir; null = the default login
 * @returns Env for the child process
 */
export function nativeLoginEnv(baseEnv: NodeJS.ProcessEnv, configDir: string | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...baseEnv };
	delete env[HARNESS_CONSTANTS.CLAUDE.OAUTH_TOKEN_ENV];
	delete env[HARNESS_CONSTANTS.CLAUDE.API_KEY_ENV];
	for (const name of NESTED_ENV) delete env[name];
	if (configDir) env[HARNESS_CONSTANTS.CLAUDE.CONFIG_DIR_ENV] = configDir;
	return env;
}

/**
 * Resolve the claude binary and base env once per call.
 *
 * @param deps - Dependencies
 * @returns Binary path (or null), base env and the runner
 */
function setup(deps: ClaudeNativeLoginDeps): { binary: string | null; env: NodeJS.ProcessEnv; run: RunCommand; timeoutMs: number } {
	const env = deps.env ?? process.env;
	const homeDir = deps.homeDir ?? os.homedir();
	const resolve = deps.resolveCommand ?? ((command: string) => resolveExecutable(command, buildHarnessPath(env.PATH, homeDir)));
	return { binary: resolve('claude'), env, run: deps.run ?? runCommand, timeoutMs: deps.timeoutMs ?? HARNESS_CONSTANTS.RELOGIN.PROBE_TIMEOUT_MS };
}

/**
 * Ask the CLI whether it is signed in (`claude auth status --json`).
 *
 * @param configDir - A named account's config dir; null = the default login
 * @param deps - Dependencies
 * @returns `loggedIn` as the CLI reports it, or null when it could not be asked
 */
export async function readClaudeAuthStatus(configDir: string | null, deps: ClaudeNativeLoginDeps = {}): Promise<boolean | null> {
	try {
		const { binary, env, run, timeoutMs } = setup(deps);
		if (!binary) return null;
		const result = await run(binary, ['auth', 'status', '--json'], { env: nativeLoginEnv(env, configDir), timeoutMs });
		const parsed: unknown = JSON.parse(result.stdout);
		if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { loggedIn?: unknown }).loggedIn === 'boolean') {
			return (parsed as { loggedIn: boolean }).loggedIn;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Refresh the cached `claude auth status` answer of accounts.
 *
 * @param accounts - Account configs: `account` is the name (null = default login), `configDir` its dir (null = default)
 * @param deps - Dependencies
 * @param maxAgeMs - Skip an account answered this recently
 * @returns Resolves when every account was asked (an unanswered one keeps its old answer)
 */
export async function refreshClaudeNativeLogins(
	accounts: ReadonlyArray<{ account: string | null; configDir: string | null }>,
	deps: ClaudeNativeLoginDeps = {},
	maxAgeMs = 60_000,
): Promise<void> {
	const now = (deps.now ?? Date.now)();
	for (const { account, configDir } of accounts) {
		const key = account ?? DEFAULT_KEY;
		const known = statusCache.get(key);
		if (known && now - known.at < maxAgeMs) continue;
		const loggedIn = await readClaudeAuthStatus(configDir, deps);
		if (loggedIn !== null) statusCache.set(key, { loggedIn, at: now });
	}
}

/**
 * The last `claude auth status` answer for an account.
 *
 * @param account - Account name; null = the default login
 * @returns True/false, or undefined when never asked
 */
export function cachedClaudeNativeLogin(account: string | null): boolean | undefined {
	return statusCache.get(account ?? DEFAULT_KEY)?.loggedIn;
}

/**
 * Set the cached answer (after a verified login or sign-out).
 *
 * @param account - Account name; null = the default login
 * @param loggedIn - New answer
 * @param now - Clock
 */
export function setCachedClaudeNativeLogin(account: string | null, loggedIn: boolean, now: number = Date.now()): void {
	statusCache.set(account ?? DEFAULT_KEY, { loggedIn, at: now });
}

/** Forget every cached answer (tests). */
export function resetClaudeNativeLoginCache(): void {
	statusCache.clear();
}

/**
 * Classify the output of a probe turn.
 *
 * @param result - Exit code and output
 * @returns `logged_out` on a login-expiry message; `logged_in` when the turn
 *   worked or the account answered with a usage limit (a limit proves the
 *   login works); else `unknown`
 */
export function classifyNativeProbe(result: { code: number | null; stdout: string; stderr: string }): LoginState {
	const output = `${result.stdout}\n${result.stderr}`;
	if (detectLoginExpiry(output, HARNESS_CONSTANTS.IDS.CLAUDE_CODE)) return 'logged_out';
	const limit = detectUsageLimit(output, RUNTIME_TYPES.CLAUDE_CODE);
	if (limit && isExhaustingKind(limit.kind)) return 'logged_in';
	if (result.code === 0) return 'logged_in';
	return 'unknown';
}

/**
 * Verify a login with one real Claude turn on Claude Code's own login, with
 * no token or key in the env.
 *
 * @param configDir - A named account's config dir; null = the default login
 * @param deps - Dependencies
 * @returns `logged_in`, `logged_out` or `unknown`; never rejects
 */
export async function probeClaudeNativeLogin(configDir: string | null, deps: ClaudeNativeLoginDeps = {}): Promise<LoginState> {
	try {
		const { binary, env, run, timeoutMs } = setup(deps);
		if (!binary) return 'unknown';
		const scratch = deps.scratchDir ?? path.join(os.tmpdir(), 'crewly-native-login-probe');
		fs.mkdirSync(scratch, { recursive: true });
		const result = await run(binary, HARNESS_CONSTANTS.CLAUDE.PROBE_ARGS, { env: nativeLoginEnv(env, configDir), timeoutMs, cwd: scratch });
		return classifyNativeProbe(result);
	} catch {
		return 'unknown';
	}
}
