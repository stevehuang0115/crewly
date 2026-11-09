import { DISPATCH_WRITE_RETRY_CONSTANTS as C } from '../../constants.js';
import { isRetryableWriteError, writeWithRetry } from './terminal-write-retry.js';

const timeoutErr = (): Error => Object.assign(new Error('timeout of 45000ms exceeded'), { code: 'ECONNABORTED' });
const refusedErr = (): Error => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), { code: 'ECONNREFUSED' });
const httpErr = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

describe('isRetryableWriteError', () => {
  it('retries requests that never reached the server and transient gateway statuses only', () => {
    expect(isRetryableWriteError(refusedErr())).toBe(true);
    for (const code of ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']) expect(isRetryableWriteError(Object.assign(new Error(code), { code }))).toBe(true);
    expect(isRetryableWriteError(new Error('connect ECONNREFUSED'))).toBe(true);
    for (const s of C.RETRYABLE_STATUSES) expect(isRetryableWriteError(httpErr(s))).toBe(true);
    for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']) expect(isRetryableWriteError(Object.assign(new Error('x'), { code }))).toBe(false);
    expect(isRetryableWriteError(timeoutErr())).toBe(false);
    expect(isRetryableWriteError(new Error('timeout of 5000ms exceeded'))).toBe(false);
    expect(isRetryableWriteError(new Error('boom'))).toBe(false);
    for (const s of [400, 404, 409, 500]) expect(isRetryableWriteError(httpErr(s))).toBe(false);
  });
});

describe('writeWithRetry (CREW-862)', () => {
  it('a write refused once succeeds on the retry, after the base wait', async () => {
    const write = jest.fn().mockRejectedValueOnce(refusedErr()).mockResolvedValueOnce('ok');
    const sleep = jest.fn().mockResolvedValue(undefined);
    const onRetry = jest.fn();
    await expect(writeWithRetry(write, onRetry, sleep)).resolves.toBe('ok');
    expect(write).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(C.BASE_DELAY_MS);
    expect(onRetry).toHaveBeenCalledWith(1, C.BASE_DELAY_MS, expect.any(Error));
  });

  it('a write that keeps failing is tried MAX_ATTEMPTS times with doubling waits, then the error is thrown', async () => {
    const err = refusedErr();
    const write = jest.fn().mockRejectedValue(err);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(writeWithRetry(write, undefined, sleep)).rejects.toBe(err);
    expect(write).toHaveBeenCalledTimes(C.MAX_ATTEMPTS);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([C.BASE_DELAY_MS, Math.min(C.BASE_DELAY_MS * 2, C.MAX_DELAY_MS)]);
  });

  it('a write that TIMES OUT is not retried: it may still be delivering (double paste)', async () => {
    const err = timeoutErr();
    const write = jest.fn().mockRejectedValue(err);
    const sleep = jest.fn();
    await expect(writeWithRetry(write, undefined, sleep)).rejects.toBe(err);
    expect(write).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a final HTTP answer (404) is not retried', async () => {
    const write = jest.fn().mockRejectedValue(httpErr(404));
    const sleep = jest.fn();
    await expect(writeWithRetry(write, undefined, sleep)).rejects.toThrow('HTTP 404');
    expect(write).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a first-try success waits for nothing', async () => {
    const sleep = jest.fn();
    await expect(writeWithRetry(async () => 7, undefined, sleep)).resolves.toBe(7);
    expect(sleep).not.toHaveBeenCalled();
  });
});
