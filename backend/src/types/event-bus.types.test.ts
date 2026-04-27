/**
 * Tests for Event Bus Types Module
 *
 * @module types/event-bus.test
 */

import {
  EVENT_TYPES,
  isValidEventType,
  isValidCreateSubscriptionInput,
  CRITICAL_EVENT_TYPES,
  INFO_EVENT_TYPES,
  isCriticalEventType,
  getCriticalEventTypes,
} from './event-bus.types.js';
import type {
  AgentEvent,
  EventType,
  CreateSubscriptionInput,
} from './event-bus.types.js';

describe('Event Bus Types', () => {
  describe('Constants', () => {
    it('should have correct event types', () => {
      expect(EVENT_TYPES).toEqual([
        // Agent lifecycle events
        'agent:status_changed',
        'agent:idle',
        'agent:busy',
        'agent:active',
        'agent:inactive',
        'agent:context_warning',
        'agent:context_critical',
        'agent:oauth_url',
        // Hierarchical task events
        'task:submitted',
        'task:accepted',
        'task:working',
        'task:input_required',
        'task:verification_requested',
        'task:completed',
        'task:failed',
        'task:cancelled',
        // Architecture Upgrade: Task Event Chain (Phase 6)
        'task:assigned',
        'task:done',
        'task:verified',
        'task:blocked',
        'task:needs_clarification',
        'team:all_tasks_done',
        // BRIDGE-1 worker / verification lifecycle events
        'task:done_by_worker',
        'task:rejected',
        // BRIDGE-1 mission-level events
        'mission:review_due',
        'mission:stale',
        'mission:replanned',
        // INBOUND-1 Request lifecycle events
        'request:created',
        'request:sla_breached',
        // INBOUND-1.f1 WorkItem queue mutation event
        'workitem:queued',
        // Hierarchy communication events
        'hierarchy:escalation',
        'hierarchy:delegation',
        'hierarchy:report_up',
      ]);
    });
  });

  describe('isValidEventType', () => {
    it('should return true for valid event types', () => {
      expect(isValidEventType('agent:status_changed')).toBe(true);
      expect(isValidEventType('agent:idle')).toBe(true);
      expect(isValidEventType('agent:busy')).toBe(true);
      expect(isValidEventType('agent:active')).toBe(true);
      expect(isValidEventType('agent:inactive')).toBe(true);
      expect(isValidEventType('agent:context_warning')).toBe(true);
      expect(isValidEventType('agent:context_critical')).toBe(true);
      expect(isValidEventType('agent:oauth_url')).toBe(true);
    });

    it('should return true for new task event types', () => {
      expect(isValidEventType('task:submitted')).toBe(true);
      expect(isValidEventType('task:accepted')).toBe(true);
      expect(isValidEventType('task:working')).toBe(true);
      expect(isValidEventType('task:input_required')).toBe(true);
      expect(isValidEventType('task:verification_requested')).toBe(true);
      expect(isValidEventType('task:completed')).toBe(true);
      expect(isValidEventType('task:failed')).toBe(true);
      expect(isValidEventType('task:cancelled')).toBe(true);
    });

    it('should return true for hierarchy event types', () => {
      expect(isValidEventType('hierarchy:escalation')).toBe(true);
      expect(isValidEventType('hierarchy:delegation')).toBe(true);
      expect(isValidEventType('hierarchy:report_up')).toBe(true);
    });

    it('should return true for BRIDGE-1 worker / verification event types', () => {
      expect(isValidEventType('task:done_by_worker')).toBe(true);
      expect(isValidEventType('task:rejected')).toBe(true);
    });

    it('should return true for BRIDGE-1 mission-level event types', () => {
      expect(isValidEventType('mission:review_due')).toBe(true);
      expect(isValidEventType('mission:stale')).toBe(true);
      expect(isValidEventType('mission:replanned')).toBe(true);
    });

    it('should return true for INBOUND-1.f1 workitem:queued event type', () => {
      expect(isValidEventType('workitem:queued')).toBe(true);
    });

    it('should return false for invalid event types', () => {
      expect(isValidEventType('agent:unknown')).toBe(false);
      expect(isValidEventType('')).toBe(false);
      expect(isValidEventType(null)).toBe(false);
      expect(isValidEventType(undefined)).toBe(false);
      expect(isValidEventType(123)).toBe(false);
      expect(isValidEventType('idle')).toBe(false);
    });
  });

  describe('Event Priority Classification', () => {
    it('should have every EVENT_TYPE classified as either critical or info', () => {
      for (const eventType of EVENT_TYPES) {
        const isCritical = CRITICAL_EVENT_TYPES.has(eventType);
        const isInfo = INFO_EVENT_TYPES.has(eventType);
        expect(isCritical || isInfo).toBe(true);
        // No event should be in both sets
        expect(isCritical && isInfo).toBe(false);
      }
    });

    it('should classify task completions and failures as critical', () => {
      expect(CRITICAL_EVENT_TYPES.has('task:completed')).toBe(true);
      expect(CRITICAL_EVENT_TYPES.has('task:failed')).toBe(true);
      expect(CRITICAL_EVENT_TYPES.has('task:cancelled')).toBe(true);
      expect(CRITICAL_EVENT_TYPES.has('task:input_required')).toBe(true);
    });

    it('should classify agent crashes and context exhaustion as critical', () => {
      expect(CRITICAL_EVENT_TYPES.has('agent:inactive')).toBe(true);
      expect(CRITICAL_EVENT_TYPES.has('agent:context_critical')).toBe(true);
    });

    it('should classify hierarchy escalations as critical', () => {
      expect(CRITICAL_EVENT_TYPES.has('hierarchy:escalation')).toBe(true);
    });

    it('should classify agent:idle as critical (worker completion is time-sensitive)', () => {
      expect(CRITICAL_EVENT_TYPES.has('agent:idle' as EventType)).toBe(true);
      expect(INFO_EVENT_TYPES.has('agent:idle' as EventType)).toBe(false);
    });

    it('should classify busy/status_changed toggles as info (not critical)', () => {
      expect(CRITICAL_EVENT_TYPES.has('agent:busy' as EventType)).toBe(false);
      expect(CRITICAL_EVENT_TYPES.has('agent:status_changed' as EventType)).toBe(false);
      expect(INFO_EVENT_TYPES.has('agent:busy')).toBe(true);
    });

    it('should classify BRIDGE-1 events as critical (queue-creating)', () => {
      // Worker/verification events drive WorkItem creation in BRIDGE-1; if any
      // of these get debounced into oblivion the autonomy chain stalls.
      expect(CRITICAL_EVENT_TYPES.has('task:done_by_worker')).toBe(true);
      expect(CRITICAL_EVENT_TYPES.has('task:rejected')).toBe(true);
      expect(CRITICAL_EVENT_TYPES.has('mission:review_due')).toBe(true);
      expect(CRITICAL_EVENT_TYPES.has('mission:stale')).toBe(true);
      expect(CRITICAL_EVENT_TYPES.has('mission:replanned')).toBe(true);
    });

    it('should classify INBOUND-1 request events as critical (user-visible)', () => {
      // request:created seeds the SLA WI for the orc; request:sla_breached
      // surfaces the missed-response signal — both must bypass debounce.
      expect(CRITICAL_EVENT_TYPES.has('request:created')).toBe(true);
      expect(CRITICAL_EVENT_TYPES.has('request:sla_breached')).toBe(true);
    });

    it('should classify INBOUND-1.f1 workitem:queued as critical (queue mutations are user-visible)', () => {
      // workitem:queued drives the auto-close path b — every decomposition
      // must dispatch exactly once or the SLA chain keeps ticking.
      expect(CRITICAL_EVENT_TYPES.has('workitem:queued')).toBe(true);
    });
  });

  describe('isCriticalEventType', () => {
    it('should return true for critical event types', () => {
      expect(isCriticalEventType('task:completed')).toBe(true);
      expect(isCriticalEventType('task:failed')).toBe(true);
      expect(isCriticalEventType('agent:inactive')).toBe(true);
      expect(isCriticalEventType('agent:context_critical')).toBe(true);
      expect(isCriticalEventType('hierarchy:escalation')).toBe(true);
    });

    it('should return false for info event types', () => {
      expect(isCriticalEventType('agent:busy')).toBe(false);
      expect(isCriticalEventType('agent:status_changed')).toBe(false);
      expect(isCriticalEventType('agent:active')).toBe(false);
    });

    it('should return false for unknown event types', () => {
      expect(isCriticalEventType('unknown:event')).toBe(false);
    });
  });

  describe('getCriticalEventTypes', () => {
    it('should return an array of all critical event types', () => {
      const types = getCriticalEventTypes();
      expect(Array.isArray(types)).toBe(true);
      expect(types.length).toBe(CRITICAL_EVENT_TYPES.size);
      for (const type of types) {
        expect(CRITICAL_EVENT_TYPES.has(type)).toBe(true);
      }
    });

    it('should return a new array each time (not shared reference)', () => {
      const a = getCriticalEventTypes();
      const b = getCriticalEventTypes();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('isValidCreateSubscriptionInput', () => {
    const validInput: CreateSubscriptionInput = {
      eventType: 'agent:idle',
      filter: { sessionName: 'agent-joe' },
      subscriberSession: 'crewly-orc',
    };

    it('should return true for valid input with single event type', () => {
      expect(isValidCreateSubscriptionInput(validInput)).toBe(true);
    });

    it('should return true for valid input with array of event types', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        eventType: ['agent:idle', 'agent:busy'],
      })).toBe(true);
    });

    it('should return true for valid input with all optional fields', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        oneShot: true,
        ttlMinutes: 60,
        messageTemplate: 'Agent {memberName} is now {newValue}',
      })).toBe(true);
    });

    it('should return false for null or non-object', () => {
      expect(isValidCreateSubscriptionInput(null)).toBe(false);
      expect(isValidCreateSubscriptionInput(undefined)).toBe(false);
      expect(isValidCreateSubscriptionInput('string')).toBe(false);
      expect(isValidCreateSubscriptionInput(123)).toBe(false);
    });

    it('should return false for invalid eventType', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        eventType: 'agent:unknown',
      })).toBe(false);
    });

    it('should return false for empty eventType array', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        eventType: [],
      })).toBe(false);
    });

    it('should return false for array with invalid event types', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        eventType: ['agent:idle', 'invalid'],
      })).toBe(false);
    });

    it('should return false for missing filter', () => {
      expect(isValidCreateSubscriptionInput({
        eventType: 'agent:idle',
        subscriberSession: 'orc',
      })).toBe(false);
    });

    it('should return false for non-object filter', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        filter: 'not-object',
      })).toBe(false);
    });

    it('should return false for empty subscriberSession', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        subscriberSession: '',
      })).toBe(false);
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        subscriberSession: '   ',
      })).toBe(false);
    });

    it('should return false for non-string subscriberSession', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        subscriberSession: 123,
      })).toBe(false);
    });

    it('should return false for invalid ttlMinutes', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        ttlMinutes: 0,
      })).toBe(false);
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        ttlMinutes: -5,
      })).toBe(false);
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        ttlMinutes: 'thirty',
      })).toBe(false);
    });

    it('should return false for non-boolean oneShot', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        oneShot: 'true',
      })).toBe(false);
    });

    it('should return false for non-string messageTemplate', () => {
      expect(isValidCreateSubscriptionInput({
        ...validInput,
        messageTemplate: 123,
      })).toBe(false);
    });
  });

  describe('AgentEvent BRIDGE-1 correlation fields', () => {
    /**
     * Build a minimal AgentEvent. The new `workItemId` / `missionId` fields
     * are optional, so the BRIDGE-1 contract tests assert both presence and
     * absence — publishers without the value in scope must still produce a
     * valid event (bridge falls back to a storage lookup keyed on `taskId`).
     */
    function buildEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
      return {
        id: 'evt-1',
        type: 'task:done_by_worker',
        timestamp: new Date().toISOString(),
        teamId: 'team-1',
        teamName: 'Crewly Product',
        memberId: 'm-1',
        memberName: 'Leo',
        sessionName: 'crewly-product-leo',
        previousValue: 'running',
        newValue: 'done_by_worker',
        changedField: 'taskStatus',
        ...overrides,
      };
    }

    it('accepts workItemId on task events when publisher has it in scope', () => {
      const event = buildEvent({ workItemId: 'wi-123' });
      expect(event.workItemId).toBe('wi-123');
    });

    it('accepts missionId on mission events', () => {
      const event = buildEvent({
        type: 'mission:review_due',
        missionId: 'mission-abc',
      });
      expect(event.missionId).toBe('mission-abc');
    });

    it('keeps both fields optional for backward-compat', () => {
      const event = buildEvent();
      expect(event.workItemId).toBeUndefined();
      expect(event.missionId).toBeUndefined();
    });
  });
});
