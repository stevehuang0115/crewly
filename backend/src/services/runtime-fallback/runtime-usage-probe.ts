/**
 * Usage probe — does a runtime have usage right now?
 *
 * Reuses the harness-login-probe approach: for Claude Code one tiny
 * print-mode turn (`claude -p … --model haiku --no-session-persistence`) in
 * a scratch directory, with the env an agent gets. Output that matches a
 * usage-limit rule → `limited`; exit 0 → `available`; anything else
 * (network, login, timeout) → `unknown`.
 *
 * For the in-process Crewly Agent: one tiny API call (`max_tokens: 1`) to
 * each provider its agents use, with the stored key. HTTP 402 / a usage or
 * billing error → `limited`; 2xx → `available`; anything else → `unknown`.
 *
 * One of the owner's other Claude Code accounts (`claude-code@<name>`,
 * issue #942) is probed the same way, with that account's config dir and
 * token (claude-accounts.ts) instead of the default login.
 *
 * Other runtimes return `unsupported` (a probe would spend their usage or
 * needs a login Crewly cannot check cheaply); the fallback then relies on the
 * parsed reset time. `unknown` (the probe ran but could not tell) never
 * switches an agent back.
 *
 * The probe never prints or logs a secret.
 *
 * @module services/runtime-fallback/runtime-usage-probe
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { claudeAccountEnv, parseRuntimeTarget } from '../harness/claude-accounts.js';
import { getHarnessCredentialsStore, type HarnessCredentialsStore } from '../harness/harness-credentials.store.js';
import { buildHarnessPath, resolveExecutable, runCommand } from '../harness/harness-exec.utils.js';
import type { RunCommand } from '../harness/harness.types.js';
import { detectUsageLimit, isExhaustingKind } from './usage-limit-rules.js';
import type { ProbeResult } from './runtime-fallback.service.js';

/** One provider the in-process Crewly Agent uses, with its key. */
export interface CrewlyAgentProbeTarget {
	/** Provider id (`deepseek`, `openai`, `anthropic`, `google`, …) */
	provider: string;
	/** API key (never logged) */
	apiKey: string;
	/** Model id without the provider prefix, when an agent names one */
	model?: string;
}

/** Minimal fetch. */
export type ProbeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/** Injectable dependencies. */
export interface UsageProbeDeps {
	/** Providers (with keys) the Crewly Agent runtime uses; empty → `unknown` */
	crewlyAgentTargets?: () => Promise<CrewlyAgentProbeTarget[]>;
	fetch?: ProbeFetch;
	run?: RunCommand;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	resolveCommand?: (command: string) => string | null;
	credentials?: Pick<HarnessCredentialsStore, 'harnessEnvForAgents'>;
	scratchDir?: string;
	timeoutMs?: number;
	/** Env of one of the owner's other Claude Code accounts (default: claude-accounts.ts) */
	accountEnv?: (account: string) => Record<string, string>;
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
	if (match && isExhaustingKind(match.kind)) return 'limited';
	if (result.code === 0) return 'available';
	return 'unknown';
}

/**
 * Classify a provider's answer to a one-token request.
 *
 * @param status - HTTP status
 * @param body - Response body (never logged)
 * @returns `available` on 2xx, `limited` on 402 or a usage/billing error, else `unknown`
 *
 * @example
 * ```ts
 * classifyProviderProbe(402, '{"error":{"message":"Insufficient Balance"}}'); // 'limited'
 * ```
 */
export function classifyProviderProbe(status: number, body: string): ProbeResult {
	if (status >= 200 && status < 300) return 'available';
	if (status === 402) return 'limited';
	const match = detectUsageLimit(`statusCode: ${status} ${body}`, RUNTIME_TYPES.CREWLY_AGENT);
	if (match && isExhaustingKind(match.kind)) return 'limited';
	return 'unknown';
}

/** How to send a one-token request to a provider. */
interface ProviderRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/**
 * The smallest request a provider bills (one output token).
 *
 * @param target - Provider, key, model
 * @returns The request, or null for a provider without a cheap probe
 */
