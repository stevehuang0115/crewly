/**
 * Login expiry rules — per-harness patterns that mean "this agent's harness
 * login has expired and a human has to sign in again".
 *
 * Used by the OAuth re-login monitor on agent terminal output (live PTY
 * chunks and the periodic screen sweep). A match is handed to the harness
 * re-login coordinator (harness-relogin.service.ts), which runs one broker
 * login per harness and asks the owner over Slack.
 *
 * Output is normalized with {@link normalizeTerminalOutput} first, and every
 * pattern is matched against the normalized text and its spaceless copy,
 * because Claude Code places words with cursor moves instead of spaces.
 * Patterns therefore use `\s*` between words.
 *
 * Wording sources:
 * - Claude Code 2.1.282, from the binary (`strings`, 2026-09-25):
 *   `Login expired · Please run /login`, `OAuth token revoked · Please run
 *   /login`, `Not logged in · Please run /login`, `API Error: 401 Invalid
 *   API key · Please run /login`, `Session expired. Please run /login to sign
 *   in again.`, and the API's own `OAuth token has expired` /
 *   `OAuth token has been revoked` inside an `authentication_error`.
 *   Deliberately NOT matched: the warning `Your login expires in 3 days ·
 *   run /login to renew` (the login still works).
 * - Codex (codex-rs auth refresh errors and the Responses API 401): `Your
 *   access token could not be refreshed because your refresh token has
 *   expired`, `Provided authentication token is expired`,
 *   `"code":"token_expired"`, `unexpected status 401 Unauthorized`.
 *
 * UI messages require Claude's `·` separator, so an agent that merely reads
 * source code mentioning "please run /login" does not trip them; API errors
 * require the `authentication_error` / `401` context in the same text.
 *
 * @module services/harness/login-expiry-rules
 */

import { HARNESS_CONSTANTS } from '../../constants.js';
import type { HarnessId } from './harness.types.js';
import { normalizeTerminalOutput, type NormalizedScreen } from './login-rules.js';

/** One expiry rule: every pattern must match (AND). */
export interface LoginExpiryRule {
	/** Stable id, used in logs (never contains output) */
	id: string;
	harnessId: HarnessId;
	/** All must match the normalized text or its spaceless copy */
	all: readonly RegExp[];
}

/** What {@link detectLoginExpiry} found. */
export interface LoginExpiryMatch {
	harnessId: HarnessId;
	/** Id of the rule that matched */
	ruleId: string;
}

/** API error context: an authentication error or an HTTP 401. */
const AUTH_ERROR_CONTEXT = /authentication_error|API\s*Error|\b401\b/i;

/** Claude Code expiry rules. */
export const CLAUDE_EXPIRY_RULES: readonly LoginExpiryRule[] = [
	{
		id: 'claude.api_oauth_expired',
		harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		all: [/OAuth\s*(?:access\s*)?token\s*(?:has\s*)?expired/i, AUTH_ERROR_CONTEXT],
	},
	{
		id: 'claude.api_oauth_revoked',
		harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		all: [/OAuth\s*(?:access\s*)?token\s*has\s*been\s*revoked/i, AUTH_ERROR_CONTEXT],
	},
	{
		id: 'claude.api_invalid_credentials',
		harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		all: [/Invalid\s*authentication\s*credentials/i, AUTH_ERROR_CONTEXT],
	},
	{
		id: 'claude.login_expired',
		harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		all: [/Login\s*expired\s*·\s*(?:Please\s*)?run\s*\/login/i],
	},
	{
		id: 'claude.token_revoked',
		harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		all: [/OAuth\s*token\s*revoked\s*·\s*(?:Please\s*)?run\s*\/login/i],
	},
	{
		id: 'claude.not_logged_in',
		harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		all: [/Not\s*logged\s*in\s*·\s*(?:Please\s*)?run\s*\/login/i],
	},
	{
		id: 'claude.api_401_run_login',
		harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		all: [/API\s*Error:?\s*401\b[^\n]*·\s*Please\s*run\s*\/login/i],
	},
	{
		id: 'claude.session_expired',
		harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		all: [/session\s*(?:has\s*)?expired\.\s*Please\s*run\s*\/login/i],
	},
];

/** Codex expiry rules. */
export const CODEX_EXPIRY_RULES: readonly LoginExpiryRule[] = [
	{
		id: 'codex.refresh_failed',
		harnessId: HARNESS_CONSTANTS.IDS.CODEX_CLI,
		all: [/access\s*token\s*could\s*not\s*be\s*refreshed/i],
	},
	{
		id: 'codex.refresh_token_invalid',
		harnessId: HARNESS_CONSTANTS.IDS.CODEX_CLI,
		all: [/refresh\s*token\s*(?:has\s*expired|was\s*already\s*used|was\s*revoked)/i],
	},
	{
		id: 'codex.api_token_expired',
		harnessId: HARNESS_CONSTANTS.IDS.CODEX_CLI,
		all: [/Provided\s*authentication\s*token\s*is\s*expired|"code"\s*:\s*"token_expired"/i],
	},
	{
		id: 'codex.api_401',
		harnessId: HARNESS_CONSTANTS.IDS.CODEX_CLI,
		all: [/unexpected\s*status\s*401\s*Unauthorized/i],
	},
];

/** Every rule, by harness. */
const RULES_BY_HARNESS: Readonly<Record<string, readonly LoginExpiryRule[]>> = {
	[HARNESS_CONSTANTS.IDS.CLAUDE_CODE]: CLAUDE_EXPIRY_RULES,
	[HARNESS_CONSTANTS.IDS.CODEX_CLI]: CODEX_EXPIRY_RULES,
};

/**
 * Expiry rules for a harness (or for every harness when the runtime is unknown).
 *
 * @param harnessId - Harness / runtime id, or null
 * @returns Rules to try
 */
export function getLoginExpiryRules(harnessId: string | null): readonly LoginExpiryRule[] {
	if (harnessId === null) return [...CLAUDE_EXPIRY_RULES, ...CODEX_EXPIRY_RULES];
	return RULES_BY_HARNESS[harnessId] ?? [];
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
 * Find an expired-login message in agent terminal output.
 *
 * @param output - Raw PTY output (escape sequences allowed) or captured screen text
 * @param harnessId - The agent's runtime (a harness id), or null to try every harness
 * @returns The harness whose login expired and the rule that matched, or null
 *
 * @example
 * ```ts
 * detectLoginExpiry('  ⎿  Login expired · Please run /login', 'claude-code');
 * // { harnessId: 'claude-code', ruleId: 'claude.login_expired' }
 * ```
 */
export function detectLoginExpiry(output: string, harnessId: string | null): LoginExpiryMatch | null {
	if (!output) return null;
	const rules = getLoginExpiryRules(harnessId);
	if (rules.length === 0) return null;
	const screen = normalizeTerminalOutput(output);
	for (const rule of rules) {
		if (rule.all.every((pattern) => matches(pattern, screen))) {
			return { harnessId: rule.harnessId, ruleId: rule.id };
		}
	}
	return null;
}
