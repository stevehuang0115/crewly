/**
 * Tests for CLI safe-shutdown helpers.
 */

const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
	__esModule: true,
	default: { get: (...args: unknown[]) => mockAxiosGet(...args) },
}));

import {
	createChildShutdownHandler,
	describeReadiness,
	fetchRestartReadiness,
	isPidAlive,
	parseReadiness,
	resolveRestartDrainMs,
	resolveShutdownBudgetMs,
	waitForPidExit,
	type ShutdownChild,
} from './safe-shutdown.js';
import { SAFE_RESTART_CONSTANTS } from '../../../config/index.js';

const ENV = SAFE_RESTART_CONSTANTS.DRAIN_ENV_VAR;

describe('resolveRestartDrainMs / resolveShutdownBudgetMs', () => {
	it('defaults to the shared drain timeout', () => {
		expect(resolveRestartDrainMs({})).toBe(SAFE_RESTART_CONSTANTS.DRAIN_TIMEOUT_MS);
		expect(resolveShutdownBudgetMs({})).toBe(SAFE_RESTART_CONSTANTS.DRAIN_TIMEOUT_MS + SAFE_RESTART_CONSTANTS.SHUTDOWN_MARGIN_MS);
	});

	it('honours the env override, including 0', () => {
		expect(resolveRestartDrainMs({ [ENV]: '45000' })).toBe(45_000);
		expect(resolveShutdownBudgetMs({ [ENV]: '0' })).toBe(SAFE_RESTART_CONSTANTS.SHUTDOWN_MARGIN_MS);
	});

	it('ignores junk', () => {
		expect(resolveRestartDrainMs({ [ENV]: 'soon' })).toBe(SAFE_RESTART_CONSTANTS.DRAIN_TIMEOUT_MS);
		expect(resolveRestartDrainMs({ [ENV]: '-1' })).toBe(SAFE_RESTART_CONSTANTS.DRAIN_TIMEOUT_MS);
		expect(resolveRestartDrainMs({ [ENV]: '' })).toBe(SAFE_RESTART_CONSTANTS.DRAIN_TIMEOUT_MS);
	});
});

describe('readiness', () => {
	beforeEach(() => mockAxiosGet.mockReset());

	it('parses a valid body and rejects anything else', () => {
		expect(parseReadiness({ safe: true, busyAgents: [], queued: 3 })).toEqual({ safe: true, busyAgents: [], queued: 3, draining: false });
		expect(parseReadiness({ safe: false, busyAgents: [{ session: 'ella', since: 'x', messagePreview: 'y' }, null] })).toEqual({
			safe: false,
			busyAgents: [{ session: 'ella', since: 'x', messagePreview: 'y' }],
			queued: 0,
			draining: false,
		});
		expect(parseReadiness(undefined)).toBeNull();
		expect(parseReadiness({ ok: true })).toBeNull();
	});

	it('fetches from the readiness endpoint and returns null on failure', async () => {
		mockAxiosGet.mockResolvedValueOnce({ data: { safe: true, busyAgents: [], queued: 0 } });
		expect(await fetchRestartReadiness(9999)).toMatchObject({ safe: true });
		expect(mockAxiosGet.mock.calls[0][0]).toBe(`http://localhost:9999${SAFE_RESTART_CONSTANTS.READINESS_ENDPOINT}`);
		mockAxiosGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		expect(await fetchRestartReadiness(9999)).toBeNull();
	});

	it('describes busy agents for the operator', () => {
		const lines = describeReadiness(
			{ safe: false, busyAgents: [{ session: 'ella', since: '2026-09-24T01:38:30Z', messagePreview: 'check my To Do' }], queued: 1 },
			120_000,
		);
		expect(lines[0]).toContain('1 agent(s) are mid-turn');
		expect(lines[0]).toContain('120s');
		expect(lines[1]).toContain('ella');
		expect(lines[1]).toContain('check my To Do');
		expect(describeReadiness({ safe: true, busyAgents: [], queued: 2 }, 0)[0]).toContain('No agent is mid-turn');
	});
});

