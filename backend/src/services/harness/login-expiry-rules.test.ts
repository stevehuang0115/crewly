/**
 * Tests for login expiry detection.
 *
 * Claude samples use the exact wording found in the Claude Code 2.1.282
 * binary; the TUI-rendered ones place words with `CSI n G`, as Claude Code
 * does on screen.
 */

import { CLAUDE_EXPIRY_RULES, CODEX_EXPIRY_RULES, detectLoginExpiry, getLoginExpiryRules } from './login-expiry-rules.js';

/** The API error Claude Code prints when its OAuth access token expired. */
const CLAUDE_API_EXPIRED =
	'  ⎿  API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. ' +
	'Please obtain a new token or refresh your existing token."},"request_id":"req_011CTq2"} · Please run /login\r\n';

/**
 * Render words the way Claude Code's TUI does: each word placed with a
 * cursor-to-column move instead of a preceding space.
 *
 * @param words - Words of the line
 * @returns Raw PTY text
 */
function tuiLine(words: string[]): string {
	let column = 2;
	let out = '';
	for (const word of words) {
		out += `\x1b[${column}G${word}`;
		column += word.length + 1;
	}
	return `${out}\r\n`;
}

describe('detectLoginExpiry — Claude Code', () => {
	it.each([
		['the API "OAuth token has expired" error', CLAUDE_API_EXPIRED, 'claude.api_oauth_expired'],
		[
			'the API "token has been revoked" error',
			'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked."}}',
			'claude.api_oauth_revoked',
		],
		[
			'invalid credentials',
			'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
			'claude.api_invalid_credentials',
		],
		['"Login expired · Please run /login"', '  ⎿  Login expired · Please run /login\n', 'claude.login_expired'],
		['"OAuth token revoked · Please run /login"', 'OAuth token revoked · Please run /login', 'claude.token_revoked'],
		['the "Not logged in · Please run /login" footer', 'Not logged in · Please run /login', 'claude.not_logged_in'],
		['the "Not logged in · Run /login" footer', 'Not logged in · Run /login', 'claude.not_logged_in'],
		['"API Error: 401 Invalid API key · Please run /login"', 'API Error: 401 Invalid API key · Please run /login', 'claude.api_401_run_login'],
		['"Your session has expired. Please run /login…"', 'Your session has expired. Please run /login to sign in again.', 'claude.session_expired'],
	])('detects %s', (_label, output, ruleId) => {
		expect(detectLoginExpiry(output, 'claude-code')).toEqual({ harnessId: 'claude-code', ruleId });
	});

	it('detects a TUI line whose words are placed with cursor moves (no spaces)', () => {
		const raw = `\x1b[38;5;203m${tuiLine(['⎿', 'Login', 'expired', '·', 'Please', 'run', '/login'])}\x1b[0m`;
		expect(detectLoginExpiry(raw, 'claude-code')?.ruleId).toBe('claude.login_expired');
	});

	it('does not fire on the "login expires soon" warning', () => {
		expect(detectLoginExpiry('Your login expires in 3 days · run /login to renew', 'claude-code')).toBeNull();
	});

	it('does not fire on source code or prose that mentions /login without the UI separator', () => {
		expect(detectLoginExpiry("const hint = 'Not logged in. Please run /login';", 'claude-code')).toBeNull();
		expect(detectLoginExpiry('The OAuth token has expired in our test fixture', 'claude-code')).toBeNull();
	});

	it('does not fire on normal output', () => {
		expect(detectLoginExpiry('✻ Thinking… (12s · ↓ 1.2k tokens)\n> ', 'claude-code')).toBeNull();
	});

	it('does not apply Claude rules to a Codex session', () => {
		expect(detectLoginExpiry(CLAUDE_API_EXPIRED, 'codex-cli')).toBeNull();
	});
});

describe('detectLoginExpiry — Codex', () => {
	it.each([
		[
			'a refresh-token expiry',
			'■ Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
			'codex.refresh_failed',
		],
		['a reused refresh token', 'error: refresh token was already used', 'codex.refresh_token_invalid'],
		[
			'the Responses API token_expired error',
			'■ stream error: {"error":{"message":"Provided authentication token is expired. Please try signing in again.","code":"token_expired"}}',
			'codex.api_token_expired',
		],
		['a bare 401', '■ unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', 'codex.api_401'],
	])('detects %s', (_label, output, ruleId) => {
		expect(detectLoginExpiry(output, 'codex-cli')).toEqual({ harnessId: 'codex-cli', ruleId });
	});

	it('does not fire on normal Codex output', () => {
		expect(detectLoginExpiry('• Ran npm test\n  └ 42 passed\n▌ Ask Codex to do anything', 'codex-cli')).toBeNull();
	});
});

describe('detectLoginExpiry — unknown runtime', () => {
	it('tries every harness and reports which one expired', () => {
		expect(detectLoginExpiry(CLAUDE_API_EXPIRED, null)?.harnessId).toBe('claude-code');
		expect(detectLoginExpiry('unexpected status 401 Unauthorized', null)?.harnessId).toBe('codex-cli');
	});

	it('returns null for empty output and for harnesses without rules', () => {
		expect(detectLoginExpiry('', 'claude-code')).toBeNull();
		expect(detectLoginExpiry(CLAUDE_API_EXPIRED, 'gemini-cli')).toBeNull();
	});
});

describe('getLoginExpiryRules', () => {
	it('returns the rules of one harness, or all of them', () => {
		expect(getLoginExpiryRules('claude-code')).toBe(CLAUDE_EXPIRY_RULES);
		expect(getLoginExpiryRules('codex-cli')).toBe(CODEX_EXPIRY_RULES);
		expect(getLoginExpiryRules(null)).toHaveLength(CLAUDE_EXPIRY_RULES.length + CODEX_EXPIRY_RULES.length);
		expect(getLoginExpiryRules('opencode-cli')).toEqual([]);
	});
});
