/**
 * Tests for FallbackTriggerCleanupSubscriber.
 *
 * @module services/v3/fallback-trigger-cleanup.subscriber.test
 */

import {
  FallbackTriggerCleanupSubscriber,
  fallbackTriggerName,
  isFallbackTriggerFor,
  FALLBACK_CLEANUP_EVENTS,
} from './fallback-trigger-cleanup.subscriber.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { Trigger } from '../../types/v2/trigger.types.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

function makeFakeBus() {
  const handlers = new Map<EventType, Set<(e: AgentEvent) => unknown>>();
  return {
    onInProcess(types: EventType | EventType[], h: (e: AgentEvent) => unknown) {
      for (const t of Array.isArray(types) ? types : [types]) {
        if (!handlers.has(t)) handlers.set(t, new Set());
        handlers.get(t)!.add(h);
      }
      return () => {
        for (const t of Array.isArray(types) ? types : [types]) handlers.get(t)?.delete(h);
      };
    },
    publish(event: AgentEvent) {
      for (const h of handlers.get(event.type) ?? []) h(event);
    },
    handlerCount() {
      let n = 0;
      for (const s of handlers.values()) n += s.size;
      return n;
    },
  };
}

function trigger(id: string, name: string, status: Trigger['status'] = 'active'): Trigger {
  return { id, name, status } as Trigger;
}

function event(type: EventType, workItemId?: string): AgentEvent {
  return { id: `e-${type}`, type, timestamp: 'x', teamId: '', teamName: '', memberId: '', memberName: '', sessionName: '', workItemId } as AgentEvent;
}

const WI = 'd1f9f049-cd77-4402-af8e-131c3eeefdfa';

describe('name helpers', () => {
  it('builds and recognises the delegate-task trigger name', () => {
    expect(fallbackTriggerName(WI, 'kai')).toBe('fallback-kai-d1f9f049');
    expect(isFallbackTriggerFor({ name: 'fallback-kai-d1f9f049' }, WI)).toBe(true);
    expect(isFallbackTriggerFor({ name: 'fallback-someone-else-d1f9f049' }, WI)).toBe(true);
    expect(isFallbackTriggerFor({ name: 'fallback-kai-deadbeef' }, WI)).toBe(false);
    expect(isFallbackTriggerFor({ name: 'daily-report-d1f9f049' }, WI)).toBe(false);
    expect(isFallbackTriggerFor({}, WI)).toBe(false);
  });
});

describe('FallbackTriggerCleanupSubscriber', () => {
  let bus: ReturnType<typeof makeFakeBus>;
  let triggers: { list: jest.Mock; cancel: jest.Mock };
  let sub: FallbackTriggerCleanupSubscriber;

  beforeEach(() => {
    bus = makeFakeBus();
    triggers = {
      list: jest.fn().mockReturnValue([
        trigger('t1', fallbackTriggerName(WI, 'kai')),
        trigger('t2', fallbackTriggerName('other-wi-id-000', 'kai')),
        trigger('t3', fallbackTriggerName(WI, 'kai'), 'cancelled'),
        trigger('t4', 'daily-learning-push'),
      ]),
      cancel: jest.fn().mockResolvedValue(true),
    };
    sub = new FallbackTriggerCleanupSubscriber({ eventBus: bus as unknown as EventBusService, triggers });
  });

  it('subscribes to done, verified and cancelled, and unsubscribes on stop', () => {
    sub.start();
    sub.start();
    expect(bus.handlerCount()).toBe(FALLBACK_CLEANUP_EVENTS.length);
    sub.stop();
    expect(bus.handlerCount()).toBe(0);
  });

  it('cancels only live fallback timers that belong to the finished WorkItem', async () => {
    const n = await sub.handle(event('task:verified', WI));
    expect(n).toBe(1);
    expect(triggers.cancel).toHaveBeenCalledTimes(1);
    expect(triggers.cancel).toHaveBeenCalledWith('t1');
  });

  it('reacts to published events end to end', async () => {
    sub.start();
    bus.publish(event('task:done', WI));
    await new Promise((r) => setImmediate(r));
    expect(triggers.cancel).toHaveBeenCalledWith('t1');
  });

  it('ignores events without a WorkItem id and tolerates engine failures', async () => {
    expect(await sub.handle(event('task:done'))).toBe(0);
    triggers.cancel.mockRejectedValue(new Error('engine down'));
    sub.start();
    bus.publish(event('task:cancelled', WI));
    await new Promise((r) => setImmediate(r));
    // No throw surfaced; the handler swallowed and logged.
    expect(triggers.cancel).toHaveBeenCalled();
  });
});
