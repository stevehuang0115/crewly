/**
 * Usage-limit rules — per-runtime patterns that mean "this runtime's account
 * is out of usage", as opposed to a login that expired (login-expiry-rules.ts,
 * the re-login flow) or a short rate limit the runtime retries by itself.
 *
 * Modelled on login-expiry-rules.ts: output is normalized with
 * {@link normalizeTerminalOutput} and every pattern is matched against the
 * normalized text and its spaceless copy (Claude Code places words with
 * cursor moves instead of spaces), so patterns use `\s*` between words.
 *
 * Wording sources:
 * - Claude Code 2.1.287 binary (`strings`, 2026-10-01): `Usage limit
 *   reached`, `Usage limit reached again`, `continuing automatically {when}`,
 *   `You're out of extra usage`, `You're out of usage credits`, `You've hit
 *   your monthly spend limit`, ` resets $…`, `/upgrade to increase your usage
 *   limit.`, the API's `billing_error` "spend limit reached (daily; resets …)",
 *   and its own note that the client composes "You've hit your limit" from a
 *   429. Older releases print `5-hour limit reached ∙ resets 3pm`, `Claude
 *   usage limit reached. Your limit will reset at 3pm (America/Los_Angeles).`
 *   and `Claude AI usage limit reached|<epoch>`.
 * - Codex: `You've hit your usage limit. Upgrade to Pro (…) or try again in
 *   4 days 7 hours 3 minutes.` / `… try again at 4:05 PM.`; transient:
 *   `exceeded retry limit, last status: 429 Too Many Requests`.
 * - Gemini / Antigravity: `RESOURCE_EXHAUSTED` with `Quota exceeded for quota
 *   metric '… per day'`, `You exceeded your current quota`, `You have
 *   exhausted your daily quota`; a bare 429 / RESOURCE_EXHAUSTED is transient.
 * - DeepSeek (the in-process Crewly Agent): HTTP 402 `Insufficient Balance`
 *   is a usage limit; HTTP 429 `Rate Limit Reached` is transient.
 *
 * Context requirements keep an agent that merely reads or quotes this kind of
 * text (for example while working on this file) from tripping a rule: the
 * Claude UI rules need the `·` / `∙` separator, a reset time or a slash
 * command next to the message; API rules need the API error context.
 * Warnings that the limit is near ("Approaching usage limit", "You've used
 * 90% of your session limit") are deliberately not matched.
 *
 * @module services/runtime-fallback/usage-limit-rules
 */

import { RUNTIME_TYPES } from '../../constants.js';
import { normalizeTerminalOutput, type NormalizedScreen } from '../harness/login-rules.js';
import { detectLoginExpiry } from '../harness/login-expiry-rules.js';
import { parseResetTime } from './reset-time.js';

/** `usage_limit`: the account is out of usage; `transient`: a short rate limit the runtime retries. */
export type UsageLimitKind = 'usage_limit' | 'transient';

/** One rule: every pattern must match (AND); `none` must not match. */
export interface UsageLimitRule {
	/** Stable id, used in logs (never contains output) */
	id: string;
	/** Runtime type the rule belongs to */
	runtime: string;
	kind: UsageLimitKind;
	/** All must match the normalized text or its spaceless copy */
	all: readonly RegExp[];
	/** None of these may match (e.g. a warning, not the limit itself) */
	none?: readonly RegExp[];
}

/** What {@link detectUsageLimit} found. */
export interface UsageLimitMatch {
	/** Runtime the rule belongs to */
	runtime: string;
	ruleId: string;
	kind: UsageLimitKind;
	/** When the limit lifts (epoch ms), when the message says so */
	resetAt: number | null;
}

/** Claude UI context: the separator, a reset time, or a Claude slash command. */
const CLAUDE_UI_CONTEXT = /[·∙•]|\bresets?\b|reset\s*at|continuing\s*automatically|\/(?:upgrade|extra-usage|usage-credits|rate-limit-options|model)\b|\|\s*\d{10}\b/i;
/** API error context for Claude: a 429 / billing error. */
const CLAUDE_API_429 = /\b429\b|rate_limit_error|billing_error/i;
/** Wording that means "usage", not a per-minute rate. */
const USAGE_WORDING = /usage\s*limit|limit\s*reached|hit\s*your\s*(?:[\w-]+\s*)?limit|spend\s*limit|quota|limit\s*will\s*reset|\bresets?\b|out\s*of\s*(?:extra\s*)?usage/i;

