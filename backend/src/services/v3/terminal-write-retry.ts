/**
 * Bounded retry for the dispatcher's write to an agent's terminal (CREW-862).
 *
 * A write that never reached the server (connection refused / reset, DNS) or
 * got a transient 502/503/504 is tried again after a doubling wait. A TIMEOUT
 * is never retried: the guarded paste may still be landing, and a second
 * write would paste the brief twice. Any other HTTP answer is final: 404 (session gone), 409 (input box not ours) and a
 * spend-cap reply are decisions, not blips. When every try fails the last
 * error is rethrown, so the caller keeps the item queued and reports it.
 *
 * @module services/v3/terminal-write-retry
 */

import { DISPATCH_WRITE_RETRY_CONSTANTS as C } from '../../constants.js';

/** How a retry waits; replaced in tests. */
export type RetrySleep = (ms: number) => Promise<void>;

const defaultSleep: RetrySleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/** Error codes that mean the request never reached the server, so a second try cannot double-deliver. */
const NEVER_REACHED_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']);
/** Codes / words of a request that went out and got no answer: the paste may still be landing. */
const MAYBE_DELIVERED = /ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed out/i;
const NEVER_REACHED_IN_TEXT = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b/;

/**
 * Whether a failed write is safe and worth another try. A timeout is NOT:
 * the server answers only after the guarded paste has finished (#1431), so a
 * client that gave up may be waiting on a brief that is still being
 * delivered, and writing it again would paste it twice. Only a request that
 * never reached the server (connection refused / reset, DNS failure) or a
 * transient gateway status is retried.
 *
 * @param err - The error the HTTP client threw
 * @returns True for "never reached the server" and 502/503/504
 */
export function isRetryableWriteError(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: string; message?: string } | null;
  const status = e?.response?.status;
  if (status !== undefined) return C.RETRYABLE_STATUSES.includes(status);
  const text = `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (MAYBE_DELIVERED.test(text)) return false;
  return NEVER_REACHED_CODES.has(e?.code ?? '') || NEVER_REACHED_IN_TEXT.test(text);
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
