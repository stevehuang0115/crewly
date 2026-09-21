/**
 * Tests for TriggerEngine Service
 *
 * @module services/v3/trigger-engine.service.test
 */

// Runner: jest (root jest.config.js). Ported from vitest syntax — the suite
// could not be collected under CommonJS ("Vitest cannot be imported"), so it
// had never actually run in CI.
import { TriggerEngine } from './trigger-engine.service.js';
import type { CreateTriggerInput, Trigger } from '../../types/v2/index.js';
import { DEFAULT_MAX_IDLE_FIRES } from '../../types/v2/index.js';
import * as fs from 'fs/promises';
import { TRIGGER_ENGINE_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

jest.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  // atomicWriteJson / safeReadJson no longer used by trigger-engine after B1,
  // but kept here for any indirect imports.
  atomicWriteJson: jest.fn().mockResolvedValue(undefined),
  safeReadJson: jest.fn().mockResolvedValue([]),
}));

// B1: trigger-engine now uses atomicWriteJsonWithGuard for persistTriggers
// and reads via fs/promises directly in readTriggersFromDisk. Both are mocked
// here so unit tests remain pure (real-fs coverage is in
// trigger-engine-persistence.integration.test.ts).
jest.mock('../../utils/integrity-guarded-write.utils.js', () => {
  return {
    atomicWriteJsonWithGuard: jest.fn().mockResolvedValue(undefined),
    IntegrityViolationError: class IntegrityViolationError extends Error {
      readonly path: string;
      readonly prevCount: number;
      readonly nextCount: number;
      readonly reason: 'collapse-to-empty' | 'decrease-exceeds-threshold';
      constructor(message: string, details: { path: string; prevCount: number; nextCount: number; reason: 'collapse-to-empty' | 'decrease-exceeds-threshold' }) {
        super(message);
        this.name = 'IntegrityViolationError';
        this.path = details.path;
        this.prevCount = details.prevCount;
        this.nextCount = details.nextCount;
        this.reason = details.reason;
      }
    },
  };
});

