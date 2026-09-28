/**
 * Tests for the `crewly cloud login` PTY runner: link / code parsing,
 * success, expiry, failure, typed input and timeout — with a fake PTY.
 *
 * @module services/cloud/cloud-login-runner.test
 */

import type { BrokerPty } from '../harness/login-broker.service.js';
import {
	buildCloudLoginEnv,
	extractLoginUrl,
	isCloudLoginFinished,
	parseCloudLoginScreen,
	startCloudLogin,
} from './cloud-login-runner.js';

/** A PTY the test drives by hand. */
class FakePty implements BrokerPty {
	dataListener: (data: string) => void = () => undefined;
	exitListener: (event: { exitCode: number }) => void = () => undefined;
	written: string[] = [];
	killed = false;
	onData(listener: (data: string) => void): void {
		this.dataListener = listener;
	}
	onExit(listener: (event: { exitCode: number }) => void): void {
		this.exitListener = listener;
	}
	write(data: string): void {
		this.written.push(data);
	}
	kill(): void {
		this.killed = true;
	}
}

const PAIRING_SCREEN = [
	'',
	'CrewlyAI Cloud Login',
	'────────────────────────────────────────',
	'',
	'  On your phone or any browser, open:',
	'',
	'  \x1b[36mhttps://portal.example.test/cloud/pair?code=ABCD-2345\x1b[39m',
	'',
	'  and check the code matches:  ABCD-2345',
	'  (or go to https://portal.example.test/cloud/pair and type the code)',
	'',
	'  The link expires in 15 minutes.',
	'',
	'  Waiting for approval… (Ctrl+C to cancel)',
	'',
].join('\r\n');

describe('screen parsing', () => {
	it('prefers the approve page with the code filled in', () => {
		expect(extractLoginUrl('go to https://a.test/pair and https://a.test/pair?code=X')).toBe('https://a.test/pair?code=X');
		expect(extractLoginUrl('only https://a.test/x')).toBe('https://a.test/x');
		expect(extractLoginUrl('no link')).toBeNull();
	});

	it('reads link, code, success, expiry and the ✗ line', () => {
		const parsed = parseCloudLoginScreen('open https://a.test/p?code=WXYZ-7890\ncheck the code matches:  WXYZ-7890', '');
		expect(parsed).toMatchObject({ url: 'https://a.test/p?code=WXYZ-7890', userCode: 'WXYZ-7890', succeeded: false, expired: false, failure: null });
		expect(parseCloudLoginScreen('  ✓ Approved by a@b\n  ✓ Connected to CrewlyAI Cloud', '').succeeded).toBe(true);
		const expired = parseCloudLoginScreen('  ✗ The link expired before it was approved.', '');
		expect(expired.expired).toBe(true);
		expect(expired.failure).toBe('The link expired before it was approved.');
		expect(parseCloudLoginScreen('x', 'Paste your token here: ').needsInput).toBe(true);
		expect(parseCloudLoginScreen('x', 'Waiting for approval… (Ctrl+C to cancel)').needsInput).toBe(false);
	});

	it('builds an env with no browser and no colours, keeping CREWLY_HOME', () => {
		const env = buildCloudLoginEnv({ CREWLY_HOME: '/tmp/h', PATH: '/bin', EMPTY: undefined });
		expect(env).toMatchObject({ CREWLY_HOME: '/tmp/h', PATH: '/bin', BROWSER: 'true', NO_COLOR: '1' });
		expect('EMPTY' in env).toBe(false);
	});
});

describe('startCloudLogin', () => {
	let term: FakePty;
	let spawnPty: jest.Mock;

	beforeEach(() => {
		term = new FakePty();
		spawnPty = jest.fn(() => term);
	});

	it('spawns `node <cli> cloud login --no-browser` and surfaces the link', async () => {
		const handle = startCloudLogin({ cliEntry: '/pkg/dist/cli/cli/src/index.js', nodePath: '/usr/bin/node', spawnPty, env: {} });
		expect(spawnPty).toHaveBeenCalledWith(
			'/usr/bin/node',
			['/pkg/dist/cli/cli/src/index.js', 'cloud', 'login', '--no-browser'],
			expect.objectContaining({ env: expect.objectContaining({ BROWSER: 'true' }) }),
		);
		const waiting = handle.waitForLink(1000);
		term.dataListener(PAIRING_SCREEN);
		const snap = await waiting;
		expect(snap).toMatchObject({ state: 'awaiting_user', url: 'https://portal.example.test/cloud/pair?code=ABCD-2345', userCode: 'ABCD-2345' });

		term.dataListener('\r\n  ✓ Approved by owner@example.test\r\n  ✓ Connected to CrewlyAI Cloud\r\n');
		term.exitListener({ exitCode: 0 });
		expect((await handle.done).state).toBe('succeeded');
		handle.cancel();
	});

	it('reports an expired pairing', async () => {
		const handle = startCloudLogin({ cliEntry: 'cli.js', spawnPty, env: {} });
		term.dataListener(PAIRING_SCREEN);
		term.dataListener('  ✗ The link expired before it was approved.\r\n');
		term.exitListener({ exitCode: 1 });
		const done = await handle.done;
		expect(done.state).toBe('expired');
		expect(isCloudLoginFinished(done.state)).toBe(true);
	});

	it('reports a failure (no link) and waitForLink resolves without one', async () => {
		const handle = startCloudLogin({ cliEntry: 'cli.js', spawnPty, env: {} });
		const waiting = handle.waitForLink(5000);
		term.dataListener('  ✗ Could not start login: Crewly Cloud unreachable: fetch failed\r\n');
		term.exitListener({ exitCode: 1 });
		const snap = await waiting;
		expect(snap.url).toBeNull();
		expect(snap.state).toBe('failed');
		expect(snap.message).toContain('Could not start login');
	});

	it('types a reply when the CLI asks for one', async () => {
		const handle = startCloudLogin({ cliEntry: 'cli.js', spawnPty, env: {} });
		const changes: boolean[] = [];
		handle.onChange((s) => changes.push(s.needsInput));
		term.dataListener('Open https://portal.example.test/cloud/cli-token\r\nPaste your token here: ');
		expect(handle.get()).toMatchObject({ state: 'awaiting_user', needsInput: true });
		handle.input('tok-placeholder\n');
		expect(term.written).toEqual(['tok-placeholder\r']);
		expect(handle.get()).toMatchObject({ state: 'verifying', needsInput: false });
		expect(changes).toContain(true);
		handle.cancel();
		expect(term.killed).toBe(true);
		expect((await handle.done).state).toBe('cancelled');
	});

	it('times out and kills the PTY', async () => {
		jest.useFakeTimers();
		try {
			const handle = startCloudLogin({ cliEntry: 'cli.js', spawnPty, env: {}, timeoutMs: 1000 });
			jest.advanceTimersByTime(1000);
			expect((await handle.done).state).toBe('timed_out');
			expect(term.killed).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});
});
