/**
 * Login rules — per-harness patterns the login broker applies to terminal text.
 *
 * The broker runs a harness's own login command in a PTY and learns what is
 * happening purely from the screen: the sign-in URL, a one-time code, a
 * "paste the code" prompt, success and failure. Nothing here talks to a
 * harness API.
 *
 * Terminal text is messy, so it is normalized first:
 * - ANSI/OSC escapes are removed; OSC 8 hyperlink targets are kept as URL
 *   candidates; cursor-forward (`CSI n C`) and cursor-to-column (`CSI n G`)
 *   become spaces, which restores the gaps TUIs draw between words.
 * - TUIs such as Claude Code's may render words without spaces, so prompt,
 *   success and failure patterns are matched against both the normalized text
 *   and a copy with all spaces removed (patterns use `\s*` between words).
 * - A URL (or token) that a TUI wrapped at the terminal width continues on
 *   the next line(s); {@link extractWrappedRuns} joins those back.
 *
 * Values are only accepted once they are complete — followed by more output —
 * so a URL that arrives split across two PTY chunks is never exposed half-way.
 *
 * Rule sets are built from real output captured on 2026-09-25 (Claude Code
 * 2.1.282 `claude setup-token`, codex-cli 0.156.1 `codex login --device-auth`);
 * see login-rules.test.ts.
 *
 * @module services/harness/login-rules
 */

/* eslint-disable no-control-regex -- terminal escape sequences (ESC, BEL, …) are control characters by definition */

import { HARNESS_CONSTANTS } from '../../constants.js';
import type { HarnessId, LoginMethodId } from './harness.types.js';

/** Normalized terminal text. */
export interface NormalizedScreen {
	/** Text with escapes removed, `\n` line breaks, trailing spaces trimmed */
	text: string;
	/** `text` with every space and tab removed (for TUIs that drop spaces) */
	spaceless: string;
	/** Targets of OSC 8 hyperlinks seen in the raw output */
	hyperlinks: string[];
}

/** Patterns for one harness login method. */
export interface LoginRuleSet {
	harnessId: HarnessId;
	method: LoginMethodId;
	/** A URL candidate is the sign-in URL when this matches it */
	urlPattern: RegExp;
	/** Capture group 1 is the one-time code the user types elsewhere */
	userCodePattern?: RegExp;
	/** The harness is waiting for the user to type/paste something */
	inputPromptPattern?: RegExp;
	/** Success text */
	successPattern?: RegExp;
	/** Any match fails the login; the matched line becomes the message */
	failurePatterns: readonly RegExp[];
	/** A credential the harness prints on success (group 0), e.g. Claude's long-lived token */
	secretPattern?: RegExp;
	/** Success needs the secret: the harness does not store it itself (Claude setup-token) */
	successRequiresSecret: boolean;
	/** Exit code 0 counts as success (Codex writes its own credentials) */
	successOnExitZero: boolean;
	/** Confirm success with the harness's own status command before reporting it */
	verifyAfterSuccess: boolean;
}

/** What the rules found on the screen. */
export interface LoginRuleMatch {
	url: string | null;
	userCode: string | null;
	needsInput: boolean;
	succeeded: boolean;
	/** Line that matched a failure pattern */
	failureMessage: string | null;
	/** Captured credential — never log or expose it */
	secret: string | null;
}

/** Characters a URL may contain (RFC 3986 unreserved + reserved + `%`). */
const URL_CHAR_CLASS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";

/** A line made only of URL characters (a wrapped URL continuation). */
const URL_CONTINUATION = new RegExp(`^[${URL_CHAR_CLASS}]+$`);

/** A run of URL characters starting with http(s)://. */
const URL_RUN = new RegExp(`https?://[${URL_CHAR_CLASS}]+`, 'g');

/** Characters of a token-like secret. */
const TOKEN_CONTINUATION = /^[A-Za-z0-9_-]+$/;

