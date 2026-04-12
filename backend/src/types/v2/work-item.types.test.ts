/**
 * Tests for V2 WorkItem Type Definitions
 *
 * @module types/v2/work-item.types.test
 */

import {
  WORK_ITEM_TYPES,
  WORK_ITEM_OWNERS,
  WORK_ITEM_STATUSES,
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  DEFAULT_MAX_RETRIES,
  isValidWorkItemType,
  isValidWorkItemStatus,
  isValidWorkItemOwner,
  isValidWorkItemTransition,
  isWorkItem,
  validateCreateWorkItemInput,
  createWorkItem,
} from './work-item.types.js';
import type { CreateWorkItemInput, WorkItem } from './work-item.types.js';

describe('WorkItem Types', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('WORK_ITEM_TYPES', () => {
    it('should contain all 8 types', () => {
      expect(WORK_ITEM_TYPES).toHaveLength(8);
      expect(WORK_ITEM_TYPES).toContain('delegate');
      expect(WORK_ITEM_TYPES).toContain('project_task');
      expect(WORK_ITEM_TYPES).toContain('check');
      expect(WORK_ITEM_TYPES).toContain('notify');
      expect(WORK_ITEM_TYPES).toContain('cron_run');
      expect(WORK_ITEM_TYPES).toContain('review');
      expect(WORK_ITEM_TYPES).toContain('confirm');
      expect(WORK_ITEM_TYPES).toContain('reconcile');
    });
  });

  describe('WORK_ITEM_STATUSES', () => {
    it('should contain all 7 statuses', () => {
      expect(WORK_ITEM_STATUSES).toHaveLength(7);
    });
  });

  describe('TERMINAL_WORK_ITEM_STATUSES', () => {
    it('should contain done and cancelled', () => {
      expect(TERMINAL_WORK_ITEM_STATUSES.has('done')).toBe(true);
      expect(TERMINAL_WORK_ITEM_STATUSES.has('cancelled')).toBe(true);
    });
    it('should have exactly 2 entries', () => {
      expect(TERMINAL_WORK_ITEM_STATUSES.size).toBe(2);
    });
  });

  describe('DEFAULT_MAX_RETRIES', () => {
    it('should be 3', () => {
      expect(DEFAULT_MAX_RETRIES).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Type Guards
  // -----------------------------------------------------------------------
  describe('isValidWorkItemType', () => {
    it('should return true for all valid types', () => {
      for (const t of WORK_ITEM_TYPES) {
        expect(isValidWorkItemType(t)).toBe(true);
      }
    });
    it('should return false for invalid types', () => {
      expect(isValidWorkItemType('unknown')).toBe(false);
      expect(isValidWorkItemType('')).toBe(false);
    });
  });

  describe('isValidWorkItemStatus', () => {
    it('should return true for all valid statuses', () => {
      for (const s of WORK_ITEM_STATUSES) {
        expect(isValidWorkItemStatus(s)).toBe(true);
      }
    });
    it('should return false for invalid statuses', () => {
      expect(isValidWorkItemStatus('pending')).toBe(false);
    });
  });

  describe('isValidWorkItemOwner', () => {
    it('should return true for all valid owners', () => {
      for (const o of WORK_ITEM_OWNERS) {
        expect(isValidWorkItemOwner(o)).toBe(true);
      }
    });
    it('should return false for invalid owners', () => {
      expect(isValidWorkItemOwner('admin')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // State Machine Transitions
  // -----------------------------------------------------------------------
  describe('isValidWorkItemTransition', () => {
    it('should allow queued → running', () => {
      expect(isValidWorkItemTransition('queued', 'running')).toBe(true);
    });
    it('should allow queued → scheduled', () => {
      expect(isValidWorkItemTransition('queued', 'scheduled')).toBe(true);
    });
    it('should allow queued → cancelled', () => {
      expect(isValidWorkItemTransition('queued', 'cancelled')).toBe(true);
    });
    it('should allow scheduled → queued', () => {
      expect(isValidWorkItemTransition('scheduled', 'queued')).toBe(true);
    });
    it('should allow running → done', () => {
      expect(isValidWorkItemTransition('running', 'done')).toBe(true);
    });
    it('should allow running → failed', () => {
      expect(isValidWorkItemTransition('running', 'failed')).toBe(true);
    });
    it('should allow running → blocked', () => {
      expect(isValidWorkItemTransition('running', 'blocked')).toBe(true);
    });
    it('should allow blocked → queued', () => {
      expect(isValidWorkItemTransition('blocked', 'queued')).toBe(true);
    });
    it('should allow failed → queued (retry)', () => {
      expect(isValidWorkItemTransition('failed', 'queued')).toBe(true);
    });
    it('should disallow done → any', () => {
      for (const s of WORK_ITEM_STATUSES) {
        expect(isValidWorkItemTransition('done', s)).toBe(false);
      }
    });
    it('should disallow cancelled → any', () => {
      for (const s of WORK_ITEM_STATUSES) {
        expect(isValidWorkItemTransition('cancelled', s)).toBe(false);
      }
    });
    it('should disallow queued → done (must go through running)', () => {
      expect(isValidWorkItemTransition('queued', 'done')).toBe(false);
    });
  });

  describe('WORK_ITEM_TRANSITIONS completeness', () => {
    it('should have an entry for every status', () => {
      for (const status of WORK_ITEM_STATUSES) {
        expect(WORK_ITEM_TRANSITIONS).toHaveProperty(status);
      }
    });
  });

  // -----------------------------------------------------------------------
  // isWorkItem Type Guard
  // -----------------------------------------------------------------------
  describe('isWorkItem', () => {
    const validWorkItem: WorkItem = {
      id: 'wi-001',
      type: 'delegate',
      owner: 'agent',
      title: 'Test task',
      status: 'queued',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    it('should return true for a valid WorkItem', () => {
      expect(isWorkItem(validWorkItem)).toBe(true);
    });
    it('should return false for null', () => {
      expect(isWorkItem(null)).toBe(false);
    });
    it('should return false for non-object', () => {
      expect(isWorkItem(42)).toBe(false);
    });
    it('should return false for invalid type', () => {
      expect(isWorkItem({ ...validWorkItem, type: 'bogus' })).toBe(false);
    });
    it('should return false for invalid owner', () => {
      expect(isWorkItem({ ...validWorkItem, owner: 'nobody' })).toBe(false);
    });
    it('should return false for invalid status', () => {
      expect(isWorkItem({ ...validWorkItem, status: 'nope' })).toBe(false);
    });
    it('should return false for missing retryCount', () => {
      const { retryCount: _, ...incomplete } = validWorkItem;
      expect(isWorkItem(incomplete)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  describe('validateCreateWorkItemInput', () => {
    const validInput: CreateWorkItemInput = {
      type: 'delegate',
      owner: 'agent',
      title: 'Implement feature X',
      target: 'crewly-product-leo-member-n',
    };

    it('should return empty array for valid input', () => {
      expect(validateCreateWorkItemInput(validInput)).toEqual([]);
    });
    it('should error on invalid type', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, type: 'bogus' as 'delegate' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on invalid owner', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, owner: 'nobody' as 'agent' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on empty title', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, title: '' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on invalid scheduledAt', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, scheduledAt: 'not-a-date' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on negative maxRetries', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, maxRetries: -1 });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should accept valid scheduledAt', () => {
      const errors = validateCreateWorkItemInput({
        ...validInput,
        scheduledAt: new Date().toISOString(),
      });
      expect(errors).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------
  describe('createWorkItem', () => {
    const input: CreateWorkItemInput = {
      type: 'delegate',
      owner: 'agent',
      title: 'Implement TaskPoolService',
      target: 'crewly-product-leo-member-n',
      requestId: 'req-001',
    };

    it('should create a WorkItem with status queued', () => {
      const wi = createWorkItem(input);
      expect(wi.status).toBe('queued');
    });
    it('should set status to scheduled when scheduledAt is provided', () => {
      const wi = createWorkItem({
        ...input,
        scheduledAt: new Date(Date.now() + 60000).toISOString(),
      });
      expect(wi.status).toBe('scheduled');
    });
    it('should generate a UUID id', () => {
      const wi = createWorkItem(input);
      expect(wi.id).toMatch(/^[0-9a-f]{8}-/);
    });
    it('should default maxRetries to DEFAULT_MAX_RETRIES', () => {
      const wi = createWorkItem(input);
      expect(wi.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    });
    it('should respect custom maxRetries', () => {
      const wi = createWorkItem({ ...input, maxRetries: 5 });
      expect(wi.maxRetries).toBe(5);
    });
    it('should initialize retryCount to 0', () => {
      const wi = createWorkItem(input);
      expect(wi.retryCount).toBe(0);
    });
    it('should initialize token counts to 0', () => {
      const wi = createWorkItem(input);
      expect(wi.inputTokens).toBe(0);
      expect(wi.outputTokens).toBe(0);
      expect(wi.cost).toBe(0);
    });
    it('should set requestId from input', () => {
      const wi = createWorkItem(input);
      expect(wi.requestId).toBe('req-001');
    });
    it('should set target from input', () => {
      const wi = createWorkItem(input);
      expect(wi.target).toBe('crewly-product-leo-member-n');
    });
  });
});
