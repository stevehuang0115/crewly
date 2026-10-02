/**
 * Owner login requests — recognising "log harness X in" in plain words.
 *
 * Two consumers:
 * - {@link parseOwnerLoginRequest}: the Slack DM interceptor. An owner who
 *   writes 「重新登录 claude」, 「换个账号登录 claude」 or "relogin codex" in the
 *   orchestrator's DM gets the login flow directly, without the LLM. The
 *   match is deliberately strict — the whole message must be the request —
 *   so a sentence that merely mentions a login still goes to the orc.
 * - {@link isOwnerLoginRequestEvidence}: the orchestrator's `harness-login`
 *   skill. The orc may start a login only when a real owner message asked for
 *   one; this is the evidence check over the owner's recent messages.
 *
 * `login claude@work` / `login claude account work` / 「登录 claude 账号 work」
 * asks for one of the owner's OTHER Claude Code accounts (issue #942,
 * claude-accounts.ts); the request then carries `account`. The bare form
 * `login claude work` counts only for an account that already exists
 * ("login claude please" is not an account).
 *
 * Incident 2026-09-26: the orc ran `claude setup-token` in its one-shot bash
 * tool (the process died with the call, every pasted code went stale) and
 * then claimed several times that it had sent a new link. The broker-backed
 * flow started from here keeps the login alive in its own PTY.
 *
 * @module services/harness/owner-login-request
 */

import { HARNESS_CONSTANTS } from '../../constants.js';
import { isValidClaudeAccountName } from './claude-accounts.js';
import type { HarnessId } from './harness.types.js';

/** A recognised owner login request. */
export type OwnerLoginRequest =
	/**
	 * A known harness (it may still have no broker login — Antigravity, Gemini).
	 * `account`: one of the owner's other Claude Code accounts.
	 */
	| { kind: 'harness'; harnessId: HarnessId; switchAccount: boolean; account?: string }
	/** A login request without a harness Crewly knows; `name` is what was written, or null. */
	| { kind: 'unknown'; name: string | null; switchAccount: boolean };

/** Harness names and aliases → id, longest first so "claude code" wins over "claude". */
const HARNESS_NAME_PATTERNS: ReadonlyArray<{ re: RegExp; id: HarnessId }> = [
	{ re: /^claude[\s_-]*code$/, id: HARNESS_CONSTANTS.IDS.CLAUDE_CODE },
	{ re: /^claude$/, id: HARNESS_CONSTANTS.IDS.CLAUDE_CODE },
	{ re: /^codex(?:[\s_-]*cli)?$/, id: HARNESS_CONSTANTS.IDS.CODEX_CLI },
	{ re: /^antigravity(?:[\s_-]*cli)?$/, id: HARNESS_CONSTANTS.IDS.ANTIGRAVITY_CLI },
	{ re: /^agy$/, id: HARNESS_CONSTANTS.IDS.ANTIGRAVITY_CLI },
	{ re: /^gemini(?:[\s_-]*cli)?$/, id: HARNESS_CONSTANTS.IDS.GEMINI_CLI },
];

/** Any harness mention inside a longer message (evidence check). */
const HARNESS_MENTIONS: ReadonlyArray<{ re: RegExp; id: HarnessId }> = [
	{ re: /claude/i, id: HARNESS_CONSTANTS.IDS.CLAUDE_CODE },
	{ re: /codex/i, id: HARNESS_CONSTANTS.IDS.CODEX_CLI },
	{ re: /antigravity|\bagy\b/i, id: HARNESS_CONSTANTS.IDS.ANTIGRAVITY_CLI },
	{ re: /gemini/i, id: HARNESS_CONSTANTS.IDS.GEMINI_CLI },
];

/**
 * Names that are coding assistants Crewly does not run. "登录 cursor" is
 * answered with the supported list; any other unknown word after a login
 * verb ("登录 gmail") is not a harness request and goes to the orc.
 */
const OTHER_CODING_TOOLS = /^(?:cursor|copilot|github\s*copilot|aider|opencode|cline|windsurf|kimi(?:\s*cli)?|qwen(?:\s*code)?|amp|goose|kiro|trae)$/;

/** Generic words for "the coding assistant" — a request for a harness without naming one. */
const GENERIC_HARNESS_WORDS = /^(?:harness|编程助手|编码助手|代码助手|ai\s*harness|cli)$/;

/** Chinese login verbs. The account-switch forms come first so they win. */
const ZH_VERB =
	'(?:换(?:一)?个(?:新)?账号(?:重新)?登[录陆]|换(?:一)?个号(?:重新)?登[录陆]|换账号(?:重新)?登[录陆]|换号(?:重新)?登[录陆]|用(?:另|别)(?:一)?个账号(?:重新)?登[录陆]|切换账号|换(?:一)?个(?:新)?账号|换账号|换号|重新登[录陆入]|重登[录陆]?|再登[录陆]|登[录陆入])';

