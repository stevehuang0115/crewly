/**
 * Generic retry-with-backoff helper.
 *
 * Crewly services routinely return a success-flagged result object
 * (`{ success: boolean, error?: string, ... }`) rather than throwing. This
 * helper retries such an operation until it reports success or the attempt
 * budget is exhausted, applying a linear backoff between tries.
 *
 * Extracted so retry policy is unit-testable in isolation (the original
 * caller — the orchestrator auto-start in the server bootstrap, #686 — cannot
 * be unit-tested without standing up the entire CrewlyServer).
 *
 * @module services/core/retry.util
 */

/**
 * Options controlling {@link retryWithBackoff}.
 */
export interface RetryWithBackoffOptions<T> {
	/** Maximum number of attempts (must be >= 1). The first try counts as attempt 1. */
	maxAttempts: number;
	/**
	 * Base backoff in milliseconds. The wait before retry N is
	 * `backoffMs * N` (linear backoff): after attempt 1 fails we wait
	 * `backoffMs`, after attempt 2 we wait `2 * backoffMs`, etc. No wait is
	 * applied after the final attempt.
	 */
	backoffMs: number;
	/** Predicate deciding whether a result counts as success (stops retrying). */
	isSuccess: (result: T) => boolean;
	/** Optional hook invoked before each backoff sleep (for logging). */
	onRetry?: (info: { attempt: number; maxAttempts: number; retryInMs: number; result: T }) => void;
	/**
	 * Sleep implementation, injectable for tests. Defaults to a real
	 * `setTimeout`-based delay.
	 */
	sleep?: (ms: number) => Promise<void>;
}

/** Default real-time sleep. */
function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run `operation` up to `maxAttempts` times until `isSuccess` returns true,
 * waiting `backoffMs * attempt` between tries (linear backoff).
 *
 * Always returns the LAST result — successful or not — so the caller can
 * inspect it (e.g. read `result.error`). The operation receives the 1-based
 * attempt number.
 *
 * @param operation - Async operation to run; receives the 1-based attempt number
 * @param options - Retry policy {@link RetryWithBackoffOptions}
 * @returns The last result produced by `operation`
 * @throws RangeError if `maxAttempts` < 1
 *
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   () => service.createAgentSession({ ... }),
 *   { maxAttempts: 5, backoffMs: 3000, isSuccess: r => r.success,
 *     onRetry: ({ attempt, retryInMs }) => logger.warn('retrying', { attempt, retryInMs }) },
 * );
 * if (!result.success) logger.error('gave up', { error: result.error });
 * ```
 */
export async function retryWithBackoff<T>(
	operation: (attempt: number) => Promise<T>,
	options: RetryWithBackoffOptions<T>,
): Promise<T> {
	const { maxAttempts, backoffMs, isSuccess, onRetry } = options;
	if (maxAttempts < 1) {
		throw new RangeError(`maxAttempts must be >= 1, got ${maxAttempts}`);
	}
	const sleep = options.sleep ?? defaultSleep;

	let result!: T;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		result = await operation(attempt);
		if (isSuccess(result)) {
			return result;
		}
		if (attempt < maxAttempts) {
			const retryInMs = backoffMs * attempt;
			onRetry?.({ attempt, maxAttempts, retryInMs, result });
			await sleep(retryInMs);
		}
	}
	return result;
}
