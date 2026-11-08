/**
 * Bounded retry for the dispatcher's write to an agent's terminal (CREW-862).
 *
 * A write that gets no answer (client timeout, reset connection) or a
 * transient 502/503/504 is tried again after a doubling wait. Any other HTTP
 * answer is final: 404 (session gone), 409 (input box not ours) and a
 * spend-cap reply are decisions, not blips. When every try fails the last
 * error is rethrown, so the caller keeps the item queued and reports it.
 *
 * @module services/v3/terminal-write-retry
 */

import { DISPATCH_WRITE_RETRY_CONSTANTS as C } from '../../constants.js';

/** How a retry waits; replaced in tests. */
export type RetrySleep = (ms: number) => Promise<void>;

const defaultSleep: RetrySleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Whether a failed write is worth another try.
 *
 * @param err - The error the HTTP client threw
 * @returns True for "no answer" and transient gateway statuses
 */
export function isRetryableWriteError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  if (status === undefined) return true;
  return C.RETRYABLE_STATUSES.includes(status);
}

/**
 * Run a write, trying again when it fails in a retryable way.
 *
 * @param write - One attempt
 * @param onRetry - Called before each wait (attempt that just failed, wait, error)
 * @param sleep - Wait function (tests)
 * @returns The first successful result
 * @throws The last error once the tries are used up, or at once for a final answer
 */
export async function writeWithRetry<T>(
  write: () => Promise<T>,
  onRetry?: (failedAttempt: number, waitMs: number, err: unknown) => void,
  sleep: RetrySleep = defaultSleep,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (attempt >= C.MAX_ATTEMPTS || !isRetryableWriteError(err)) throw err;
      const waitMs = Math.min(C.BASE_DELAY_MS * 2 ** (attempt - 1), C.MAX_DELAY_MS);
      onRetry?.(attempt, waitMs, err);
      await sleep(waitMs);
    }
  }
}
