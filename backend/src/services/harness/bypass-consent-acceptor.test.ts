import { acceptBypassConsent, consentCommand, hasBypassConsent, type ConsentPty } from './bypass-consent-acceptor.js';

const CLEAR = '\x1b[2J\x1b[H';
/** Draw a whole screen the way a TUI does: clear, then the lines from the top. */
const draw = (lines: string[]): string => CLEAR + lines.join('\r\n');
/** The consent with the marker (`m`) on the first or the second option. */
const consent = (on: 'no' | 'yes', m = '❯'): string =>
	draw([' WARNING: Claude Code running in Bypass Permissions mode', '', on === 'no' ? ` ${m} No, exit` : '   No, exit', on === 'yes' ? ` ${m} Yes, I accept` : '   Yes, I accept', '', ' Enter to confirm · Esc to cancel']);
/** The folder-trust prompt, same layout. */
const trust = (on: 'no' | 'yes', m = '❯'): string =>
	draw([' Accessing workspace:', ' Quick safety check', on === 'no' ? ` ${m} No, exit` : '   No, exit', on === 'yes' ? ` ${m} Yes, I trust this folder` : '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel']);
/** What a Windows console sends after Down: blank the old marker (row 3), write `>` on row 4. Nothing else. */
const WINDOWS_DOWN_DIFF = '\x1b[3;2H \x1b[4;2H>';
const READY = draw([' Claude Code v2', '', '❯ ', '  ⏵⏵ bypass permissions on']);
const CONSENT_SCREEN = consent('no');
const DOWN = '\x1b[B';
const ENTER = '\r';

/**
 * Fake terminal that reacts to keys.
 *
 * @param onKey - Called with each key and helpers to print or exit
 * @returns The fake and what was written to it
 */
function fakePty(onKey: (key: string, api: { print: (text: string) => void; exit: () => void }) => void) {
	let data: (text: string) => void = () => undefined;
	let exit: (event: { exitCode: number }) => void = () => undefined;
	const written: string[] = [];
	const api = { print: (text: string) => data(text), exit: () => exit({ exitCode: 0 }) };
	const terminal: ConsentPty & { kill: jest.Mock } = {
		pid: 4242,
		write: (key) => {
			written.push(key);
			onKey(key, api);
		},
		kill: jest.fn(),
		onData: (listener) => {
			data = listener;
		},
		onExit: (listener) => {
			exit = listener;
		},
	};
	return { terminal, written, api };
}

/**
 * Dependencies with a virtual clock.
 *
 * @param terminal - Fake terminal
 * @param onStart - Runs right after the terminal started
 * @returns Deps for acceptBypassConsent
 */
function deps(terminal: ConsentPty, onStart: () => void = () => undefined) {
	let clock = 0;
	const spawnPty = jest.fn(() => {
		queueMicrotask(onStart);
		return terminal;
	});
	return {
		spawnPty,
		findClaude: () => '/usr/local/bin/claude',
		env: { PATH: '/usr/bin' },
		makeWorkDir: jest.fn(() => '/tmp/crewly-consent-x'),
		removeWorkDir: jest.fn(),
		platform: 'linux' as NodeJS.Platform,
		now: () => clock,
		sleep: async (ms: number) => {
			clock += ms;
		},
		killTree: jest.fn(),
	};
}

describe('hasBypassConsent', () => {
	it('needs the menu itself, not just its words', () => {
		expect(hasBypassConsent(' WARNING: Claude Code running in Bypass Permissions mode\n ❯ No, exit\n   Yes, I accept\n Enter to confirm')).toBe(true);
		expect(hasBypassConsent('Bypass Permissions mode … Yes, I accept')).toBe(false);
		expect(hasBypassConsent('Bypass Permissions mode on')).toBe(false);
	});
});

describe('consentCommand', () => {
	it('runs a .cmd shim through cmd.exe on Windows only', () => {
		expect(consentCommand('C:\\npm\\claude.cmd', 'win32')).toEqual({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'C:\\npm\\claude.cmd', '--dangerously-skip-permissions'] });
		expect(consentCommand('C:\\bin\\claude.exe', 'win32')).toEqual({ file: 'C:\\bin\\claude.exe', args: ['--dangerously-skip-permissions'] });
		expect(consentCommand('/usr/local/bin/claude', 'darwin').file).toBe('/usr/local/bin/claude');
	});
});

