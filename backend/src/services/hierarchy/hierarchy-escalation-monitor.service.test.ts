/**
 * Tests for HierarchyEscalationMonitor — TL-unresponsive bypass wiring.
 *
 * @module services/hierarchy/hierarchy-escalation-monitor.service.test
 */

import { jest } from '@jest/globals';
import {
  HierarchyEscalationMonitor,
  DEFAULT_TL_ACK_TIMEOUT_MS,
  HIERARCHY_ESCALATION_CONVERSATION_ID,
} from './hierarchy-escalation-monitor.service.js';
import { HierarchyEscalationService } from './hierarchy-escalation.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never;

function makeFakeBus() {
  const handlers = new Map<EventType, Set<(e: AgentEvent) => unknown>>();
  const published: AgentEvent[] = [];
  return {
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
}

function makeEvent(type: EventType, workItemId: string): AgentEvent {
  return {
    id: `${type}:${workItemId}`,
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

function makeTeam(): Team {
  return {
    id: 'team-1',
    name: 'Product',
    description: '',
    members: [
      { id: 'tl', name: 'Leo', sessionName: 'tl-session', role: 'team-lead', hierarchyLevel: 1, canDelegate: true },
      { id: 'w1', name: 'Max', sessionName: 'worker-session', role: 'developer', hierarchyLevel: 2, parentMemberId: 'tl' },
    ],
  } as unknown as Team;
}

function makeWI(id: string, status: WorkItem['status'] = 'done_by_worker'): WorkItem {
  return { id, title: `Task ${id}`, status, target: 'worker-session', type: 'delegate' } as WorkItem;
}

function build(opts: { pool?: WorkItem[]; teams?: Team[]; now?: () => Date } = {}) {
  HierarchyEscalationService.clearInstance();
  const bus = makeFakeBus();
  const enqueued: Array<Record<string, unknown>> = [];
  const pool = opts.pool ?? [];
  const escalation = HierarchyEscalationService.getInstance();
  const monitor = new HierarchyEscalationMonitor({
    eventBus: bus as unknown as EventBusService,
    messageQueue: { enqueue: (m) => enqueued.push(m as Record<string, unknown>) },
    taskPool: { findWorkItem: async (id) => pool.find((w) => w.id === id) ?? null },
    getTeams: async () => opts.teams ?? [makeTeam()],
    escalation,
    logger,
    now: opts.now ?? (() => new Date()),
    sweepIntervalMs: 0,
  });
  monitor.start();
  return { bus, enqueued, monitor, escalation, pool };
}

describe('HierarchyEscalationMonitor', () => {
  afterEach(() => {
    HierarchyEscalationService.clearInstance();
  });

  it('opens a pending handoff on task:done_by_worker and closes it on the TL verdict', async () => {
    const { bus, monitor, escalation } = build({ pool: [makeWI('wi-1')] });
    const spy = jest.spyOn(escalation, 'recordTLResponse');

    bus.publish(makeEvent('task:done_by_worker', 'wi-1'));
    await monitor.flushPending();
    expect(monitor.pendingCount).toBe(1);

    bus.publish(makeEvent('task:verified', 'wi-1'));
    await monitor.flushPending();
    expect(monitor.pendingCount).toBe(0);
    expect(spy).toHaveBeenCalledWith('tl-session');
    monitor.stop();
  });

  it('does not escalate before the ack timeout', async () => {
    let now = new Date('2026-09-18T10:00:00.000Z');
    const { bus, monitor, enqueued } = build({ pool: [makeWI('wi-1')], now: () => now });
    bus.publish(makeEvent('task:done_by_worker', 'wi-1'));
    await monitor.flushPending();

    now = new Date(now.getTime() + DEFAULT_TL_ACK_TIMEOUT_MS - 1000);
    const result = await monitor.sweep();
    expect(result.escalated).toEqual([]);
    expect(enqueued).toHaveLength(0);
    expect(monitor.pendingCount).toBe(1);
    monitor.stop();
  });

  it('after the timeout: publishes hierarchy:escalation, enqueues [ESCALATION] to the orchestrator, once', async () => {
    let now = new Date('2026-09-18T10:00:00.000Z');
    const { bus, monitor, enqueued } = build({ pool: [makeWI('wi-1')], now: () => now });
    bus.publish(makeEvent('task:done_by_worker', 'wi-1'));
    await monitor.flushPending();

    now = new Date(now.getTime() + DEFAULT_TL_ACK_TIMEOUT_MS + 1);
    const result = await monitor.sweep();
    expect(result.escalated).toEqual(['wi-1']);

    const escalations = bus.published.filter((e) => e.type === 'hierarchy:escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      teamId: 'team-1',
      sessionName: 'worker-session',
      previousValue: 'tl-session',
      taskId: 'wi-1',
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      source: 'system_event',
      conversationId: HIERARCHY_ESCALATION_CONVERSATION_ID,
      targetSession: 'crewly-orc',
    });
    expect(String(enqueued[0].content)).toMatch(/^\[ESCALATION\] Team lead has not acted on "Task wi-1"/);
    expect(enqueued[0].sourceMetadata).toMatchObject({
      workItemId: 'wi-1',
      teamLeadSession: 'tl-session',
      reason: 'tl_unresponsive',
    });

    // Re-opening the same WI does not escalate twice.
    bus.publish(makeEvent('task:done_by_worker', 'wi-1'));
    await monitor.flushPending();
    await monitor.sweep();
    expect(enqueued).toHaveLength(1);
    monitor.stop();
  });

  it('clears a stale handoff whose WI is no longer waiting on the TL (resolved out-of-band)', async () => {
    let now = new Date('2026-09-18T10:00:00.000Z');
    const pool = [makeWI('wi-1')];
    const { bus, monitor, enqueued } = build({ pool, now: () => now });
    bus.publish(makeEvent('task:done_by_worker', 'wi-1'));
    await monitor.flushPending();

    pool[0] = makeWI('wi-1', 'verified');
    now = new Date(now.getTime() + DEFAULT_TL_ACK_TIMEOUT_MS + 1);
    const result = await monitor.sweep();
    expect(result.cleared).toEqual(['wi-1']);
    expect(enqueued).toHaveLength(0);
    monitor.stop();
  });

  it('still bypasses to the orchestrator when the worker has no resolvable TL', async () => {
    let now = new Date('2026-09-18T10:00:00.000Z');
    const loneTeam = {
      id: 'team-2',
      name: 'Solo',
      description: '',
      members: [{ id: 'w1', name: 'Max', sessionName: 'worker-session', role: 'developer' }],
    } as unknown as Team;
    const { bus, monitor, enqueued } = build({ pool: [makeWI('wi-1')], teams: [loneTeam], now: () => now });
    bus.publish(makeEvent('task:done_by_worker', 'wi-1'));
    await monitor.flushPending();

    now = new Date(now.getTime() + DEFAULT_TL_ACK_TIMEOUT_MS + 1);
    await monitor.sweep();
    expect(bus.published.filter((e) => e.type === 'hierarchy:escalation')).toHaveLength(0);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].targetSession).toBe('crewly-orc');
    monitor.stop();
  });

  it('routes to the TL\'s own parent when the hierarchy has one above the TL', async () => {
    let now = new Date('2026-09-18T10:00:00.000Z');
    const deepTeam = {
      id: 'team-3',
      name: 'Deep',
      description: '',
      members: [
        { id: 'dir', name: 'Dana', sessionName: 'director-session', role: 'director', hierarchyLevel: 0 },
        { id: 'tl', name: 'Leo', sessionName: 'tl-session', role: 'team-lead', hierarchyLevel: 1, parentMemberId: 'dir' },
        { id: 'w1', name: 'Max', sessionName: 'worker-session', role: 'developer', hierarchyLevel: 2, parentMemberId: 'tl' },
      ],
    } as unknown as Team;
    const { bus, monitor, enqueued } = build({ pool: [makeWI('wi-1')], teams: [deepTeam], now: () => now });
    bus.publish(makeEvent('task:done_by_worker', 'wi-1'));
    await monitor.flushPending();

    now = new Date(now.getTime() + DEFAULT_TL_ACK_TIMEOUT_MS + 1);
    await monitor.sweep();

    const escalations = bus.published.filter((e) => e.type === 'hierarchy:escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].newValue).toBe('director-session');
    expect(enqueued[0].targetSession).toBe('director-session');
    monitor.stop();
  });

  it('stop() detaches subscriptions', async () => {
    const { bus, monitor } = build({ pool: [makeWI('wi-1')] });
    monitor.stop();
    bus.publish(makeEvent('task:done_by_worker', 'wi-1'));
    await monitor.flushPending();
    expect(monitor.pendingCount).toBe(0);
  });

  it('boot() wires the singleton services and start() is idempotent', () => {
    const bus = makeFakeBus();
    const monitor = HierarchyEscalationMonitor.boot(
      bus as unknown as EventBusService,
      { enqueue: () => undefined },
    );
    expect(() => monitor.start()).not.toThrow();
    expect(() => monitor.start()).not.toThrow();
    monitor.stop();
  });
});
