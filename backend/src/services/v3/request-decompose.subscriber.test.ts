/**
 * RequestDecomposeSubscriber unit tests.
 *
 * Covers the filter rules, plan() invocation, and addToPool fan-out in
 * isolation from real services. Integration coverage (real bus, real
 * RequestService, real TaskPoolService, fs-backed) lives in
 * `request-decompose-auto.integration.test.ts`.
 *
 * @module services/v3/request-decompose.subscriber.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import {
  RequestDecomposeSubscriber,
  ACTIONABLE_INTENT_CATEGORIES,
  setRequestDecomposeSubscriber,
  getRequestDecomposeSubscriber,
} from './request-decompose.subscriber.js';
import type { RequestService } from './request.service.js';
import type { TaskPoolService } from '../task-pool/task-pool.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { Request, IntentCategory, IntentLevel } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { AgentEvent } from '../../types/event-bus.types.js';
import type { ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Build a minimal in-memory RequestService fake. Only the methods the
 * subscriber actually calls are implemented.
 */
function makeFakeRequestService(seed: Map<string, Request>): RequestService {
  const planMock = jest.fn(async (message: string) => {
    if (!message || message.length < 10) {
      return { message, tasks: [], reasoning: 'too short', strategy: 'none' as const };
    }
    return {
      message,
      tasks: [
        {
          title: 'Task A',
          description: 'do A',
          acceptanceCriteria: ['A done'],
          priority: 'high' as const,
        },
        {
          title: 'Task B',
          description: 'do B',
          acceptanceCriteria: ['B done'],
          priority: 'medium' as const,
        },
      ],
      reasoning: '2-task plan',
      strategy: 'build' as const,
    };
  });
  const fake = {
    getById: async (id: string) => seed.get(id) ?? null,
    plan: planMock,
  } as unknown as RequestService;
  // Surface the mock for assertion
  (fake as unknown as { planMock: typeof planMock }).planMock = planMock;
  return fake;
}

function makeFakeTaskPool(): TaskPoolService {
  const queued: WorkItem[] = [];
  const addMock = jest.fn(async (wi: WorkItem) => {
    queued.push(wi);
  });
  const fake = {
    addToPool: addMock,
  } as unknown as TaskPoolService;
  (fake as unknown as { queued: WorkItem[]; addMock: typeof addMock }).queued = queued;
  (fake as unknown as { addMock: typeof addMock }).addMock = addMock;
  return fake;
}

interface BusListenerEntry {
  eventType: string;
  handler: (e: AgentEvent) => void;
}

