/**
 * Tests for the CLI harness setup steps (engine and login driver faked).
 */

jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy({}, {
		get: () => {
			const fn = (s: string) => s;
			return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
		},
	}),
}));

import type { HarnessService } from '../../../backend/src/services/harness/harness.service.js';
import type { HarnessOverview, HarnessStatus, LoginSession } from '../../../backend/src/services/harness/harness.types.js';
import type { LoginDriver } from '../utils/harness-engine.js';
import {
	chooseOrcHarness,
	cliAlias,
	describeHarness,
	driveBrokerLogin,
	ensureHarnessInstalled,
	isYes,
	loginHarness,
	printHarnessOverview,
	runHarnessSetup,
	type SetupIO,
	type SetupTiming,
} from './harness-setup.js';

const CLAUDE: HarnessStatus = {
	id: 'claude-code',
	displayName: 'Claude Code',
	installed: true,
	version: '2.1.282',
	latestVersion: '2.1.282',
	updateAvailable: false,
	loginState: 'logged_out',
	loginSource: null,
	loginMethods: [
		{ id: 'subscription', label: 'Claude subscription (Pro / Max)', kind: 'broker' },
		{ id: 'api_key', label: 'Anthropic API key', kind: 'api_key' },
	],
};
const CODEX: HarnessStatus = {
	...CLAUDE,
	id: 'codex-cli',
	displayName: 'Codex',
	version: '0.156.1',
	latestVersion: '0.157.0',
	updateAvailable: true,
	loginMethods: [
		{ id: 'device', label: 'ChatGPT account (device code)', kind: 'broker' },
		{ id: 'api_key', label: 'OpenAI API key', kind: 'api_key' },
	],
};
const GEMINI: HarnessStatus = { ...CLAUDE, id: 'gemini-cli', displayName: 'Gemini CLI', installed: false, version: null, loginState: 'unknown', loginMethods: [] };
const OVERVIEW: HarnessOverview = {
	harnesses: [CLAUDE, CODEX, GEMINI],
	orcHarness: null,
	systemTools: [{ id: 'jq', installed: false, installHint: 'brew install jq' }],
};

const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=x';

/**
 * Scripted IO.
 *
 * @param answers - Answers in order
 * @returns IO plus captured output
 */
function makeIO(answers: string[] = []): SetupIO & { lines: string[]; asked: string[] } {
	const lines: string[] = [];
	const asked: string[] = [];
	return {
		lines,
		asked,
		ask: jest.fn(async (q: string) => {
			asked.push(q);
			return answers.shift() ?? '';
		}),
		askSecret: jest.fn(async (q: string) => {
			asked.push(`secret:${q}`);
			return answers.shift() ?? '';
		}),
		log: (line: string) => lines.push(line),
	};
}

/** Instant timing with a fake clock that advances per sleep. */
function fastTiming(overrides: Partial<SetupTiming> = {}): SetupTiming {
	let now = 0;
	return {
		pollIntervalMs: 1000,
		urlWaitMs: 30_000,
		screenFallbackMs: 20_000,
		maxWaitMs: 60_000,
		sleep: async (ms) => {
			now += ms;
		},
		now: () => now,
		...overrides,
	};
}

/**
 * Login driver replaying a list of session snapshots on each `get`.
 *
 * @param where - Where the session lives
 * @param start - Snapshot returned by start
 * @param updates - Snapshots returned by successive gets (last one repeats)
 * @returns Driver with mocks
 */
function makeDriver(where: 'in-process' | 'backend' | 'detached', start: Partial<LoginSession>, updates: Array<Partial<LoginSession>> = []) {
	const base: LoginSession = {
		id: 's1',
		harnessId: 'claude-code',
		method: 'subscription',
		state: 'starting',
		url: null,
		userCode: null,
		needsInput: false,
		message: null,
		screen: '',
		startedAt: '',
		updatedAt: '',
	};
	const queue = [...updates];
	let last: LoginSession = { ...base, ...start };
	const driver = {
		where,
		start: jest.fn(async () => last),
		get: jest.fn(async () => {
			const next = queue.shift();
			if (next) last = { ...last, ...next };
			return last;
		}),
		input: jest.fn(async () => {
			const next = queue.shift();
			last = { ...last, needsInput: false, state: 'verifying', ...(next ?? {}) };
			return last;
		}),
		cancel: jest.fn(async () => ({ ...last, state: 'cancelled' as const })),
	};
	return driver as typeof driver & LoginDriver;
}