/**
 * Patterns that look like credentials. Screen text exposed to front ends has
 * every match replaced with {@link HARNESS_CONSTANTS.LOGIN.REDACTED}.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
	/sk-ant-[A-Za-z0-9_-]{8,}/g,
	/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
	/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/\b(?:ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{16,}/g,
	/AIza[0-9A-Za-z_-]{30,}/g,
];

/**
 * Normalize raw PTY output for rule matching.
 *
 * @param raw - Raw bytes from the PTY, as a string
 * @returns Normalized text, a spaceless copy and OSC 8 hyperlink targets
 *
 * @example
 * ```ts
 * normalizeTerminalOutput('\x1b[1mPaste\x1b[1Ccode\x1b[0m\r\n').text; // 'Paste code\n'
 * ```
 */
export function normalizeTerminalOutput(raw: string): NormalizedScreen {
	const hyperlinks: string[] = [];
	let text = raw.replace(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, (_match, uri: string) => {
		if (uri && !hyperlinks.includes(uri)) hyperlinks.push(uri);
		return '';
	});
	text = text
		// Other OSC sequences (window title, etc.)
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
		// `\r\r\n` (TUIs) and `\r\n` are one line break; a lone `\r` redraws a line
		.replace(/\r+\n/g, '\n')
		.replace(/\r/g, '\n')
		// Cursor forward: TUIs use it instead of printing spaces
		.replace(/\x1b\[(\d*)C/g, (_match, n: string) => ' '.repeat(Math.max(1, Number(n) || 1)))
		// Remaining CSI sequences, except cursor-to-column (resolved below)
		.replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (match, final: string) => (final === 'G' ? match : ''));
	text = resolveColumnMoves(text)
		// Charset selection and other two-character escapes
		.replace(/\x1b[()][0-9A-Za-z]/g, '')
		.replace(/\x1b[@-Z\\-_]/g, '')
		// Other control characters except newline and tab
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
		.split('\n')
		.map((line) => line.replace(/[ \t]+$/, ''))
		.join('\n')
		// Runs of blank lines (TUI frames) collapse to one
		.replace(/\n{3,}/g, '\n\n');
	return { text, spaceless: text.replace(/[ \t]+/g, ''), hyperlinks };
}

/**
 * Turn cursor-to-column moves (`CSI n G`) into spaces.
 *
 * TUIs such as Claude Code's place each word with `CSI n G` instead of
 * printing the space before it (captured 2026-09-25:
 * `\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere…`). Moving right pads the line with
 * spaces up to column n; moving left (an overwrite) becomes a single space.
 *
 * @param text - Text whose only remaining CSI sequences are `CSI n G`
 * @returns Text with the moves replaced
 */
function resolveColumnMoves(text: string): string {
	let out = '';
	let column = 0;
	let last = 0;
	const pattern = /\x1b\[(\d*)G/g;
	const advance = (chunk: string): void => {
		out += chunk;
		const newline = chunk.lastIndexOf('\n');
		column = newline === -1 ? column + chunk.length : chunk.length - newline - 1;
	};
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		advance(text.slice(last, match.index));
		const target = Math.max(1, Number(match[1]) || 1) - 1;
		if (target > column) advance(' '.repeat(target - column));
		else if (target < column && target > 0) advance(' ');
		last = match.index + match[0].length;
	}
	advance(text.slice(last));
	return out;
}

/**
 * Find runs (URLs, tokens) and join the ones a TUI wrapped across lines.
 *
 * A run that reaches the end of a line at least `minWrappedLineLength` long
 * continues on the next line when that line consists only of continuation
 * characters. Joining stops at the first line that is shorter than the
 * minimum (the last piece of a wrapped run) or that is not a continuation.
 *
 * A run is only returned when it is complete: it ends before the end of its
 * line, or a non-empty line follows it. A run still being written at the end
 * of the buffer (possibly continued by the next PTY chunk) is skipped — unless
 * `final` is set because the process has exited.
 *
 * @param text - Normalized text
 * @param runPattern - Pattern matching a run on one line (the `g` flag is added)
 * @param continuation - Pattern a whole continuation line must match
 * @param options - `minWrappedLineLength` (Infinity disables joining), `final` (no more output will come)
 * @returns Complete runs, in order of appearance
 *
 * @example
 * ```ts
 * extractWrappedRuns('https://x.io/' + 'a'.repeat(40) + '\nbcd\nnext line\n', /https:\/\/\S+/, /^[a-z]+$/);
 * // ['https://x.io/aaaa…abcd']
 * ```
 */