/** Claude Code rules (usage limits first, then transient). */
export const CLAUDE_USAGE_RULES: readonly UsageLimitRule[] = [
	{
		id: 'claude.api_usage_429',
		runtime: RUNTIME_TYPES.CLAUDE_CODE,
		kind: 'usage_limit',
		all: [/API\s*Error|"type"\s*:\s*"error"/i, CLAUDE_API_429, USAGE_WORDING],
	},
	{
		id: 'claude.api_credit_balance',
		runtime: RUNTIME_TYPES.CLAUDE_CODE,
		kind: 'usage_limit',
		all: [/API\s*Error|"type"\s*:\s*"error"/i, /credit\s*balance\s*(?:is\s*)?too\s*low/i],
	},
	{
		id: 'claude.legacy_limit_reached',
		runtime: RUNTIME_TYPES.CLAUDE_CODE,
		kind: 'usage_limit',
		all: [/Claude\s*(?:AI\s*)?usage\s*limit\s*reached\s*(?:\|\s*\d{10}|\.\s*Your\s*limit\s*will\s*reset)/i],
	},
	{
		id: 'claude.hit_your_limit',
		runtime: RUNTIME_TYPES.CLAUDE_CODE,
		kind: 'usage_limit',
		all: [/You['’]ve\s*hit\s*your\s*(?:[\w-]+\s*){0,3}limit/i, CLAUDE_UI_CONTEXT],
	},
	{
		id: 'claude.usage_limit_reached',
		runtime: RUNTIME_TYPES.CLAUDE_CODE,
		kind: 'usage_limit',
		all: [/usage\s*(?:credit\s*)?limit\s*reached/i, CLAUDE_UI_CONTEXT],
	},
	{
		id: 'claude.window_limit_reached',
		runtime: RUNTIME_TYPES.CLAUDE_CODE,
		kind: 'usage_limit',
		all: [/(?:5-hour|five-hour|weekly|session|daily|Opus|Sonnet|Fable)\s*limit\s*reached/i, CLAUDE_UI_CONTEXT],
	},
	{
		id: 'claude.out_of_usage',
		runtime: RUNTIME_TYPES.CLAUDE_CODE,
		kind: 'usage_limit',
		all: [/You['’]re\s*out\s*of\s*(?:extra\s*usage|usage\s*credits)/i, CLAUDE_UI_CONTEXT],
	},
	{
		id: 'claude.api_rate_limited',
		runtime: RUNTIME_TYPES.CLAUDE_CODE,
		kind: 'transient',
		all: [/API\s*Error/i, /\b429\b|rate_limit_error/i],
	},
	{
		id: 'claude.api_overloaded',
		runtime: RUNTIME_TYPES.CLAUDE_CODE,
		kind: 'transient',
		all: [/API\s*Error/i, /\b529\b|overloaded_error/i],
	},
];

/** Codex rules. */
export const CODEX_USAGE_RULES: readonly UsageLimitRule[] = [
	{
		id: 'codex.usage_limit',
		runtime: RUNTIME_TYPES.CODEX_CLI,
		kind: 'usage_limit',
		all: [/You['’]ve\s*hit\s*your\s*usage\s*limit/i, /try\s*again|upgrade|resets?/i],
	},
	{
		id: 'codex.quota_exceeded',
		runtime: RUNTIME_TYPES.CODEX_CLI,
		kind: 'usage_limit',
		all: [/insufficient_quota|exceeded\s*your\s*current\s*quota/i],
	},
	{
		id: 'codex.rate_limited',
		runtime: RUNTIME_TYPES.CODEX_CLI,
		kind: 'transient',
		all: [/\b429\b\s*Too\s*Many\s*Requests|exceeded\s*retry\s*limit|rate\s*limit\s*reached\s*for/i],
	},
];

/** Gemini quota rules, shared by Antigravity CLI and Gemini CLI. */
function geminiRules(runtime: string, prefix: string): UsageLimitRule[] {
	return [
		{
			id: `${prefix}.quota_exceeded`,
			runtime,
			kind: 'usage_limit',
			all: [/exceeded\s*your\s*current\s*quota|exhausted\s*your\s*(?:daily\s*)?quota|quota\s*exceeded\s*for\s*quota\s*metric[^\n]*per\s*day|daily\s*(?:quota|limit)\s*(?:exceeded|reached)/i],
		},
		{
			id: `${prefix}.rate_limited`,
			runtime,
			kind: 'transient',
			all: [/RESOURCE_EXHAUSTED|\b429\b\s*Too\s*Many\s*Requests|status\s*(?:code\s*)?:?\s*429|Resource\s*has\s*been\s*exhausted/i],
		},
	];
}

/** Antigravity CLI rules. */
export const ANTIGRAVITY_USAGE_RULES: readonly UsageLimitRule[] = geminiRules(RUNTIME_TYPES.ANTIGRAVITY_CLI, 'antigravity');

/** Gemini CLI rules (retired runtime, detect only). */
export const GEMINI_USAGE_RULES: readonly UsageLimitRule[] = geminiRules(RUNTIME_TYPES.GEMINI_CLI, 'gemini');

/**
 * In-process Crewly Agent rules. These run on the error of a failed model
 * call (never on text the model wrote), so they need no UI context.
 */
export const CREWLY_AGENT_USAGE_RULES: readonly UsageLimitRule[] = [
	{
		id: 'crewly-agent.insufficient_balance',
		runtime: RUNTIME_TYPES.CREWLY_AGENT,
		kind: 'usage_limit',
		all: [/Insufficient\s*Balance|\b402\b[^\n]*(?:Payment\s*Required|balance)/i],
	},
	{
		id: 'crewly-agent.quota_exceeded',
		runtime: RUNTIME_TYPES.CREWLY_AGENT,
		kind: 'usage_limit',
		all: [/insufficient_quota|exceeded\s*your\s*current\s*quota|exhausted\s*your\s*(?:daily\s*)?quota|credit\s*balance\s*(?:is\s*)?too\s*low|usage\s*limit\s*reached/i],
	},
	{
		id: 'crewly-agent.rate_limited',
		runtime: RUNTIME_TYPES.CREWLY_AGENT,
		kind: 'transient',
		all: [/\b429\b|Rate\s*Limit\s*Reached|Too\s*Many\s*Requests|RESOURCE_EXHAUSTED|overloaded/i],
	},
];

/** Rules by runtime. */
const RULES_BY_RUNTIME: Readonly<Record<string, readonly UsageLimitRule[]>> = {
	[RUNTIME_TYPES.CLAUDE_CODE]: CLAUDE_USAGE_RULES,
	[RUNTIME_TYPES.CODEX_CLI]: CODEX_USAGE_RULES,
	[RUNTIME_TYPES.ANTIGRAVITY_CLI]: ANTIGRAVITY_USAGE_RULES,
	[RUNTIME_TYPES.GEMINI_CLI]: GEMINI_USAGE_RULES,
	[RUNTIME_TYPES.CREWLY_AGENT]: CREWLY_AGENT_USAGE_RULES,
};

/**
 * Usage-limit rules for a runtime.
 *
 * @param runtime - Runtime type
 * @returns Rules to try (empty for a runtime without rules)
 */
export function getUsageLimitRules(runtime: string): readonly UsageLimitRule[] {
	return RULES_BY_RUNTIME[runtime] ?? [];
}

/**
 * Whether a pattern matches the normalized text or its spaceless copy.
 *
 * @param pattern - Pattern
 * @param screen - Normalized screen
 * @returns True on a match
 */
function matches(pattern: RegExp, screen: NormalizedScreen): boolean {
	const nonGlobal = new RegExp(pattern.source, pattern.flags.replace('g', ''));
	return nonGlobal.test(screen.text) || nonGlobal.test(screen.spaceless);
}

/**
 * Find a usage-limit (or transient rate-limit) message in a runtime's output.
 * An expired login is never reported here — that is the re-login flow's.
 *
 * @param output - Raw PTY output (escape sequences allowed), captured screen, or an error message
 * @param runtime - The runtime the output came from
 * @param now - Current time (ms), for the reset time
 * @param defaultTimeZone - Zone for reset clock times that name none
 * @returns The match, or null
 *
 * @example
 * ```ts
 * detectUsageLimit("You've hit your limit · resets 3pm (America/Los_Angeles)", 'claude-code');
 * // { runtime: 'claude-code', ruleId: 'claude.hit_your_limit', kind: 'usage_limit', resetAt: <next 3pm LA> }
 * ```
 */
export function detectUsageLimit(output: string, runtime: string, now: number = Date.now(), defaultTimeZone?: string): UsageLimitMatch | null {
	if (!output) return null;
	const rules = getUsageLimitRules(runtime);
	if (rules.length === 0) return null;
	if (detectLoginExpiry(output, runtime === RUNTIME_TYPES.CLAUDE_CODE || runtime === RUNTIME_TYPES.CODEX_CLI ? runtime : null)) {
		return null;
	}
	const screen = normalizeTerminalOutput(output);
	for (const rule of rules) {
		if (!rule.all.every((pattern) => matches(pattern, screen))) continue;
		if (rule.none?.some((pattern) => matches(pattern, screen))) continue;
		return {
			runtime: rule.runtime,
			ruleId: rule.id,
			kind: rule.kind,
			resetAt: rule.kind === 'usage_limit' ? parseResetTime(screen.text, now, defaultTimeZone) : null,
		};
	}
	return null;
}
