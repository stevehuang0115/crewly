/**
 * Tests for V2 Request Type Definitions
 *
 * @module types/v2/request.types.test
 */

import {
  REQUEST_STATUSES,
  TERMINAL_REQUEST_STATUSES,
  INTENT_CATEGORIES,
  REQUEST_TRANSITIONS,
  isValidRequestStatus,
  isValidIntentCategory,
  isValidRequestTransition,
  isRequest,
  validateCreateRequestInput,
  createRequest,
} from './request.types.js';
import type { CreateRequestInput, Request } from './request.types.js';

describe('Request Types', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('REQUEST_STATUSES', () => {
    it('should contain all 7 statuses', () => {
      expect(REQUEST_STATUSES).toHaveLength(7);
      expect(REQUEST_STATUSES).toContain('open');
      expect(REQUEST_STATUSES).toContain('ready');
      expect(REQUEST_STATUSES).toContain('running');
      expect(REQUEST_STATUSES).toContain('blocked');
      expect(REQUEST_STATUSES).toContain('waiting_confirmation');
      expect(REQUEST_STATUSES).toContain('done');
      expect(REQUEST_STATUSES).toContain('cancelled');
    });
  });

  describe('TERMINAL_REQUEST_STATUSES', () => {
    it('should contain done and cancelled', () => {
      expect(TERMINAL_REQUEST_STATUSES.has('done')).toBe(true);
      expect(TERMINAL_REQUEST_STATUSES.has('cancelled')).toBe(true);
    });
    it('should not contain non-terminal statuses', () => {
      expect(TERMINAL_REQUEST_STATUSES.has('open')).toBe(false);
      expect(TERMINAL_REQUEST_STATUSES.has('running')).toBe(false);
    });
  });

  describe('INTENT_CATEGORIES', () => {
    it('should contain all 9 categories', () => {
      expect(INTENT_CATEGORIES).toHaveLength(9);
      expect(INTENT_CATEGORIES).toContain('query');
      expect(INTENT_CATEGORIES).toContain('code_change');
      expect(INTENT_CATEGORIES).toContain('other');
    });
  });

  // -----------------------------------------------------------------------
  // Type Guards
  // -----------------------------------------------------------------------
  describe('isValidRequestStatus', () => {
    it('should return true for valid statuses', () => {
      for (const status of REQUEST_STATUSES) {
        expect(isValidRequestStatus(status)).toBe(true);
      }
    });
    it('should return false for invalid statuses', () => {
      expect(isValidRequestStatus('invalid')).toBe(false);
      expect(isValidRequestStatus('')).toBe(false);
      expect(isValidRequestStatus('OPEN')).toBe(false);
    });
  });

  describe('isValidIntentCategory', () => {
    it('should return true for valid categories', () => {
      for (const cat of INTENT_CATEGORIES) {
        expect(isValidIntentCategory(cat)).toBe(true);
      }
    });
    it('should return false for invalid categories', () => {
      expect(isValidIntentCategory('unknown')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // State Machine Transitions
  // -----------------------------------------------------------------------
  describe('isValidRequestTransition', () => {
    it('should allow open → ready', () => {
      expect(isValidRequestTransition('open', 'ready')).toBe(true);
    });

    it('should allow open → done (auto-close dangling)', () => {
      expect(isValidRequestTransition('open', 'done')).toBe(true);
    });

    it('should allow open → cancelled', () => {
      expect(isValidRequestTransition('open', 'cancelled')).toBe(true);
    });
    it('should allow running → done', () => {
      expect(isValidRequestTransition('running', 'done')).toBe(true);
    });
    it('should allow running → blocked', () => {
      expect(isValidRequestTransition('running', 'blocked')).toBe(true);
    });
    it('should allow running → waiting_confirmation', () => {
      expect(isValidRequestTransition('running', 'waiting_confirmation')).toBe(true);
    });
    it('should allow blocked → running', () => {
      expect(isValidRequestTransition('blocked', 'running')).toBe(true);
    });
    it('should allow waiting_confirmation → done', () => {
      expect(isValidRequestTransition('waiting_confirmation', 'done')).toBe(true);
    });
    it('should allow waiting_confirmation → running (user rejected)', () => {
      expect(isValidRequestTransition('waiting_confirmation', 'running')).toBe(true);
    });
    it('should disallow done → any transition', () => {
      for (const status of REQUEST_STATUSES) {
        expect(isValidRequestTransition('done', status)).toBe(false);
      }
    });
    it('should disallow cancelled → any transition', () => {
      for (const status of REQUEST_STATUSES) {
        expect(isValidRequestTransition('cancelled', status)).toBe(false);
      }
    });
    it('should disallow open → running (must go through ready)', () => {
      expect(isValidRequestTransition('open', 'running')).toBe(false);
    });
  });

  describe('REQUEST_TRANSITIONS completeness', () => {
    it('should have an entry for every status', () => {
      for (const status of REQUEST_STATUSES) {
        expect(REQUEST_TRANSITIONS).toHaveProperty(status);
      }
    });
  });

  // -----------------------------------------------------------------------
  // isRequest Type Guard
  // -----------------------------------------------------------------------
  describe('isRequest', () => {
    const validRequest: Request = {
      id: 'req-001',
      sourceConversationItemId: 'conv-001',
      title: 'Test',
      description: 'desc',
      status: 'open',
      priority: 'normal',
      requiresConfirmation: false,
      workItemIds: [],
      intentLevel: 'L1',
      intentCategory: 'other',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
    };

    it('should return true for a valid Request', () => {
      expect(isRequest(validRequest)).toBe(true);
    });
    it('should return false for null', () => {
      expect(isRequest(null)).toBe(false);
    });
    it('should return false for non-object', () => {
      expect(isRequest('string')).toBe(false);
    });
    it('should return false for missing required fields', () => {
      expect(isRequest({ id: 'x' })).toBe(false);
    });
    it('should return false for invalid status', () => {
      expect(isRequest({ ...validRequest, status: 'bogus' })).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  describe('validateCreateRequestInput', () => {
    const validInput: CreateRequestInput = {
      sourceConversationItemId: 'conv-001',
      title: 'Deploy staging',
      description: 'Deploy the current build',
    };

    it('should return empty array for valid input', () => {
      expect(validateCreateRequestInput(validInput)).toEqual([]);
    });
    it('should error on missing sourceConversationItemId', () => {
      const errors = validateCreateRequestInput({ ...validInput, sourceConversationItemId: '' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on missing title', () => {
      const errors = validateCreateRequestInput({ ...validInput, title: '' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on missing description', () => {
      const errors = validateCreateRequestInput({ ...validInput, description: '' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on invalid priority', () => {
      const errors = validateCreateRequestInput({ ...validInput, priority: 'urgent' as 'high' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on invalid intentCategory', () => {
      const errors = validateCreateRequestInput({ ...validInput, intentCategory: 'bogus' as 'query' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on invalid intentLevel', () => {
      const errors = validateCreateRequestInput({ ...validInput, intentLevel: 'L5' as 'L0' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should accept valid optional fields', () => {
      const errors = validateCreateRequestInput({
        ...validInput,
        priority: 'high',
        intentCategory: 'code_change',
        intentLevel: 'L2',
        tags: ['deploy'],
      });
      expect(errors).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------
  describe('createRequest', () => {
    const input: CreateRequestInput = {
      sourceConversationItemId: 'conv-001',
      title: 'Deploy staging',
      description: 'Deploy the current build to staging env',
    };

    it('should create a Request with status open', () => {
      const req = createRequest(input);
      expect(req.status).toBe('open');
    });
    it('should generate a UUID id', () => {
      const req = createRequest(input);
      expect(req.id).toMatch(/^[0-9a-f]{8}-/);
    });
    it('should set default priority to normal', () => {
      const req = createRequest(input);
      expect(req.priority).toBe('normal');
    });
    it('should set default intentLevel to L1', () => {
      const req = createRequest(input);
      expect(req.intentLevel).toBe('L1');
    });
    it('should set default intentCategory to other', () => {
      const req = createRequest(input);
      expect(req.intentCategory).toBe('other');
    });
    it('should initialize token counts to 0', () => {
      const req = createRequest(input);
      expect(req.totalInputTokens).toBe(0);
      expect(req.totalOutputTokens).toBe(0);
      expect(req.totalCost).toBe(0);
    });
    it('should initialize workItemIds as empty array', () => {
      const req = createRequest(input);
      expect(req.workItemIds).toEqual([]);
    });
    it('should set ISO8601 timestamps', () => {
      const req = createRequest(input);
      expect(() => new Date(req.createdAt)).not.toThrow();
      expect(req.createdAt).toBe(req.updatedAt);
    });
    it('should respect provided optional fields', () => {
      const req = createRequest({
        ...input,
        priority: 'high',
        intentLevel: 'L2',
        intentCategory: 'deployment',
        tags: ['staging', 'deploy'],
        requiresConfirmation: true,
        confirmationReason: 'Production deploy needs approval',
        missionId: 'mission-001',
      });
      expect(req.priority).toBe('high');
      expect(req.intentLevel).toBe('L2');
      expect(req.intentCategory).toBe('deployment');
      expect(req.tags).toEqual(['staging', 'deploy']);
      expect(req.requiresConfirmation).toBe(true);
      expect(req.confirmationReason).toBe('Production deploy needs approval');
      expect(req.missionId).toBe('mission-001');
    });
  });
});