describe('waitForPidExit', () => {
	it('returns true once the process is gone', async () => {
		let alive = 3;
		const exited = await waitForPidExit(1, 10_000, { isAlive: () => alive-- > 0, sleep: async () => undefined });
		expect(exited).toBe(true);
	});

	it('returns false at the timeout and reports progress', async () => {
		let t = 0;
		const progress: number[] = [];
		const exited = await waitForPidExit(1, 30_000, {
			isAlive: async () => true,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			},
			pollMs: 1_000,
			onProgress: (w) => progress.push(w),
		});
		expect(exited).toBe(false);
		expect(progress).toEqual([10_000, 20_000]);
	});

	it('isPidAlive is true for this process and false for a pid that cannot exist', () => {
		expect(isPidAlive(process.pid)).toBe(true);
		expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
	});
});

describe('createChildShutdownHandler', () => {
	type FakeChild = ShutdownChild & { kill: jest.Mock; once: jest.Mock; exit: () => void };

	/**
	 * Fake child process.
	 *
	 * @returns Child with a trigger for its exit event
	 */
	function makeChild(): FakeChild {
		const handlers: Array<() => void> = [];
		const child = {
			killed: false,
			exitCode: null,
			signalCode: null,
		} as unknown as FakeChild;
		child.kill = jest.fn(() => {
			child.killed = true;
			return true;
		});
		child.once = jest.fn((event: string, h: () => void): unknown => {
			if (event === 'exit') handlers.push(h);
			return child;
		});
		child.exit = () => {
			child.exitCode = 0;
			handlers.forEach((h) => h());
		};
		return child;
	}

	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it('SIGTERMs live children, registers one exit listener each, and exits after they exit', async () => {
		const a = makeChild();
		const dead = makeChild();
		dead.exitCode = 0;
		const exit = jest.fn();
		const onSignal = createChildShutdownHandler(() => [a, dead, null], { budgetMs: 150_000, log: jest.fn(), exit });
		onSignal();
		expect(a.kill).toHaveBeenCalledWith('SIGTERM');
		expect(dead.kill).not.toHaveBeenCalled();
		expect(a.once.mock.calls.filter((c) => c[0] === 'exit')).toHaveLength(1);
		expect(exit).not.toHaveBeenCalled();
		a.exit();
		await Promise.resolve();
		await Promise.resolve();
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it('waits the whole drain budget before SIGKILL (not the old 5s)', async () => {
		const a = makeChild();
		const exit = jest.fn();
		createChildShutdownHandler(() => [a], { budgetMs: 150_000, log: jest.fn(), exit })();
		jest.advanceTimersByTime(5_000);
		expect(a.kill).not.toHaveBeenCalledWith('SIGKILL');
		jest.advanceTimersByTime(145_000);
		expect(a.kill).toHaveBeenCalledWith('SIGKILL');
		await jest.advanceTimersByTimeAsync(3_000);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it('forwards a repeated signal so the backend can skip the drain', () => {
		const a = makeChild();
		const log = jest.fn();
		const onSignal = createChildShutdownHandler(() => [a], { budgetMs: 150_000, log, exit: jest.fn() });
		onSignal();
		expect(a.killed).toBe(true);
		onSignal();
		expect(a.kill).toHaveBeenCalledTimes(2);
		expect(a.kill).toHaveBeenNthCalledWith(2, 'SIGTERM');
		expect(log).toHaveBeenCalledWith(expect.stringContaining('stop waiting'));
	});

	it('exits straight away when there is nothing to stop', async () => {
		const exit = jest.fn();
		createChildShutdownHandler(() => [], { budgetMs: 1, log: jest.fn(), exit })();
		await Promise.resolve();
		await Promise.resolve();
		expect(exit).toHaveBeenCalledTimes(1);
	});
});
