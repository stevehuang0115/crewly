/**
 * Tests for start-up screen error scoping (ce-nova incident, 2026-10-07).
 */

import { findStartupErrorPattern, isShellFailurePattern, shellOutputLines } from './runtime-startup-screen.js';

const CLAUDE_PATTERNS = ['Permission denied', 'No such file or directory', 'command not found: claude'];
const CODEX_PATTERNS = ['Permission denied', 'No such file or directory', 'command not found: codex', 'Invalid API key', 'Rate limit exceeded'];

/** `claude --resume` re-rendering a conversation whose bash output hit a missing file. */
const RESUMED_HISTORY = [
	'me@mac ce-core % claude --resume fbaa420a-711e-4991-b059-9ec1b6a82f5e --dangerously-skip-permissions',
	' ▐▛███▜▌   Claude Code v2.1.289',
	'▝▜█████▛▘  Opus 4.7 · Claude Max',
	'  ▘▘ ▝▝    ~/Desktop/projects/ce-projects/ce-core',
	'',
	'> check why the import failed',
	'',
	'⏺ Bash(ls /tmp/ce-import)',
	'  ⎿  Error: ls: /tmp/ce-import: No such file or directory',
	'     cat: /tmp/ce-import/run.log: No such file or directory',
	'     zsh: permission denied: ./import.sh',
	'',
	'⏺ The import folder is missing; I will recreate it.',
	'  The script then failed with No such file or directory again.',
].join('\n');

const RESUMED_READY = `${RESUMED_HISTORY}\n\n╭────────────────────────────────╮\n│ >                              │\n╰────────────────────────────────╯\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`;

describe('findStartupErrorPattern', () => {
	it('ignores "No such file or directory" in a resumed transcript (still rendering)', () => {
		expect(findStartupErrorPattern(RESUMED_HISTORY, CLAUDE_PATTERNS)).toBeUndefined();
	});

	it('ignores it once the ready prompt is drawn too', () => {
		expect(findStartupErrorPattern(RESUMED_READY, CLAUDE_PATTERNS)).toBeUndefined();
	});

	it.each([
		['zsh', 'zsh: command not found: claude', 'command not found: claude'],
		['zsh cd', 'cd: no such file or directory: /x', 'No such file or directory'],
		['bash cd', 'bash: cd: /x: No such file or directory', 'No such file or directory'],
		['env shebang', 'env: node: No such file or directory', 'No such file or directory'],
		['zsh exec', 'zsh: permission denied: /usr/local/bin/claude', 'Permission denied'],
		['script', '/opt/crewly/launch.sh: line 3: /x/run: No such file or directory', 'No such file or directory'],
	])('detects a real shell failure before launch (%s)', (_label, line, expected) => {
		const screen = `me@mac proj % cd /x && claude --resume abc\n${line}\nme@mac proj % `;
		expect(findStartupErrorPattern(screen, CLAUDE_PATTERNS)).toBe(expected);
	});

	it('detects a shell failure printed after an earlier runtime UI exited', () => {
		const screen = `${RESUMED_READY}\nme@mac proj % claude --resume abc\nzsh: command not found: claude\nme@mac proj % `;
		expect(findStartupErrorPattern(screen, CLAUDE_PATTERNS)).toBe('command not found: claude');
	});

	it('does not treat the launch command line itself as a failure', () => {
		expect(findStartupErrorPattern('me@mac proj % claude --add-dir "/No such file or directory"', CLAUDE_PATTERNS)).toBeUndefined();
	});

	it('keeps runtime-specific patterns, scoped to shell output', () => {
		expect(findStartupErrorPattern('me@mac % codex\nError: Invalid API key\nme@mac % ', CODEX_PATTERNS)).toBe('Invalid API key');
		const codexUi = '╭──────────────────────────╮\n│ >_ OpenAI Codex          │\n╰──────────────────────────╯\n\n› earlier: the API said Rate limit exceeded\n\n╭──────╮\n│ ›    │\n╰──────╯';
		expect(findStartupErrorPattern(codexUi, CODEX_PATTERNS)).toBeUndefined();
	});

	it('uses a custom matcher for runtime-specific patterns (wrapped text)', () => {
		const wrapped = 'me@mac % agy\nInvalid API ke\ny supplied';
		const includes = (text: string, p: string) => text.replace(/\n/g, '').includes(p);
		expect(findStartupErrorPattern(wrapped, ['Invalid API key'], { includes })).toBe('Invalid API key');
	});

	it('returns undefined with no patterns', () => {
		expect(findStartupErrorPattern('zsh: command not found: claude', [])).toBeUndefined();
	});
});

