/**
 * Tests for the login rules, against terminal output captured on 2026-09-25:
 * Claude Code 2.1.282 `claude setup-token` (space-stripped TUI text, URL
 * wrapped at the terminal width) and codex-cli 0.156.1 `codex login --device-auth`.
 */

import {
	CLAUDE_SETUP_TOKEN_RULES,
	CODEX_DEVICE_AUTH_RULES,
	evaluateLoginRules,
	extractUrlCandidates,
	extractWrappedRuns,
	getLoginRules,
	normalizeTerminalOutput,
	redactSecrets,
} from './login-rules.js';

/** The authorize URL as Claude Code printed it, before the TUI wrapped it. */
const CLAUDE_URL =
	'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code' +
	'&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference' +
	'&code_challenge=Xy3kq9PZb0mN7vV2rT8uW1sA4dE6fG5hJ0kL9pO2iU3&code_challenge_method=S256&state=Qw8eR7tY6uI5oP4aS3dF2gH1jK0lZ9xC8vB7nM6qW5e';

/** Where the TUI wrapped the URL (right after `scope=user%3`), as in the capture. */
const WRAP_AT = CLAUDE_URL.indexOf('Ainference');

/** A long-lived token the way `setup-token` prints it (fake value). */
const CLAUDE_TOKEN = `sk-ant-oat01-${'AbCdEf0123456789_-'.repeat(5)}XyZ-AA`;

/** Captured `claude setup-token` screen: spaces stripped by the TUI, URL wrapped. */
const CLAUDE_CAPTURE_SPACELESS = [
	'Openingbrowsertosignin…',
	'',
	"Browserdidn'topen?Usetheurlbelowtosignin(ctocopy)",
	'',
	CLAUDE_URL.slice(0, WRAP_AT),
	CLAUDE_URL.slice(WRAP_AT),
	'',
	'Pastecodehereifprompted>',
	'',
].join('\r\n');

/** The same screen with normal spacing (what a wide PTY usually shows). */
const CLAUDE_CAPTURE_SPACED = [
	'Opening browser to sign in…',
	"Browser didn't open? Use the url below to sign in (c to copy)",
	CLAUDE_URL,
	'Paste code here if prompted >',
	'',
].join('\r\n');

/** Captured `codex login --device-auth` screen. */
const CODEX_CAPTURE = [
	'',
	'Follow these steps to sign in with ChatGPT using device code authorization:',
	'',
	'1. Open this link in your browser and sign in to your account',
	'   https://auth.openai.com/codex/device',
	'',
	'2. Enter this one-time code (expires in 15 minutes)',
	'   WH2P-EO69V',
	'',
	'Continue only if you started this login in Codex. Never share this code.',
	'',
].join('\r\n');

describe('normalizeTerminalOutput', () => {
	it('removes ANSI colour and cursor escapes and converts CRLF', () => {
		const screen = normalizeTerminalOutput('\x1b[1m\x1b[38;5;214mHello\x1b[0m\r\n\x1b[2K\x1b[1Aworld  \r\n');
		expect(screen.text).toBe('Hello\nworld\n');
	});

	it('turns cursor-forward into spaces so TUI words stay apart', () => {
		expect(normalizeTerminalOutput('Paste\x1b[1Ccode\x1b[3Chere').text).toBe('Paste code   here');
		expect(normalizeTerminalOutput('a\x1b[Cb').text).toBe('a b');
	});

	it('keeps OSC 8 hyperlink targets and drops other OSC sequences', () => {
		const raw = '\x1b]0;window title\x07\x1b]8;;https://example.com/x\x07link\x1b]8;;\x07 done';
		const screen = normalizeTerminalOutput(raw);
		expect(screen.text).toBe('link done');
		expect(screen.hyperlinks).toEqual(['https://example.com/x']);
	});

	it('builds a spaceless copy for TUIs that drop spaces', () => {
		expect(normalizeTerminalOutput('Paste code here if prompted >').spaceless).toBe('Pastecodehereifprompted>');
	});

	it('turns cursor-to-column moves into spaces (real Claude Code 2.1.282 bytes)', () => {
		const raw = '\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>\r\r\n';
		expect(normalizeTerminalOutput(raw).text).toBe(' Paste code here if prompted >\n');
	});

	it('treats \\r\\r\\n as one line break and collapses blank-line runs', () => {
		expect(normalizeTerminalOutput('a\r\r\nb\r\r\n\r\r\n\r\r\n\r\r\nc').text).toBe('a\nb\n\nc');
	});

	it('approximates a leftward column move with one space', () => {
		expect(normalizeTerminalOutput('abcdef\x1b[3Gx').text).toBe('abcdef x');
	});

	it('strips other control characters', () => {
		expect(normalizeTerminalOutput('a\x07b\x00c').text).toBe('abc');
	});
});

