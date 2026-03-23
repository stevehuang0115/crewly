/**
 * Tests for Event Bus Service
 *
 * @module services/event-bus/event-bus.test
 */

import { EventBusService } from './event-bus.service.js';
import type { AgentEvent, CreateSubscriptionInput } from '../../types/event-bus.types.js';

// Mock logger
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

/**
 * Create a sample agent event for testing
 */
function createTestEvent(overrides?: Partial<AgentEvent>): AgentEvent {
  return {
    id: crypto.randomUUID(),
    type: 'agent:busy',
    timestamp: new Date().toISOString(),
    teamId: 'team-1',
    teamName: 'Web Team',
    memberId: 'member-1',
    memberName: 'Joe',
    sessionName: 'agent-joe',
    previousValue: 'idle',
    newValue: 'in_progress',
    changedField: 'workingStatus',
    ...overrides,
  };
}

/**
 * Create a sample subscription input for testing
 */
function createTestSubscriptionInput(overrides?: Partial<CreateSubscriptionInput>): CreateSubscriptionInput {
  return {
    eventType: 'agent:busy',
    filter: { sessionName: 'agent-joe' },
    subscriberSession: 'crewly-orc',
    ...overrides,
  };
}

describe('EventBusService', () => {
  let eventBus: EventBusService;
  let mockQueueService: any;

  beforeEach(() => {
    jest.useFakeTimers();
    eventBus = new EventBusService();
    mockQueueService = {
      enqueue: jest.fn().mockReturnValue({ id: 'msg-1' }),
    };
    eventBus.setMessageQueueService(mockQueueService);
  });

  afterEach(() => {
    eventBus.cleanup();
    jest.useRealTimers();
  });

  describe('subscribe', () => {
    it('should create a subscription with defaults', () => {
      const sub = eventBus.subscribe(createTestSubscriptionInput());

      expect(sub.id).toBeDefined();
      expect(sub.eventType).toBe('agent:busy');
      expect(sub.filter.sessionName).toBe('agent-joe');
      expect(sub.subscriberSession).toBe('crewly-orc');
      expect(sub.oneShot).toBe(true);
      expect(sub.createdAt).toBeDefined();
      expect(sub.expiresAt).toBeDefined();
    });

    it('should create a subscription with custom options', () => {
      const sub = eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        ttlMinutes: 60,
        messageTemplate: 'Agent {memberName} is now {newValue}',
      }));

      expect(sub.oneShot).toBe(false);
      expect(sub.messageTemplate).toBe('Agent {memberName} is now {newValue}');
    });

    it('should accept an array of event types', () => {
      const sub = eventBus.subscribe(createTestSubscriptionInput({
        eventType: ['agent:idle', 'agent:busy'],
      }));

      expect(sub.eventType).toEqual(['agent:idle', 'agent:busy']);
    });

    it('should throw for invalid input', () => {
      expect(() => {
        eventBus.subscribe({} as any);
      }).toThrow('Invalid subscription input');
    });

    it('should cap TTL at maximum', () => {
      const sub = eventBus.subscribe(createTestSubscriptionInput({
        ttlMinutes: 99999,
      }));

      const created = new Date(sub.createdAt!).getTime();
      const expires = new Date(sub.expiresAt!).getTime();
      const diffMinutes = (expires - created) / 60000;

      expect(diffMinutes).toBe(1440); // MAX_SUBSCRIPTION_TTL_MINUTES
    });

    it('should enforce per-session subscription limit', () => {
      // Create max subscriptions
      for (let i = 0; i < 50; i++) {
        eventBus.subscribe(createTestSubscriptionInput());
      }

      expect(() => {
        eventBus.subscribe(createTestSubscriptionInput());
      }).toThrow(/Subscription limit reached/);
    });
  });

  describe('unsubscribe', () => {
    it('should remove an existing subscription', () => {
      const sub = eventBus.subscribe(createTestSubscriptionInput());
      const result = eventBus.unsubscribe(sub.id);

      expect(result).toBe(true);
      expect(eventBus.listSubscriptions()).toHaveLength(0);
    });

    it('should return false for non-existent subscription', () => {
      expect(eventBus.unsubscribe('non-existent')).toBe(false);
    });
  });

  describe('publish', () => {
    it('should deliver notification when event matches subscription', () => {
      eventBus.subscribe(createTestSubscriptionInput());
      eventBus.publish(createTestEvent());

      // Advance past debounce window to flush buffered notifications
      jest.advanceTimersByTime(5000);

      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
      const call = mockQueueService.enqueue.mock.calls[0][0];
      expect(call.content).toContain('[EVENT:');
      expect(call.content).toContain('agent:busy');
      expect(call.content).toContain('Joe');
      expect(call.conversationId).toBe('system');
      expect(call.source).toBe('system_event');
    });

    it('should not deliver when event type does not match', () => {
      eventBus.subscribe(createTestSubscriptionInput({ eventType: 'agent:busy' }));
      eventBus.publish(createTestEvent({ type: 'agent:idle' }));

      expect(mockQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('should not deliver when session name filter does not match', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        filter: { sessionName: 'agent-bob' },
      }));
      eventBus.publish(createTestEvent({ sessionName: 'agent-joe' }));

      expect(mockQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('should match when filter has teamId', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        filter: { teamId: 'team-1' },
      }));
      eventBus.publish(createTestEvent({ teamId: 'team-1' }));

      jest.advanceTimersByTime(5000);

      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should not match when teamId filter differs', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        filter: { teamId: 'team-other' },
      }));
      eventBus.publish(createTestEvent({ teamId: 'team-1' }));

      expect(mockQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('should not deliver self-events (subscriber === event source)', () => {
      // Orchestrator subscribes to all events with empty filter
      eventBus.subscribe(createTestSubscriptionInput({
        eventType: ['agent:idle', 'agent:busy'],
        filter: {},
        subscriberSession: 'crewly-orc',
      }));
      // Event from the orchestrator itself
      eventBus.publish(createTestEvent({
        sessionName: 'crewly-orc',
        memberName: 'Orchestrator',
        type: 'agent:busy',
      }));

      jest.advanceTimersByTime(5000);

      // Should NOT be delivered — subscriber === event source
      expect(mockQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('should deliver events from other agents to subscriber', () => {
      // Orchestrator subscribes to all events
      eventBus.subscribe(createTestSubscriptionInput({
        eventType: ['agent:idle', 'agent:busy'],
        filter: {},
        subscriberSession: 'crewly-orc',
      }));
      // Event from a different agent
      eventBus.publish(createTestEvent({
        sessionName: 'agent-sam',
        memberName: 'Sam',
        type: 'agent:idle',
      }));

      jest.advanceTimersByTime(5000);

      // Should be delivered — different session
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should remove one-shot subscription after delivery', () => {
      eventBus.subscribe(createTestSubscriptionInput({ oneShot: true }));
      expect(eventBus.listSubscriptions()).toHaveLength(1);

      eventBus.publish(createTestEvent());

      expect(eventBus.listSubscriptions()).toHaveLength(0);
    });

    it('should keep non-one-shot subscription after delivery', () => {
      eventBus.subscribe(createTestSubscriptionInput({ oneShot: false }));

      eventBus.publish(createTestEvent());

      jest.advanceTimersByTime(5000);

      expect(eventBus.listSubscriptions()).toHaveLength(1);
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should use custom message template when provided', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        messageTemplate: 'Hey! {memberName} on {sessionName} went {newValue}',
      }));
      eventBus.publish(createTestEvent());

      jest.advanceTimersByTime(5000);

      const call = mockQueueService.enqueue.mock.calls[0][0];
      expect(call.content).toBe('Hey! Joe on agent-joe went in_progress');
    });

    it('should emit event_delivered when notification is sent', () => {
      const handler = jest.fn();
      eventBus.on('event_delivered', handler);

      eventBus.subscribe(createTestSubscriptionInput());
      eventBus.publish(createTestEvent());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'agent:busy',
        })
      );
    });

    it('should match array of event types', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        eventType: ['agent:idle', 'agent:active'],
      }));

      eventBus.publish(createTestEvent({ type: 'agent:active' }));

      jest.advanceTimersByTime(5000);

      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate events from the same agent within debounce window', () => {
      eventBus.subscribe(createTestSubscriptionInput({ oneShot: false }));

      // Publish 3 events for the same agent in rapid succession
      eventBus.publish(createTestEvent({ newValue: 'in_progress' }));
      eventBus.publish(createTestEvent({ newValue: 'idle' }));
      eventBus.publish(createTestEvent({ newValue: 'in_progress' }));

      jest.advanceTimersByTime(5000);

      // Only 1 enqueue call: all 3 events for agent-joe were deduped to the latest
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
      const call = mockQueueService.enqueue.mock.calls[0][0];
      expect(call.content).toContain('in_progress'); // Only final state
    });

    it('should batch events from different agents into one delivery', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {}, // Match all agents
        eventType: ['agent:busy', 'agent:active'],
      }));

      eventBus.publish(createTestEvent({ sessionName: 'agent-joe', type: 'agent:busy', newValue: 'in_progress' }));
      eventBus.publish(createTestEvent({ sessionName: 'agent-sam', type: 'agent:active', newValue: 'active' }));

      jest.advanceTimersByTime(5000);

      // 1 enqueue call with both events combined
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
      const call = mockQueueService.enqueue.mock.calls[0][0];
      expect(call.content).toContain('agent-joe');
      expect(call.content).toContain('agent-sam');
    });

    it('should skip expired subscriptions during publish', () => {
      const sub = eventBus.subscribe(createTestSubscriptionInput({ ttlMinutes: 1 }));

      // Manually expire the subscription
      const stored = eventBus.getSubscription(sub.id);
      if (stored) {
        (stored as any).expiresAt = new Date(Date.now() - 60000).toISOString();
      }

      eventBus.publish(createTestEvent());

      expect(mockQueueService.enqueue).not.toHaveBeenCalled();
      expect(eventBus.listSubscriptions()).toHaveLength(0);
    });

    it('should handle missing messageQueueService gracefully', () => {
      const busNoQueue = new EventBusService();
      busNoQueue.subscribe(createTestSubscriptionInput());

      // Should not throw
      expect(() => {
        busNoQueue.publish(createTestEvent());
      }).not.toThrow();

      busNoQueue.cleanup();
    });
  });

  describe('listSubscriptions', () => {
    it('should return all subscriptions', () => {
      eventBus.subscribe(createTestSubscriptionInput());
      eventBus.subscribe(createTestSubscriptionInput({
        subscriberSession: 'other-session',
      }));

      expect(eventBus.listSubscriptions()).toHaveLength(2);
    });

    it('should filter by subscriber session', () => {
      eventBus.subscribe(createTestSubscriptionInput());
      eventBus.subscribe(createTestSubscriptionInput({
        subscriberSession: 'other-session',
      }));

      expect(eventBus.listSubscriptions('crewly-orc')).toHaveLength(1);
      expect(eventBus.listSubscriptions('other-session')).toHaveLength(1);
      expect(eventBus.listSubscriptions('nonexistent')).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('should return correct initial stats', () => {
      const stats = eventBus.getStats();
      expect(stats.subscriptionCount).toBe(0);
      expect(stats.deliveryCount).toBe(0);
    });

    it('should track subscription count', () => {
      eventBus.subscribe(createTestSubscriptionInput({ oneShot: false }));
      eventBus.subscribe(createTestSubscriptionInput({
        subscriberSession: 'other',
        oneShot: false,
      }));

      expect(eventBus.getStats().subscriptionCount).toBe(2);
    });

    it('should track delivery count', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: ['agent:idle', 'agent:busy'],
      }));

      // Use different sessions so events aren't deduped by the publish guard
      eventBus.publish(createTestEvent({ sessionName: 'agent-joe' }));
      eventBus.publish(createTestEvent({ sessionName: 'agent-sam' }));

      expect(eventBus.getStats().deliveryCount).toBe(2);
    });
  });

  describe('cleanup', () => {
    it('should clear all subscriptions', () => {
      eventBus.subscribe(createTestSubscriptionInput());
      eventBus.subscribe(createTestSubscriptionInput({
        subscriberSession: 'other',
      }));

      eventBus.cleanup();

      expect(eventBus.listSubscriptions()).toHaveLength(0);
    });
  });

  describe('critical event immediate delivery', () => {
    it('should deliver task:completed events immediately without debounce', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: ['task:completed'],
      }));

      eventBus.publish(createTestEvent({
        type: 'task:completed' as any,
        sessionName: 'agent-sam',
        memberName: 'Sam',
        newValue: 'completed',
        changedField: 'taskStatus',
      }));

      // Should be delivered IMMEDIATELY — no need to advance timers
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
      const call = mockQueueService.enqueue.mock.calls[0][0];
      expect(call.targetSession).toBe('crewly-orc');
      expect(call.source).toBe('system_event');
    });

    it('should deliver task:failed events immediately without debounce', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: ['task:failed'],
      }));

      eventBus.publish(createTestEvent({
        type: 'task:failed' as any,
        sessionName: 'agent-sam',
        memberName: 'Sam',
        newValue: 'failed',
        changedField: 'taskStatus',
      }));

      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should deliver agent:inactive events immediately', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: ['agent:inactive'],
      }));

      eventBus.publish(createTestEvent({
        type: 'agent:inactive',
        sessionName: 'agent-sam',
        memberName: 'Sam',
        newValue: 'inactive',
        changedField: 'agentStatus',
      }));

      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should deliver agent:context_critical events immediately', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: ['agent:context_critical'],
      }));

      eventBus.publish(createTestEvent({
        type: 'agent:context_critical',
        sessionName: 'agent-sam',
        memberName: 'Sam',
        newValue: '95%',
        changedField: 'contextUsage',
      }));

      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should still debounce info events (agent:busy)', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: ['agent:busy'],
      }));

      eventBus.publish(createTestEvent({
        type: 'agent:busy',
        sessionName: 'agent-sam',
        memberName: 'Sam',
        newValue: 'in_progress',
      }));

      // NOT delivered yet — still in debounce buffer
      expect(mockQueueService.enqueue).not.toHaveBeenCalled();

      // Advance past debounce window
      jest.advanceTimersByTime(5000);
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should not buffer critical events in pendingNotifications', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: ['task:completed'],
      }));

      eventBus.publish(createTestEvent({
        type: 'task:completed' as any,
        sessionName: 'agent-sam',
        newValue: 'completed',
        changedField: 'taskStatus',
      }));

      // Critical event should NOT be in pending buffer
      expect((eventBus as any).pendingNotifications.size).toBe(0);
      // But should have been delivered
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should deliver agent:idle immediately as critical event', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: ['agent:idle'],
      }));

      eventBus.publish(createTestEvent({
        type: 'agent:idle',
        sessionName: 'agent-sam',
        memberName: 'Sam',
        newValue: 'idle',
        changedField: 'workingStatus',
      }));

      // agent:idle is now critical — delivered immediately, not buffered
      expect((eventBus as any).pendingNotifications.size).toBe(0);
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('MAX_BATCH_WAIT hard deadline', () => {
    it('should force flush when MAX_BATCH_WAIT_MS is reached even if debounce keeps resetting', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: ['agent:busy'],
      }));

      // Publish events every 4s (within 5s debounce window), so debounce timer keeps resetting
      for (let i = 0; i < 7; i++) {
        eventBus.publish(createTestEvent({ sessionName: `agent-${i}`, type: 'agent:busy' }));
        jest.advanceTimersByTime(4000);
      }
      // After 7*4s = 28s, still under MAX_BATCH_WAIT_MS (30s) but debounce hasn't flushed
      // because timer keeps resetting. But the maxWaitTimer was set at first event.

      // Advance to 30s total (2s more) — MAX_BATCH_WAIT forces flush
      jest.advanceTimersByTime(2000);

      expect(mockQueueService.enqueue).toHaveBeenCalled();
    });
  });

  describe('publish dedup and flush', () => {
    it('should suppress duplicate publish events within debounce window', () => {
      eventBus.subscribe(createTestSubscriptionInput({ oneShot: false }));

      // Publish same event (same type + sessionName) twice within 5s
      eventBus.publish(createTestEvent({ type: 'agent:busy', sessionName: 'agent-joe' }));
      eventBus.publish(createTestEvent({ type: 'agent:busy', sessionName: 'agent-joe' }));

      jest.advanceTimersByTime(5000);

      // Second publish was silently ignored by the recentPublishMap dedup guard
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should allow same event after debounce window expires', () => {
      eventBus.subscribe(createTestSubscriptionInput({ oneShot: false }));

      // First publish
      eventBus.publish(createTestEvent({ type: 'agent:busy', sessionName: 'agent-joe' }));

      // Advance past debounce window — flushes the first notification
      jest.advanceTimersByTime(5001);
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);

      // Publish same event again — allowed because debounce window has expired
      eventBus.publish(createTestEvent({ type: 'agent:busy', sessionName: 'agent-joe' }));

      // Flush the second notification
      jest.advanceTimersByTime(5000);
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should clean up recentPublishMap when it exceeds 100 entries', () => {
      eventBus.subscribe(createTestSubscriptionInput({
        oneShot: false,
        filter: {},
        eventType: 'agent:busy',
      }));

      // Publish 100 events with unique sessionNames
      for (let i = 0; i < 100; i++) {
        eventBus.publish(createTestEvent({ sessionName: `agent-${i}` }));
      }
      expect((eventBus as any).recentPublishMap.size).toBe(100);

      // Advance past debounce window so existing entries become stale
      jest.advanceTimersByTime(5001);

      // Publish the 101st event — triggers cleanup of stale entries
      eventBus.publish(createTestEvent({ sessionName: 'agent-101' }));

      // Old entries (older than debounce window) should have been removed
      expect((eventBus as any).recentPublishMap.size).toBeLessThanOrEqual(1);
    });

    it('should flush pending notifications on cleanup', () => {
      eventBus.subscribe(createTestSubscriptionInput({ oneShot: false }));
      eventBus.publish(createTestEvent());

      // Do NOT advance timers — notification is still buffered
      expect(mockQueueService.enqueue).not.toHaveBeenCalled();

      // cleanup() should flush pending notifications before clearing state
      eventBus.cleanup();

      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should discard buffered notifications when messageQueueService not set', () => {
      const busNoQueue = new EventBusService();
      busNoQueue.subscribe(createTestSubscriptionInput({ oneShot: false }));

      // Publish an event without a queue service set — should not throw
      expect(() => {
        busNoQueue.publish(createTestEvent());
      }).not.toThrow();

      // Advance timers to trigger flush
      jest.advanceTimersByTime(5000);

      // No enqueue should have been called since no queue service is available
      expect(mockQueueService.enqueue).not.toHaveBeenCalled();

      busNoQueue.cleanup();
    });

    it('should set targetSession to subscriberSession when flushing', () => {
      // Subscribe with a specific subscriber session
      eventBus.subscribe(createTestSubscriptionInput({
        subscriberSession: 'crewly-assistant',
        oneShot: false,
      }));

      // Publish event
      eventBus.publish(createTestEvent());

      // Advance timers to trigger flush
      jest.advanceTimersByTime(5000);

      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(1);
      const enqueueArg = mockQueueService.enqueue.mock.calls[0][0];
      expect(enqueueArg.targetSession).toBe('crewly-assistant');
      expect(enqueueArg.source).toBe('system_event');
    });

    it('should group notifications by subscriber and deliver separately', () => {
      // Two subscribers watching the same agent
      eventBus.subscribe(createTestSubscriptionInput({
        subscriberSession: 'crewly-orc',
        oneShot: false,
      }));
      eventBus.subscribe(createTestSubscriptionInput({
        subscriberSession: 'crewly-assistant',
        oneShot: false,
      }));

      // Publish event — both subscribers should get it
      eventBus.publish(createTestEvent());

      // Advance timers to trigger flush
      jest.advanceTimersByTime(5000);

      // Should enqueue separately for each subscriber
      expect(mockQueueService.enqueue).toHaveBeenCalledTimes(2);
      const targets = mockQueueService.enqueue.mock.calls.map(
        (c: any) => c[0].targetSession
      );
      expect(targets).toContain('crewly-orc');
      expect(targets).toContain('crewly-assistant');
    });
  });
});
