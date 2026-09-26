/**
 * Tests for `crewly harness` and `crewly login` (engine faked).
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
import type { HarnessStatus } from '../../../backend/src/services/harness/harness.types.js';
import type { LoginDriver } from '../utils/harness-engine.js';
import { LoginInputClosedError, harnessCommand, loginCommand } from './harness.js';

const CODEX: HarnessStatus = {
	id: 'codex-cli',
	displayName: 'Codex',
	installed: true,
	version: '0.156.1',
	latestVersion: '0.156.1',
	updateAvailable: false,
	loginState: 'logged_out',
	loginSource: null,
	loginMethods: [
		{ id: 'device', label: 'ChatGPT account (device code)', kind: 'broker' },
		{ id: 'api_key', label: 'OpenAI API key', kind: 'api_key' },
	],
	retired: false,
};

/**
 * Fake service.
 *
 * @param status - Status returned for every harness
 * @returns Service and mocks
 */
function makeService(status: HarnessStatus = CODEX) {
	const mocks = {
		getOverview: jest.fn(async () => ({ harnesses: [status], orcHarness: 'codex-cli', systemTools: [] })),
		getStatus: jest.fn(async () => status),
		submitApiKey: jest.fn(),
		broker: { shutdown: jest.fn() },
	};
	return { mocks, service: mocks as unknown as HarnessService };
}

/**
 * IO capturing output.
 *
 * @param answers - Scripted answers
 * @returns IO
 */
function makeIO(answers: string[] = []) {
	const lines: string[] = [];
	return {
		lines,
		ask: jest.fn(async () => answers.shift() ?? ''),
		askSecret: jest.fn(async () => answers.shift() ?? ''),
		log: (line: string) => lines.push(line),
	};
}

/**
 * Driver that finishes immediately.
 *
 * @param state - Final state
 * @returns Driver
 */
function doneDriver(state: 'succeeded' | 'failed'): LoginDriver {
	const session = { id: 's1', harnessId: 'codex-cli' as const, method: 'device' as const, state, url: null, userCode: null, needsInput: false, message: null, screen: '', startedAt: '', updatedAt: '' };
	return { where: 'in-process', start: async () => session, get: async () => session, input: async () => session, cancel: async () => session };
}

describe('harnessCommand', () => {
	it('prints the harnesses and the orchestrator harness', async () => {
		const { service } = makeService();
		const io = makeIO();
		expect(await harnessCommand({ service, io })).toBe(0);
		expect(io.lines.join('\n')).toContain('Codex');
		expect(io.lines.join('\n')).toContain('Orchestrator harness: codex-cli');
	});
});

describe('loginCommand', () => {
	let logSpy: jest.SpyInstance;
	beforeEach(() => {
		logSpy = jest.spyOn(console, 'log').mockImplementation();
	});
	afterEach(() => logSpy.mockRestore());

	it('rejects an unknown harness name', async () => {
		expect(await loginCommand('opencode', {}, { service: makeService().service, io: makeIO() })).toBe(2);
	});

	it('refuses when the harness is not installed', async () => {
		const { service, mocks } = makeService({ ...CODEX, installed: false });
		const io = makeIO();
		expect(await loginCommand('codex', {}, { service, io, interactive: true })).toBe(1);
		expect(io.lines.join('\n')).toContain('npm install -g @openai/codex');
		expect(mocks.broker.shutdown).toHaveBeenCalled();
	});

	it('logs in through the driver and returns success', async () => {
		const { service, mocks } = makeService();
		const io = makeIO(['1']);
		const code = await loginCommand('codex', {}, { service, io, interactive: true, getDriver: async () => doneDriver('succeeded') });
		expect(code).toBe(0);
		expect(io.lines.join('\n')).toContain('Logging in to Codex');
		expect(mocks.broker.shutdown).toHaveBeenCalled();
	});

	it('returns an error code when the login fails', async () => {
		const { service } = makeService();
		const code = await loginCommand('codex', { method: 'device' }, { service, io: makeIO(), interactive: true, getDriver: async () => doneDriver('failed') });
		expect(code).toBe(1);
	});

	it('--yes never prompts', async () => {
		const { service } = makeService();
		const io = makeIO();
		await loginCommand('codex', { yes: true }, { service, io, interactive: true, getDriver: async () => doneDriver('succeeded') });
		expect(io.ask).not.toHaveBeenCalled();
	});

	it('treats closed input as a failed login, rethrows other errors', async () => {
		const { service } = makeService();
		const io = makeIO();
		io.ask.mockRejectedValue(new LoginInputClosedError());
		expect(await loginCommand('codex', {}, { service, io, interactive: true, getDriver: async () => doneDriver('succeeded') })).toBe(1);
		expect(io.lines.join('\n')).toContain('Input closed');
		const broken = makeService();
		broken.mocks.getStatus.mockRejectedValue(new Error('boom'));
		await expect(loginCommand('codex', {}, { service: broken.service, io: makeIO(), interactive: true })).rejects.toThrow('boom');
	});
});