describe('extractWrappedRuns', () => {
	const run = /https:\/\/\S+/;
	const cont = /^[a-z0-9]+$/;

	it('joins a run wrapped over full-width lines', () => {
		const first = `https://x.io/${'a'.repeat(40)}`;
		expect(extractWrappedRuns(`${first}\nbcd\nnext line\n`, run, cont)).toEqual([`${first}bcd`]);
	});

	it('does not join lines shorter than the wrap threshold', () => {
		expect(extractWrappedRuns('https://x.io/a\nbcd\nnext\n', run, cont)).toEqual(['https://x.io/a']);
	});

	it('skips a run still being written at the end of the buffer', () => {
		expect(extractWrappedRuns('see https://x.io/abc', run, cont)).toEqual([]);
		expect(extractWrappedRuns(`https://x.io/${'a'.repeat(40)}\n`, run, cont)).toEqual([]);
	});

	it('accepts a run at the end of the buffer once the process has exited', () => {
		expect(extractWrappedRuns('see https://x.io/abc', run, cont, { final: true })).toEqual(['https://x.io/abc']);
	});

	it('accepts a run that ends inside its line', () => {
		expect(extractWrappedRuns('go to https://x.io/abc now', /https:\/\/[a-z./]+/, cont)).toEqual(['https://x.io/abc']);
	});

	it('never joins when joining is disabled', () => {
		const first = `https://x.io/${'a'.repeat(40)}`;
		expect(extractWrappedRuns(`${first}\nbcd\nmore\n`, run, cont, { minWrappedLineLength: Number.POSITIVE_INFINITY })).toEqual([first]);
	});
});

describe('Claude setup-token rules (captured output)', () => {
	it('reconstructs the wrapped URL from the space-stripped capture', () => {
		const match = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(CLAUDE_CAPTURE_SPACELESS));
		expect(match.url).toBe(CLAUDE_URL);
		expect(match.url).toContain('scope=user%3Ainference');
	});

	it('detects the paste prompt in space-stripped text', () => {
		const match = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(CLAUDE_CAPTURE_SPACELESS));
		expect(match.needsInput).toBe(true);
		expect(match.succeeded).toBe(false);
		expect(match.failureMessage).toBeNull();
		expect(match.userCode).toBeNull();
	});

	it('handles the normally spaced screen too', () => {
		const match = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(CLAUDE_CAPTURE_SPACED));
		expect(match.url).toBe(CLAUDE_URL);
		expect(match.needsInput).toBe(true);
	});

	it('handles ANSI-decorated output with cursor-forward spacing', () => {
		const raw = `\x1b[2mPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\x1b[0m`;
		const match = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(`\x1b[36m${CLAUDE_URL}\x1b[0m\r\n${raw}`));
		expect(match.url).toBe(CLAUDE_URL);
		expect(match.needsInput).toBe(true);
	});

	it('does not expose a URL that is cut off mid-chunk', () => {
		const partial = CLAUDE_CAPTURE_SPACELESS.slice(0, CLAUDE_CAPTURE_SPACELESS.indexOf('Ainference') + 5);
		expect(evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(partial)).url).toBeNull();
		const upToWrap = CLAUDE_CAPTURE_SPACELESS.slice(0, CLAUDE_CAPTURE_SPACELESS.indexOf('Ainference'));
		expect(evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(upToWrap)).url).toBeNull();
	});

	it('picks the URL from an OSC 8 hyperlink', () => {
		const raw = `\x1b]8;;${CLAUDE_URL}\x07sign in\x1b]8;;\x07\r\nPaste code here if prompted >`;
		expect(evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(raw)).url).toBe(CLAUDE_URL);
	});

	it('ignores URLs that are not the authorize URL', () => {
		const raw = 'See https://docs.claude.com/setup for help\r\nmore\r\n';
		expect(evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(raw)).url).toBeNull();
	});

	it('treats the printed long-lived token as success and captures it', () => {
		const after = [
			'✓Long-livedauthenticationtokencreatedsuccessfully!',
			'Your OAuth token (valid for 1 year):',
			CLAUDE_TOKEN,
			"Store this token securely. You won't be able to see it again.",
			'Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>',
			'',
		].join('\r\n');
		const raw = `${CLAUDE_CAPTURE_SPACELESS}code#state\r\n${after}`;
		const screen = normalizeTerminalOutput(raw);
		const promptScreen = normalizeTerminalOutput(after);
		const match = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, screen, { promptScreen });
		expect(match.succeeded).toBe(true);
		expect(match.secret).toBe(CLAUDE_TOKEN);
		expect(match.needsInput).toBe(false);
	});

	it('waits for the token to be complete before capturing it', () => {
		const partial = `Your OAuth token:\r\n${CLAUDE_TOKEN.slice(0, 40)}`;
		const match = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(partial));
		expect(match.secret).toBeNull();
		expect(match.succeeded).toBe(false);
		const final = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput(`Your OAuth token:\r\n${CLAUDE_TOKEN}`), { final: true });
		expect(final.secret).toBe(CLAUDE_TOKEN);
	});

	it('reports an invalid code from the output after the input only', () => {
		const after = 'Invalid code. Please make sure the full code was copied.\r\nPaste code here if prompted > ';
		const screen = normalizeTerminalOutput(`${CLAUDE_CAPTURE_SPACELESS}bad\r\n${after}`);
		const match = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, screen, { promptScreen: normalizeTerminalOutput(after) });
		expect(match.failureMessage).toBe('Invalid code. Please make sure the full code was copied.');
		expect(match.needsInput).toBe(true);
		// Before the input, the same screen shows no failure.
		const earlier = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, screen, { promptScreen: normalizeTerminalOutput('') });
		expect(earlier.failureMessage).toBeNull();
	});

	it('reports an OAuth error in space-stripped text', () => {
		const match = evaluateLoginRules(CLAUDE_SETUP_TOKEN_RULES, normalizeTerminalOutput('OAutherror:access_denied\r\n'));
		expect(match.failureMessage).toBe('OAutherror:access_denied');
	});
});

