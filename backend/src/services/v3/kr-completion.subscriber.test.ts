/**
 * Unit tests for KRCompletionSubscriber — KR auto-measure from task
 * completion + `team:all_tasks_done` publication.
 *
 * @module services/v3/kr-completion.subscriber.test
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  KRCompletionSubscriber,
  ALL_TASKS_DONE_TRIGGER_EVENTS,
  KR_MEASURE_EVENTS,
  type KRCompletionTracker,
} from './kr-completion.subscriber.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { KeyResult } from '../../types/v2/key-result.types.js';
import type { Mission } from '../../types/v2/mission.types.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';

const SILENT_LOGGER = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

function makeWI(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 'wi-1',
    title: 'test wi',
    description: '',
    status: 'done',
    type: 'delegate',
    owner: 'orchestrator',
    missionId: 'm-1',
    createdAt: '2026-09-18T01:00:00.000Z',
    retryCount: 0,
    maxRetries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...overrides,
  } as WorkItem;
}

function makeKR(overrides: Partial<KeyResult>): KeyResult {
  return {
    id: 'kr-1',
    missionId: 'm-1',
    title: 'Ship 4 features',
    metricType: 'count',
    baseline: 0,
    target: 4,
    current: 0,
    unit: 'features',
    status: 'not_started',
    measurementSource: 'task_completion',
    linkedWorkItemIds: [],
    measurements: [],
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  } as KeyResult;
}

function makeEvent(type: EventType, workItemId?: string): AgentEvent {
  return {
    id: `${type}:${workItemId ?? 'x'}`,
    type,
    timestamp: new Date().toISOString(),
    teamId: '',
    teamName: '',
    memberId: '',
    memberName: '',
    sessionName: '',
    previousValue: '',
    newValue: '',
    changedField: 'taskStatus',
    workItemId,
  } as AgentEvent;
}

/** Minimal in-memory bus: onInProcess + publish, records every publish. */
function makeFakeBus() {
  const handlers = new Map<EventType, Set<(e: AgentEvent) => unknown>>();
  const published: AgentEvent[] = [];
  const bus = {
    published,
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
      published.push(event);
      const set = handlers.get(event.type);
      if (!set) return;
      for (const h of set) h(event);
    },
  };
  return bus;
}

function makeTracker(krs: KeyResult[]): KRCompletionTracker & { completed: WorkItem[] } {
  const completed: WorkItem[] = [];
  return {
    completed,
    async listByMission(missionId: string) {
      return krs.filter((k) => k.missionId === missionId);
    },
    async get(missionId: string, krId: string) {
      return krs.find((k) => k.missionId === missionId && k.id === krId) ?? null;
    },
    async onWorkItemCompleted(wi: WorkItem) {
      completed.push(wi);
    },
  };
}

function build(opts: { pool: WorkItem[]; krs?: KeyResult[]; mission?: Mission | null; now?: Date }) {
  const bus = makeFakeBus();
  const tracker = makeTracker(opts.krs ?? []);
  const subscriber = new KRCompletionSubscriber({
    eventBus: bus as unknown as EventBusService,
    taskPool: {
      findWorkItem: async (id: string) => opts.pool.find((w) => w.id === id) ?? null,
      getAllItems: async () => opts.pool,
    },
    krTracking: tracker,
    loadMission: async () => opts.mission ?? null,
    logger: SILENT_LOGGER as never,
    now: () => opts.now ?? new Date('2026-09-18T12:00:00.000Z'),
  });
  subscriber.start();
  return { bus, tracker, subscriber };
}

