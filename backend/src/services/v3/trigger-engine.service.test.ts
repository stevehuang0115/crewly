/**
 * Tests for TriggerEngine Service
 *
 * @module services/v3/trigger-engine.service.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TriggerEngine } from './trigger-engine.service.js';
import type { CreateTriggerInput, Trigger, TriggerAction } from '../../types/v2/index.js';
import { DEFAULT_MAX_IDLE_FIRES } from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  },
}));

vi.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWriteJson: vi.fn().mockResolvedValue(undefined),
  safeReadJson: vi.fn().mockResolvedValue([]),
}));

vi.mock('../workflow/cron-task.service.js', () => ({
  getNextRunTime: vi.fn().mockReturnValue(new Date(Date.now() + 60_000).toISOString()),
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
  const listeners = new Map<string, Function[]>();
  return {
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
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
    vi.restoreAllMocks();
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
      const handler = vi.fn().mockResolvedValue(undefined);
      engine.setActionHandler(handler);

      const trigger = await engine.create(makeCronTriggerInput());
      await engine.fire(trigger);

      expect(handler).toHaveBeenCalledWith(trigger, trigger.action);
    });

    it('handles action handler errors gracefully', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('boom'));
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
      const handler = vi.fn().mockResolvedValue(undefined);
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
      const handler = vi.fn().mockResolvedValue(undefined);
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
      const handler = vi.fn().mockResolvedValue(undefined);
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
      const handler = vi.fn().mockResolvedValue(undefined);
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
      const handler = vi.fn().mockResolvedValue(undefined);
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
      const handler = vi.fn().mockResolvedValue(undefined);
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
      const handler = vi.fn().mockResolvedValue(undefined);

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
});
