/**
 * Unit tests for RequestCascadeSubscriber.
 *
 * Verifies the subscriber resolves requestId from event payload (or
 * by WI lookup when missing), routes through cascadeRequestStatus,
 * and never lets a single failed dispatch break the rest of the
 * subscription.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { RequestCascadeSubscriber } from './request-cascade.subscriber.js';
import type {
  CascadeRequestService,
  CascadeNotifier,
} from './cascade-request-status.js';
import type { CascadeSubscriberTaskPool } from './request-cascade.subscriber.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';

const SILENT_LOGGER = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'req-1',
    title: 'test',
    sourceConversationItemId: 'slack-CTEST-1707000000.000001',
    intentLevel: 'L2',
    intentCategory: 'planning',
    actionable: true,
    status: 'running',
    workItemIds: [],
    createdAt: '2026-05-09T01:00:00.000Z',
    updatedAt: '2026-05-09T01:00:00.000Z',
    ...overrides,
  } as Request;
}

function makeWI(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 'wi-1',
    title: 'test wi',
    description: '',
    status: 'queued',
    requestId: 'req-1',
    target: '',
    type: 'delegate',
    createdAt: '2026-05-09T01:00:00.000Z',
    updatedAt: '2026-05-09T01:00:00.000Z',
    ...overrides,
  } as WorkItem;
}

function makeEvent(opts: {
  type: EventType;
  workItemId?: string;
  requestId?: string;
}): AgentEvent {
  return {
    id: `${opts.type}:${opts.workItemId ?? 'x'}`,
    type: opts.type,
    timestamp: new Date().toISOString(),
    teamId: '',
    teamName: '',
    memberId: '',
    memberName: '',
    sessionName: '',
    previousValue: '',
    newValue: '',
    changedField: 'taskStatus',
    workItemId: opts.workItemId,
    requestId: opts.requestId,
  } as AgentEvent;
}

/**
 * Minimal in-memory EventBus stub. Keeps a Set of handlers per event
 * type; `publish` invokes each one. Mirrors the surface
 * RequestCascadeSubscriber uses (`onInProcess` + the unsubscribe
 * callback).
 */
function makeFakeBus() {
  const handlers = new Map<EventType, Set<(e: AgentEvent) => unknown>>();
  const bus = {
    onInProcess(types: EventType | EventType[], h: (e: AgentEvent) => unknown) {
      const arr = Array.isArray(types) ? types : [types];
      for (const t of arr) {
        let s = handlers.get(t);
        if (!s) {
          s = new Set();
          handlers.set(t, s);
        }
        s.add(h);
      }
      return () => {
        for (const t of arr) handlers.get(t)?.delete(h);
      };
    },
    publish(event: AgentEvent) {
      const set = handlers.get(event.type);
      if (!set) return;
      for (const h of set) h(event);
    },
  };
  return bus;
}

function makeFakeServices(opts: {
  request?: Request;
  pool?: WorkItem[];
} = {}) {
  const requestStore = new Map<string, Request>();
  if (opts.request) requestStore.set(opts.request.id, opts.request);
  const pool = opts.pool ?? [];
  const updates: Array<[string, Partial<Request>]> = [];

  const requestService: CascadeRequestService = {
    getById: async (id: string) => requestStore.get(id) ?? null,
    update: async (id: string, patch: Partial<Request>) => {
      updates.push([id, patch]);
      const existing = requestStore.get(id);
      if (existing) requestStore.set(id, { ...existing, ...patch } as Request);
      return null;
    },
  };

  const taskPool: CascadeSubscriberTaskPool = {
    findWorkItem: async (id: string) => pool.find((w) => w.id === id),
    getAllItems: async () => pool,
  };

  const notified: Array<{ event: string; payload: unknown }> = [];
  const notifier: CascadeNotifier = {
    emit: (e, p) => notified.push({ event: e, payload: p }),
  };

  return { requestService, taskPool, requestStore, updates, notified, notifier };
}

