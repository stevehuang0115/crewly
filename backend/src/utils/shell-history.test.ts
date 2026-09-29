/**
 * Tests for the shell-history guard used by agent PTYs.
 *
 * @module utils/shell-history.test
 */

import { historyOffSpawnEnv, quietShellLine, shellHistoryDisableLine, shellQuote } from './shell-history.js';

describe('historyOffSpawnEnv', () => {
	it('turns history off for bash and zsh without touching HISTSIZE/HISTFILESIZE', () => {
		const env = historyOffSpawnEnv();
		expect(env).toEqual({ HISTFILE: '/dev/null', SAVEHIST: '0', HISTCONTROL: 'ignorespace' });
		expect(env).not.toHaveProperty('HISTSIZE');
		expect(env).not.toHaveProperty('HISTFILESIZE');
	});

	it('returns a fresh copy each time', () => {
		const a = historyOffSpawnEnv();
		a.HISTFILE = 'x';
		expect(historyOffSpawnEnv().HISTFILE).toBe('/dev/null');
	});
});

describe('quietShellLine', () => {
	it('prefixes a space once', () => {
		expect(quietShellLine('cd "/p"')).toBe(' cd "/p"');
		expect(quietShellLine(' cd "/p"')).toBe(' cd "/p"');
	});
});

describe('shellHistoryDisableLine', () => {
	it.each(['/bin/bash', '/bin/zsh', '/usr/local/bin/bash', '/bin/sh', '/bin/dash'])('gives a POSIX line for %s', (shell) => {
		const line = shellHistoryDisableLine(shell);
		expect(line).not.toBeNull();
		expect(line?.startsWith(' unset HISTFILE;')).toBe(true);
	});

	it('gives the fish form for fish', () => {
		expect(shellHistoryDisableLine('/opt/homebrew/bin/fish')).toBe(" set -g fish_history ''");
	});

	it('returns null for a shell it does not know', () => {
		expect(shellHistoryDisableLine('/usr/bin/nu')).toBeNull();
	});
});

describe('shellQuote', () => {
	it('single-quotes and escapes embedded quotes', () => {
		expect(shellQuote('a b')).toBe("'a b'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});
});
