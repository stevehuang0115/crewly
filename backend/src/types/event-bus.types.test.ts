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
});