/** English login verbs. */
const EN_VERB =
	'(?:re-?log\\s*in(?:\\s+to)?|re-?login(?:\\s+to)?|log\\s*in(?:\\s+to)?|login(?:\\s+to)?|sign\\s*in(?:\\s+to)?|re-?auth(?:enticate)?|switch\\s+(?:the\\s+)?accounts?(?:\\s+(?:for|of|on))?)';

/** Polite lead-ins that do not change the request. */
const PREFIX = '(?:(?:please|pls|can\\s+you|could\\s+you)\\s+)?(?:帮我|帮忙|麻烦(?:你)?|请(?:你)?|给我|你)?\\s*(?:(?:把|给|帮)\\s*)?';

/** Harmless endings. No 吗/了: "登录 claude 了吗" asks about a login, it does not request one. */
const SUFFIX = '\\s*(?:一下|下|吧)?\\s*[.。!！~～]*';

/**
 * A name after or before the verb: up to four ASCII words, fewest first
 * ("claude code", not "claude account"); `claude@work` and
 * "claude code account work" name one of the owner's other Claude accounts.
 */
const NAME = '([a-z][a-z0-9_-]*(?:@[a-z0-9][a-z0-9_-]*)?(?:\\s+[a-z0-9][a-z0-9_-]*){0,3}?|[a-z][a-z0-9_-]*\\s*(?:的)?(?:账号|帐号)\\s*[a-z0-9][a-z0-9_-]*|编程助手|编码助手|代码助手)';

/** "claude@work", "claude code account work", "claude 账号 work" → Claude Code, account "work". */
const CLAUDE_ACCOUNT_EXPLICIT = /^claude(?:[\s_-]*code)?\s*(?:@\s*|\s+account\s+|\s*(?:的)?(?:账号|帐号)\s*)([a-z0-9][a-z0-9_-]*)$/;

/** "claude work", "claude code work" — an account only when it already exists. */
const CLAUDE_ACCOUNT_BARE = /^claude(?:[\s_-]*code)?\s+([a-z0-9][a-z0-9_-]*)$/;

/** Options of {@link parseOwnerLoginRequest}. */
export interface ParseOwnerLoginOptions {
	/** The owner's existing other Claude Code accounts (lets "login claude work" name one) */
	knownClaudeAccounts?: readonly string[];
}

/** Optional "account" noun after the name ("claude 的账号", "claude account"). */
const ACCOUNT_NOUN = '(?:\\s*(?:的)?(?:账号|帐号|account))?';

/** "登录 claude" / "relogin to codex" / "换个账号登录 claude code". */
const VERB_FIRST = new RegExp(`^${PREFIX}(${ZH_VERB}|${EN_VERB})\\s*(?:到\\s*)?${NAME}${ACCOUNT_NOUN}${SUFFIX}$`, 'i');

/** "claude 重新登录" / "codex login" / "把 claude 换个账号登录". */
const NAME_FIRST = new RegExp(`^${PREFIX}${NAME}${ACCOUNT_NOUN}\\s*(?:重新)?(${ZH_VERB}|${EN_VERB})${SUFFIX}$`, 'i');

/** "给 claude 换个账号" / "switch claude account" / "switch claude to another account". */
const SWITCH_NAME = new RegExp(
	`^${PREFIX}(?:switch|change)\\s+${NAME}\\s+(?:to\\s+(?:another|a\\s+different|a\\s+new)\\s+)?accounts?${SUFFIX}$`,
	'i',
);

/** A bare verb ("重新登录", "login") — a request with no harness named. */
const BARE_VERB = new RegExp(`^${PREFIX}(${ZH_VERB}|${EN_VERB})${SUFFIX}$`, 'i');

/** Words that mark an account switch. */
const SWITCH_WORDS = /换|切换|switch|another\s+account|different\s+account|other\s+account|另一个账号|别的账号|其他账号/i;

/**
 * Normalise a DM for matching: drop Slack mention/link markup, collapse
 * whitespace, lower-case, trim.
 *
 * @param text - Raw message text
 * @returns Normalised text
 */