/**
 * Fake harness service.
 *
 * @param overrides - Method overrides
 * @returns Service mocks
 */
function makeService(overrides: Record<string, unknown> = {}) {
	const mocks = {
		getOverview: jest.fn(async () => OVERVIEW),
		getStatus: jest.fn(async (id: string) => OVERVIEW.harnesses.find((h) => h.id === id)!),
		startInstall: jest.fn(() => ({ jobId: 'j1' })),
		install: { waitForJob: jest.fn(async () => ({ jobId: 'j1', harnessId: 'codex-cli', state: 'succeeded', log: 'Installed.\n', usedUserPrefix: true })) },
		setOrcHarness: jest.fn(async (id: string) => id),
		submitApiKey: jest.fn(async () => ({ ...CLAUDE, loginState: 'logged_in' })),
		...overrides,
	};
	return { mocks, service: mocks as unknown as HarnessService };
}

describe('small helpers', () => {
	it('isYes uses the default for an empty answer', () => {
		expect(isYes('', true)).toBe(true);
		expect(isYes('', false)).toBe(false);
		expect(isYes('Y', false)).toBe(true);
		expect(isYes('yes', false)).toBe(true);
		expect(isYes('n', true)).toBe(false);
	});

	it('cliAlias maps ids back to short names', () => {
		expect(cliAlias('claude-code')).toBe('claude');
		expect(cliAlias('codex-cli')).toBe('codex');
		expect(cliAlias('gemini-cli')).toBe('gemini');
	});

	it('describeHarness shows version, update and login', () => {
		expect(describeHarness(CODEX, true)).toContain('v0.156.1 (update: v0.157.0)');
		expect(describeHarness(CODEX, true)).toContain('← orchestrator');
		expect(describeHarness(GEMINI)).toContain('not installed');
		expect(describeHarness(GEMINI)).toContain('login unknown');
		expect(describeHarness({ ...CLAUDE, loginState: 'logged_in', loginSource: 'macos-keychain' })).toContain('logged in (macos-keychain)');
	});

	it('printHarnessOverview lists harnesses and missing tools', () => {
		const io = makeIO();
		printHarnessOverview(io, OVERVIEW);
		expect(io.lines.join('\n')).toContain('Claude Code');
		expect(io.lines.join('\n')).toContain('jq missing — brew install jq');
	});
});

describe('chooseOrcHarness', () => {
	it('uses the preset, else Claude Code, without asking when non-interactive', async () => {
		const io = makeIO();
		expect(await chooseOrcHarness(io, OVERVIEW, { interactive: false })).toBe('claude-code');
		expect(await chooseOrcHarness(io, OVERVIEW, { interactive: true, preset: 'codex' })).toBe('codex-cli');
		expect(io.asked).toEqual([]);
		await expect(chooseOrcHarness(io, OVERVIEW, { interactive: false, preset: 'opencode' })).rejects.toThrow('Unknown harness');
	});

	it('asks interactively: default, number, name, and re-asks on nonsense', async () => {
		expect(await chooseOrcHarness(makeIO(['']), OVERVIEW, { interactive: true })).toBe('claude-code');
		expect(await chooseOrcHarness(makeIO(['2']), OVERVIEW, { interactive: true })).toBe('codex-cli');
		const io = makeIO(['zzz', 'gemini']);
		expect(await chooseOrcHarness(io, OVERVIEW, { interactive: true })).toBe('gemini-cli');
		expect(io.lines.join('\n')).toContain('Please enter a number');
	});
});