export function extractWrappedRuns(
	text: string,
	runPattern: RegExp,
	continuation: RegExp,
	options: { minWrappedLineLength?: number; final?: boolean } = {},
): string[] {
	const minWrappedLineLength = options.minWrappedLineLength ?? HARNESS_CONSTANTS.LOGIN.WRAPPED_LINE_MIN_LENGTH;
	const lines = text.split('\n');
	const runs: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const pattern = new RegExp(runPattern.source, runPattern.flags.includes('g') ? runPattern.flags : `${runPattern.flags}g`);
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(line)) !== null) {
			let run = match[0];
			const reachesEnd = match.index + run.length === line.length;
			let lastLine = i;
			if (reachesEnd && line.length >= minWrappedLineLength) {
				let previousLength = line.length;
				let j = i + 1;
				while (j < lines.length && previousLength >= minWrappedLineLength && lines[j].length > 0 && continuation.test(lines[j])) {
					run += lines[j];
					previousLength = lines[j].length;
					lastLine = j;
					j++;
				}
			}
			// Complete when the run ends inside its line, or when output
			// continues on a later non-empty line.
			const complete =
				options.final === true || !reachesEnd || lines.slice(lastLine + 1).some((later) => later.length > 0);
			if (complete) runs.push(run);
			if (match[0].length === 0) pattern.lastIndex++;
		}
	}
	return runs;
}

/**
 * All complete URLs on the screen (wrapped ones joined), plus hyperlink targets.
 *
 * @param screen - Normalized screen
 * @param final - The process has exited: accept runs at the end of the buffer
 * @returns URL candidates
 */
export function extractUrlCandidates(screen: NormalizedScreen, final = false): string[] {
	return [...extractWrappedRuns(screen.text, URL_RUN, URL_CONTINUATION, { final }), ...screen.hyperlinks];
}

/**
 * Line of `text` that contains character offset `index`.
 *
 * @param text - Text
 * @param index - Offset
 * @returns The trimmed line
 */
function lineAt(text: string, index: number): string {
	const start = text.lastIndexOf('\n', index - 1) + 1;
	const endIdx = text.indexOf('\n', index);
	return text.slice(start, endIdx === -1 ? text.length : endIdx).trim();
}

/**
 * First match of a pattern in the text or its spaceless copy.
 *
 * @param pattern - Pattern (flags other than `g` are kept)
 * @param screen - Normalized screen
 * @returns The line that matched, or null
 */
function matchLine(pattern: RegExp, screen: NormalizedScreen): string | null {
	const nonGlobal = new RegExp(pattern.source, pattern.flags.replace('g', ''));
	for (const text of [screen.text, screen.spaceless]) {
		const found = nonGlobal.exec(text);
		if (found) return lineAt(text, found.index);
	}
	return null;
}

/**
 * Apply a rule set to the screen.
 *
 * @param rules - Rule set for the harness login method
 * @param screen - Whole session screen, normalized
 * @param options - `promptScreen`: screen since the user's last input (input prompt and failures are read
 *   from it; defaults to `screen`); `final`: the process has exited
 * @returns What was found
 */
export function evaluateLoginRules(
	rules: LoginRuleSet,
	screen: NormalizedScreen,
	options: { promptScreen?: NormalizedScreen; final?: boolean } = {},
): LoginRuleMatch {
	const promptScreen = options.promptScreen ?? screen;
	const final = options.final === true;
	const urls = extractUrlCandidates(screen, final).filter((candidate) => rules.urlPattern.test(candidate));
	// Redraws repeat the URL; the longest candidate is the most complete one.
	const url = urls.reduce<string | null>((best, candidate) => (best === null || candidate.length > best.length ? candidate : best), null);

	let userCode: string | null = null;
	if (rules.userCodePattern) {
		const found = new RegExp(rules.userCodePattern.source, rules.userCodePattern.flags.replace('g', '')).exec(screen.text);
		userCode = found?.[1] ?? null;
	}

	let secret: string | null = null;
	if (rules.secretPattern) {
		// Tokens are far shorter than the broker's PTY width, so they are never
		// wrapped; joining is disabled to avoid gluing a following word on.
		const tokenRuns = extractWrappedRuns(screen.text, rules.secretPattern, TOKEN_CONTINUATION, {
			minWrappedLineLength: Number.POSITIVE_INFINITY,
			final,
		});
		secret = tokenRuns.length > 0 ? tokenRuns[tokenRuns.length - 1] : null;
	}

	const needsInput = rules.inputPromptPattern ? matchLine(rules.inputPromptPattern, promptScreen) !== null : false;
	const successText = rules.successPattern ? matchLine(rules.successPattern, screen) !== null : false;
	const succeeded = rules.successRequiresSecret ? secret !== null : successText || secret !== null;

	// Failures are read from the output since the user's last input, so a
	// rejected code that the user then corrects does not fail the session.
	let failureMessage: string | null = null;
	for (const pattern of rules.failurePatterns) {
		const line = matchLine(pattern, promptScreen);
		if (line) {
			failureMessage = line;
			break;
		}
	}

	return { url, userCode, needsInput, succeeded, failureMessage, secret };
}