function makeFakeEventBus(): EventBusService {
  const listeners: BusListenerEntry[] = [];
  const fake = {
    onInProcess: (eventType: string, handler: (e: AgentEvent) => void) => {
      const entry: BusListenerEntry = { eventType, handler };
      listeners.push(entry);
      return () => {
        const idx = listeners.indexOf(entry);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  } as unknown as EventBusService;
  (fake as unknown as { listeners: BusListenerEntry[] }).listeners = listeners;
  return fake;
}

const SILENT_LOGGER: ComponentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as ComponentLogger;

function makeRequest(overrides: Partial<Request> = {}): Request {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `req-${Math.random().toString(36).slice(2, 10)}`,
    sourceConversationItemId: overrides.sourceConversationItemId ?? 'slack-CTEST-1.000001',
    title: overrides.title ?? 'test request',
    description:
      overrides.description ??
      'Build a feature that does X end to end with tests and acceptance criteria',
    status: overrides.status ?? 'open',
    priority: overrides.priority ?? 'normal',
    requiresConfirmation: overrides.requiresConfirmation ?? false,
    workItemIds: overrides.workItemIds ?? [],
    intentLevel: (overrides.intentLevel ?? 'L2') as IntentLevel,
    intentCategory: (overrides.intentCategory ?? 'code_change') as IntentCategory,
    tags: overrides.tags ?? ['slack'],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RequestDecomposeSubscriber', () => {
  let bus: EventBusService;
  let requestService: RequestService;
  let taskPool: TaskPoolService;
  let subscriber: RequestDecomposeSubscriber;
  let seed: Map<string, Request>;

  beforeEach(() => {
    seed = new Map<string, Request>();
    bus = makeFakeEventBus();
    requestService = makeFakeRequestService(seed);
    taskPool = makeFakeTaskPool();
    subscriber = new RequestDecomposeSubscriber({
      eventBus: bus,
      requestService,
      taskPool,
      logger: SILENT_LOGGER,
    });
  });

  // -------------------------------------------------------------------------

  describe('filter rules', () => {
    it.each<[string, Partial<Request>]>([
      ['intentLevel L0', { intentLevel: 'L0' as IntentLevel }],
      ['intentLevel L1', { intentLevel: 'L1' as IntentLevel }],
      ['intentCategory communication', { intentCategory: 'communication' as IntentCategory }],
      ['intentCategory query', { intentCategory: 'query' as IntentCategory }],
      ['intentCategory other', { intentCategory: 'other' as IntentCategory }],
      ['intentCategory review', { intentCategory: 'review' as IntentCategory }],
    ])('skips when %s', async (_label, overrides) => {
      const r = makeRequest(overrides);
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();
      expect((taskPool as unknown as { addMock: jest.Mock }).addMock).not.toHaveBeenCalled();
    });

    it.each<[IntentCategory]>([
      ['planning'],
      ['code_change'],
      ['debugging'],
      ['deployment'],
      ['research'],
    ])('decomposes when intentCategory = %s', async (intentCategory) => {
      const r = makeRequest({ intentCategory });
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();
      expect((taskPool as unknown as { addMock: jest.Mock }).addMock).toHaveBeenCalledTimes(2);
    });

    it('skips when Request already has linked WorkItems', async () => {
      const r = makeRequest({ workItemIds: ['existing-wi-1'] });
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();
      expect((taskPool as unknown as { addMock: jest.Mock }).addMock).not.toHaveBeenCalled();
    });

    it('skips when Request not found in storage', async () => {
      // Don't seed — getById returns null
      subscriber.start();
      await deliverRequestCreated(bus, 'nonexistent-req-id');
      await subscriber.flushPending();
      expect((taskPool as unknown as { addMock: jest.Mock }).addMock).not.toHaveBeenCalled();
    });

    it('skips when event has no requestId', async () => {
      subscriber.start();
      const listeners = (bus as unknown as { listeners: BusListenerEntry[] }).listeners;
      const handler = listeners.find((l) => l.eventType === 'request:created')?.handler;
      expect(handler).toBeDefined();
      await handler!({ id: 'evt-1', type: 'request:created' } as AgentEvent);
      await subscriber.flushPending();
      expect((taskPool as unknown as { addMock: jest.Mock }).addMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('plan invocation', () => {
    it('calls plan() with the Request description and queues each task', async () => {
      const r = makeRequest();
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();

      const planMock = (requestService as unknown as { planMock: jest.Mock }).planMock;
      expect(planMock).toHaveBeenCalledWith(r.description);

      const queued = (taskPool as unknown as { queued: WorkItem[] }).queued;
      expect(queued).toHaveLength(2);
      // Each WI carries the parent Request id — this is what the L4 fix in
      // request-sla.subscriber.ts:1153 keys on for the workItemIds[] link.
      expect(queued[0].requestId).toBe(r.id);
      expect(queued[1].requestId).toBe(r.id);
      // Owner = orchestrator (orc-pickup pattern, mirrors break-down-request skill).
      expect(queued[0].owner).toBe('orchestrator');
      // No preset target — orc fan-out decides.
      expect(queued[0].target).toBeUndefined();
      // Type = delegate (canonical decomposition output).
      expect(queued[0].type).toBe('delegate');
    });

    it('skips when plan returns 0 tasks (strategy=none)', async () => {
      // Description shorter than the 10-char threshold in our fake → empty plan
      const r = makeRequest({ description: 'short' });
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();
      expect((taskPool as unknown as { addMock: jest.Mock }).addMock).not.toHaveBeenCalled();
    });

    it('encodes acceptanceCriteria into the WI description so the agent sees them inline', async () => {
      const r = makeRequest();
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();

      const queued = (taskPool as unknown as { queued: WorkItem[] }).queued;
      expect(queued[0].description).toContain('Acceptance criteria:');
      expect(queued[0].description).toContain('- A done');
    });

    it('stamps autoDecomposed=true on the WorkItem metadata', async () => {
      const r = makeRequest();
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();

      const queued = (taskPool as unknown as { queued: WorkItem[] }).queued;
      expect(queued[0].metadata).toMatchObject({ autoDecomposed: true });
    });
  });

  // -------------------------------------------------------------------------

  describe('redelivery idempotence', () => {
    it('does not double-add when the same request:created event fires twice', async () => {
      const r = makeRequest();
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();

      // Two events delivered; addToPool called only twice (once per task,
      // once total — NOT four times).
      expect((taskPool as unknown as { addMock: jest.Mock }).addMock).toHaveBeenCalledTimes(2);
    });

    it('marks even no-op (empty plan) Requests as processed so redelivery does not re-attempt plan()', async () => {
      const r = makeRequest({ description: 'short' });
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();

      const planMock = (requestService as unknown as { planMock: jest.Mock }).planMock;
      // First delivery calls plan() and returns 0 tasks. Second delivery
      // hits the dedupe set and returns BEFORE calling plan() again.
      expect(planMock).toHaveBeenCalledTimes(1);
    });

    it('exposes processed Request IDs via the snapshot accessor', async () => {
      const r = makeRequest();
      seed.set(r.id, r);
      subscriber.start();
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();
      expect(subscriber.getDecomposedRequestIdsSnapshot().has(r.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('start() is idempotent — second call does not double-subscribe', () => {
      subscriber.start();
      subscriber.start();
      const listeners = (bus as unknown as { listeners: BusListenerEntry[] }).listeners;
      // 1 event type → 1 listener even after 2 start() calls
      expect(listeners.filter((l) => l.eventType === 'request:created')).toHaveLength(1);
    });

    it('stop() detaches listeners so the bus has no remaining handler', () => {
      subscriber.start();
      const listeners = (bus as unknown as { listeners: BusListenerEntry[] }).listeners;
      expect(listeners.filter((l) => l.eventType === 'request:created')).toHaveLength(1);
      subscriber.stop();
      expect(listeners.filter((l) => l.eventType === 'request:created')).toHaveLength(0);
    });

    it('handler exception is isolated and logged (does not crash the bus)', async () => {
      const r = makeRequest();
      seed.set(r.id, r);
      // Force plan() to throw
      const planMock = (requestService as unknown as { planMock: jest.Mock }).planMock;
      planMock.mockImplementationOnce(async () => {
        throw new Error('plan boom');
      });
      subscriber.start();
      // Should NOT throw out of dispatch.
      await deliverRequestCreated(bus, r.id);
      await subscriber.flushPending();
      // No WIs queued because plan() threw.
      expect((taskPool as unknown as { addMock: jest.Mock }).addMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('module-level setter / getter', () => {
    it('round-trips through setRequestDecomposeSubscriber / getRequestDecomposeSubscriber', () => {
      expect(getRequestDecomposeSubscriber()).toBeNull();
      setRequestDecomposeSubscriber(subscriber);
      expect(getRequestDecomposeSubscriber()).toBe(subscriber);
      setRequestDecomposeSubscriber(null);
      expect(getRequestDecomposeSubscriber()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe('exported constants', () => {
    it('ACTIONABLE_INTENT_CATEGORIES is the documented set', () => {
      expect(Array.from(ACTIONABLE_INTENT_CATEGORIES).sort()).toEqual(
        ['code_change', 'debugging', 'deployment', 'planning', 'research'].sort(),
      );
    });

    it('does NOT include team_management (which is not a valid IntentCategory)', () => {
      // Pin the spec-vs-codebase reframe: the brief originally listed
      // team_management as actionable but it is not in IntentCategory.
      expect(ACTIONABLE_INTENT_CATEGORIES).not.toContain('team_management' as IntentCategory);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drive a `request:created` event through the fake bus to the listener.
 *
 * @param bus - The fake event bus
 * @param requestId - The Request id to encode in the event
 */
async function deliverRequestCreated(
  bus: EventBusService,
  requestId: string,
): Promise<void> {
  const listeners = (bus as unknown as { listeners: BusListenerEntry[] }).listeners;
  const handler = listeners.find((l) => l.eventType === 'request:created')?.handler;
  if (!handler) throw new Error('no listener for request:created');
  await handler({
    id: `evt-${requestId}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'request:created',
    requestId,
  } as AgentEvent);
}