describe('Codex device-auth rules (captured output)', () => {
	it('extracts the device URL and the one-time code', () => {
		const match = evaluateLoginRules(CODEX_DEVICE_AUTH_RULES, normalizeTerminalOutput(CODEX_CAPTURE));
		expect(match.url).toBe('https://auth.openai.com/codex/device');
		expect(match.userCode).toBe('WH2P-EO69V');
		expect(match.needsInput).toBe(false);
		expect(match.succeeded).toBe(false);
		expect(match.failureMessage).toBeNull();
	});

	it('does not expose a code cut off mid-chunk', () => {
		const partial = CODEX_CAPTURE.slice(0, CODEX_CAPTURE.indexOf('WH2P-EO69V') + 7);
		expect(evaluateLoginRules(CODEX_DEVICE_AUTH_RULES, normalizeTerminalOutput(partial)).userCode).toBeNull();
	});

	it('detects success text', () => {
		const match = evaluateLoginRules(CODEX_DEVICE_AUTH_RULES, normalizeTerminalOutput(`${CODEX_CAPTURE}Successfully logged in\r\n`));
		expect(match.succeeded).toBe(true);
		expect(match.secret).toBeNull();
	});

	it('detects an expired device code', () => {
		const match = evaluateLoginRules(CODEX_DEVICE_AUTH_RULES, normalizeTerminalOutput(`${CODEX_CAPTURE}Error: device code expired\r\n`));
		expect(match.failureMessage).toBe('Error: device code expired');
	});

	it('does not mistake "Never share this code" for a failure', () => {
		expect(evaluateLoginRules(CODEX_DEVICE_AUTH_RULES, normalizeTerminalOutput(CODEX_CAPTURE)).failureMessage).toBeNull();
	});
});

describe('extractUrlCandidates', () => {
	it('returns plain and hyperlink URLs', () => {
		const screen = normalizeTerminalOutput('\x1b]8;;https://a.io/x\x07a\x1b]8;;\x07 https://b.io/y more\r\n');
		expect(extractUrlCandidates(screen)).toEqual(['https://b.io/y', 'https://a.io/x']);
	});
});

describe('redactSecrets', () => {
	it('redacts known secrets and anything that looks like a key or token', () => {
		const text = `token ${CLAUDE_TOKEN}\nopenai sk-proj-${'a'.repeat(30)}\njwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q`;
		const redacted = redactSecrets(text, [CLAUDE_TOKEN]);
		expect(redacted).not.toContain(CLAUDE_TOKEN);
		expect(redacted).not.toContain('sk-proj-');
		expect(redacted).not.toContain('eyJhbGciOiJIUzI1');
		expect(redacted).toContain('[redacted]');
	});

	it('redacts the pieces of a known secret wrapped over lines', () => {
		const secret = 'zz9fragmentAAAA1111bbbb2222';
		const text = `x\n${secret.slice(0, 13)}\n${secret.slice(13)}\ny`;
		const redacted = redactSecrets(text, [secret]);
		expect(redacted).toBe('x\n[redacted]\n[redacted]\ny');
	});

	it('leaves the authorize URL readable', () => {
		expect(redactSecrets(CLAUDE_URL)).toBe(CLAUDE_URL);
	});
});

describe('getLoginRules', () => {
	it('finds the rule set per harness and method', () => {
		expect(getLoginRules('claude-code', 'subscription')).toBe(CLAUDE_SETUP_TOKEN_RULES);
		expect(getLoginRules('codex-cli', 'device')).toBe(CODEX_DEVICE_AUTH_RULES);
		expect(getLoginRules('claude-code', 'api_key')).toBeUndefined();
		expect(getLoginRules('gemini-cli', 'device')).toBeUndefined();
	});
});
