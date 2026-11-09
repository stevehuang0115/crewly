jest.mock('../core/logger.service.js', () => ({
	LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) }) },
}));

import { DEFERRED_START_RETRY_CONSTANTS, resetDeferredStartRetries, scheduleDeferredStartRetry, sweepWakeDue } from './deferred-start-retry.js';
import { SUB_AGENT_QUEUE_CONSTANTS } from '../../constants.js';

/** Fake clock: each pause moves time forward, so the loop's time bound holds without real waiting. */
let t = 0;
const now = (): number => t;
const sleep = async (ms: number): Promise<void> => {
	t += ms;
};

beforeEach(() => {
	resetDeferredStartRetries();
	t = 0;
});

describe('scheduleDeferredStartRetry', () => {
	it('retries until the start goes through', async () => {
		const results = [{ success: false, deferred: true }, { success: false, deferred: true }, { success: true }];
		const activate = jest.fn(async () => results.shift()!);
		await scheduleDeferredStartRetry('ella', { activate, hasPending: () => true, sleep, now });
		expect(activate).toHaveBeenCalledTimes(3);
	});

	it('waits the first pause before the first round when one is given', async () => {
		const pauses: number[] = [];
		const activate = jest.fn(async () => ({ success: false, deferred: true }));
		await scheduleDeferredStartRetry('ella', { activate, hasPending: () => true, sleep: async (ms) => { pauses.push(ms); await sleep(ms); }, now, firstPauseMs: 60_000 });
		expect(pauses[0]).toBe(60_000);
		expect(pauses[1]).toBe(DEFERRED_START_RETRY_CONSTANTS.ROUND_PAUSE_MS);
	});

	it('stops when the queue has emptied', async () => {
		const activate = jest.fn(async () => ({ success: true }));
		await scheduleDeferredStartRetry('ella', { activate, hasPending: () => false, sleep, now });
		expect(activate).not.toHaveBeenCalled();
	});

	it('stops on a failure that is not a deferral', async () => {
		const activate = jest.fn(async () => ({ success: false }));
		await scheduleDeferredStartRetry('ella', { activate, hasPending: () => true, sleep, now });
		expect(activate).toHaveBeenCalledTimes(1);
	});

	it('keeps trying at the slow pause after the fast rounds, until MAX_TOTAL_MS (Pia, 2026-10-16)', async () => {
		const pauses: number[] = [];
		const activate = jest.fn(async () => ({ success: false, deferred: true }));
		await scheduleDeferredStartRetry('pia', { activate, hasPending: () => true, sleep: async (ms) => { pauses.push(ms); await sleep(ms); }, now });
		const { MAX_ROUNDS, ROUND_PAUSE_MS, SLOW_ROUND_PAUSE_MS, MAX_TOTAL_MS } = DEFERRED_START_RETRY_CONSTANTS;
		expect(pauses.slice(0, MAX_ROUNDS).every((p) => p === ROUND_PAUSE_MS)).toBe(true);
		expect(pauses.slice(MAX_ROUNDS).every((p) => p === SLOW_ROUND_PAUSE_MS)).toBe(true);
		expect(activate.mock.calls.length).toBeGreaterThan(MAX_ROUNDS);
		expect(t).toBeGreaterThanOrEqual(MAX_TOTAL_MS);
		expect(t).toBeLessThan(MAX_TOTAL_MS + SLOW_ROUND_PAUSE_MS + 1);
	});

	it('a slot freeing late still gets the agent started', async () => {
		const activate = jest.fn(async () => (t > 60 * 60_000 ? { success: true } : { success: false, deferred: true }));
		await scheduleDeferredStartRetry('pia', { activate, hasPending: () => true, sleep, now });
		expect(await activate.mock.results[activate.mock.results.length - 1].value).toEqual({ success: true });
	});

	it('runs one loop per agent', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const activate = jest.fn(async () => { await gate; return { success: true }; });
		const first = scheduleDeferredStartRetry('ella', { activate, hasPending: () => true, sleep, now });
		await scheduleDeferredStartRetry('ella', { activate, hasPending: () => true, sleep, now });
		release();
		await first;
		expect(activate).toHaveBeenCalledTimes(1);
	});

	it('a held round is skipped without a start, and the start follows once the hold lifts (crewly#1353)', async () => {
		const activate = jest.fn(async () => ({ success: true }));
		const hold = jest.fn(() => (t < 30_000 ? 'memory tight: swap 95% >= 80%' : null));
		await scheduleDeferredStartRetry('max', { activate, hasPending: () => true, hold, sleep, now });
		expect(activate).toHaveBeenCalledTimes(1);
		expect(hold.mock.calls.length).toBeGreaterThan(1);
		expect(t).toBeGreaterThanOrEqual(30_000);
	});

	it('a hold that never lifts still ends at the total budget', async () => {
		const activate = jest.fn(async () => ({ success: true }));
		await scheduleDeferredStartRetry('max', { activate, hasPending: () => true, hold: () => 'held', sleep, now });
		expect(activate).not.toHaveBeenCalled();
		expect(t).toBeGreaterThanOrEqual(DEFERRED_START_RETRY_CONSTANTS.MAX_TOTAL_MS);
	});
});

describe('sweepWakeDue (periodic queued-wake sweep backoff)', () => {
	const step = SUB_AGENT_QUEUE_CONSTANTS.QUEUED_WAKE_SWEEP_MS;
	it('wakes an agent the sweep has not woken yet', () => {
		expect(sweepWakeDue(undefined, 0)).toBe(true);
	});
	it('doubles the gap after each wake that did not bring the agent up, up to the cap', () => {
		expect(sweepWakeDue({ count: 1, at: 0 }, step - 1)).toBe(false);
		expect(sweepWakeDue({ count: 1, at: 0 }, step)).toBe(true);
		expect(sweepWakeDue({ count: 3, at: 0 }, 4 * step - 1)).toBe(false);
		expect(sweepWakeDue({ count: 3, at: 0 }, 4 * step)).toBe(true);
		expect(sweepWakeDue({ count: 20, at: 0 }, SUB_AGENT_QUEUE_CONSTANTS.QUEUED_WAKE_SWEEP_MAX_BACKOFF_MS)).toBe(true);
	});
});
