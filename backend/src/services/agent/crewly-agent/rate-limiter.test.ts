import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { RateLimiter, RATE_LIMITER_DEFAULTS } from './rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter<string>;

  beforeEach(() => {
    jest.useFakeTimers();
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
    jest.useRealTimers();
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
      const handler = jest.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');
      const resultP = limiter.enqueue('hello', undefined, handler);
      await jest.advanceTimersByTimeAsync(100);
      const result = await resultP;
      expect(result).toBe('ok');
      expect(handler).toHaveBeenCalledWith('hello', undefined);
    });

    it('should pass metadata through', async () => {
      const handler = jest.fn<(msg: string, meta?: Record<string, string>) => Promise<string>>().mockResolvedValue('ok');
      const meta = { channelId: 'C1' };
      const resultP = limiter.enqueue('hello', meta, handler);
      await jest.advanceTimersByTimeAsync(100);
      await resultP;
      expect(handler).toHaveBeenCalledWith('hello', meta);
    });
  });

  describe('message coalescing', () => {
    it('should coalesce messages arriving within the coalesce window', async () => {
      const handler = jest.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');

      // Enqueue 3 messages rapidly (within 50ms coalesce window)
      const p1 = limiter.enqueue('msg1', undefined, handler);
      const p2 = limiter.enqueue('msg2', undefined, handler);
      const p3 = limiter.enqueue('msg3', undefined, handler);

      // Advance past coalesce window
      await jest.advanceTimersByTimeAsync(100);

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
      const handler = jest.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');

      const p = limiter.enqueue('single', undefined, handler);
      await jest.advanceTimersByTimeAsync(100);
      await p;

      expect(handler).toHaveBeenCalledWith('single', undefined);
    });
  });

  describe('429 retry', () => {
    it('should retry on quota exceeded error', async () => {
      const handler = jest.fn<(msg: string) => Promise<string>>()
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockResolvedValueOnce('recovered');

      const resultP = limiter.enqueue('test', undefined, handler);
      // Advance past coalesce window
      await jest.advanceTimersByTimeAsync(100);
      // Advance past backoff (100ms)
      await jest.advanceTimersByTimeAsync(200);
      const result = await resultP;

      expect(result).toBe('recovered');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should retry on quota exceeded message', async () => {
      const handler = jest.fn<(msg: string) => Promise<string>>()
        .mockRejectedValueOnce(new Error('You exceeded your current quota'))
        .mockResolvedValueOnce('ok');

      const resultP = limiter.enqueue('test', undefined, handler);
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);
      const result = await resultP;

      expect(result).toBe('ok');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should retry on RESOURCE_EXHAUSTED', async () => {
      const handler = jest.fn<(msg: string) => Promise<string>>()
        .mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED: quota limit reached'))
        .mockResolvedValueOnce('ok');

      const resultP = limiter.enqueue('test', undefined, handler);
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);
      const result = await resultP;

      expect(result).toBe('ok');
    });

    it('should NOT retry on non-quota errors', async () => {
      const handler = jest.fn<(msg: string) => Promise<string>>()
        .mockRejectedValue(new Error('Invalid API key'));

      // Attach catch immediately to prevent unhandled rejection warning
      let caughtError: Error | null = null;
      const resultP = limiter.enqueue('test', undefined, handler)
        .catch((e: Error) => { caughtError = e; return 'caught' as string; });

      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(100);
      }
      await resultP;

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toBe('Invalid API key');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should reject after max retries exhausted', async () => {
      const handler = jest.fn<(msg: string) => Promise<string>>()
        .mockRejectedValue(new Error('429 rate limited'));

      let caughtError: Error | null = null;
      const resultP = limiter.enqueue('test', undefined, handler)
        .catch((e: Error) => { caughtError = e; return 'caught' as string; });

      for (let i = 0; i < 20; i++) {
        await jest.advanceTimersByTimeAsync(200);
      }
      await resultP;

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toContain('Rate limit retries exhausted');
      expect(handler).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should reject all coalesced messages on retry exhaustion', async () => {
      const handler = jest.fn<(msg: string) => Promise<string>>()
        .mockRejectedValue(new Error('429'));

      let err1: Error | null = null;
      let err2: Error | null = null;
      const p1 = limiter.enqueue('a', undefined, handler)
        .catch((e: Error) => { err1 = e; return 'caught' as string; });
      const p2 = limiter.enqueue('b', undefined, handler)
        .catch((e: Error) => { err2 = e; return 'caught' as string; });

      for (let i = 0; i < 20; i++) {
        await jest.advanceTimersByTimeAsync(200);
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
      const handler = jest.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');

      expect(limiter.getRequestCountInWindow()).toBe(0);

      const p1 = limiter.enqueue('a', undefined, handler);
      await jest.advanceTimersByTimeAsync(100);
      await p1;
      expect(limiter.getRequestCountInWindow()).toBe(1);
    });
  });

  describe('consecutive messages (second-message-no-response bug)', () => {
    it('should process msg2 arriving while msg1 is in-flight', async () => {
      // Simulate: msg1 takes a long time (handler resolves after delay)
      let resolveMsg1!: (v: string) => void;
      const handler1 = jest.fn<(msg: string) => Promise<string>>()
        .mockImplementation(() => new Promise<string>((r) => { resolveMsg1 = r; }));
      const handler2 = jest.fn<(msg: string) => Promise<string>>()
        .mockResolvedValue('response2');

      // Enqueue msg1 — starts coalesce timer
      const p1 = limiter.enqueue('msg1', undefined, handler1);

      // Fire coalesce timer → processQueue starts with msg1
      await jest.advanceTimersByTimeAsync(100);
      expect(limiter.isProcessing()).toBe(true);

      // While msg1 is processing, enqueue msg2 with a DIFFERENT handler
      const p2 = limiter.enqueue('msg2', undefined, handler2);

      // msg2's coalesce timer fires — but processing=true, so it's a no-op.
      // The while-loop re-check in processQueue must pick msg2 up.
      await jest.advanceTimersByTimeAsync(100);

      // msg1 still processing
      expect(limiter.isProcessing()).toBe(true);

      // Now resolve msg1's handler
      resolveMsg1('response1');
      await jest.advanceTimersByTimeAsync(0);

      const result1 = await p1;
      expect(result1).toBe('response1');
      expect(handler1).toHaveBeenCalledTimes(1);

      // processQueue's while loop should pick up msg2 and use handler2
      await jest.advanceTimersByTimeAsync(0);
      const result2 = await p2;
      expect(result2).toBe('response2');
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledWith('msg2', undefined);
    });

    it('should process msg2 arriving after msg1 completes', async () => {
      const handler1 = jest.fn<(msg: string) => Promise<string>>().mockResolvedValue('r1');
      const handler2 = jest.fn<(msg: string) => Promise<string>>().mockResolvedValue('r2');

      // Process msg1 fully
      const p1 = limiter.enqueue('msg1', undefined, handler1);
      await jest.advanceTimersByTimeAsync(100);
      const r1 = await p1;
      expect(r1).toBe('r1');
      expect(limiter.isProcessing()).toBe(false);

      // Now enqueue msg2 — should start its own processQueue cycle
      const p2 = limiter.enqueue('msg2', undefined, handler2);
      await jest.advanceTimersByTimeAsync(100);
      const r2 = await p2;
      expect(r2).toBe('r2');
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledWith('msg2', undefined);
    });

    it('should use each messages own handler, not a stale closure', async () => {
      // This tests the handler-per-message fix: when the while-loop
      // processes msg2 during msg1's processQueue cycle, msg2's handler
      // must be used (not msg1's handler).
      const capturedContexts: string[] = [];

      let resolveMsg1!: (v: string) => void;
      const handler1 = jest.fn<(msg: string) => Promise<string>>()
        .mockImplementation((msg) => {
          capturedContexts.push(`handler1:${msg}`);
          return new Promise<string>((r) => { resolveMsg1 = r; });
        });
      const handler2 = jest.fn<(msg: string) => Promise<string>>()
        .mockImplementation((msg) => {
          capturedContexts.push(`handler2:${msg}`);
          return Promise.resolve('r2');
        });

      const p1 = limiter.enqueue('msg1', undefined, handler1);
      await jest.advanceTimersByTimeAsync(100);

      // msg1 is processing — enqueue msg2 with different handler
      const p2 = limiter.enqueue('msg2', undefined, handler2);
      await jest.advanceTimersByTimeAsync(100);

      // Complete msg1
      resolveMsg1('r1');
      await jest.advanceTimersByTimeAsync(0);
      await p1;
      await jest.advanceTimersByTimeAsync(0);
      await p2;

      // handler2 should have been called for msg2, NOT handler1
      expect(capturedContexts).toEqual([
        'handler1:msg1',
        'handler2:msg2',
      ]);
    });

    it('should handle 3+ consecutive messages in rapid succession', async () => {
      const results: string[] = [];
      const handlers = [1, 2, 3].map(i =>
        jest.fn<(msg: string) => Promise<string>>().mockImplementation(async () => {
          const r = `response${i}`;
          results.push(r);
          return r;
        })
      );

      // Enqueue 3 messages rapidly (within coalesce window)
      const p1 = limiter.enqueue('m1', undefined, handlers[0]);
      const p2 = limiter.enqueue('m2', undefined, handlers[1]);
      const p3 = limiter.enqueue('m3', undefined, handlers[2]);

      await jest.advanceTimersByTimeAsync(100);
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      // All coalesced into one call — handler3 (most recent) is used
      expect(handlers[2]).toHaveBeenCalledTimes(1);
      // All get the same result from the coalesced call
      expect(r1).toBe('response3');
      expect(r2).toBe('response3');
      expect(r3).toBe('response3');
    });

    it('should process msg2 via finally re-check when timer fires during processing', async () => {
      // Scenario: msg1 processing, msg2 enqueued, msg2 timer fires (processing=true),
      // msg1 finishes, while loop exits (queue had msg2 so processes it).
      // If msg2 arrives AFTER while loop's last check: finally re-check catches it.
      let resolveMsg1!: (v: string) => void;
      const handler1 = jest.fn<(msg: string) => Promise<string>>()
        .mockImplementation(() => new Promise<string>((r) => { resolveMsg1 = r; }));
      const handler2 = jest.fn<(msg: string) => Promise<string>>()
        .mockResolvedValue('r2');

      const p1 = limiter.enqueue('msg1', undefined, handler1);
      await jest.advanceTimersByTimeAsync(100);
      expect(limiter.isProcessing()).toBe(true);

      // Resolve msg1 but DON'T advance timers yet — msg2 not enqueued
      resolveMsg1('r1');
      // Let microtasks resolve (processQueue while loop exits, queue empty)
      await jest.advanceTimersByTimeAsync(0);
      await p1;

      // Now msg1 done, processing should be false
      expect(limiter.isProcessing()).toBe(false);

      // Enqueue msg2 — new coalesce timer
      const p2 = limiter.enqueue('msg2', undefined, handler2);
      // Fire msg2's coalesce timer
      await jest.advanceTimersByTimeAsync(100);
      const r2 = await p2;
      expect(r2).toBe('r2');
      expect(handler2).toHaveBeenCalledWith('msg2', undefined);
    });

    it('should preserve metadata per-message when processed individually', async () => {
      let resolveMsg1!: (v: string) => void;
      const handler = jest.fn<(msg: string, meta?: Record<string, string>) => Promise<string>>()
        .mockImplementationOnce(() => new Promise<string>((r) => { resolveMsg1 = r; }))
        .mockResolvedValueOnce('r2');

      const meta1 = { convId: 'conv1' };
      const meta2 = { convId: 'conv2' };

      const p1 = limiter.enqueue('msg1', meta1, handler);
      await jest.advanceTimersByTimeAsync(100);

      const p2 = limiter.enqueue('msg2', meta2, handler);
      await jest.advanceTimersByTimeAsync(100);

      resolveMsg1('r1');
      await jest.advanceTimersByTimeAsync(0);
      await p1;
      await jest.advanceTimersByTimeAsync(0);
      await p2;

      // msg1 processed with meta1, msg2 processed with meta2
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0]).toEqual(['msg1', meta1]);
      expect(handler.mock.calls[1]).toEqual(['msg2', meta2]);
    });
  });

  describe('reset', () => {
    it('should clear all state', async () => {
      const handler = jest.fn<(msg: string) => Promise<string>>().mockResolvedValue('ok');

      const p = limiter.enqueue('test', undefined, handler);
      await jest.advanceTimersByTimeAsync(100);
      await p;

      limiter.reset();
      expect(limiter.getQueueLength()).toBe(0);
      expect(limiter.isProcessing()).toBe(false);
      expect(limiter.getRequestCountInWindow()).toBe(0);
    });
  });
});
