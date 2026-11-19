import { acceptBypassConsent, consentCommand, hasBypassConsent, type ConsentPty } from './bypass-consent-acceptor.js';

const CONSENT_SCREEN = 'WARNING: Claude Code running in Bypass Permissions mode\r\n❯ No, exit\r\n  Yes, I accept\r\nEnter to confirm\r\n';
const CONSENT_ON_YES = '  No, exit\r\n❯ Yes, I accept\r\n';
const TRUST_SCREEN = 'Quick safety check\r\n❯ No, exit\r\n  Yes, I trust this folder\r\n';
const TRUST_ON_YES = '  No, exit\r\n❯ Yes, I trust this folder\r\n';
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
		expect(hasBypassConsent(CONSENT_SCREEN)).toBe(true);
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
			if (key === DOWN) a.print(CONSENT_ON_YES);
			if (key === ENTER) a.print('\r\n> Welcome to Claude Code\r\n');
		});
		const d = deps(terminal, () => api.print(CONSENT_SCREEN));
		const result = await acceptBypassConsent(d);
		expect(result.outcome).toBe('accepted');
		expect(written).toEqual([DOWN, ENTER]);
		expect(d.spawnPty).toHaveBeenCalledWith('/usr/local/bin/claude', ['--dangerously-skip-permissions'], expect.objectContaining({ cwd: '/tmp/crewly-consent-x' }));
		expect(terminal.kill).toHaveBeenCalled();
		expect(d.removeWorkDir).toHaveBeenCalledWith('/tmp/crewly-consent-x');
	});

	it('trusts its own empty folder first when asked', async () => {
		let screen: 'trust' | 'consent' = 'trust';
		const { terminal, written, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(screen === 'trust' ? TRUST_ON_YES : CONSENT_ON_YES);
			if (key === ENTER && screen === 'trust') {
				screen = 'consent';
				a.print(CONSENT_SCREEN);
			} else if (key === ENTER) a.print('\r\n> ready\r\n');
		});
		const result = await acceptBypassConsent(deps(terminal, () => api.print(TRUST_SCREEN)));
		expect(result.outcome).toBe('accepted');
		expect(written).toEqual([DOWN, ENTER, DOWN, ENTER]);
	});

	it('reads the `>` highlight of a Windows console (trust prompt, then consent)', async () => {
		let screen: 'trust' | 'consent' = 'trust';
		const { terminal, written, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(screen === 'trust' ? '  No, exit\r\n> Yes, I trust this folder\r\n' : '  No, exit\r\n> Yes, I accept\r\n');
			if (key === ENTER && screen === 'trust') {
				screen = 'consent';
				a.print('WARNING: Claude Code running in Bypass Permissions mode\r\n> No, exit\r\n  Yes, I accept\r\n');
			} else if (key === ENTER) a.print('\r\n> ready\r\n');
		});
		const start = 'Accessing workspace: C:\\Temp\\crewly-consent-x\r\n> No, exit\r\n  Yes, I trust this folder\r\nEnter to confirm\r\n';
		const result = await acceptBypassConsent({ ...deps(terminal, () => api.print(start)), platform: 'win32' });
		expect(result.outcome).toBe('accepted');
		expect(written).toEqual([DOWN, ENTER, DOWN, ENTER]);
	});

	it('never presses Enter when the highlight did not reach "Yes, I accept"', async () => {
		const { terminal, written, api } = fakePty(() => undefined);
		const result = await acceptBypassConsent(deps(terminal, () => api.print(CONSENT_SCREEN)));
		expect(result).toEqual({ outcome: 'failed', detail: 'accept_not_highlighted' });
		expect(written).toEqual([DOWN]);
	});

	it('fails when the answer made Claude Code exit', async () => {
		const { terminal, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(CONSENT_ON_YES);
			if (key === ENTER) a.exit();
		});
		const result = await acceptBypassConsent(deps(terminal, () => api.print(CONSENT_SCREEN)));
		expect(result).toEqual({ outcome: 'failed', detail: 'exited_after_answer' });
		expect(terminal.kill).not.toHaveBeenCalled();
	});

	it('fails when the consent stays on screen', async () => {
		const { terminal, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(CONSENT_ON_YES);
			if (key === ENTER) a.print(CONSENT_SCREEN);
		});
		const result = await acceptBypassConsent(deps(terminal, () => api.print(CONSENT_SCREEN)));
		expect(result).toEqual({ outcome: 'failed', detail: 'consent_still_shown' });
	});

	it('reports not_shown when Claude Code starts without the consent', async () => {
		const { terminal, written, api } = fakePty(() => undefined);
		const result = await acceptBypassConsent(deps(terminal, () => api.print('> Welcome back\r\n')));
		expect(result.outcome).toBe('not_shown');
		expect(written).toEqual([]);
	});

	it('ends the whole process tree on Windows', async () => {
		const { terminal, api } = fakePty((key, a) => {
			if (key === DOWN) a.print(CONSENT_ON_YES);
			if (key === ENTER) a.print('ready\r\n');
		});
		const d = { ...deps(terminal, () => api.print(CONSENT_SCREEN)), platform: 'win32' as NodeJS.Platform };
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