export function normaliseLoginText(text: string): string {
	return text
		.replace(/<@[A-Z0-9]+>/g, ' ')
		.replace(/<([^|>]+)\|([^>]+)>/g, '$2')
		.replace(/[「」“”"'`]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/**
 * Resolve a harness name or alias as written by a person.
 *
 * @param name - e.g. "claude code", "Claude", "agy", "codex cli"
 * @returns The harness id, or null
 *
 * @example
 * ```ts
 * resolveHarnessName('claude code'); // 'claude-code'
 * ```
 */
export function resolveHarnessName(name: string): HarnessId | null {
	const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
	for (const { re, id } of HARNESS_NAME_PATTERNS) {
		if (re.test(key)) return id;
	}
	return null;
}

/**
 * Turn a matched name into a request, or null when the name is not about a
 * coding assistant at all ("登录 gmail" is for the orc, not for us).
 *
 * @param rawName - Name as matched
 * @param switchAccount - Whether the owner asked for a different account
 * @param knownAccounts - The owner's existing other Claude Code accounts
 * @returns The request or null
 */
function requestForName(rawName: string, switchAccount: boolean, knownAccounts: readonly string[] = []): OwnerLoginRequest | null {
	const name = rawName.trim();
	const harnessId = resolveHarnessName(name);
	if (harnessId) return { kind: 'harness', harnessId, switchAccount };
	const explicit = CLAUDE_ACCOUNT_EXPLICIT.exec(name)?.[1];
	const bare = CLAUDE_ACCOUNT_BARE.exec(name)?.[1];
	const account = explicit ?? (bare && knownAccounts.includes(bare) ? bare : undefined);
	if (account && isValidClaudeAccountName(account)) {
		return { kind: 'harness', harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE, switchAccount: false, account };
	}
	if (GENERIC_HARNESS_WORDS.test(name)) return { kind: 'unknown', name: null, switchAccount };
	if (OTHER_CODING_TOOLS.test(name)) return { kind: 'unknown', name, switchAccount };
	return null;
}

/**
 * Recognise an owner's DM that asks Crewly to log a harness in (or switch
 * its account). The whole message must be the request; anything longer or
 * different returns null and is handled by the orchestrator as usual.
 *
 * @param text - Owner DM text
 * @param options - The owner's existing other Claude Code accounts
 * @returns The request, or null when the message is not a login request
 *
 * @example
 * ```ts
 * parseOwnerLoginRequest('换个账号登录 claude');
 * // { kind: 'harness', harnessId: 'claude-code', switchAccount: true }
 * parseOwnerLoginRequest('重新登录');
 * // { kind: 'unknown', name: null, switchAccount: false }
 * ```
 */
export function parseOwnerLoginRequest(text: string, options: ParseOwnerLoginOptions = {}): OwnerLoginRequest | null {
	const known = options.knownClaudeAccounts ?? [];
	if (typeof text !== 'string') return null;
	const normalised = normaliseLoginText(text);
	if (!normalised || normalised.length > HARNESS_CONSTANTS.OWNER_LOGIN.MAX_TRIGGER_LENGTH) return null;
	const switchAccount = SWITCH_WORDS.test(normalised);

	// Each form in turn; a form whose "name" is not a harness ("relogin" read
	// as name "re" + verb "login") does not end the search.
	const verbFirst = VERB_FIRST.exec(normalised);
	const fromVerbFirst = verbFirst ? requestForName(verbFirst[2], switchAccount, known) : null;
	if (fromVerbFirst) return fromVerbFirst;
	const nameFirst = NAME_FIRST.exec(normalised);
	const fromNameFirst = nameFirst ? requestForName(nameFirst[1], switchAccount, known) : null;
	if (fromNameFirst) return fromNameFirst;
	const switchName = SWITCH_NAME.exec(normalised);
	const fromSwitch = switchName ? requestForName(switchName[1], true, known) : null;
	if (fromSwitch) return fromSwitch;
	if (BARE_VERB.test(normalised)) return { kind: 'unknown', name: null, switchAccount };
	return null;
}

/** A login verb anywhere in a message (evidence check; broader than the trigger). */
const LOGIN_MENTION =
	/登[录陆入]|重登|换(?:一)?个?账号|切换账号|换号|re-?log\s*in|re-?login|\blog\s*in\b|\blog\s+(?:\S+\s+){1,2}in\b|\blogin\b|sign\s*in|setup-token|\/login|switch\s+(?:the\s+)?accounts?|login\s+link|登[录陆]链接/i;

/** Status questions — asking whether it is logged in is not asking to log in. */
const STATUS_QUESTION =
	/登[录陆]了吗|登[录陆]状态|是否(?:已经)?登[录陆]|有没有登[录陆]|登[录陆]过期了吗|(?:is|are)\s+\S+\s+logged\s+in|login\s+status|still\s+logged\s+in/i;

/**
 * Whether one owner message asks for a (re-)login of a harness. Mirrors the
 * install-skill approval check: the orchestrator's claim is not trusted, the
 * owner's own words are.
 *
 * Counts a message with a login verb that either names this harness or names
 * none (「不 我要重新登陆一个账号」 in a conversation about Claude). A message
 * naming only other harnesses, or a status question, does not count.
 *
 * @param message - Owner message text
 * @param harnessId - Harness the orchestrator wants to log in
 * @returns True when the message is evidence for that login
 */
export function isOwnerLoginRequestEvidence(message: string, harnessId: HarnessId): boolean {
	if (typeof message !== 'string' || !message.trim()) return false;
	const parsed = parseOwnerLoginRequest(message);
	if (parsed?.kind === 'harness') return parsed.harnessId === harnessId;
	if (!LOGIN_MENTION.test(message) || STATUS_QUESTION.test(message)) return false;
	const named = HARNESS_MENTIONS.filter(({ re }) => re.test(message)).map(({ id }) => id);
	return named.length === 0 || named.includes(harnessId);
}