describe('acceptBypassConsent', () => {
	it('fails when claude is not installed', async () => {
		const result = await acceptBypassConsent({ findClaude: () => null });
		expect(result).toEqual({ outcome: 'failed', detail: 'claude_not_found' });
	});

	it('moves to "Yes, I accept", confirms, ends the process and removes its folder', async () => {
		const { terminal, written, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(consent('yes'));
			if (key === ENTER) a.print(READY);
		});
		const d = deps(terminal, () => api.print(CONSENT_SCREEN));
		const result = await acceptBypassConsent(d);
		expect(result).toEqual({ outcome: 'accepted', detail: 'consent_answered' });
		expect(written).toEqual([DOWN, ENTER]);
		expect(d.spawnPty).toHaveBeenCalledWith('/usr/local/bin/claude', ['--dangerously-skip-permissions'], expect.objectContaining({ cwd: '/tmp/crewly-consent-x' }));
		expect(terminal.kill).toHaveBeenCalled();
		expect(d.removeWorkDir).toHaveBeenCalledWith('/tmp/crewly-consent-x');
	});

	it('trusts its own empty folder first when asked', async () => {
		let shown: 'trust' | 'consent' = 'trust';
		const { terminal, written, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(shown === 'trust' ? trust('yes') : consent('yes'));
			if (key === ENTER && shown === 'trust') {
				shown = 'consent';
				a.print(CONSENT_SCREEN);
			} else if (key === ENTER) a.print(READY);
		});
		const result = await acceptBypassConsent(deps(terminal, () => api.print(trust('no'))));
		expect(result.outcome).toBe('accepted');
		expect(written).toEqual([DOWN, ENTER, DOWN, ENTER]);
	});

	it('reads a Windows console, which sends only the moved marker after Down (trust_not_answered on DESKTOP-RIG1SOO)', async () => {
		let shown: 'trust' | 'consent' = 'trust';
		const { terminal, written, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(WINDOWS_DOWN_DIFF);
			if (key === ENTER && shown === 'trust') {
				shown = 'consent';
				a.print(consent('no', '>'));
			} else if (key === ENTER) a.print(READY);
		});
		const result = await acceptBypassConsent({ ...deps(terminal, () => api.print(trust('no', '>'))), platform: 'win32' });
		expect(result).toEqual({ outcome: 'accepted', detail: 'consent_answered' });
		expect(written).toEqual([DOWN, ENTER, DOWN, ENTER]);
	});

	it('never presses Enter when the highlight did not reach "Yes, I accept"', async () => {
		const { terminal, written, api } = fakePty(() => undefined);
		const result = await acceptBypassConsent(deps(terminal, () => api.print(CONSENT_SCREEN)));
		expect(result).toEqual({ outcome: 'failed', detail: 'accept_not_highlighted' });
		expect(written).toEqual([DOWN]);
	});

	it('never presses Enter on the trust prompt either when the highlight did not move', async () => {
		const { terminal, written, api } = fakePty(() => undefined);
		const result = await acceptBypassConsent(deps(terminal, () => api.print(trust('no', '>'))));
		expect(result).toEqual({ outcome: 'failed', detail: 'trust_not_answered' });
		expect(written).toEqual([DOWN]);
	});

	it('fails when the answer made Claude Code exit', async () => {
		const { terminal, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(consent('yes'));
			if (key === ENTER) a.exit();
		});
		const result = await acceptBypassConsent(deps(terminal, () => api.print(CONSENT_SCREEN)));
		expect(result).toEqual({ outcome: 'failed', detail: 'exited_after_answer' });
		expect(terminal.kill).not.toHaveBeenCalled();
	});

	it('fails when the consent stays on screen', async () => {
		const { terminal, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(consent('yes'));
		});
		const result = await acceptBypassConsent(deps(terminal, () => api.print(CONSENT_SCREEN)));
		expect(result).toEqual({ outcome: 'failed', detail: 'consent_still_shown' });
	});

	it('reports not_shown when Claude Code starts without the consent', async () => {
		const { terminal, written, api } = fakePty(() => undefined);
		const result = await acceptBypassConsent(deps(terminal, () => api.print(READY)));
		expect(result.outcome).toBe('not_shown');
		expect(written).toEqual([]);
	});

	it('ends the whole process tree on Windows', async () => {
		const { terminal, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(WINDOWS_DOWN_DIFF);
			if (key === ENTER) a.print(READY);
		});
		const d = { ...deps(terminal, () => api.print(consent('no', '>'))), platform: 'win32' as NodeJS.Platform };
		await acceptBypassConsent(d);
		expect(d.killTree).toHaveBeenCalledWith(4242);
	});

	it('fails when the terminal cannot start', async () => {
		const result = await acceptBypassConsent({
			findClaude: () => '/bin/claude',
			makeWorkDir: () => '/tmp/crewly-consent-x',
			removeWorkDir: () => undefined,
			spawnPty: () => {
				throw new Error('no pty');
			},
		});
		expect(result.outcome).toBe('failed');
		expect(result.detail).toContain('no pty');
	});
});
