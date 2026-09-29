/**
 * Secret redactor for persisted terminal output.
 *
 * Every byte of agent PTY output that Crewly writes to disk
 * (~/.crewly/logs/sessions/*.log) passes through here, and so do the
 * one-time scrub of existing logs and shell history files
 * (`crewly security scrub-logs`). Three layers, applied in this order:
 *
 * 1. **Known values** — the exact value of every secret Crewly holds for the
 *    session (backend env + the session's spawn env, see
 *    collectSecretEnvValues). Catches secrets no pattern recognises (a Slack
 *    signing secret is plain hex). Masked as `[REDACTED <NAME>]`.
 * 2. **Secret-named assignments** — `NAME=value` where NAME is a secret name
 *    (isSecretEnvKey: `…API_KEY`, `…TOKEN`, `…SECRET`, `…PASSWORD`,
 *    `…PRIVATE_KEY`, … plus SECRET_REDACTION_CONSTANTS.KNOWN_SECRET_ENV_NAMES).
 *    The value is masked whatever it looks like. Names are matched on the
 *    whole identifier, so `TOKEN_COUNT=5` or `MAX_TOKENS=4096` are left alone
 *    (the name does not END in a secret suffix); `$VAR` references and
 *    already-masked values are left alone too.
 * 3. **Token shapes** — well-known raw credential formats wherever they
 *    appear: Slack `xoxb-/xoxp-/xoxa-/xoxe-/xapp-…`, OpenAI/DeepSeek `sk-…`,
 *    Anthropic `sk-ant-…`, Google `AIza…`, GitHub `ghp_/gho_/…` and
 *    `github_pat_…`, plus the wiki confidentiality patterns (JWTs, bearer
 *    headers, private-key blocks, connection strings).
 *
 * Redaction is idempotent: running it over already-redacted text changes
 * nothing and reports a count of 0.
 *
 * Output is streamed in arbitrary chunks, so a secret can be split between
 * two chunks. StreamingSecretRedactor holds back the tail after the last
 * whitespace (secrets never contain whitespace) and prepends it to the next
 * chunk, which keeps the whole thing linear with a small bounded carry.
 *
 * @module utils/secret-redactor
 */

import { SECRET_REDACTION_CONSTANTS } from '../constants.js';
import { SECRET_PATTERNS } from '../services/wiki/wiki-redaction.js';
import { isSecretEnvKey, type SecretEnvValue } from './secret-env.js';

/** A raw-token detector used by the redactor. */
interface TokenPattern {
	/** Pattern name, used in the mask */
	name: string;
	/** Global regex matching the credential */
	regex: RegExp;
	/** Replacement text */
	mask: string;
}

/**
 * Raw token shapes beyond the wiki SECRET_PATTERNS (which require a numeric
 * team segment for Slack tokens and do not know `xapp-` or `github_pat_`).
 */
const EXTRA_TOKEN_PATTERNS: readonly TokenPattern[] = [
	{ name: 'slack_token', regex: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g, mask: '[REDACTED slack_token]' },
	{ name: 'slack_app_token', regex: /\bxapp-[A-Za-z0-9-]{10,}/g, mask: '[REDACTED slack_app_token]' },
	{ name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, mask: '[REDACTED api_key]' },
	{ name: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, mask: '[REDACTED github_token]' },
];

/** Every token-shape detector, most specific first. */
const TOKEN_PATTERNS: readonly TokenPattern[] = [...EXTRA_TOKEN_PATTERNS, ...SECRET_PATTERNS];

/**
 * `NAME=value` (optionally quoted value). The value stops at whitespace,
 * quotes, backticks and shell separators. The identifier must start at a
 * word boundary so it is matched whole.
 */
const ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*)=(["']?)([^\s"'`;&|]+)/g;

/** Prefix every mask this module emits starts with. */
const REDACTED_PREFIX = '[REDACTED';

/** Mask written in place of a secret-named assignment's value. */
const ASSIGNMENT_MASK = '[REDACTED]';

/** Characters that can appear inside a credential or a `NAME=value` pair. */
const TOKEN_CHAR_RE = /[A-Za-z0-9_\-=.:/+"'[\]]/;

/** Known secret names, upper-cased, for O(1) lookup. */
const KNOWN_SECRET_NAMES = new Set<string>(SECRET_REDACTION_CONSTANTS.KNOWN_SECRET_ENV_NAMES);

/**
 * Whether an assignment's name marks its value as secret.
 *
 * @param name - Variable name as it appeared (any case)
 * @returns True for secret names (see module docs)
 */
export function isSecretAssignmentName(name: string): boolean {
	const upper = name.toUpperCase();
	return (
		KNOWN_SECRET_NAMES.has(upper) ||
		isSecretEnvKey(name) ||
		SECRET_REDACTION_CONSTANTS.SECRET_NAME_PATTERNS.some((re) => re.test(upper))
	);
}

/** Result of a counted redaction. */
export interface RedactionResult {
	/** The masked text */
	text: string;
	/** Number of secrets masked (0 when the text was already clean) */
	count: number;
}

/**
 * Masks every secret in a complete piece of text and counts what was masked.
 *
 * @param text - Text to mask
 * @param knownSecrets - Exact secret values to mask (see collectSecretEnvValues)
 * @returns Masked text and the number of secrets masked
 *
 * @example
 * ```ts
 * redactSecretsWithCount('export OPENAI_API_KEY=sk-abc…').count; // 1
 * redactSecretsWithCount('TOKEN_COUNT=5').count; // 0
 * ```
 */
export function redactSecretsWithCount(text: string, knownSecrets: readonly SecretEnvValue[] = []): RedactionResult {
	let out = text;
	let count = 0;

	for (const { name, value } of knownSecrets) {
		if (!value || !out.includes(value)) continue;
		const parts = out.split(value);
		count += parts.length - 1;
		out = parts.join(`${REDACTED_PREFIX} ${name}]`);
	}

	out = out.replace(ASSIGNMENT_RE, (match: string, name: string, quote: string, value: string) => {
		if (!isSecretAssignmentName(name) || value.startsWith('$') || value.startsWith(REDACTED_PREFIX)) return match;
		count++;
		return `${name}=${quote}${ASSIGNMENT_MASK}`;
	});

	for (const p of TOKEN_PATTERNS) {
		p.regex.lastIndex = 0;
		out = out.replace(p.regex, (match: string) => {
			if (match === p.mask) return match;
			count++;
			return p.mask;
		});
	}

	return { text: out, count };
}

/**
 * Masks every secret in a complete piece of text.
 *
 * @param text - Text to mask
 * @param knownSecrets - Exact secret values to mask
 * @returns The masked text
 */
export function redactSecrets(text: string, knownSecrets: readonly SecretEnvValue[] = []): string {
	return redactSecretsWithCount(text, knownSecrets).text;
}

/**
 * Chunk-boundary-safe redactor for streamed output.
 *
 * `push()` returns the redacted text that is safe to emit now and holds back
 * the tail after the last whitespace; `flush()` returns whatever is held back
 * (call it when the stream closes). Only the new chunk is scanned for
 * whitespace (the carry never contains any), so work is linear in the input.
 * A run of more than MAX_CARRY_CHARS non-whitespace characters is cut at a
 * non-token character near its end (or hard-cut when there is none), keeping
 * the carry bounded.
 *
 * @example
 * ```ts
 * const r = new StreamingSecretRedactor();
 * log.write(r.push('export GEMINI_API_KEY=AIzaSy'));
 * log.write(r.push('…rest of key\n'));
 * log.write(r.flush());
 * ```
 */
export class StreamingSecretRedactor {
	private carry = '';
	private knownSecrets: readonly SecretEnvValue[];
	private readonly maxCarry: number;
	private readonly minCarry: number;

	/**
	 * @param knownSecrets - Exact secret values to mask
	 * @param maxCarry - Longest whitespace-free tail held back before forcing a cut
	 */
	constructor(
		knownSecrets: readonly SecretEnvValue[] = [],
		maxCarry: number = SECRET_REDACTION_CONSTANTS.MAX_CARRY_CHARS,
	) {
		this.knownSecrets = knownSecrets;
		this.maxCarry = Math.max(maxCarry, 2);
		this.minCarry = Math.max(1, Math.min(SECRET_REDACTION_CONSTANTS.MIN_FORCED_CARRY_CHARS, Math.floor(this.maxCarry / 2)));
	}

	/**
	 * Replaces the exact-value secret set (e.g. after the session's env changes).
	 *
	 * @param knownSecrets - Exact secret values to mask
	 */
	setKnownSecrets(knownSecrets: readonly SecretEnvValue[]): void {
		this.knownSecrets = knownSecrets;
	}

	/**
	 * Feeds one chunk and returns the redacted text that can be emitted now.
	 *
	 * @param chunk - Next piece of output
	 * @returns Redacted text (possibly empty while a word is still arriving)
	 */
	push(chunk: string): string {
		if (!chunk) return '';
		const carryLength = this.carry.length;
		const buf = this.carry + chunk;

		let cut = -1;
		for (let i = buf.length - 1; i >= carryLength; i--) {
			if (isWhitespace(buf.charCodeAt(i))) {
				cut = i + 1;
				break;
			}
		}

		if (cut === -1 || buf.length - cut > this.maxCarry) {
			if (buf.length <= this.maxCarry) {
				this.carry = buf;
				return '';
			}
			cut = this.forcedCut(buf);
		}

		this.carry = buf.slice(cut);
		return cut > 0 ? redactSecrets(buf.slice(0, cut), this.knownSecrets) : '';
	}

	/**
	 * Returns (redacted) whatever is still held back and resets the carry.
	 *
	 * @returns Remaining redacted text
	 */
	flush(): string {
		const rest = this.carry;
		this.carry = '';
		return rest ? redactSecrets(rest, this.knownSecrets) : '';
	}

	/**
	 * Picks a cut point for a whitespace-free run that outgrew the carry: the
	 * last non-token character before the final minCarry characters, so a
	 * credential near the end is not split; hard cut when there is none.
	 *
	 * @param buf - Buffered text whose tail has no whitespace
	 * @returns Index to cut at
	 */
	private forcedCut(buf: string): number {
		const target = buf.length - this.minCarry;
		const floor = Math.max(0, target - this.minCarry);
		for (let i = target; i > floor; i--) {
			if (!TOKEN_CHAR_RE.test(buf[i - 1])) return i;
		}
		return target;
	}
}

/**
 * Whitespace test on a UTF-16 code unit (space, tab, CR, LF, VT, FF).
 *
 * @param code - Character code
 * @returns True for ASCII whitespace
 */
function isWhitespace(code: number): boolean {
	return code === 32 || (code >= 9 && code <= 13);
}
