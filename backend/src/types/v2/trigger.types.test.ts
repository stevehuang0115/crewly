/**
 * Tests for V2 Trigger Type Definitions
 *
 * @module types/v2/trigger.types.test
 */

import {
  TRIGGER_TYPES,
  TRIGGER_STATUSES,
  DEFAULT_MAX_IDLE_FIRES,
  isValidTriggerType,
  isValidTriggerStatus,
  isValidTriggerConfig,
  isTrigger,
  isValidTriggerAction,
  validateCreateTriggerInput,
  createTrigger,
} from './trigger.types.js';
import type {
  TimeTriggerConfig,
  SignalTriggerConfig,
  CompoundTriggerConfig,
  TriggerAction,
  CreateTriggerInput,
  Trigger,
} from './trigger.types.js';

describe('Trigger Types', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('TRIGGER_TYPES', () => {
    it('should contain time, signal, compound', () => {
      expect(TRIGGER_TYPES).toEqual(['time', 'signal', 'compound']);
    });
  });

  describe('TRIGGER_STATUSES', () => {
    it('should contain 4 statuses', () => {
      expect(TRIGGER_STATUSES).toHaveLength(4);
      expect(TRIGGER_STATUSES).toContain('active');
      expect(TRIGGER_STATUSES).toContain('paused');
      expect(TRIGGER_STATUSES).toContain('exhausted');
      expect(TRIGGER_STATUSES).toContain('cancelled');
    });
  });

  describe('DEFAULT_MAX_IDLE_FIRES', () => {
    it('should be 3 (from v1 issue #131)', () => {
      expect(DEFAULT_MAX_IDLE_FIRES).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Type Guards
  // -----------------------------------------------------------------------
  describe('isValidTriggerType', () => {
    it('should return true for valid types', () => {
      for (const t of TRIGGER_TYPES) {
        expect(isValidTriggerType(t)).toBe(true);
      }
    });
    it('should return false for invalid types', () => {
      expect(isValidTriggerType('webhook')).toBe(false);
    });
  });

  describe('isValidTriggerStatus', () => {
    it('should return true for valid statuses', () => {
      for (const s of TRIGGER_STATUSES) {
        expect(isValidTriggerStatus(s)).toBe(true);
      }
    });
    it('should return false for invalid statuses', () => {
      expect(isValidTriggerStatus('disabled')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Config Validation
  // -----------------------------------------------------------------------
  describe('isValidTriggerConfig', () => {
    it('should validate time config with cronExpression', () => {
      const config: TimeTriggerConfig = { type: 'time', cronExpression: '0 9 * * 1' };
      expect(isValidTriggerConfig(config)).toBe(true);
    });
    it('should validate time config with delayMs', () => {
      const config: TimeTriggerConfig = { type: 'time', delayMs: 5000 };
      expect(isValidTriggerConfig(config)).toBe(true);
    });
    it('should validate time config with fireAt', () => {
      const config: TimeTriggerConfig = { type: 'time', fireAt: new Date().toISOString() };
      expect(isValidTriggerConfig(config)).toBe(true);
    });
    it('should reject time config with no scheduling field', () => {
      const config: TimeTriggerConfig = { type: 'time' };
      expect(isValidTriggerConfig(config)).toBe(false);
    });

    it('should validate signal config with eventType', () => {
      const config: SignalTriggerConfig = { type: 'signal', eventType: 'agent:idle' };
      expect(isValidTriggerConfig(config)).toBe(true);
    });
    it('should reject signal config with empty eventType', () => {
      const config: SignalTriggerConfig = { type: 'signal', eventType: '' };
      expect(isValidTriggerConfig(config)).toBe(false);
    });

    // autonomy_v1.f1 — source filter validation
    it("should accept signal config with source = 'local'", () => {
      const config: SignalTriggerConfig = { type: 'signal', eventType: 'agent:idle', source: 'local' };
      expect(isValidTriggerConfig(config)).toBe(true);
    });
    it("should accept signal config with source = 'remote'", () => {
      const config: SignalTriggerConfig = { type: 'signal', eventType: 'agent:idle', source: 'remote' };
      expect(isValidTriggerConfig(config)).toBe(true);
    });
    it("should accept signal config with source = 'any'", () => {
      const config: SignalTriggerConfig = { type: 'signal', eventType: 'agent:idle', source: 'any' };
      expect(isValidTriggerConfig(config)).toBe(true);
    });
    it('should accept signal config with source unset (defaults at evaluation)', () => {
      const config: SignalTriggerConfig = { type: 'signal', eventType: 'agent:idle' };
      expect(isValidTriggerConfig(config)).toBe(true);
    });
    it('should reject signal config with malformed source value', () => {
      // Reject typos / unknown values at registration so they surface
      // immediately rather than silently coercing to default.
      const config = { type: 'signal', eventType: 'agent:idle', source: 'global' } as unknown as SignalTriggerConfig;
      expect(isValidTriggerConfig(config)).toBe(false);
    });

    it('should validate compound config', () => {
      const config: CompoundTriggerConfig = {
        type: 'compound',
        operator: 'and',
        conditions: [
          { type: 'time', cronExpression: '0 9 * * 1' },
          { type: 'signal', eventType: 'agent:idle' },
        ],
      };
      expect(isValidTriggerConfig(config)).toBe(true);
    });
    it('should reject compound config with empty conditions', () => {
      const config: CompoundTriggerConfig = {
        type: 'compound',
        operator: 'or',
        conditions: [],
      };
      expect(isValidTriggerConfig(config)).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isValidTriggerConfig(null as unknown as TimeTriggerConfig)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Action Validation
  // -----------------------------------------------------------------------
  describe('isValidTriggerAction', () => {
    it('should return true for action with createWorkItem', () => {
      const action: TriggerAction = { createWorkItem: { type: 'check' } };
      expect(isValidTriggerAction(action)).toBe(true);
    });
    it('should return true for action with wakeWorkItemId', () => {
      const action: TriggerAction = { wakeWorkItemId: 'wi-001' };
      expect(isValidTriggerAction(action)).toBe(true);
    });
    it('should return true for action with sendMessage', () => {
      const action: TriggerAction = { sendMessage: { target: 'agent-1', message: 'hello' } };
      expect(isValidTriggerAction(action)).toBe(true);
    });
    it('should return true for action with runReconciler', () => {
      const action: TriggerAction = { runReconciler: true };
      expect(isValidTriggerAction(action)).toBe(true);
    });
    it('should return false for empty action', () => {
      const action: TriggerAction = {};
      expect(isValidTriggerAction(action)).toBe(false);
    });
    it('should return false for null', () => {
      expect(isValidTriggerAction(null as unknown as TriggerAction)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // isTrigger Type Guard
  // -----------------------------------------------------------------------
  describe('isTrigger', () => {
    const validTrigger: Trigger = {
      id: 'trig-001',
      type: 'time',
      config: { type: 'time', cronExpression: '0 9 * * 1' },
      action: { runReconciler: true },
      status: 'active',
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      fireCount: 0,
      maxIdleFires: 3,
      consecutiveIdleFires: 0,
    };

    it('should return true for valid Trigger', () => {
      expect(isTrigger(validTrigger)).toBe(true);
    });
    it('should return false for null', () => {
      expect(isTrigger(null)).toBe(false);
    });
    it('should return false for invalid type', () => {
      expect(isTrigger({ ...validTrigger, type: 'webhook' })).toBe(false);
    });
    it('should return false for invalid status', () => {
      expect(isTrigger({ ...validTrigger, status: 'disabled' })).toBe(false);
    });
    it('should return false for missing fireCount', () => {
      const { fireCount: _, ...incomplete } = validTrigger;
      expect(isTrigger(incomplete)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  describe('validateCreateTriggerInput', () => {
    const validInput: CreateTriggerInput = {
      type: 'time',
      config: { type: 'time', cronExpression: '0 9 * * 1' },
      action: { runReconciler: true },
      createdBy: 'system',
    };

    it('should return empty array for valid input', () => {
      expect(validateCreateTriggerInput(validInput)).toEqual([]);
    });
    it('should error on invalid type', () => {
      const errors = validateCreateTriggerInput({ ...validInput, type: 'webhook' as 'time' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on missing config', () => {
      const errors = validateCreateTriggerInput({
        ...validInput,
        config: undefined as unknown as TimeTriggerConfig,
      });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on invalid config', () => {
      const errors = validateCreateTriggerInput({
        ...validInput,
        config: { type: 'time' } as TimeTriggerConfig,
      });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on empty action', () => {
      const errors = validateCreateTriggerInput({ ...validInput, action: {} });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on non-positive maxFires', () => {
      const errors = validateCreateTriggerInput({ ...validInput, maxFires: 0 });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on non-positive maxIdleFires', () => {
      const errors = validateCreateTriggerInput({ ...validInput, maxIdleFires: 0 });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------
  describe('createTrigger', () => {
    const input: CreateTriggerInput = {
      type: 'signal',
      config: { type: 'signal', eventType: 'task:completed' },
      action: { createWorkItem: { type: 'check', title: 'Verify completion' } },
      createdBy: 'orchestrator',
    };

    it('should create a Trigger with status active', () => {
      const trigger = createTrigger(input);
      expect(trigger.status).toBe('active');
    });
    it('should generate a UUID id', () => {
      const trigger = createTrigger(input);
      expect(trigger.id).toMatch(/^[0-9a-f]{8}-/);
    });
    it('should initialize fireCount to 0', () => {
      const trigger = createTrigger(input);
      expect(trigger.fireCount).toBe(0);
    });
    it('should set default maxIdleFires', () => {
      const trigger = createTrigger(input);
      expect(trigger.maxIdleFires).toBe(DEFAULT_MAX_IDLE_FIRES);
    });
    it('should respect custom maxIdleFires', () => {
      const trigger = createTrigger({ ...input, maxIdleFires: 5 });
      expect(trigger.maxIdleFires).toBe(5);
    });
    it('should initialize consecutiveIdleFires to 0', () => {
      const trigger = createTrigger(input);
      expect(trigger.consecutiveIdleFires).toBe(0);
    });
    it('should set createdBy from input', () => {
      const trigger = createTrigger(input);
      expect(trigger.createdBy).toBe('orchestrator');
    });
    it('should set ISO8601 createdAt', () => {
      const trigger = createTrigger(input);
      expect(() => new Date(trigger.createdAt)).not.toThrow();
    });
  });
});
