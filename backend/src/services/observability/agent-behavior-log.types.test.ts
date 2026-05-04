/**
 * Tests for `agent-behavior-log.types`.
 *
 * @module services/observability/agent-behavior-log.types.test
 */

import {
  BEHAVIOR_LOG_EVENT_TYPES,
  isBehaviorLogEventType,
} from './agent-behavior-log.types.js';

describe('agent-behavior-log.types', () => {
  describe('BEHAVIOR_LOG_EVENT_TYPES', () => {
    it('exposes the four canonical event types', () => {
      expect(BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION).toBe('agent.action');
      expect(BEHAVIOR_LOG_EVENT_TYPES.AGENT_ESCALATION).toBe('agent.escalation');
      expect(BEHAVIOR_LOG_EVENT_TYPES.SLACK_DELIVERY_FAILED).toBe(
        'slack.delivery.failed',
      );
      expect(BEHAVIOR_LOG_EVENT_TYPES.PROMPT_SIZE_BYTES).toBe('prompt.size.bytes');
    });

    it('every value is a unique non-empty string', () => {
      const values = Object.values(BEHAVIOR_LOG_EVENT_TYPES);
      expect(values.every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    });
  });

  describe('isBehaviorLogEventType', () => {
    it('returns true for every canonical event type', () => {
      for (const v of Object.values(BEHAVIOR_LOG_EVENT_TYPES)) {
        expect(isBehaviorLogEventType(v)).toBe(true);
      }
    });

    it('returns false for unknown strings', () => {
      expect(isBehaviorLogEventType('agent.unknown')).toBe(false);
      expect(isBehaviorLogEventType('')).toBe(false);
      expect(isBehaviorLogEventType('Agent.Action')).toBe(false);
    });
  });
});
