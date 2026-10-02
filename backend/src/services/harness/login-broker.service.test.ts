/**
 * Tests for the login broker state machine, driven by a fake PTY that replays
 * the captured `claude setup-token` / `codex login --device-auth` output.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { HarnessCredentialsStore } from './harness-credentials.store.js';
import { LOGIN_BROKER_EVENTS, LoginBrokerError, LoginBrokerService, type BrokerPty } from './login-broker.service.js';
import type { LoginSession } from './harness.types.js';

/** Fake PTY the test drives. */
class FakePty implements BrokerPty {
	written: string[] = [];
	killed = false;
	private dataListeners: Array<(data: string) => void> = [];
	private exitListeners: Array<(event: { exitCode: number }) => void> = [];

	onData(listener: (data: string) => void): void {
		this.dataListeners.push(listener);
	}
	onExit(listener: (event: { exitCode: number }) => void): void {
		this.exitListeners.push(listener);
	}
	write(data: string): void {
		this.written.push(data);
	}
	kill(): void {
		this.killed = true;
	}
	/** Emit output. */
	emit(data: string): void {
		for (const listener of this.dataListeners) listener(data);
	}
	/** Emit process exit. */
	exit(exitCode: number): void {
		for (const listener of this.exitListeners) listener({ exitCode });
	}
}

const CLAUDE_URL =
	'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&code_challenge_method=S256&state=HIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx';
const WRAP_AT = CLAUDE_URL.indexOf('Ainference');
const CLAUDE_TOKEN = `sk-ant-oat01-${'Zq9'.repeat(30)}-AA`;

const CLAUDE_SCREEN = [
	"Browserdidn'topen?Usetheurlbelowtosignin(ctocopy)",
	CLAUDE_URL.slice(0, WRAP_AT),
	CLAUDE_URL.slice(WRAP_AT),
	'',
	'\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>',
	'',
].join('\r\r\n');

const CLAUDE_TOKEN_SCREEN = [
	'Your OAuth token (valid for 1 year):',
	CLAUDE_TOKEN,
	"Store this token securely. You won't be able to see it again.",
	'',
].join('\r\n');

const CODEX_SCREEN = [
	'Follow these steps to sign in with ChatGPT using device code authorization:',
	'1. Open this link in your browser and sign in to your account',
	'   https://auth.openai.com/codex/device',
	'2. Enter this one-time code (expires in 15 minutes)',
	'   WH2P-EO69V',
	'Continue only if you started this login in Codex. Never share this code.',
	'',
].join('\r\n');

