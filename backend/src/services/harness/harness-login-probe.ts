/**
 * Live sign-in probe — is a harness's login actually usable right now?
 *
 * The status checks in {@link HarnessStatusService} only see whether a
 * credential is *stored*. For Claude Code that is not enough: an expired or
 * revoked login stays in the macOS keychain (and `claude auth status` keeps
 * saying `loggedIn: true`), so a machine whose every agent sits at
 * "Login expired · Please run /login" still looks logged in. The re-login
 * coordinator therefore confirms a suspected expiry with this probe before
 * telling the owner, and runs it now and then for harnesses in use so an
 * expiry is noticed even when no agent is running (the Air, 2026-09-30).
 *
 * - Claude Code: one tiny print-mode turn (`claude -p … --model haiku
 *   --no-session-persistence`) in a scratch directory, with the env agents
 *   get (a token Crewly stores is used, exactly as an agent would). Exit 0 →
 *   `logged_in`; output that matches a login-expiry rule → `logged_out`;
 *   anything else (network, rate limit, timeout) → `unknown`.
 * - Codex: `codex login status` (what the status check already asks).
 *
 * The probe never logs in or out and never prints a secret.
 *
 * @module services/harness/harness-login-probe
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { getHarnessCredentialsStore, type HarnessCredentialsStore } from './harness-credentials.store.js';
import { buildHarnessPath, resolveExecutable, runCommand } from './harness-exec.utils.js';
import type { HarnessId, LoginState, RunCommand } from './harness.types.js';
import { detectLoginExpiry } from './login-expiry-rules.js';

/** Injectable dependencies. */
export interface HarnessLoginProbeDeps {
	run?: RunCommand;
	/** Base env (default process.env) */
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	/** PATH lookup of the harness binary */
	resolveCommand?: (command: string) => string | null;
	/** Stored credentials exported to agents (Claude token / key) */
	credentials?: Pick<HarnessCredentialsStore, 'harnessEnvForAgents'>;
	/** Scratch directory the Claude probe runs in */
	scratchDir?: string;
	timeoutMs?: number;
}

/** Result of one probe. */
export type HarnessLoginProbe = (harnessId: HarnessId) => Promise<LoginState>;

/** Env variables that would make the probe a nested Claude session or leak Crewly's API token. */
const STRIPPED_ENV = ['CREWLY_API_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'] as const;

/**
 * Classify the output of a Claude probe turn.
 *
 * @param result - Exit code and output
 * @returns The login state it proves
 *
 * @example
 * ```ts
 * classifyClaudeProbe({ code: 1, stdout: 'Not logged in · Please run /login', stderr: '' }); // 'logged_out'
 * ```
 */
export function classifyClaudeProbe(result: { code: number | null; stdout: string; stderr: string }): LoginState {
	const output = `${result.stdout}\n${result.stderr}`;
	if (detectLoginExpiry(output, HARNESS_CONSTANTS.IDS.CLAUDE_CODE)) return 'logged_out';
	if (result.code === 0) return 'logged_in';
	return 'unknown';
}

/**
 * Build the probe.
 *
 * @param deps - Dependencies (defaults: the real CLI and stored credentials)
 * @returns `probe(harnessId)` → `logged_in` / `logged_out` / `unknown`; never rejects
 */
export function createHarnessLoginProbe(deps: HarnessLoginProbeDeps = {}): HarnessLoginProbe {
	const run = deps.run ?? runCommand;
	const baseEnv = deps.env ?? process.env;
	const homeDir = deps.homeDir ?? os.homedir();
	const timeoutMs = deps.timeoutMs ?? HARNESS_CONSTANTS.RELOGIN.PROBE_TIMEOUT_MS;
	const resolve = deps.resolveCommand ?? ((command: string) => resolveExecutable(command, buildHarnessPath(baseEnv.PATH, homeDir)));

	/** Env of the probe: what an agent of that harness gets. */
	const envFor = (harnessId: HarnessId): NodeJS.ProcessEnv => {
		const credentials = deps.credentials ?? getHarnessCredentialsStore();
		const env: NodeJS.ProcessEnv = { ...baseEnv, ...credentials.harnessEnvForAgents(baseEnv, harnessId) };
		for (const name of STRIPPED_ENV) delete env[name];
		return env;
	};

	return async (harnessId: HarnessId): Promise<LoginState> => {
		try {
			if (harnessId === HARNESS_CONSTANTS.IDS.CLAUDE_CODE) {
				const binary = resolve('claude');
				if (!binary) return 'unknown';
				const scratch = deps.scratchDir ?? path.join(os.tmpdir(), 'crewly-login-probe');
				fs.mkdirSync(scratch, { recursive: true });
				const result = await run(binary, HARNESS_CONSTANTS.CLAUDE.PROBE_ARGS, { env: envFor(harnessId), timeoutMs, cwd: scratch });
				return classifyClaudeProbe(result);
			}
			if (harnessId === HARNESS_CONSTANTS.IDS.CODEX_CLI) {
				const binary = resolve('codex');
				if (!binary) return 'unknown';
				const result = await run(binary, ['login', 'status'], { env: envFor(harnessId), timeoutMs: HARNESS_CONSTANTS.PROBE_TIMEOUT_MS });
				if (result.code === 0) return 'logged_in';
				return result.code === null ? 'unknown' : 'logged_out';
			}
			return 'unknown';
		} catch {
			return 'unknown';
		}
	};
}