describe('shellOutputLines', () => {
	it('drops everything between the first and the last runtime UI line', () => {
		const lines = shellOutputLines('a\n╭─╮\nhistory line\n╰─╯\nb');
		expect(lines).toEqual(['a', 'b']);
	});

	it('keeps every line when no runtime UI is drawn', () => {
		expect(shellOutputLines('a\nb')).toEqual(['a', 'b']);
	});
});

describe('isShellFailurePattern', () => {
	it('tells shell failures from runtime messages', () => {
		expect(isShellFailurePattern('No such file or directory')).toBe(true);
		expect(isShellFailurePattern('command not found: codex')).toBe(true);
		expect(isShellFailurePattern('opencode: command not found')).toBe(true);
		expect(isShellFailurePattern('Invalid API key')).toBe(false);
	});
});

describe('showsBypassConsentMenu', () => {
	const { showsBypassConsentMenu } = jest.requireActual('./runtime-startup-screen.js') as typeof import('./runtime-startup-screen.js');
	const WARNING =
		'  WARNING: Claude Code running in Bypass Permissions mode\n\n  In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.\n  This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.\n\n  By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.\n\n  https://code.claude.com/docs/en/security\n\n';

	it('recognises the menu, with either highlight glyph and on either option', () => {
		expect(showsBypassConsentMenu(`${WARNING}  ❯ No, exit\n    Yes, I accept\n\n  Enter to confirm · Esc to cancel`)).toBe(true);
		expect(showsBypassConsentMenu(`${WARNING}  > No, exit\r\n    Yes, I accept\r\n\r\n  Enter to confirm · Esc to cancel`)).toBe(true);
		expect(showsBypassConsentMenu(`${WARNING}    No, exit\n  ❯ Yes, I accept`)).toBe(true);
	});

	it('is not fooled by a resumed conversation that talks about the consent (orchestrator down 50 min, 2026-11-19)', () => {
		const transcript = [
			'⏺ 收到你的「同意」。这个确认属于 DESKTOP-RIG1SOO 那台电脑上的 Crewly，由它自己收你的回复并选「Yes, I accept」，我在这台 MacBook 上点不了。',
			'⏺ 你是不是指某个终端里出现了“Bypass Permissions mode”的确认提示，需要选“接受”？',
			'  Reply accept bypass and I will choose "Yes, I accept" there and start the agents.',
			'────────────────────────────────────────',
			'❯ ',
			'────────────────────────────────────────',
			'  ⏵⏵ bypass permissions on (shift+tab to cycle)',
		].join('\n');
		expect(showsBypassConsentMenu(transcript)).toBe(false);
	});

	it('does not count a menu that is no longer the last thing on screen, or half a menu', () => {
		expect(showsBypassConsentMenu(`${WARNING}  ❯ No, exit\n    Yes, I accept\n  Enter to confirm\n\n Claude Code v2\n ❯ \n ⏵⏵ bypass permissions on`)).toBe(false);
		expect(showsBypassConsentMenu('  ❯ No, exit\n    Yes, I accept\n')).toBe(false);
		expect(showsBypassConsentMenu(`${WARNING}    Yes, I accept\n`)).toBe(false);
		expect(showsBypassConsentMenu(' ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel')).toBe(false);
		expect(showsBypassConsentMenu('')).toBe(false);
	});
});