/**
 * Replace anything that looks like a credential with a placeholder.
 *
 * Besides {@link SECRET_PATTERNS}, every known secret is removed — including
 * the pieces of one a TUI wrapped over several lines.
 *
 * @param text - Text to redact
 * @param knownSecrets - Secrets captured in this session
 * @returns Redacted text
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
	const { REDACTED, REDACT_MIN_FRAGMENT } = HARNESS_CONSTANTS.LOGIN;
	let result = text;
	for (const secret of knownSecrets) {
		if (!secret) continue;
		result = result.split(secret).join(REDACTED);
		// Wrapped pieces of the secret, one per line
		result = result
			.split('\n')
			.map((line) => {
				const trimmed = line.trim();
				return trimmed.length >= REDACT_MIN_FRAGMENT && secret.includes(trimmed) ? line.replace(trimmed, REDACTED) : line;
			})
			.join('\n');
	}
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, REDACTED);
	}
	return result;
}

/** Claude Code `claude setup-token` (subscription login). */
export const CLAUDE_SETUP_TOKEN_RULES: LoginRuleSet = {
	harnessId: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
	method: 'subscription',
	urlPattern: /^https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.com|claude\.ai|anthropic\.com)\/\S*oauth\/authorize\?\S+/,
	inputPromptPattern: /paste\s*code\s*here\s*if\s*prompted/i,
	failurePatterns: [
		/invalid\s*code\.?\s*please\s*make\s*sure/i,
		/OAuth\s*error/i,
		/login\s*failed/i,
		/authentication\s*failed/i,
	],
	secretPattern: /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g,
	successRequiresSecret: true,
	successOnExitZero: false,
	verifyAfterSuccess: false,
};

/** Codex `codex login --device-auth` (ChatGPT device-code login). */
export const CODEX_DEVICE_AUTH_RULES: LoginRuleSet = {
	harnessId: HARNESS_CONSTANTS.IDS.CODEX_CLI,
	method: 'device',
	urlPattern: /^https:\/\/auth\.openai\.com\/codex\/device\S*$/,
	// The code follows "Enter this one-time code ..." on the next line; the
	// lookahead makes sure it is complete (followed by whitespace).
	userCodePattern: /one-time\s*code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})(?=\s)/i,
	successPattern: /successfully\s*logged\s*in/i,
	failurePatterns: [
		/login\s*(?:failed|error)/i,
		/device\s*code\s*(?:has\s*)?expired/i,
		/authorization\s*(?:was\s*)?(?:denied|declined)/i,
		/^\s*error:/im,
	],
	successRequiresSecret: false,
	successOnExitZero: true,
	verifyAfterSuccess: true,
};

/** Every rule set, by harness and method. */
const RULE_SETS: readonly LoginRuleSet[] = [CLAUDE_SETUP_TOKEN_RULES, CODEX_DEVICE_AUTH_RULES];

/**
 * The rule set for a harness login method.
 *
 * @param harnessId - Harness id
 * @param method - Login method id
 * @returns The rule set, or undefined when the method is not brokered
 */
export function getLoginRules(harnessId: string, method: string): LoginRuleSet | undefined {
	return RULE_SETS.find((rules) => rules.harnessId === harnessId && rules.method === method);
}