/** Let queued promise callbacks run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('LoginBrokerService', () => {
	let dir: string;
	let credentials: HarnessCredentialsStore;
	let ptys: FakePty[];
	let spawnPty: jest.Mock;
	let prepareClaudeConfig: jest.Mock;
	let verify: jest.Mock;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-broker-'));
		credentials = new HarnessCredentialsStore(path.join(dir, 'creds.json'));
		ptys = [];
		spawnPty = jest.fn(() => {
			const p = new FakePty();
			ptys.push(p);
			return p;
		});
		prepareClaudeConfig = jest.fn();
		verify = jest.fn(async () => true);
	});
	afterEach(() => {
		jest.useRealTimers();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * Build a broker.
	 *
	 * @param overrides - Deps overrides
	 * @returns Broker
	 */
	function make(overrides: Partial<ConstructorParameters<typeof LoginBrokerService>[0]> = {}): LoginBrokerService {
		let n = 0;
		return new LoginBrokerService({
			spawnPty,
			resolveCommand: (cmd) => `/usr/local/bin/${cmd}`,
			env: { PATH: '/usr/bin', CREWLY_API_TOKEN: 'owner-token', CLAUDECODE: '1', HOME: dir },
			homeDir: dir,
			credentials,
			prepareClaudeConfig,
			verify,
			idFactory: () => `s${++n}`,
			submitDelayMs: 0,
			...overrides,
		});
	}

	it('spawns the login command in a wide PTY with a safe env', () => {
		const broker = make();
		const session = broker.start('claude-code', 'subscription');
		expect(session).toMatchObject({ id: 's1', harnessId: 'claude-code', method: 'subscription', state: 'starting', url: null, needsInput: false });
		const [file, args, options] = spawnPty.mock.calls[0];
		expect(file).toBe('/usr/local/bin/claude');
		expect(args).toEqual(['setup-token']);
		expect(options.cols).toBeGreaterThanOrEqual(500);
		expect(options.cwd).toBe(dir);
		expect(options.env.CREWLY_API_TOKEN).toBeUndefined();
		expect(options.env.CLAUDECODE).toBeUndefined();
		expect(options.env.BROWSER).toBe('true');
		expect(options.env.PATH).toContain('npm-global/bin');
	});

	it('Claude: URL + prompt → awaiting_user → input → token → succeeded (token stored, never exposed)', async () => {
		const broker = make();
		const updates: LoginSession[] = [];
		broker.on(LOGIN_BROKER_EVENTS.UPDATE, (s: LoginSession) => updates.push(s));
		const { id } = broker.start('claude-code', 'subscription');
		const pty = ptys[0];

		pty.emit(CLAUDE_SCREEN);
		let session = broker.get(id);
		expect(session.state).toBe('awaiting_user');
		expect(session.url).toBe(CLAUDE_URL);
		expect(session.needsInput).toBe(true);
		expect(session.screen).toContain('Paste code here if prompted >');

		session = broker.input(id, 'the-code#the-state\n');
		expect(pty.written).toEqual(['the-code#the-state\r']);
		expect(session).toMatchObject({ state: 'verifying', needsInput: false });

		pty.emit('the-code#the-state\r\n');
		expect(broker.get(id).state).toBe('verifying');

		const done = broker.waitForCompletion(id);
		pty.emit(CLAUDE_TOKEN_SCREEN);
		await flush();
		session = await done;
		expect(session.state).toBe('succeeded');
		expect(credentials.read().claude?.oauthToken).toBe(CLAUDE_TOKEN);
		expect(prepareClaudeConfig).toHaveBeenCalled();
		expect(pty.killed).toBe(true);
		expect(session.screen).not.toContain(CLAUDE_TOKEN);
		expect(session.screen).toContain('[redacted]');
		for (const update of updates) expect(JSON.stringify(update)).not.toContain(CLAUDE_TOKEN);
	});

	describe('another of the owner\'s Claude Code accounts (#942)', () => {
		it('runs the login with that account\'s config dir, without the default login\'s credentials', () => {
			const ensureAccountDir = jest.fn((account: string) => path.join(dir, 'accounts', account));
			const broker = make({
				ensureAccountDir,
				prepareAccount: jest.fn(),
				env: { PATH: '/usr/bin', HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: 'default', ANTHROPIC_API_KEY: 'sk-default', CLAUDE_CONFIG_DIR: '/default' },
			});
			const session = broker.start('claude-code', 'subscription', { account: 'b' });
			expect(session.account).toBe('b');
			expect(ensureAccountDir).toHaveBeenCalledWith('b');
			const env = spawnPty.mock.calls[0][2].env;
			expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(dir, 'accounts', 'b'));
			expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		});

		it('keeps one live login per account, apart from the default login', () => {
			const broker = make({ ensureAccountDir: (a) => path.join(dir, a), prepareAccount: jest.fn() });
			const def = broker.start('claude-code', 'subscription');
			const b = broker.start('claude-code', 'subscription', { account: 'b' });
			expect(b.id).not.toBe(def.id);
			expect(broker.start('claude-code', 'subscription', { account: 'b' }).id).toBe(b.id);
			expect(broker.getActiveSession('claude-code')?.id).toBe(def.id);
			expect(broker.getActiveSession('claude-code', 'b')?.id).toBe(b.id);
		});

		it('stores the token for that account only', async () => {
			const prepareAccount = jest.fn();
			const broker = make({ ensureAccountDir: (a) => path.join(dir, a), prepareAccount });
			const { id } = broker.start('claude-code', 'subscription', { account: 'b' });
			ptys[0].emit(CLAUDE_SCREEN);
			broker.input(id, 'code#state');
			const done = broker.waitForCompletion(id);
			ptys[0].emit(CLAUDE_TOKEN_SCREEN);
			await flush();
			expect((await done).state).toBe('succeeded');
			expect(credentials.getClaudeAccountToken('b')).toBe(CLAUDE_TOKEN);
			expect(credentials.read().claude).toBeUndefined();
			expect(prepareAccount).toHaveBeenCalledWith('b');
			expect(prepareClaudeConfig).not.toHaveBeenCalled();
		});

		it('refuses an account for a harness without accounts', () => {
			expect(() => make().start('codex-cli', 'device', { account: 'b' })).toThrow(LoginBrokerError);
		});
	});

	it('Claude: types the code, then presses Enter separately (Ink reads one write as a paste)', () => {
		jest.useFakeTimers();
		try {
			const broker = make({ submitDelayMs: 300, submitRetryMs: 4000 });
			const { id } = broker.start('claude-code', 'subscription');
			const pty = ptys[ptys.length - 1];
			pty.emit(CLAUDE_SCREEN);
			broker.input(id, 'the-code#the-state');
			expect(pty.written).toEqual(['the-code#the-state']);
			jest.advanceTimersByTime(300);
			expect(pty.written).toEqual(['the-code#the-state', '\r']);
			// Nothing printed after Enter: pressed once more.
			jest.advanceTimersByTime(4000);
			expect(pty.written).toEqual(['the-code#the-state', '\r', '\r']);
		} finally {
			jest.useRealTimers();
		}
	});

	it('Claude: no second Enter when the login reacted to the first', () => {
		jest.useFakeTimers();
		try {
			const broker = make({ submitDelayMs: 300, submitRetryMs: 4000 });
			const { id } = broker.start('claude-code', 'subscription');
			const pty = ptys[ptys.length - 1];
			pty.emit(CLAUDE_SCREEN);
			broker.input(id, 'code-value-123');
			jest.advanceTimersByTime(300);
			pty.emit('Verifying…\r\n');
			jest.advanceTimersByTime(4000);
			expect(pty.written).toEqual(['code-value-123', '\r']);
		} finally {
			jest.useRealTimers();
		}
	});

	it('Claude: a rejected code returns to awaiting_user with the message', () => {
		const broker = make();
		const { id } = broker.start('claude-code', 'subscription');
		ptys[0].emit(CLAUDE_SCREEN);
		broker.input(id, 'bad');
		ptys[0].emit('Invalid code. Please make sure the full code was copied.\r\n\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>\r\n');
		expect(broker.get(id)).toMatchObject({ state: 'awaiting_user', needsInput: true, message: 'Invalid code. Please make sure the full code was copied.' });
	});

	it('Claude: a failure without a new prompt fails the session', () => {
		const broker = make();
		const { id } = broker.start('claude-code', 'subscription');
		ptys[0].emit(CLAUDE_SCREEN);
		broker.input(id, 'code');
		ptys[0].emit('OAuth error: access_denied\r\n');
		expect(broker.get(id)).toMatchObject({ state: 'failed', message: 'OAuth error: access_denied' });
		expect(ptys[0].killed).toBe(true);
	});

	it('Claude: exiting without a token fails the session', async () => {
		const broker = make();
		const { id } = broker.start('claude-code', 'subscription');
		ptys[0].emit(CLAUDE_SCREEN);
		ptys[0].exit(1);
		await flush();
		expect(broker.get(id)).toMatchObject({ state: 'failed', message: expect.stringContaining('code 1') });
		expect(credentials.getClaudeCredentialKind()).toBeNull();
	});

	it('Claude: a token printed right before exit is still captured', async () => {
		const broker = make();
		const { id } = broker.start('claude-code', 'subscription');
		ptys[0].emit(`Token:\r\n${CLAUDE_TOKEN}`);
		expect(broker.get(id).state).toBe('starting');
		ptys[0].exit(0);
		await flush();
		expect(broker.get(id).state).toBe('succeeded');
		expect(credentials.read().claude?.oauthToken).toBe(CLAUDE_TOKEN);
	});

	it('Claude: a store failure fails the session without leaking the token', async () => {
		const broken = { setClaudeOauthToken: () => { throw new Error('disk full'); } } as unknown as HarnessCredentialsStore;
		const broker = make({ credentials: broken });
		const { id } = broker.start('claude-code', 'subscription');
		ptys[0].emit(CLAUDE_TOKEN_SCREEN);
		await flush();
		const session = broker.get(id);
		expect(session.state).toBe('failed');
		expect(session.message).toContain('disk full');
		expect(JSON.stringify(session)).not.toContain(CLAUDE_TOKEN);
	});

	it('Codex: URL + code → awaiting_user; exit 0 → verified → succeeded', async () => {
		const broker = make();
		const { id } = broker.start('codex-cli', 'device');
		expect(spawnPty.mock.calls[0][1]).toEqual(['login', '--device-auth']);
		ptys[0].emit(CODEX_SCREEN);
		expect(broker.get(id)).toMatchObject({ state: 'awaiting_user', url: 'https://auth.openai.com/codex/device', userCode: 'WH2P-EO69V', needsInput: false });
		ptys[0].emit('Successfully logged in\r\n');
		ptys[0].exit(0);
		const session = await broker.waitForCompletion(id);
		expect(session.state).toBe('succeeded');
		expect(verify).toHaveBeenCalledWith('codex-cli');
		expect(verify).toHaveBeenCalledTimes(1);
	});

	it('Codex: exit 0 without success text is confirmed with login status', async () => {
		verify.mockResolvedValueOnce(false);
		const broker = make();
		const { id } = broker.start('codex-cli', 'device');
		ptys[0].emit(CODEX_SCREEN);
		ptys[0].exit(0);
		const session = await broker.waitForCompletion(id);
		expect(session).toMatchObject({ state: 'failed', message: expect.stringContaining('not logged in') });
	});

	it('Codex: a verification error fails the session', async () => {
		verify.mockRejectedValueOnce(new Error('status crashed'));
		const broker = make();
		const { id } = broker.start('codex-cli', 'device');
		ptys[0].exit(0);
		expect((await broker.waitForCompletion(id)).message).toContain('status crashed');
	});

	it('Codex: a non-zero exit fails when the harness is not logged in', async () => {
		verify.mockResolvedValueOnce(false);
		const broker = make();
		const { id } = broker.start('codex-cli', 'device');
		ptys[0].emit(CODEX_SCREEN);
		ptys[0].exit(2);
		const session = await broker.waitForCompletion(id);
		expect(session.state).toBe('failed');
		expect(session.message).toContain('code 2');
		expect(verify).toHaveBeenCalledTimes(1);
	});

	// steamfun-ops 2026-09-29/30: the owner finished the device login four
	// times (codex logged "oauth token exchange succeeded"); every attempt was
	// reported failed and each retry's `codex login` revoked the previous one.
	it('Codex: an error line does not kill the login; its exit decides, and the codex message is kept', async () => {
		verify.mockResolvedValueOnce(false);
		const broker = make();
		const { id } = broker.start('codex-cli', 'device');
		ptys[0].emit(CODEX_SCREEN);
		ptys[0].emit('Error logging in with device code: workspace not allowed\r\n');
		await flush();
		expect(ptys[0].killed).toBe(false);
		expect(broker.get(id).state).not.toBe('failed');
		ptys[0].exit(1);
		const session = await broker.waitForCompletion(id);
		expect(session).toMatchObject({ state: 'failed', message: expect.stringContaining('workspace not allowed') });
	});

	it('Codex: a failure report is overridden when the harness is logged in afterwards', async () => {
		const broker = make();
		const { id } = broker.start('codex-cli', 'device');
		ptys[0].emit(CODEX_SCREEN);
		ptys[0].emit('error: something went sideways\r\n');
		ptys[0].exit(1);
		const session = await broker.waitForCompletion(id);
		expect(session.state).toBe('succeeded');
		expect(verify).toHaveBeenCalledWith('codex-cli');
	});

	it('Codex: an error line with no exit fails after the grace period', () => {
		jest.useFakeTimers();
		const broker = make();
		const { id } = broker.start('codex-cli', 'device');
		ptys[0].emit('Error logging in with device code: boom\r\n');
		jest.advanceTimersByTime(HARNESS_CONSTANTS.LOGIN.FAILURE_EXIT_GRACE_MS + 1);
		expect(broker.get(id)).toMatchObject({ state: 'failed', message: expect.stringContaining('boom') });
		expect(ptys[0].killed).toBe(true);
	});

	it('logs why a session failed, with secrets redacted', async () => {
		verify.mockResolvedValueOnce(false);
		const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
		const broker = make({ logger });
		const { id } = broker.start('codex-cli', 'device');
		ptys[0].emit(`Error logging in with device code: bad ${CLAUDE_TOKEN}\r\n`);
		ptys[0].exit(1);
		await broker.waitForCompletion(id);
		const finished = logger.info.mock.calls.find(([msg]) => msg === 'Login broker session finished');
		expect(finished?.[1]).toMatchObject({ state: 'failed', message: expect.stringContaining('Error logging in') });
		expect(JSON.stringify(logger.info.mock.calls)).not.toContain(CLAUDE_TOKEN);
	});

	it('times out after the configured window', () => {
		jest.useFakeTimers();
		const broker = make({ timeoutMs: 1000 });
		const { id } = broker.start('codex-cli', 'device');
		jest.advanceTimersByTime(1001);
		expect(broker.get(id).state).toBe('timed_out');
		expect(ptys[0].killed).toBe(true);
	});

	it('cancel kills the PTY; cancelling again is a no-op', () => {
		const broker = make();
		const finished = jest.fn();
		broker.on(LOGIN_BROKER_EVENTS.FINISHED, finished);
		const { id } = broker.start('codex-cli', 'device');
		expect(broker.cancel(id).state).toBe('cancelled');
		expect(ptys[0].killed).toBe(true);
		expect(broker.cancel(id).state).toBe('cancelled');
		expect(finished).toHaveBeenCalledTimes(1);
	});

	it('ignores output after the session finished', () => {
		const broker = make();
		const { id } = broker.start('codex-cli', 'device');
		broker.cancel(id);
		ptys[0].emit(CODEX_SCREEN);
		expect(broker.get(id).url).toBeNull();
	});

	it('refuses input after the session finished', () => {
		const broker = make();
		const { id } = broker.start('claude-code', 'subscription');
		broker.cancel(id);
		expect(() => broker.input(id, 'x')).toThrow(expect.objectContaining({ code: 'not_active' }));
	});

	it('keeps one live session per harness', () => {
		const broker = make();
		const first = broker.start('claude-code', 'subscription');
		expect(broker.start('claude-code', 'subscription').id).toBe(first.id);
		expect(spawnPty).toHaveBeenCalledTimes(1);
		expect(broker.getActiveSession('claude-code')?.id).toBe(first.id);
		const codex = broker.start('codex-cli', 'device');
		expect(codex.id).not.toBe(first.id);
		broker.cancel(first.id);
		expect(broker.getActiveSession('claude-code')).toBeNull();
		expect(broker.start('claude-code', 'subscription').id).not.toBe(first.id);
	});

	it('waitForCompletion resolves immediately for a finished session', async () => {
		const broker = make();
		const { id } = broker.start('codex-cli', 'device');
		broker.cancel(id);
		expect((await broker.waitForCompletion(id)).state).toBe('cancelled');
	});

	it('shutdown cancels every live session', () => {
		const broker = make();
		const a = broker.start('claude-code', 'subscription');
		const b = broker.start('codex-cli', 'device');
		broker.shutdown();
		expect(broker.get(a.id).state).toBe('cancelled');
		expect(broker.get(b.id).state).toBe('cancelled');
	});

	it('forgets finished sessions after the retention window', () => {
		let now = 1_000_000;
		const broker = make({ now: () => now });
		const { id } = broker.start('codex-cli', 'device');
		broker.cancel(id);
		now += 2 * 60 * 60 * 1000;
		broker.start('claude-code', 'subscription');
		expect(() => broker.get(id)).toThrow(expect.objectContaining({ code: 'not_found' }));
	});

	it('keeps only the tail of a huge output buffer', () => {
		const broker = make();
		const { id } = broker.start('claude-code', 'subscription');
		ptys[0].emit('x'.repeat(250_000));
		ptys[0].emit(CLAUDE_SCREEN);
		expect(broker.get(id).url).toBe(CLAUDE_URL);
		expect(broker.get(id).screen.length).toBeLessThanOrEqual(2000);
	});

	it('rejects unknown harnesses, methods, missing binaries and spawn failures', () => {
		const broker = make();
		expect(() => broker.start('nope', 'device')).toThrow(expect.objectContaining({ code: 'unknown_harness' }));
		expect(() => broker.start('claude-code', 'api_key')).toThrow(expect.objectContaining({ code: 'unsupported_method' }));
		expect(() => broker.start('gemini-cli', 'device')).toThrow(expect.objectContaining({ code: 'unsupported_method' }));
		expect(() => make({ resolveCommand: () => null }).start('claude-code', 'subscription')).toThrow(expect.objectContaining({ code: 'not_installed' }));
		const failing = make({ spawnPty: () => { throw new Error('posix_spawnp failed'); } });
		expect(() => failing.start('claude-code', 'subscription')).toThrow(LoginBrokerError);
		expect(() => broker.get('missing')).toThrow(expect.objectContaining({ code: 'not_found' }));
	});
});