describe('KRCompletionSubscriber', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('subscribes to the closed set of task terminal events', () => {
    expect(ALL_TASKS_DONE_TRIGGER_EVENTS).toEqual(['task:done', 'task:verified', 'task:cancelled']);
    expect(KR_MEASURE_EVENTS).toEqual(['task:done', 'task:verified']);
  });

  describe('KR auto-measure', () => {
    it('calls onWorkItemCompleted for a task_completion KR referenced by metadata.krId', async () => {
      const wi = makeWI({ id: 'wi-1', metadata: { krId: 'kr-1' } });
      const running = makeWI({ id: 'wi-2', status: 'running' });
      const { bus, tracker, subscriber } = build({ pool: [wi, running], krs: [makeKR({})] });

      bus.publish(makeEvent('task:done', 'wi-1'));
      await subscriber.flushPending();

      expect(tracker.completed).toHaveLength(1);
      expect(tracker.completed[0].id).toBe('wi-1');
    });

    it('resolves the KR via linkedWorkItemIds when metadata.krId is absent and injects krId', async () => {
      const wi = makeWI({ id: 'wi-1' });
      const { bus, tracker, subscriber } = build({
        pool: [wi, makeWI({ id: 'wi-2', status: 'queued' })],
        krs: [makeKR({ id: 'kr-9', linkedWorkItemIds: ['wi-1'] })],
      });

      bus.publish(makeEvent('task:verified', 'wi-1'));
      await subscriber.flushPending();

      expect(tracker.completed).toHaveLength(1);
      expect(tracker.completed[0].metadata?.krId).toBe('kr-9');
    });

    it('does NOT measure a KR whose measurementSource is not task_completion', async () => {
      const wi = makeWI({ id: 'wi-1', metadata: { krId: 'kr-1' } });
      const { bus, tracker, subscriber } = build({
        pool: [wi, makeWI({ id: 'wi-2', status: 'queued' })],
        krs: [makeKR({ measurementSource: 'manual' })],
      });

      bus.publish(makeEvent('task:done', 'wi-1'));
      await subscriber.flushPending();

      expect(tracker.completed).toHaveLength(0);
    });

    it('does NOT measure on task:cancelled', async () => {
      const wi = makeWI({ id: 'wi-1', status: 'cancelled', metadata: { krId: 'kr-1' } });
      const { bus, tracker, subscriber } = build({
        pool: [wi, makeWI({ id: 'wi-2', status: 'queued' })],
        krs: [makeKR({})],
      });

      bus.publish(makeEvent('task:cancelled', 'wi-1'));
      await subscriber.flushPending();

      expect(tracker.completed).toHaveLength(0);
    });

    it('ignores events without a workItemId or for WIs without a mission', async () => {
      const wi = makeWI({ id: 'wi-1', missionId: undefined, metadata: { krId: 'kr-1' } });
      const { bus, tracker, subscriber } = build({ pool: [wi], krs: [makeKR({})] });

      bus.publish(makeEvent('task:done'));
      bus.publish(makeEvent('task:done', 'wi-1'));
      await subscriber.flushPending();

      expect(tracker.completed).toHaveLength(0);
      expect(bus.published.filter((e) => e.type === 'team:all_tasks_done')).toHaveLength(0);
    });
  });

  describe('team:all_tasks_done', () => {
    it('publishes once per mission per day when no non-terminal WI remains', async () => {
      const pool = [
        makeWI({ id: 'wi-1', status: 'done' }),
        makeWI({ id: 'wi-2', status: 'verified' }),
        makeWI({ id: 'wi-3', status: 'cancelled' }),
        makeWI({ id: 'wi-other', status: 'running', missionId: 'm-2' }),
      ];
      const { bus, subscriber } = build({ pool, mission: { id: 'm-1', ownerTeamId: 'team-7' } as Mission });

      bus.publish(makeEvent('task:done', 'wi-1'));
      bus.publish(makeEvent('task:verified', 'wi-2'));
      await subscriber.flushPending();

      const done = bus.published.filter((e) => e.type === 'team:all_tasks_done');
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({
        id: 'm-1:all_tasks_done:2026-09-18',
        missionId: 'm-1',
        teamId: 'team-7',
        sessionName: '',
      });
    });

    it('does NOT publish while a queued/running/blocked WI remains', async () => {
      const pool = [
        makeWI({ id: 'wi-1', status: 'done' }),
        makeWI({ id: 'wi-2', status: 'blocked' }),
      ];
      const { bus, subscriber } = build({ pool });

      bus.publish(makeEvent('task:done', 'wi-1'));
      await subscriber.flushPending();

      expect(bus.published.filter((e) => e.type === 'team:all_tasks_done')).toHaveLength(0);
    });

    it('treats failed/rejected as exited-queue (no active work) and still publishes', async () => {
      const pool = [
        makeWI({ id: 'wi-1', status: 'done' }),
        makeWI({ id: 'wi-2', status: 'failed' }),
      ];
      const { bus, subscriber } = build({ pool });

      bus.publish(makeEvent('task:done', 'wi-1'));
      await subscriber.flushPending();

      expect(bus.published.filter((e) => e.type === 'team:all_tasks_done')).toHaveLength(1);
    });

    it('publishes on task:cancelled when it was the last active item', async () => {
      const pool = [makeWI({ id: 'wi-1', status: 'cancelled' })];
      const { bus, subscriber } = build({ pool });

      bus.publish(makeEvent('task:cancelled', 'wi-1'));
      await subscriber.flushPending();

      expect(bus.published.filter((e) => e.type === 'team:all_tasks_done')).toHaveLength(1);
    });

    it('publishes again on a new UTC day (dedup key is per day)', async () => {
      const pool = [makeWI({ id: 'wi-1', status: 'done' })];
      let now = new Date('2026-09-18T23:00:00.000Z');
      const bus = makeFakeBus();
      const subscriber = new KRCompletionSubscriber({
        eventBus: bus as unknown as EventBusService,
        taskPool: {
          findWorkItem: async (id: string) => pool.find((w) => w.id === id) ?? null,
          getAllItems: async () => pool,
        },
        krTracking: makeTracker([]),
        loadMission: async () => null,
        logger: SILENT_LOGGER as never,
        now: () => now,
      });
      subscriber.start();

      bus.publish(makeEvent('task:done', 'wi-1'));
      await subscriber.flushPending();
      now = new Date('2026-09-19T01:00:00.000Z');
      bus.publish(makeEvent('task:done', 'wi-1'));
      await subscriber.flushPending();

      const ids = bus.published.filter((e) => e.type === 'team:all_tasks_done').map((e) => e.id);
      expect(ids).toEqual(['m-1:all_tasks_done:2026-09-18', 'm-1:all_tasks_done:2026-09-19']);
      subscriber.stop();
    });
  });

  it('a throwing KR tracker does not prevent the all-tasks-done publish', async () => {
    const wi = makeWI({ id: 'wi-1', metadata: { krId: 'kr-1' } });
    const bus = makeFakeBus();
    const subscriber = new KRCompletionSubscriber({
      eventBus: bus as unknown as EventBusService,
      taskPool: { findWorkItem: async () => wi, getAllItems: async () => [wi] },
      krTracking: {
        listByMission: async () => [],
        get: async () => {
          throw new Error('disk');
        },
        onWorkItemCompleted: async () => undefined,
      },
      loadMission: async () => null,
      logger: SILENT_LOGGER as never,
    });
    subscriber.start();

    bus.publish(makeEvent('task:done', 'wi-1'));
    await subscriber.flushPending();

    expect(bus.published.filter((e) => e.type === 'team:all_tasks_done')).toHaveLength(1);
    expect(SILENT_LOGGER.warn).toHaveBeenCalled();
  });

  it('stop() detaches — no further dispatches', async () => {
    const wi = makeWI({ id: 'wi-1', metadata: { krId: 'kr-1' } });
    const { bus, tracker, subscriber } = build({ pool: [wi], krs: [makeKR({})] });
    subscriber.stop();

    bus.publish(makeEvent('task:done', 'wi-1'));
    await subscriber.flushPending();

    expect(tracker.completed).toHaveLength(0);
  });
});