function providerRequest(target: CrewlyAgentProbeTarget): ProviderRequest | null {
	const prompt = [{ role: 'user', content: 'ok' }];
	switch (target.provider) {
		case 'deepseek':
			return {
				url: 'https://api.deepseek.com/chat/completions',
				headers: { authorization: `Bearer ${target.apiKey}` },
				body: { model: target.model || 'deepseek-chat', messages: prompt, max_tokens: 1 },
			};
		case 'openai':
			if (!target.model) return null;
			return {
				url: 'https://api.openai.com/v1/chat/completions',
				headers: { authorization: `Bearer ${target.apiKey}` },
				body: { model: target.model, messages: prompt, max_tokens: 1 },
			};
		case 'anthropic':
			if (!target.model) return null;
			return {
				url: 'https://api.anthropic.com/v1/messages',
				headers: { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' },
				body: { model: target.model, messages: prompt, max_tokens: 1 },
			};
		default:
			return null;
	}
}

/**
 * Probe the providers the Crewly Agent runtime uses.
 *
 * @param targets - Providers with keys
 * @param fetchFn - fetch
 * @param timeoutMs - Per-request timeout
 * @returns `limited` if any is out, `unknown` if any could not tell, `unsupported` when none can be probed, else `available`
 */
async function probeCrewlyAgent(targets: CrewlyAgentProbeTarget[], fetchFn: ProbeFetch, timeoutMs: number): Promise<ProbeResult> {
	const results: ProbeResult[] = [];
	for (const target of targets) {
		const req = providerRequest(target);
		if (!req) {
			results.push('unsupported');
			continue;
		}
		try {
			const res = await fetchFn(req.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...req.headers },
				body: JSON.stringify(req.body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			results.push(classifyProviderProbe(res.status, await res.text().catch(() => '')));
		} catch {
			results.push('unknown');
		}
	}
	if (results.length === 0) return 'unknown';
	if (results.includes('limited')) return 'limited';
	if (results.includes('unknown')) return 'unknown';
	if (results.every((r) => r === 'unsupported')) return 'unsupported';
	return 'available';
}

/**
 * Build the probe.
 *
 * @param deps - Dependencies (defaults: the real CLI and stored credentials)
 * @returns `probe(runtime)` (a runtime target: `claude-code@work` probes that account); never rejects
 */
export function createRuntimeUsageProbe(deps: UsageProbeDeps = {}): (runtime: string) => Promise<ProbeResult> {
	const run = deps.run ?? runCommand;
	const baseEnv = deps.env ?? process.env;
	const homeDir = deps.homeDir ?? os.homedir();
	const timeoutMs = deps.timeoutMs ?? HARNESS_CONSTANTS.RELOGIN.PROBE_TIMEOUT_MS;
	const resolve = deps.resolveCommand ?? ((command: string) => resolveExecutable(command, buildHarnessPath(baseEnv.PATH, homeDir)));

	const accountEnv = deps.accountEnv ?? ((account: string) => claudeAccountEnv(account));

	return async (target: string): Promise<ProbeResult> => {
		try {
			const { runtime, account } = parseRuntimeTarget(target);
			if (runtime === RUNTIME_TYPES.CREWLY_AGENT) {
				const targets = deps.crewlyAgentTargets ? await deps.crewlyAgentTargets() : [];
				const fetchFn = deps.fetch ?? (globalThis.fetch as unknown as ProbeFetch);
				return await probeCrewlyAgent(targets, fetchFn, timeoutMs);
			}
			if (runtime !== RUNTIME_TYPES.CLAUDE_CODE) return 'unsupported';
			const binary = resolve('claude');
			if (!binary) return 'unknown';
			const credentials = deps.credentials ?? getHarnessCredentialsStore();
			const env: NodeJS.ProcessEnv = {
				...baseEnv,
				...credentials.harnessEnvForAgents(baseEnv, HARNESS_CONSTANTS.IDS.CLAUDE_CODE),
				...(account ? accountEnv(account) : {}),
			};
			for (const name of STRIPPED_ENV) delete env[name];
			// An account's blanked default credentials: leave them out entirely.
			for (const name of [HARNESS_CONSTANTS.CLAUDE.OAUTH_TOKEN_ENV, HARNESS_CONSTANTS.CLAUDE.API_KEY_ENV]) if (env[name] === '') delete env[name];
			const scratch = deps.scratchDir ?? path.join(os.tmpdir(), 'crewly-usage-probe');
			fs.mkdirSync(scratch, { recursive: true });
			const result = await run(binary, HARNESS_CONSTANTS.CLAUDE.PROBE_ARGS, { env, timeoutMs, cwd: scratch });
			return classifyClaudeUsageProbe(result);
		} catch {
			return 'unknown';
		}
	};
}