jest.mock('fs/promises', () => {
  const actual = jest.requireActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    // Default: ENOENT (no prior triggers file) so loadTriggers returns []
    // exactly like the prior safeReadJson([]) default. Tests that need the
    // file to exist override this via jest.mocked(fs.readFile).mockResolvedValue.
    readFile: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    copyFile: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../workflow/cron-task.service.js', () => ({
  getNextRunTime: jest.fn().mockReturnValue(new Date(Date.now() + 60_000).toISOString()),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a valid time trigger input with cron expression.
 */
function makeCronTriggerInput(overrides?: Partial<CreateTriggerInput>): CreateTriggerInput {
  return {
    type: 'time',
    config: { type: 'time', cronExpression: '0 9 * * 1' },
    action: { runReconciler: true },
    createdBy: 'system',
    ...overrides,
  };
}

/**
 * Creates a valid signal trigger input.
 */
function makeSignalTriggerInput(overrides?: Partial<CreateTriggerInput>): CreateTriggerInput {
  return {
    type: 'signal',
    config: { type: 'signal', eventType: 'agent:idle' },
    action: { sendMessage: { target: 'crewly-orc', message: 'Agent is idle' } },
    createdBy: 'orchestrator',
    ...overrides,
  };
}

/**
 * Creates a mock EventBus.
 */
function makeMockEventBus() {
  type Handler = (...args: unknown[]) => unknown;
  const listeners = new Map<string, Handler[]>();
  return {
    on: jest.fn((event: string, handler: Handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    // Pre-existing bug: original mock missed `off`, which TriggerEngine.stop()
    // calls during teardownSignalListeners(). Without it, every test that
    // set an EventBus and then ran the afterEach resetInstance() would
    // throw on stop. Added here as part of B1 cleanup.
    off: jest.fn((event: string, handler: Handler) => {
      const handlers = listeners.get(event);
      if (!handlers) return;
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }),
    emit: (event: string, data: unknown) => {
      const handlers = listeners.get(event) || [];
      for (const h of handlers) h(data);
    },
    _listeners: listeners,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TriggerEngine', () => {
  let engine: TriggerEngine;

  beforeEach(() => {
    TriggerEngine.resetInstance();
    engine = TriggerEngine.getInstance('/tmp/test-project');
  });

  afterEach(() => {
    TriggerEngine.resetInstance();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  describe('singleton', () => {
    it('returns the same instance on subsequent calls', () => {
      const a = TriggerEngine.getInstance('/tmp/test-project');
      const b = TriggerEngine.getInstance();
      expect(a).toBe(b);
    });

    it('resets the instance', () => {
      const a = TriggerEngine.getInstance('/tmp/test-project');
      TriggerEngine.resetInstance();
      const b = TriggerEngine.getInstance('/tmp/test-project2');
      expect(a).not.toBe(b);
    });
  });

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('creates a time trigger with defaults', async () => {
      const trigger = await engine.create(makeCronTriggerInput());

      expect(trigger.id).toBeDefined();
      expect(trigger.type).toBe('time');
      expect(trigger.status).toBe('active');
      expect(trigger.fireCount).toBe(0);
      expect(trigger.maxIdleFires).toBe(DEFAULT_MAX_IDLE_FIRES);
      expect(trigger.consecutiveIdleFires).toBe(0);
    });

    it('creates a signal trigger', async () => {
      const trigger = await engine.create(makeSignalTriggerInput());
      expect(trigger.type).toBe('signal');
      expect(trigger.config.type).toBe('signal');
    });

    it('respects custom maxFires', async () => {
      const trigger = await engine.create(makeCronTriggerInput({ maxFires: 5 }));
      expect(trigger.maxFires).toBe(5);
    });

    it('respects custom maxIdleFires', async () => {
      const trigger = await engine.create(makeCronTriggerInput({ maxIdleFires: 10 }));
      expect(trigger.maxIdleFires).toBe(10);
    });

    it('throws on invalid input', async () => {
      await expect(
        engine.create({ type: 'time', config: { type: 'time' } as any, action: {} as any, createdBy: 'system' }),
      ).rejects.toThrow('Invalid trigger input');
    });
  });

  describe('get', () => {
    it('returns undefined for unknown ID', () => {
      expect(engine.get('nonexistent')).toBeUndefined();
    });

    it('returns the trigger by ID', async () => {
      const created = await engine.create(makeCronTriggerInput());
      const found = engine.get(created.id);
      expect(found).toBe(created);
    });
  });

  describe('list', () => {
    it('returns all triggers', async () => {
      await engine.create(makeCronTriggerInput());
      await engine.create(makeSignalTriggerInput());
      expect(engine.list()).toHaveLength(2);
    });

    it('filters by status', async () => {
      await engine.create(makeCronTriggerInput());
      const t2 = await engine.create(makeSignalTriggerInput());
      await engine.pause(t2.id);
      expect(engine.list('active')).toHaveLength(1);
      expect(engine.list('paused')).toHaveLength(1);
    });
  });

  describe('pause / resume', () => {
    it('pauses an active trigger', async () => {
      const trigger = await engine.create(makeCronTriggerInput());
      const result = await engine.pause(trigger.id);
      expect(result).toBe(true);
      expect(engine.get(trigger.id)!.status).toBe('paused');
    });

    it('resumes a paused trigger', async () => {
      const trigger = await engine.create(makeCronTriggerInput());
      await engine.pause(trigger.id);
      const result = await engine.resume(trigger.id);
      expect(result).toBe(true);
      expect(engine.get(trigger.id)!.status).toBe('active');
    });

    it('returns false when pausing a non-active trigger', async () => {
      const trigger = await engine.create(makeCronTriggerInput());
      await engine.cancel(trigger.id);
      expect(await engine.pause(trigger.id)).toBe(false);
    });

    it('returns false when resuming a non-paused trigger', async () => {
      const trigger = await engine.create(makeCronTriggerInput());
      expect(await engine.resume(trigger.id)).toBe(false);
    });
  });

  describe('cancel', () => {
    it('cancels an active trigger', async () => {
      const trigger = await engine.create(makeCronTriggerInput());
      const result = await engine.cancel(trigger.id);
      expect(result).toBe(true);
      expect(engine.get(trigger.id)!.status).toBe('cancelled');
    });

    it('returns false for already cancelled trigger', async () => {
      const trigger = await engine.create(makeCronTriggerInput());
      await engine.cancel(trigger.id);
      expect(await engine.cancel(trigger.id)).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes a trigger', async () => {
      const trigger = await engine.create(makeCronTriggerInput());
      const result = await engine.delete(trigger.id);
      expect(result).toBe(true);
      expect(engine.get(trigger.id)).toBeUndefined();
      expect(engine.list()).toHaveLength(0);
    });

    it('returns false for unknown trigger', async () => {
      expect(await engine.delete('nonexistent')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Fire Logic
  // -------------------------------------------------------------------------

  describe('fire', () => {
    it('increments fireCount and sets lastFiredAt', async () => {
      const trigger = await engine.create(makeCronTriggerInput());
      const result = await engine.fire(trigger);

      expect(result.productive).toBe(true);
      expect(result.triggerId).toBe(trigger.id);
      expect(trigger.fireCount).toBe(1);
      expect(trigger.lastFiredAt).toBeDefined();
    });

    it('calls action handler on fire', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      engine.setActionHandler(handler);

      const trigger = await engine.create(makeCronTriggerInput());
      await engine.fire(trigger);

      expect(handler).toHaveBeenCalledWith(trigger, trigger.action);
    });

    it('handles action handler errors gracefully', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('boom'));
      engine.setActionHandler(handler);

      const trigger = await engine.create(makeCronTriggerInput());
      // Should not throw
      const result = await engine.fire(trigger);
      expect(result.triggerId).toBe(trigger.id);
    });

    it('exhausts trigger when maxFires reached', async () => {
      const trigger = await engine.create(makeCronTriggerInput({ maxFires: 2 }));

      await engine.fire(trigger);
      expect(trigger.status).toBe('active');
      expect(trigger.fireCount).toBe(1);

      await engine.fire(trigger);
      expect(trigger.status).toBe('exhausted');
      expect(trigger.fireCount).toBe(2);
    });

    it('cancels trigger when maxIdleFires reached', async () => {
      const trigger = await engine.create(makeCronTriggerInput({ maxIdleFires: 2 }));

      await engine.fire(trigger, false); // idle fire 1
      expect(trigger.consecutiveIdleFires).toBe(1);
      expect(trigger.status).toBe('active');

      await engine.fire(trigger, false); // idle fire 2
      expect(trigger.consecutiveIdleFires).toBe(2);
      expect(trigger.status).toBe('cancelled');
    });

    it('resets consecutiveIdleFires on productive fire', async () => {
      const trigger = await engine.create(makeCronTriggerInput({ maxIdleFires: 5 }));

      await engine.fire(trigger, false); // idle
      await engine.fire(trigger, false); // idle
      expect(trigger.consecutiveIdleFires).toBe(2);

      await engine.fire(trigger, true); // productive
      expect(trigger.consecutiveIdleFires).toBe(0);
    });

    it('does not fire non-active triggers', async () => {
      const trigger = await engine.create(makeCronTriggerInput());
      await engine.pause(trigger.id);

      const result = await engine.fire(trigger);
      expect(result.productive).toBe(false);
      expect(trigger.fireCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Signal Trigger Handling
  // -------------------------------------------------------------------------

  describe('handleSignalEvent', () => {
    it('fires matching signal triggers', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      engine.setActionHandler(handler);

      await engine.create(makeSignalTriggerInput());
      const results = await engine.handleSignalEvent({
        eventId: 'evt-1',
        eventType: 'agent:idle',
        sessionName: 'agent-joe',
      });

      expect(results).toHaveLength(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not fire non-matching signal triggers', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      engine.setActionHandler(handler);

      await engine.create(makeSignalTriggerInput());
      const results = await engine.handleSignalEvent({
        eventId: 'evt-1',
        eventType: 'task:completed',
        sessionName: 'agent-joe',
      });

      expect(results).toHaveLength(0);
      expect(handler).not.toHaveBeenCalled();
    });

    it('applies signal filter matching', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      engine.setActionHandler(handler);

      await engine.create({
        type: 'signal',
        config: {
          type: 'signal',
          eventType: 'agent:idle',
          filter: { sessionName: 'agent-joe' },
        },
        action: { runReconciler: true },
        createdBy: 'system',
      });

      // Matching sessionName
      const r1 = await engine.handleSignalEvent({
        eventId: 'evt-1',
        eventType: 'agent:idle',
        sessionName: 'agent-joe',
      });
      expect(r1).toHaveLength(1);

      // Non-matching sessionName — should NOT fire
      // Reset fire count by creating a new trigger
      TriggerEngine.resetInstance();
      const engine2 = TriggerEngine.getInstance('/tmp/test-project');
      engine2.setActionHandler(handler);

      await engine2.create({
        type: 'signal',
        config: {
          type: 'signal',
          eventType: 'agent:idle',
          filter: { sessionName: 'agent-bob' },
        },
        action: { runReconciler: true },
        createdBy: 'system',
      });

      const r2 = await engine2.handleSignalEvent({
        eventId: 'evt-2',
        eventType: 'agent:idle',
        sessionName: 'agent-joe',
      });
      expect(r2).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Compound Triggers
  // -------------------------------------------------------------------------

  describe('compound triggers', () => {
    it('fires on OR compound when any signal matches', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      engine.setActionHandler(handler);

      await engine.create({
        type: 'compound',
        config: {
          type: 'compound',
          operator: 'or',
          conditions: [
            { type: 'signal', eventType: 'agent:idle' },
            { type: 'signal', eventType: 'agent:busy' },
          ],
        },
        action: { runReconciler: true },
        createdBy: 'system',
      });

      const results = await engine.handleSignalEvent({
        eventId: 'evt-1',
        eventType: 'agent:busy',
        sessionName: 'agent-joe',
      });
      expect(results).toHaveLength(1);
    });

    it('fires on AND compound when all signal conditions match', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      engine.setActionHandler(handler);

      // AND with two conditions of the same eventType (both match)
      await engine.create({
        type: 'compound',
        config: {
          type: 'compound',
          operator: 'and',
          conditions: [
            { type: 'signal', eventType: 'agent:idle' },
            { type: 'signal', eventType: 'agent:idle' },
          ],
        },
        action: { runReconciler: true },
        createdBy: 'system',
      });

      const results = await engine.handleSignalEvent({
        eventId: 'evt-1',
        eventType: 'agent:idle',
        sessionName: 'agent-joe',
      });
      expect(results).toHaveLength(1);
    });

    it('does not fire AND compound when not all conditions match', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      engine.setActionHandler(handler);

      await engine.create({
        type: 'compound',
        config: {
          type: 'compound',
          operator: 'and',
          conditions: [
            { type: 'signal', eventType: 'agent:idle' },
            { type: 'signal', eventType: 'agent:busy' },
          ],
        },
        action: { runReconciler: true },
        createdBy: 'system',
      });

      const results = await engine.handleSignalEvent({
        eventId: 'evt-1',
        eventType: 'agent:idle',
        sessionName: 'agent-joe',
      });
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('start / stop', () => {
    it('starts and stops without errors', async () => {
      await engine.start();
      expect(engine.isRunning()).toBe(true);

      engine.stop();
      expect(engine.isRunning()).toBe(false);
    });

    it('is idempotent on double start', async () => {
      await engine.start();
      await engine.start(); // should not throw
      expect(engine.isRunning()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getStatus
  // -------------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns correct counts', async () => {
      await engine.create(makeCronTriggerInput());
      const t2 = await engine.create(makeSignalTriggerInput());
      await engine.pause(t2.id);

      const status = engine.getStatus();
      expect(status.total).toBe(2);
      expect(status.byStatus.active).toBe(1);
      expect(status.byStatus.paused).toBe(1);
      expect(status.byType.time).toBe(1);
      expect(status.byType.signal).toBe(1);
      expect(status.running).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // EventBus integration
  // -------------------------------------------------------------------------

  describe('EventBus integration', () => {
    it('registers listener on start when EventBus is set', async () => {
      const mockBus = makeMockEventBus();
      engine.setEventBus(mockBus as any);

      await engine.start();
      expect(mockBus.on).toHaveBeenCalledWith('event_published', expect.any(Function));
    });

    it('fires signal trigger via handleSignalEvent when event matches', async () => {
      const mockBus = makeMockEventBus();
      const handler = jest.fn().mockResolvedValue(undefined);

      engine.setEventBus(mockBus as any);
      engine.setActionHandler(handler);

      await engine.start();
      // Create trigger AFTER start so loadTriggers (from empty mock) doesn't clear it
      await engine.create(makeSignalTriggerInput());

      // Directly invoke handleSignalEvent (which is what the EventBus listener calls)
      const results = await engine.handleSignalEvent({
        eventId: 'evt-1',
        eventType: 'agent:idle',
        sessionName: 'agent-joe',
      });

      expect(results).toHaveLength(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
  // -------------------------------------------------------------------------
  // managedBy is carried through persistence (Request 1b5b879b)
  // -------------------------------------------------------------------------

  describe('managedBy persistence', () => {
    it('persists the explicit marker and the agent default verbatim', async () => {
      const { atomicWriteJsonWithGuard } = await import('../../utils/integrity-guarded-write.utils.js');
      const write = jest.mocked(atomicWriteJsonWithGuard);
      write.mockClear();

      await engine.create({ type: 'time', config: { type: 'time', delayMs: 60_000 }, action: { runReconciler: true }, createdBy: 'system', teamId: 't1', name: 'spec-a', managedBy: 'team-spec' });
      await engine.create({ type: 'time', config: { type: 'time', delayMs: 60_000 }, action: { runReconciler: true }, createdBy: 'system', teamId: 't1', name: 'followup:x' });

      expect(write).toHaveBeenCalled();
      const lastCall = write.mock.calls[write.mock.calls.length - 1];
      const rows = lastCall[1] as Trigger[];
      expect(rows.map((r) => [r.name, r.managedBy])).toEqual([
        ['spec-a', 'team-spec'],
        ['followup:x', 'agent'],
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // nextFireAt for one-shot triggers (D-B)
  // -------------------------------------------------------------------------

  describe('nextFireAt for one-shot triggers', () => {
    it('delayMs: nextFireAt is createdAt + delayMs (was undefined)', async () => {
      const trigger = await engine.create({
        type: 'time',
        config: { type: 'time', delayMs: 35_893 * 60_000 },
        action: { runReconciler: true },
        createdBy: 'user',
      });
      const expected = new Date(new Date(trigger.createdAt).getTime() + 35_893 * 60_000).toISOString();
      expect(trigger.nextFireAt).toBe(expected);
    });

    it('fireAt: nextFireAt is exactly the requested time', async () => {
      const fireAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const trigger = await engine.create({
        type: 'time',
        config: { type: 'time', fireAt },
        action: { runReconciler: true },
        createdBy: 'user',
      });
      expect(trigger.nextFireAt).toBe(fireAt);
      expect(trigger.status).toBe('active');
    });

    it('resume keeps the createdAt anchor for delayMs (does not re-base on now)', async () => {
      const trigger = await engine.create({
        type: 'time',
        config: { type: 'time', delayMs: 60_000 },
        action: { runReconciler: true },
        createdBy: 'user',
      });
      const before = trigger.nextFireAt;
      expect(before).toBeDefined();
      await engine.pause(trigger.id);
      await engine.resume(trigger.id);
      expect(trigger.nextFireAt).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // One-shot timers beyond the Node timer cap (D-A)
  //
  // Node clamps setTimeout delays above 2^31-1 ms to 1 ms (with a
  // TimeoutOverflowWarning). Before the fix every --fire-at / --in-minutes
  // more than ~24.85 days out fired the moment it was created. These tests
  // pin the chained-timer behaviour on all three scheduling paths.
  // -------------------------------------------------------------------------

  describe('one-shot timers beyond the Node timer cap', () => {
    const MAX = TRIGGER_ENGINE_CONSTANTS.MAX_TIMER_DELAY_MS;
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const T0 = new Date('2026-09-21T00:00:00.000Z');
    let handler: jest.Mock;
    /** Every delay handed to setTimeout while fake timers were installed. */
    let armedDelays: number[];
    let fakeSetTimeout: typeof setTimeout;

    /** Largest delay handed to setTimeout so far; refuses to answer over an empty set. */
    function maxArmedDelay(): number {
      expect(armedDelays.length).toBeGreaterThan(0); // the guard must have examined something
      return Math.max(...armedDelays);
    }

    /** Advances fake time and lets the fire() promise chain settle. */
    async function advance(ms: number): Promise<void> {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
    }

    beforeEach(async () => {
      jest.useFakeTimers({ now: T0 });
      // Record delays with a plain wrapper, NOT jest.spyOn: a spy created
      // while fake timers are installed saves the *fake* as its original, and
      // the outer afterEach's restoreAllMocks() re-applies that original after
      // useRealTimers() has already run — leaving a sinon fake as the global
      // setTimeout for every later test (they hang on any real timer).
      armedDelays = [];
      fakeSetTimeout = global.setTimeout;
      const recording = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (typeof ms === 'number') armedDelays.push(ms);
        return fakeSetTimeout(fn, ms, ...args);
      }) as unknown as typeof setTimeout;
      global.setTimeout = recording;
      handler = jest.fn().mockResolvedValue(undefined);
      engine.setActionHandler(handler);
      await engine.start();
    });

    afterEach(() => {
      engine.stop();
      global.setTimeout = fakeSetTimeout; // hand the fake back before sinon uninstalls it
      jest.useRealTimers();
    });

    it('fireAt 30 days out: no hop above the cap, no fire before target, exactly one fire at target', async () => {
      const fireAt = new Date(T0.getTime() + THIRTY_DAYS_MS).toISOString();
      const trigger = await engine.create({
        type: 'time',
        config: { type: 'time', fireAt },
        action: { runReconciler: true },
        createdBy: 'user',
        maxFires: 1,
      });

      await advance(THIRTY_DAYS_MS - 60_000);
      expect(trigger.fireCount).toBe(0);
      expect(trigger.status).toBe('active');
      expect(handler).not.toHaveBeenCalled();

      await advance(60_000);
      expect(trigger.fireCount).toBe(1);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(trigger.status).toBe('exhausted');

      await advance(THIRTY_DAYS_MS);
      expect(trigger.fireCount).toBe(1);

      expect(maxArmedDelay()).toBeLessThanOrEqual(MAX);
    });

    it('delayMs 30 days (createdAt-anchored): same guarantees', async () => {
      const trigger = await engine.create({
        type: 'time',
        config: { type: 'time', delayMs: THIRTY_DAYS_MS },
        action: { runReconciler: true },
        createdBy: 'user',
        maxFires: 1,
      });

      await advance(THIRTY_DAYS_MS - 60_000);
      expect(trigger.fireCount).toBe(0);

      await advance(60_000);
      expect(trigger.fireCount).toBe(1);
      expect(handler).toHaveBeenCalledTimes(1);

      await advance(THIRTY_DAYS_MS);
      expect(trigger.fireCount).toBe(1);

      expect(maxArmedDelay()).toBeLessThanOrEqual(MAX);
    });

    it('re-arms a persisted 30-day trigger on start() (restart path) without overflowing', async () => {
      const fireAt = new Date(T0.getTime() + THIRTY_DAYS_MS).toISOString();
      const created = await engine.create({
        type: 'time',
        config: { type: 'time', fireAt },
        action: { runReconciler: true },
        createdBy: 'user',
        maxFires: 1,
      });

      // Simulate a process restart: stop, then boot from the persisted file.
      engine.stop();
      jest.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify([created]));
      armedDelays.length = 0;
      await engine.start();

      const reloaded = engine.get(created.id) as Trigger;
      expect(reloaded).toBeDefined();
      expect(reloaded).not.toBe(created); // a fresh object from disk, not the in-memory one

      await advance(THIRTY_DAYS_MS - 60_000);
      expect(reloaded.fireCount).toBe(0);

      await advance(60_000);
      expect(reloaded.fireCount).toBe(1);
      expect(handler).toHaveBeenCalledTimes(1);

      expect(maxArmedDelay()).toBeLessThanOrEqual(MAX);
    });

    it('a 90-day wait hops more than once and still fires once, at the target', async () => {
      const NINETY_DAYS_MS = 3 * THIRTY_DAYS_MS;
      const trigger = await engine.create({
        type: 'time',
        config: { type: 'time', delayMs: NINETY_DAYS_MS },
        action: { runReconciler: true },
        createdBy: 'user',
        maxFires: 1,
      });

      await advance(NINETY_DAYS_MS - 1);
      expect(trigger.fireCount).toBe(0);
      await advance(1);
      expect(trigger.fireCount).toBe(1);

      const oneShotArms = armedDelays.filter((d) => d > 60_000);
      expect(oneShotArms.length).toBeGreaterThanOrEqual(4); // ceil(90d / 24.85d)
      expect(maxArmedDelay()).toBeLessThanOrEqual(MAX);
    });

    it('a hop does not re-arm a trigger that was cancelled mid-wait', async () => {
      const trigger = await engine.create({
        type: 'time',
        config: { type: 'time', delayMs: THIRTY_DAYS_MS },
        action: { runReconciler: true },
        createdBy: 'user',
      });

      await advance(MAX - 1000);
      await engine.cancel(trigger.id);
      await advance(THIRTY_DAYS_MS);

      expect(trigger.fireCount).toBe(0);
      expect(handler).not.toHaveBeenCalled();
    });

    it('an unparseable fireAt does not fire at all (previously fired after 1 ms)', async () => {
      const trigger = await engine.create({
        type: 'time',
        config: { type: 'time', fireAt: 'not-a-date' },
        action: { runReconciler: true },
        createdBy: 'user',
      });

      await advance(THIRTY_DAYS_MS);
      expect(trigger.fireCount).toBe(0);
    });
  });

  describe('one-shot timers under REAL timers', () => {
    afterEach(() => {
      engine.stop();
    });

    it('never hands setTimeout a delay Node would overflow', async () => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      engine.setActionHandler(jest.fn().mockResolvedValue(undefined));
      await engine.start();

      const fireAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const trigger = await engine.create({
        type: 'time',
        config: { type: 'time', fireAt },
        action: { runReconciler: true },
        createdBy: 'user',
      });

      // Give a would-be overflowed 1 ms timer every chance to fire.
      await new Promise((r) => setTimeout(r, 25));

      expect(trigger.fireCount).toBe(0);
      const delays = setTimeoutSpy.mock.calls
        .map((c) => c[1])
        .filter((d): d is number => typeof d === 'number' && d > 60_000);
      expect(delays.length).toBe(1); // exactly the one hop for this trigger
      expect(delays[0]).toBeLessThanOrEqual(TRIGGER_ENGINE_CONSTANTS.MAX_TIMER_DELAY_MS);
    });
  });
});
