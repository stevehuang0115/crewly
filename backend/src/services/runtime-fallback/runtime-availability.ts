/**
 * Which runtimes can be a fallback right now: installed and signed in.
 *
 * - Harness runtimes (Claude Code, Codex, Antigravity): the harness status
 *   (`GET /api/harness`) must say installed and `logged_in`.
 * - The Crewly Agent ships with Crewly; it needs an API key for its model's
 *   provider (DeepSeek by default).
 * - Gemini CLI is retired; OpenCode has no login check Crewly can run.
 * - A runtime whose first-run Terms the owner has not accepted on this
 *   machine (pending, "Don't agree", a failed setup) is skipped.
 * - Each of the owner's other Claude Code accounts (`claude-code@<name>`,
 *   issue #942) needs Claude Code installed and that account signed in.
 *
 * @module services/runtime-fallback/runtime-availability
 */

import { RUNTIME_TYPES } from '../../constants.js';
import { runtimeTarget } from '../harness/claude-accounts.js';
import { KNOWN_RUNTIMES, runtimeLabel, type RuntimeAvailability } from './runtime-fallback.types.js';

/** The harness facts availability needs. */
export interface HarnessFacts {
	id: string;
	installed: boolean;
	loginState: 'logged_in' | 'logged_out' | 'unknown';
}

/** Inputs of {@link computeRuntimeAvailability}. */
export interface AvailabilityInput {
	harnesses: readonly HarnessFacts[];
	/** provider/model the Crewly Agent fallback runs */
	crewlyAgentModel: string;
	/** Whether an API key is configured for a provider (`deepseek`, `google`, …) */
	hasProviderKey: (provider: string) => boolean;
	/**
	 * Why a runtime's first-run Terms keep it from running here (pending
	 * owner consent, "Don't agree", a failed setup), or null.
	 * specs/2026-10-01-runtime-terms-consent.md
	 */
	termsBlocked?: (runtime: string) => string | null;
	/** The owner's other Claude Code accounts on this machine */
	claudeAccounts?: ReadonlyArray<{ name: string; signedIn: boolean }>;
}

/** Provider display names. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	deepseek: 'DeepSeek',
	google: 'Gemini',
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	ollama: 'Ollama',
};

/**
 * Availability of every runtime.
 *
 * @param input - Harness facts, Crewly Agent model, key lookup
 * @returns One entry per known runtime, then one per Claude Code account, in a stable order
 *
 * @example
 * ```ts
 * computeRuntimeAvailability({ harnesses: [{ id: 'claude-code', installed: true, loginState: 'logged_in' }], crewlyAgentModel: 'deepseek/deepseek-chat', hasProviderKey: () => true });
 * ```
 */
export function computeRuntimeAvailability(input: AvailabilityInput): RuntimeAvailability[] {
	const runtimes = KNOWN_RUNTIMES.map((runtime): RuntimeAvailability => {
		const label = runtimeLabel(runtime, input.crewlyAgentModel);
		if (runtime === RUNTIME_TYPES.CREWLY_AGENT) {
			const provider = input.crewlyAgentModel.split('/')[0] ?? '';
			if (input.hasProviderKey(provider)) return { runtime, label, selectable: true };
			return { runtime, label, selectable: false, reason: `No ${PROVIDER_NAMES[provider] ?? provider} API key (Settings → API Keys)` };
		}
		if (runtime === RUNTIME_TYPES.GEMINI_CLI) return { runtime, label, selectable: false, reason: 'Retired (enterprise only)' };
		if (runtime === RUNTIME_TYPES.OPENCODE_CLI) return { runtime, label, selectable: false, reason: "Crewly can't check its sign-in" };
		const harness = input.harnesses.find((h) => h.id === runtime);
		if (!harness || !harness.installed) return { runtime, label, selectable: false, reason: 'Not installed' };
		if (harness.loginState === 'logged_out') return { runtime, label, selectable: false, reason: 'Not signed in' };
		if (harness.loginState !== 'logged_in') return { runtime, label, selectable: false, reason: "Sign-in couldn't be checked" };
		const terms = input.termsBlocked?.(runtime) ?? null;
		if (terms) return { runtime, label, selectable: false, reason: terms, termsBlocked: true };
		return { runtime, label, selectable: true };
	});
	const claude = input.harnesses.find((h) => h.id === RUNTIME_TYPES.CLAUDE_CODE);
	const accounts = (input.claudeAccounts ?? []).map((account): RuntimeAvailability => {
		const runtime = runtimeTarget(RUNTIME_TYPES.CLAUDE_CODE, account.name);
		const label = runtimeLabel(runtime);
		if (!claude || !claude.installed) return { runtime, label, selectable: false, reason: 'Not installed' };
		if (!account.signedIn) return { runtime, label, selectable: false, reason: `Not signed in (reply \`login claude ${account.name}\` in Slack)` };
		return { runtime, label, selectable: true };
	});
	return [...runtimes, ...accounts];
}