describe('RequestCascadeSubscriber', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('cascades on task:cancelled when event carries requestId directly', async () => {
    // The end-to-end flow we care about: task-pool publishes
    // task:cancelled with the requestId on the payload, subscriber
    // closes the Request without needing a pool re-lookup.
    const r = makeRequest({ status: 'ready' });
    const wis = [
      makeWI({ id: 'a', status: 'cancelled' }),
      makeWI({ id: 'b', status: 'cancelled' }),
    ];
    const services = makeFakeServices({ request: r, pool: wis });
    const bus = makeFakeBus();
    const sub = new RequestCascadeSubscriber({
      eventBus: bus as never,
      ...services,
      logger: SILENT_LOGGER as never,
    });
    sub.start();

    bus.publish(makeEvent({ type: 'task:cancelled', workItemId: 'a', requestId: 'req-1' }));
    await sub.flushPending();

    expect(services.updates).toEqual([['req-1', { status: 'cancelled' }]]);
    expect(services.requestStore.get('req-1')!.status).toBe('cancelled');
  });

  it('cascades on task:cancelled via WI lookup when event lacks requestId', async () => {
    // Older / hand-fired emitters don't always set requestId. The
    // subscriber must fall back to findWorkItem to resolve it.
    const r = makeRequest({ status: 'ready' });
    const wis = [makeWI({ id: 'orphan', status: 'cancelled', requestId: 'req-1' })];
    const services = makeFakeServices({ request: r, pool: wis });
    const bus = makeFakeBus();
    const sub = new RequestCascadeSubscriber({
      eventBus: bus as never,
      ...services,
      logger: SILENT_LOGGER as never,
    });
    sub.start();

    bus.publish(makeEvent({ type: 'task:cancelled', workItemId: 'orphan' })); // no requestId
    await sub.flushPending();

    expect(services.updates).toEqual([['req-1', { status: 'cancelled' }]]);
  });

  it('cascades on task:done_by_worker (closes Request when all children done)', async () => {
    // Live wiring of the success path — proves the subscriber doesn't
    // ONLY handle cancellation. After the last child reports done,
    // the Request closes automatically.
    const r = makeRequest({ status: 'running' });
    const wis = [
      makeWI({ id: 'a', status: 'done' }),
      makeWI({ id: 'b', status: 'done_by_worker' }),
    ];
    const services = makeFakeServices({ request: r, pool: wis });
    const bus = makeFakeBus();
    const sub = new RequestCascadeSubscriber({
      eventBus: bus as never,
      ...services,
      logger: SILENT_LOGGER as never,
    });
    sub.start();

    bus.publish(makeEvent({ type: 'task:done_by_worker', workItemId: 'b', requestId: 'req-1' }));
    await sub.flushPending();

    expect(services.updates).toEqual([['req-1', { status: 'done' }]]);
  });

  it('no-ops when neither event nor WI lookup yields a requestId', async () => {
    // Genuinely orphan event — nothing to cascade. Must not throw.
    const services = makeFakeServices({});
    const bus = makeFakeBus();
    const sub = new RequestCascadeSubscriber({
      eventBus: bus as never,
      ...services,
      logger: SILENT_LOGGER as never,
    });
    sub.start();

    bus.publish(makeEvent({ type: 'task:cancelled', workItemId: 'unknown-wi' }));
    await sub.flushPending();

    expect(services.updates).toEqual([]);
  });

  it('does not throw when cascade itself fails (best-effort contract)', async () => {
    // Subscriber MUST swallow errors from cascade so a single failing
    // request doesn't break the bus dispatch loop.
    const services = makeFakeServices({});
    services.requestService.getById = async () => {
      throw new Error('storage exploded');
    };
    const bus = makeFakeBus();
    const sub = new RequestCascadeSubscriber({
      eventBus: bus as never,
      ...services,
      logger: SILENT_LOGGER as never,
    });
    sub.start();

    bus.publish(makeEvent({ type: 'task:failed', workItemId: 'x', requestId: 'req-1' }));
    await expect(sub.flushPending()).resolves.toBeUndefined();
  });

  it('subscribes to all six lifecycle events on start', async () => {
    // Regression gate: if a future refactor drops one of the event
    // types from SUBSCRIBED_EVENTS, the cascade for that lifecycle
    // path silently breaks. Trip it here.
    const r = makeRequest({ status: 'running' });
    const services = makeFakeServices({ request: r, pool: [makeWI({ status: 'running' })] });
    const bus = makeFakeBus();
    const sub = new RequestCascadeSubscriber({
      eventBus: bus as never,
      ...services,
      logger: SILENT_LOGGER as never,
    });
    const onSpy = jest.spyOn(bus, 'onInProcess');
    sub.start();

    const subscribedTypes = onSpy.mock.calls.map((c) => c[0]);
    expect(subscribedTypes).toEqual(
      expect.arrayContaining([
        'task:done_by_worker',
        'task:verified',
        'task:rejected',
        'task:cancelled',
        'task:failed',
        'task:blocked',
      ]),
    );
  });

  it('start() is idempotent — calling twice does not double-subscribe', async () => {
    const services = makeFakeServices({});
    const bus = makeFakeBus();
    const sub = new RequestCascadeSubscriber({
      eventBus: bus as never,
      ...services,
      logger: SILENT_LOGGER as never,
    });
    const onSpy = jest.spyOn(bus, 'onInProcess');
    sub.start();
    sub.start();
    expect(onSpy.mock.calls.length).toBe(6); // 6 unique event types, one per type
  });

  it('stop() detaches handlers — subsequent events are ignored', async () => {
    const r = makeRequest({ status: 'ready' });
    const services = makeFakeServices({
      request: r,
      pool: [makeWI({ status: 'cancelled' })],
    });
    const bus = makeFakeBus();
    const sub = new RequestCascadeSubscriber({
      eventBus: bus as never,
      ...services,
      logger: SILENT_LOGGER as never,
    });
    sub.start();
    sub.stop();

    bus.publish(makeEvent({ type: 'task:cancelled', workItemId: 'wi-1', requestId: 'req-1' }));
    await sub.flushPending();

    expect(services.updates).toEqual([]);
  });
});
