import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter, RATE_LIMITER_DEFAULTS } from './rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter<string>({
      maxRequestsPerWindow: 3,
      windowMs: 10_000,
      maxRetries: 2,
      initialBackoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1000,
      coalesceWindowMs: 50,
    });
  });

  afterEach(() => {
    limiter.reset();
    vi.useRealTimers();
  });

  describe('defaults', () => {
    it('should have sensible default config', () => {
      const defaultLimiter = new RateLimiter<string>();
      const config = defaultLimiter.getConfig();
      expect(config.maxRequestsPerWindow).toBe(RATE_LIMITER_DEFAULTS.maxRequestsPerWindow);
      expect(config.windowMs).toBe(RATE_LIMITER_DEFAULTS.windowMs);
      expect(config.maxRetries).toBe(RATE_LIMITER_DEFAULTS.maxRetries);
      defaultLimiter.reset();
    });
  });

  describe('basic enqueue', () => {
    it('should process a single message', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');
      const resultP = limiter.enqueue('hello', undefined, handler);
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultP;
      expect(result).toBe('ok');
      expect(handler).toHaveBeenCalledWith('hello', undefined);
    });

    it('should pass metadata through', async () => {
      const handler = vi.fn<(msg: string, meta?: Record<string, string>) => Promise<string>>().mockResolvedValue('ok');
      const meta = { channelId: 'C1' };
      const resultP = limiter.enqueue('hello', meta, handler);
      await vi.advanceTimersByTimeAsync(100);
      await resultP;
      expect(handler).toHaveBeenCalledWith('hello', meta);
    });
  });

  describe('message coalescing', () => {
    it('should coalesce messages arriving within the coalesce window', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');

      // Enqueue 3 messages rapidly (within 50ms coalesce window)
      const p1 = limiter.enqueue('msg1', undefined, handler);
      const p2 = limiter.enqueue('msg2', undefined, handler);
      const p3 = limiter.enqueue('msg3', undefined, handler);

      // Advance past coalesce window
      await vi.advanceTimersByTimeAsync(100);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      // All should get the same result
      expect(r1).toBe('ok');
      expect(r2).toBe('ok');
      expect(r3).toBe('ok');

      // Handler called only once (messages coalesced)
      expect(handler).toHaveBeenCalledTimes(1);

      // The coalesced message should mention all 3
      const callArg = handler.mock.calls[0][0];
      expect(callArg).toContain('3 messages received');
      expect(callArg).toContain('msg1');
      expect(callArg).toContain('msg2');
      expect(callArg).toContain('msg3');
    });

    it('should not coalesce a single message', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');

      const p = limiter.enqueue('single', undefined, handler);
      await vi.advanceTimersByTimeAsync(100);
      await p;

      expect(handler).toHaveBeenCalledWith('single', undefined);
    });
  });

  describe('429 retry', () => {
    it('should retry on quota exceeded error', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>()
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockResolvedValueOnce('recovered');

      const resultP = limiter.enqueue('test', undefined, handler);
      // Advance past coalesce window
      await vi.advanceTimersByTimeAsync(100);
      // Advance past backoff (100ms)
      await vi.advanceTimersByTimeAsync(200);
      const result = await resultP;

      expect(result).toBe('recovered');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should retry on quota exceeded message', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>()
        .mockRejectedValueOnce(new Error('You exceeded your current quota'))
        .mockResolvedValueOnce('ok');

      const resultP = limiter.enqueue('test', undefined, handler);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);
      const result = await resultP;

      expect(result).toBe('ok');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should retry on RESOURCE_EXHAUSTED', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>()
        .mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED: quota limit reached'))
        .mockResolvedValueOnce('ok');

      const resultP = limiter.enqueue('test', undefined, handler);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);
      const result = await resultP;

      expect(result).toBe('ok');
    });

    it('should NOT retry on non-quota errors', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>()
        .mockRejectedValue(new Error('Invalid API key'));

      // Attach catch immediately to prevent unhandled rejection warning
      let caughtError: Error | null = null;
      const resultP = limiter.enqueue('test', undefined, handler)
        .catch((e: Error) => { caughtError = e; return 'caught' as string; });

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      await resultP;

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toBe('Invalid API key');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should reject after max retries exhausted', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>()
        .mockRejectedValue(new Error('429 rate limited'));

      let caughtError: Error | null = null;
      const resultP = limiter.enqueue('test', undefined, handler)
        .catch((e: Error) => { caughtError = e; return 'caught' as string; });

      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }
      await resultP;

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toContain('Rate limit retries exhausted');
      expect(handler).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should reject all coalesced messages on retry exhaustion', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>()
        .mockRejectedValue(new Error('429'));

      let err1: Error | null = null;
      let err2: Error | null = null;
      const p1 = limiter.enqueue('a', undefined, handler)
        .catch((e: Error) => { err1 = e; return 'caught' as string; });
      const p2 = limiter.enqueue('b', undefined, handler)
        .catch((e: Error) => { err2 = e; return 'caught' as string; });

      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }
      await Promise.all([p1, p2]);

      expect(err1).not.toBeNull();
      expect(err1!.message).toContain('Rate limit retries exhausted');
      expect(err2).not.toBeNull();
      expect(err2!.message).toContain('Rate limit retries exhausted');
    });
  });

  describe('rate limiting (window enforcement)', () => {
    it('should track requests in window', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');

      expect(limiter.getRequestCountInWindow()).toBe(0);

      const p1 = limiter.enqueue('a', undefined, handler);
      await vi.advanceTimersByTimeAsync(100);
      await p1;
      expect(limiter.getRequestCountInWindow()).toBe(1);
    });
  });

  describe('reset', () => {
    it('should clear all state', async () => {
      const handler = vi.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');

      const p = limiter.enqueue('test', undefined, handler);
      await vi.advanceTimersByTimeAsync(100);
      await p;

      limiter.reset();
      expect(limiter.getQueueLength()).toBe(0);
      expect(limiter.isProcessing()).toBe(false);
      expect(limiter.getRequestCountInWindow()).toBe(0);
    });
  });
});
