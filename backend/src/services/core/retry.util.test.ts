/**
 * Tests for retryWithBackoff.
 *
 * @module services/core/retry.util.test
 */

import { retryWithBackoff } from './retry.util.js';

interface Result {
	success: boolean;
	error?: string;
}

describe('retryWithBackoff', () => {
	// A no-op sleep so tests don't actually wait. Records the requested delays
	// so we can assert the linear backoff schedule.
	function makeSleepSpy(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
		const delays: number[] = [];
		return {
			delays,
			sleep: async (ms: number) => {
				delays.push(ms);
			},
		};
	}

	it('returns immediately on first success without sleeping', async () => {
		const { sleep, delays } = makeSleepSpy();
		const op = jest.fn(async () => ({ success: true }) as Result);

		const result = await retryWithBackoff(op, {
			maxAttempts: 5,
			backoffMs: 1000,
			isSuccess: r => r.success,
			sleep,
		});

		expect(result.success).toBe(true);
		expect(op).toHaveBeenCalledTimes(1);
		expect(delays).toEqual([]); // never slept
	});

	it('retries on failure and succeeds on a later attempt', async () => {
		const { sleep, delays } = makeSleepSpy();
		let calls = 0;
		const op = jest.fn(async () => {
			calls++;
			return { success: calls === 3 } as Result; // fail, fail, succeed
		});

		const result = await retryWithBackoff(op, {
			maxAttempts: 5,
			backoffMs: 1000,
			isSuccess: r => r.success,
			sleep,
		});

		expect(result.success).toBe(true);
		expect(op).toHaveBeenCalledTimes(3);
		// Linear backoff before attempt 2 (1000) and attempt 3 (2000); no sleep
		// after the successful 3rd attempt.
		expect(delays).toEqual([1000, 2000]);
	});

	it('exhausts all attempts and returns the last (failed) result', async () => {
		const { sleep, delays } = makeSleepSpy();
		const op = jest.fn(async (attempt: number) => ({ success: false, error: `fail-${attempt}` }) as Result);

		const result = await retryWithBackoff(op, {
			maxAttempts: 3,
			backoffMs: 500,
			isSuccess: r => r.success,
			sleep,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe('fail-3'); // last result surfaced
		expect(op).toHaveBeenCalledTimes(3);
		// Sleeps only BETWEEN attempts (after 1 and 2), not after the final one.
		expect(delays).toEqual([500, 1000]);
	});

	it('invokes onRetry before each backoff with attempt metadata', async () => {
		const { sleep } = makeSleepSpy();
		const onRetry = jest.fn();
		const op = jest.fn(async () => ({ success: false }) as Result);

		await retryWithBackoff(op, {
			maxAttempts: 3,
			backoffMs: 1000,
			isSuccess: r => r.success,
			onRetry,
			sleep,
		});

		expect(onRetry).toHaveBeenCalledTimes(2); // before attempt 2 and 3
		expect(onRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({ attempt: 1, maxAttempts: 3, retryInMs: 1000 }));
		expect(onRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2, maxAttempts: 3, retryInMs: 2000 }));
	});

	it('passes the 1-based attempt number to the operation', async () => {
		const { sleep } = makeSleepSpy();
		const seen: number[] = [];
		const op = jest.fn(async (attempt: number) => {
			seen.push(attempt);
			return { success: false } as Result;
		});

		await retryWithBackoff(op, { maxAttempts: 3, backoffMs: 1, isSuccess: r => r.success, sleep });

		expect(seen).toEqual([1, 2, 3]);
	});

	it('throws RangeError when maxAttempts < 1', async () => {
		await expect(
			retryWithBackoff(async () => ({ success: true }) as Result, {
				maxAttempts: 0,
				backoffMs: 100,
				isSuccess: r => r.success,
			}),
		).rejects.toThrow(RangeError);
	});

	it('supports a custom isSuccess predicate', async () => {
		const { sleep } = makeSleepSpy();
		let calls = 0;
		// "Success" here means a non-empty data string, not a `success` flag.
		const op = jest.fn(async () => {
			calls++;
			return { data: calls >= 2 ? 'ready' : '' };
		});

		const result = await retryWithBackoff(op, {
			maxAttempts: 4,
			backoffMs: 10,
			isSuccess: r => r.data.length > 0,
			sleep,
		});

		expect(result.data).toBe('ready');
		expect(op).toHaveBeenCalledTimes(2);
	});
});
