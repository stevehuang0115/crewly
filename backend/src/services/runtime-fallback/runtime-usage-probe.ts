/**
 * Usage probe — does a runtime have usage right now?
 *
 * Reuses the harness-login-probe approach: for Claude Code one tiny
 * print-mode turn (`claude -p … --model haiku --no-session-persistence`) in
 * a scratch directory, with the env an agent gets. Output that matches a
 * usage-limit rule → `limited`; exit 0 → `available`; anything else
 * (network, login, timeout) → `unknown`.
 *
 * Other runtimes return `unknown` (a probe would spend their usage or needs
 * a login Crewly cannot check cheaply); the fallback then relies on the
 * parsed reset time, or retries after the probe interval.
 *
 * The probe never prints or logs a secret.
 *
 * @module services/runtime-fallback/runtime-usage-probe
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { getHarnessCredentialsStore, type HarnessCredentialsStore } from '../harness/harness-credentials.store.js';
import { buildHarnessPath, resolveExecutable, runCommand } from '../harness/harness-exec.utils.js';
import type { RunCommand } from '../harness/harness.types.js';
import { detectUsageLimit } from './usage-limit-rules.js';
import type { ProbeResult } from './runtime-fallback.service.js';

/** Injectable dependencies. */
export interface UsageProbeDeps {
	run?: RunCommand;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	resolveCommand?: (command: string) => string | null;
	credentials?: Pick<HarnessCredentialsStore, 'harnessEnvForAgents'>;
	scratchDir?: string;
	timeoutMs?: number;
}

/** Env variables that would nest the probe in a Claude session or leak Crewly's token. */
const STRIPPED_ENV = ['CREWLY_API_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'] as const;

/**
 * Classify a Claude probe turn.
 *
 * @param result - Exit code and output
 * @returns `limited`, `available` or `unknown`
 *
 * @example
 * ```ts
 * classifyClaudeUsageProbe({ code: 1, stdout: "You've hit your limit · resets 3pm", stderr: '' }); // 'limited'
 * ```
 */
export function classifyClaudeUsageProbe(result: { code: number | null; stdout: string; stderr: string }): ProbeResult {
	const output = `${result.stdout}\n${result.stderr}`;
	const match = detectUsageLimit(output, RUNTIME_TYPES.CLAUDE_CODE);
	if (match?.kind === 'usage_limit') return 'limited';
	if (result.code === 0) return 'available';
	return 'unknown';
}

/**
 * Build the probe.
 *
 * @param deps - Dependencies (defaults: the real CLI and stored credentials)
 * @returns `probe(runtime)`; never rejects
 */
export function createRuntimeUsageProbe(deps: UsageProbeDeps = {}): (runtime: string) => Promise<ProbeResult> {
	const run = deps.run ?? runCommand;
	const baseEnv = deps.env ?? process.env;
	const homeDir = deps.homeDir ?? os.homedir();
	const timeoutMs = deps.timeoutMs ?? HARNESS_CONSTANTS.RELOGIN.PROBE_TIMEOUT_MS;
	const resolve = deps.resolveCommand ?? ((command: string) => resolveExecutable(command, buildHarnessPath(baseEnv.PATH, homeDir)));

	return async (runtime: string): Promise<ProbeResult> => {
		try {
			if (runtime !== RUNTIME_TYPES.CLAUDE_CODE) return 'unknown';
			const binary = resolve('claude');
			if (!binary) return 'unknown';
			const credentials = deps.credentials ?? getHarnessCredentialsStore();
			const env: NodeJS.ProcessEnv = { ...baseEnv, ...credentials.harnessEnvForAgents(baseEnv, HARNESS_CONSTANTS.IDS.CLAUDE_CODE) };
			for (const name of STRIPPED_ENV) delete env[name];
			const scratch = deps.scratchDir ?? path.join(os.tmpdir(), 'crewly-usage-probe');
			fs.mkdirSync(scratch, { recursive: true });
			const result = await run(binary, HARNESS_CONSTANTS.CLAUDE.PROBE_ARGS, { env, timeoutMs, cwd: scratch });
			return classifyClaudeUsageProbe(result);
		} catch {
			return 'unknown';
		}
	};
}