describe('ensureHarnessInstalled', () => {
	it('does nothing when installed and current', async () => {
		const { service, mocks } = makeService();
		expect(await ensureHarnessInstalled(makeIO(), service, CLAUDE, { interactive: true })).toBe(true);
		expect(mocks.startInstall).not.toHaveBeenCalled();
	});

	it('installs a missing harness after confirmation (default yes)', async () => {
		const { service, mocks } = makeService();
		const io = makeIO(['']);
		expect(await ensureHarnessInstalled(io, service, GEMINI, { interactive: true })).toBe(true);
		expect(mocks.startInstall).toHaveBeenCalledWith('gemini-cli');
		expect(io.lines.join('\n')).toContain('npm-global');
	});

	it('updates only when confirmed (default no)', async () => {
		const { service, mocks } = makeService();
		expect(await ensureHarnessInstalled(makeIO(['']), service, CODEX, { interactive: true })).toBe(true);
		expect(mocks.startInstall).not.toHaveBeenCalled();
		await ensureHarnessInstalled(makeIO(['y']), service, CODEX, { interactive: true });
		expect(mocks.startInstall).toHaveBeenCalledWith('codex-cli');
	});

	it('installs without asking in --yes mode', async () => {
		const { service, mocks } = makeService();
		const io = makeIO();
		await ensureHarnessInstalled(io, service, GEMINI, { interactive: false });
		expect(io.asked).toEqual([]);
		expect(mocks.startInstall).toHaveBeenCalled();
	});

	it('reports a failed install with the log tail', async () => {
		const { service } = makeService({
			install: { waitForJob: jest.fn(async () => ({ jobId: 'j1', harnessId: 'gemini-cli', state: 'failed', log: 'npm ERR! 404\nInstall failed.\n', usedUserPrefix: false })) },
		});
		const io = makeIO();
		expect(await ensureHarnessInstalled(io, service, GEMINI, { interactive: false })).toBe(false);
		expect(io.lines.join('\n')).toContain('npm ERR! 404');
	});

	it('skipping a missing harness leaves it missing', async () => {
		const { service } = makeService();
		expect(await ensureHarnessInstalled(makeIO(['n']), service, GEMINI, { interactive: true })).toBe(false);
	});
});

describe('driveBrokerLogin', () => {
	it('interactive Claude: prints the link, reads the pasted code, succeeds', async () => {
		const driver = makeDriver('in-process', { state: 'awaiting_user', url: URL, needsInput: true }, [{ state: 'succeeded', message: 'Logged in.' }]);
		const io = makeIO(['', 'code#state']);
		const outcome = await driveBrokerLogin(io, driver, 'claude-code', 'subscription', { interactive: true, timing: fastTiming() });
		expect(outcome).toBe('succeeded');
		expect(io.lines.join('\n')).toContain(URL);
		expect(io.lines.join('\n')).toContain('your phone is fine');
		expect(driver.input).toHaveBeenCalledWith('s1', 'code#state');
	});

	it('device-code login prints URL and code, waits without prompting', async () => {
		const driver = makeDriver('in-process', { harnessId: 'codex-cli', state: 'awaiting_user', url: 'https://auth.openai.com/codex/device', userCode: 'WH2P-EO69V' }, [
			{},
			{ state: 'verifying' },
			{ state: 'succeeded' },
		]);
		const io = makeIO();
		expect(await driveBrokerLogin(io, driver, 'codex-cli', 'device', { interactive: false, timing: fastTiming() })).toBe('succeeded');
		expect(io.asked).toEqual([]);
		expect(io.lines.join('\n')).toContain('WH2P-EO69V');
		expect(io.lines.join('\n')).toContain('Waiting for the sign-in to finish');
	});

	it('non-interactive with the backend: prints the link and hands off to the web app / phone', async () => {
		const driver = makeDriver('backend', { state: 'starting' }, [{ state: 'awaiting_user', url: URL, needsInput: true }]);
		const io = makeIO();
		expect(await driveBrokerLogin(io, driver, 'claude-code', 'subscription', { interactive: false, timing: fastTiming() })).toBe('pending');
		expect(io.asked).toEqual([]);
		expect(io.lines.join('\n')).toContain(URL);
		expect(io.lines.join('\n')).toContain('Crewly → Setup');
		expect(driver.cancel).not.toHaveBeenCalled();
	});

	it('non-interactive with the backend gives up printing after the URL wait', async () => {
		const driver = makeDriver('backend', { state: 'starting', screen: 'weird screen' });
		const io = makeIO();
		const outcome = await driveBrokerLogin(io, driver, 'claude-code', 'subscription', { interactive: false, timing: fastTiming() });
		expect(outcome).toBe('pending');
		expect(io.lines.join('\n')).toContain('weird screen');
	});

	it('reports failure with the message and last screen', async () => {
		const driver = makeDriver('in-process', { state: 'failed', message: 'OAuth error: access_denied', screen: 'OAuth error' });
		const io = makeIO();
		expect(await driveBrokerLogin(io, driver, 'claude-code', 'subscription', { interactive: true, timing: fastTiming() })).toBe('failed');
		expect(io.lines.join('\n')).toContain('Login failed: OAuth error: access_denied');
	});

	it('shows a retry message and asks again', async () => {
		const driver = makeDriver('in-process', { state: 'awaiting_user', url: URL, needsInput: true }, [
			{ state: 'awaiting_user', needsInput: true, message: 'Invalid code. Please make sure the full code was copied.' },
			{ state: 'succeeded' },
		]);
		const io = makeIO(['bad', 'good']);
		expect(await driveBrokerLogin(io, driver, 'claude-code', 'subscription', { interactive: true, timing: fastTiming() })).toBe('succeeded');
		expect(io.lines.join('\n')).toContain('Invalid code');
		expect(driver.input).toHaveBeenCalledTimes(2);
	});

	it('detached: cancels the background login when it never shows a link', async () => {
		const driver = makeDriver('detached', { harnessId: 'codex-cli', state: 'starting' });
		const io = makeIO();
		expect(await driveBrokerLogin(io, driver, 'codex-cli', 'device', { interactive: false, timing: fastTiming() })).toBe('pending');
		expect(driver.cancel).toHaveBeenCalled();
	});

	it('stops waiting (and cancels) after the maximum wait', async () => {
		const driver = makeDriver('in-process', { state: 'awaiting_user', url: 'https://auth.openai.com/codex/device', userCode: 'AAAA-BBBB' });
		const io = makeIO();
		expect(await driveBrokerLogin(io, driver, 'codex-cli', 'device', { interactive: false, timing: fastTiming({ maxWaitMs: 5000 }) })).toBe('failed');
		expect(driver.cancel).toHaveBeenCalled();
	});
});

