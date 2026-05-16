/**
 * Tests for MilestoneNotificationSubscriber (#438).
 *
 * @module services/notification/milestone-notification.subscriber.test
 */

import { EventBusService } from '../event-bus/event-bus.service.js';
import {
  MilestoneNotificationSubscriber,
  MILESTONE_SUBSCRIBED_EVENTS,
} from './milestone-notification.subscriber.js';
import type { AgentEvent } from '../../types/event-bus.types.js';

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

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: 'task:verified',
    timestamp: new Date().toISOString(),
    teamId: 'team-1',
    teamName: 'Team',
    memberId: 'm-1',
    memberName: 'Worker',
    sessionName: 'crewly-product-leo',
    previousValue: 'done_by_worker',
    newValue: 'verified',
    changedField: 'taskStatus',
    workItemId: 'wi-1',
    ...overrides,
  } as AgentEvent;
}

describe('MilestoneNotificationSubscriber', () => {
  let bus: EventBusService;
  let enqueue: jest.Mock;
  let subscriber: MilestoneNotificationSubscriber;

  beforeEach(() => {
    bus = new EventBusService();
    enqueue = jest.fn();
    subscriber = new MilestoneNotificationSubscriber({
      eventBus: bus,
      messageQueueService: { enqueue },
      orchestratorSession: 'crewly-orc',
    });
    subscriber.start();
  });

  afterEach(() => {
    subscriber.stop();
  });

  it('subscribes to exactly the closed set', () => {
    // Smoke: starting + immediately stopping doesn't throw, and the
    // exported event list matches what we expect.
    expect(MILESTONE_SUBSCRIBED_EVENTS).toEqual(['task:verified', 'mission:replanned']);
  });

  it('enqueues a [MILESTONE] envelope when task:verified fires with a meaningful summary', async () => {
    bus.publish(
      makeEvent({
        type: 'task:verified',
        sessionName: 'crewly-product-leo',
        workItemId: 'wi-shipped-1',
        // Cast through unknown for the extra `summary` field that AgentEvent doesn't formally declare.
        ...({
          summary: 'PR #420 merged — agent state file is now corruption-resistant + auto-snapshots every 30s',
        } as unknown as Partial<AgentEvent>),
      }),
    );

    await subscriber.flushPending();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const call = enqueue.mock.calls[0][0];
    expect(call.content).toContain('[MILESTONE]');
    expect(call.content).toContain('PR #420 merged');
    expect(call.targetSession).toBe('crewly-orc');
    expect(call.source).toBe('system_event');
  });

  it('skips events with no summary (avoids spamming orc on bare lifecycle ticks)', async () => {
    bus.publish(
      makeEvent({
        type: 'task:verified',
        sessionName: 'crewly-product-leo',
        workItemId: 'wi-no-summary',
      }),
    );
    await subscriber.flushPending();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips trivially-short summaries (mirrors the agent-side ≥30-char gate)', async () => {
    bus.publish(
      makeEvent({
        type: 'task:verified',
        workItemId: 'wi-short',
        ...({ summary: 'task done' } as unknown as Partial<AgentEvent>),
      }),
    );
    await subscriber.flushPending();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('dedups identical events on the same workItemId', async () => {
    const evt = makeEvent({
      type: 'task:verified',
      workItemId: 'wi-dup-1',
      ...({
        summary: 'A meaningful milestone summary that exceeds thirty characters.',
      } as unknown as Partial<AgentEvent>),
    });
    bus.publish(evt);
    bus.publish({ ...evt, id: 'evt-dup-2' }); // Same wiKey
    await subscriber.flushPending();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