describe('loginHarness', () => {
	const driverFor = (driver: LoginDriver) => jest.fn(async () => driver);

	it('Gemini is detect-only', async () => {
		const { service } = makeService();
		const io = makeIO();
		expect(await loginHarness(io, service, driverFor(makeDriver('in-process', {})), GEMINI, { interactive: true })).toBe('skipped');
		expect(io.lines.join('\n')).toContain('Run `gemini` once');
	});

	it('keeps an existing login unless asked to log in again', async () => {
		const { service } = makeService();
		const logged = { ...CLAUDE, loginState: 'logged_in' as const, loginSource: 'macos-keychain' };
		const getDriver = driverFor(makeDriver('in-process', {}));
		expect(await loginHarness(makeIO(), service, getDriver, logged, { interactive: false })).toBe('already_logged_in');
		expect(await loginHarness(makeIO(['']), service, getDriver, logged, { interactive: true })).toBe('already_logged_in');
		expect(getDriver).not.toHaveBeenCalled();
	});

	it('interactive API key: asks without echo and submits', async () => {
		const { service, mocks } = makeService();
		const io = makeIO(['2', 'sk-ant-api03-secret']);
		expect(await loginHarness(io, service, driverFor(makeDriver('in-process', {})), CLAUDE, { interactive: true })).toBe('succeeded');
		expect(io.asked.some((q) => q.startsWith('secret:'))).toBe(true);
		expect(mocks.submitApiKey).toHaveBeenCalledWith('claude-code', 'sk-ant-api03-secret');
		expect(io.lines.join('\n')).not.toContain('sk-ant-api03-secret');
	});

	it('API key errors and empty keys', async () => {
		const { service } = makeService({ submitApiKey: jest.fn(async () => { throw new Error('Anthropic rejected this API key'); }) });
		const io = makeIO(['2', 'bad-key']);
		expect(await loginHarness(io, service, driverFor(makeDriver('in-process', {})), CLAUDE, { interactive: true })).toBe('failed');
		expect(io.lines.join('\n')).toContain('Anthropic rejected');
		expect(await loginHarness(makeIO(['2', '']), service, driverFor(makeDriver('in-process', {})), CLAUDE, { interactive: true })).toBe('skipped');
		expect(await loginHarness(makeIO(), service, driverFor(makeDriver('in-process', {})), CLAUDE, { interactive: false, method: 'api_key' })).toBe('skipped');
		expect(await loginHarness(makeIO(), service, driverFor(makeDriver('in-process', {})), CLAUDE, { interactive: false, method: 'password' })).toBe('failed');
	});

	it('--yes without a backend skips a login that needs a typed reply', async () => {
		const { service } = makeService();
		const driver = makeDriver('in-process', {});
		const io = makeIO();
		expect(await loginHarness(io, service, driverFor(driver), CLAUDE, { interactive: false })).toBe('skipped');
		expect(driver.start).not.toHaveBeenCalled();
		expect(io.lines.join('\n')).toContain('Crewly → Setup');
	});

	it('--yes with the backend starts the login there and hands off', async () => {
		const { service } = makeService();
		const driver = makeDriver('backend', { state: 'awaiting_user', url: URL, needsInput: true });
		const io = makeIO();
		expect(await loginHarness(io, service, driverFor(driver), CLAUDE, { interactive: false, timing: fastTiming() })).toBe('pending');
		expect(driver.start).toHaveBeenCalledWith('claude-code', 'subscription');
		expect(io.lines.join('\n')).toContain('also visible in Crewly → Setup');
	});

	it('--yes device-code login with no backend runs detached: prints the code and returns without waiting', async () => {
		const { service } = makeService();
		const inProcess = makeDriver('in-process', {});
		const detached = makeDriver('detached', { harnessId: 'codex-cli', method: 'device', state: 'starting' }, [
			{ state: 'awaiting_user', url: 'https://auth.openai.com/codex/device', userCode: 'WH2P-EO69V' },
		]);
		const io = makeIO();
		const outcome = await loginHarness(io, service, driverFor(inProcess), CODEX, { interactive: false, timing: fastTiming(), detachedDriver: () => detached });
		expect(outcome).toBe('pending');
		expect(inProcess.start).not.toHaveBeenCalled();
		expect(detached.start).toHaveBeenCalledWith('codex-cli', 'device');
		expect(detached.cancel).not.toHaveBeenCalled();
		const out = io.lines.join('\n');
		expect(out).toContain('WH2P-EO69V');
		expect(out).toContain('no need to keep this terminal open');
		expect(out).not.toContain('Waiting for the sign-in to finish');
		expect(io.asked).toEqual([]);
	});

	it('--yes device-code login uses the backend when ours is running (no detached process)', async () => {
		const { service } = makeService();
		const backend = makeDriver('backend', { harnessId: 'codex-cli', method: 'device', state: 'awaiting_user', url: 'https://auth.openai.com/codex/device', userCode: 'AAAA-BBBB' });
		const detachedDriver = jest.fn();
		expect(await loginHarness(makeIO(), service, driverFor(backend), CODEX, { interactive: false, timing: fastTiming(), detachedDriver })).toBe('pending');
		expect(detachedDriver).not.toHaveBeenCalled();
	});

	it('reports a driver error as failed', async () => {
		const { service } = makeService();
		const driver = makeDriver('in-process', {});
		driver.start.mockRejectedValue(new Error('Claude Code is not installed'));
		const io = makeIO(['1']);
		expect(await loginHarness(io, service, driverFor(driver), CLAUDE, { interactive: true })).toBe('failed');
		expect(io.lines.join('\n')).toContain('not installed');
	});
});

describe('runHarnessSetup', () => {
	it('--yes: default harness, install only it, record it, log in', async () => {
		const { service, mocks } = makeService();
		const driver = makeDriver('in-process', { state: 'succeeded' });
		const io = makeIO();
		const result = await runHarnessSetup(io, service, async () => driver, { interactive: false, loginHeader: 'LOGIN', timing: fastTiming() });
		expect(result.harnessId).toBe('claude-code');
		expect(mocks.setOrcHarness).toHaveBeenCalledWith('claude-code');
		expect(mocks.startInstall).not.toHaveBeenCalled();
		expect(io.lines).toContain('LOGIN');
		expect(io.asked).toEqual([]);
	});

	it('installs only the chosen harness and skips login when the install is declined', async () => {
		const { service, mocks } = makeService();
		const io = makeIO(['3', 'n']);
		const result = await runHarnessSetup(io, service, async () => makeDriver('in-process', {}), { interactive: true });
		expect(result).toEqual({ harnessId: 'gemini-cli', installed: false, login: 'skipped' });
		expect(mocks.setOrcHarness).toHaveBeenCalledWith('gemini-cli');
		expect(io.lines.join('\n')).toContain('crewly login gemini');
	});
});
