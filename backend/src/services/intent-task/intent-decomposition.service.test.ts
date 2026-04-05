/**
 * Tests for IntentDecompositionService
 *
 * Tests the utility layer: pre-filtering, regex fallback, and task creation.
 * The primary decomposition path (LLM-based) is handled by the orchestrator.
 *
 * @module services/intent-task/intent-decomposition.service.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntentDecompositionService } from './intent-decomposition.service.js';
import { IntentTaskService } from './intent-task.service.js';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// =============================================================================
// Mocks
// =============================================================================

// Mock LoggerService
vi.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
  },
}));

// =============================================================================
// Test Setup
// =============================================================================

describe('IntentDecompositionService', () => {
  let service: IntentDecompositionService;
  let tmpDir: string;
  let persistPath: string;

  beforeEach(() => {
    // Isolate IntentTaskService persistence
    tmpDir = mkdtempSync(join(tmpdir(), 'intent-decompose-test-'));
    persistPath = join(tmpDir, 'intent-tasks.json');
    IntentTaskService.setPersistencePath(persistPath);
    IntentTaskService.resetInstance();

    // Reset decomposition service
    IntentDecompositionService.resetInstance();
    service = new IntentDecompositionService();
  });

  afterEach(() => {
    IntentDecompositionService.resetInstance();
    IntentTaskService.resetInstance();
    IntentTaskService.setPersistencePath(undefined);
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  // ===========================================================================
  // isObviouslyNonActionable
  // ===========================================================================

  describe('isObviouslyNonActionable', () => {
    it('should return true for greetings', () => {
      expect(service.isObviouslyNonActionable('hi')).toBe(true);
      expect(service.isObviouslyNonActionable('hello!')).toBe(true);
      expect(service.isObviouslyNonActionable('Hey')).toBe(true);
      expect(service.isObviouslyNonActionable('thanks')).toBe(true);
      expect(service.isObviouslyNonActionable('bye')).toBe(true);
    });

    it('should return true for acknowledgments', () => {
      expect(service.isObviouslyNonActionable('ok')).toBe(true);
      expect(service.isObviouslyNonActionable('sure')).toBe(true);
      expect(service.isObviouslyNonActionable('got it')).toBe(true);
      expect(service.isObviouslyNonActionable('lgtm')).toBe(true);
      expect(service.isObviouslyNonActionable('great!')).toBe(true);
    });

    it('should return true for very short messages', () => {
      expect(service.isObviouslyNonActionable('ab')).toBe(true);
      expect(service.isObviouslyNonActionable('')).toBe(true);
    });

    it('should return false for actionable messages', () => {
      expect(service.isObviouslyNonActionable('Fix the login bug')).toBe(false);
      expect(service.isObviouslyNonActionable('Deploy the app to staging')).toBe(false);
      expect(service.isObviouslyNonActionable('Please review my PR')).toBe(false);
    });

    it('should return false for longer messages even if they start with greetings', () => {
      expect(service.isObviouslyNonActionable('Hi, can you fix the bug?')).toBe(false);
    });
  });

  // ===========================================================================
  // isWithinBounds
  // ===========================================================================

  describe('isWithinBounds', () => {
    it('should return false for messages that are too short', () => {
      expect(service.isWithinBounds('abc')).toBe(false);
      expect(service.isWithinBounds('  ab  ')).toBe(false);
    });

    it('should return true for normal-length messages', () => {
      expect(service.isWithinBounds('Fix the login bug on the settings page')).toBe(true);
    });

    it('should return false for messages exceeding max length', () => {
      const longMessage = 'Fix '.repeat(2000);
      expect(service.isWithinBounds(longMessage)).toBe(false);
    });
  });

  // ===========================================================================
  // decomposeWithRegex
  // ===========================================================================

  describe('decomposeWithRegex', () => {
    it('should decompose multi-intent messages', () => {
      const result = service.decomposeWithRegex('Fix the bug then deploy to staging');
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty for non-actionable messages', () => {
      const result = service.decomposeWithRegex('Looks good, thanks!');
      expect(result).toHaveLength(0);
    });

    it('should classify intents with level and category', () => {
      const result = service.decomposeWithRegex('Fix the login bug');
      if (result.length > 0) {
        expect(result[0]).toHaveProperty('intent');
        expect(result[0]).toHaveProperty('level');
        expect(result[0]).toHaveProperty('category');
      }
    });
  });

  // ===========================================================================
  // decomposeWithRegexAndCreate
  // ===========================================================================

  describe('decomposeWithRegexAndCreate', () => {
    it('should skip messages that are too short', () => {
      const tasks = service.decomposeWithRegexAndCreate('hi', 'msg-1');
      expect(tasks).toHaveLength(0);
    });

    it('should skip obviously non-actionable messages', () => {
      const tasks = service.decomposeWithRegexAndCreate('ok', 'msg-2');
      expect(tasks).toHaveLength(0);
    });

    it('should skip empty messages', () => {
      const tasks = service.decomposeWithRegexAndCreate('    ', 'msg-3');
      expect(tasks).toHaveLength(0);
    });

    it('should create tasks for actionable messages', () => {
      const tasks = service.decomposeWithRegexAndCreate(
        'Fix the login bug on the settings page',
        'msg-4'
      );
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      expect(tasks[0].intent).toBeTruthy();
      expect(tasks[0].category).toBeTruthy();
      expect(tasks[0].level).toBeTruthy();

      // Verify tasks are persisted
      const taskService = IntentTaskService.getInstance();
      expect(taskService.getTaskCount()).toBeGreaterThanOrEqual(1);
    });

    it('should group tasks by messageId', () => {
      const tasks = service.decomposeWithRegexAndCreate(
        'Fix the bug then deploy to staging',
        'msg-5'
      );

      if (tasks.length > 1) {
        // All tasks should share the same messageId
        expect(tasks[0].messageId).toBe(tasks[1].messageId);
      }
    });

    it('should preserve original message text in task group', () => {
      const originalMessage = 'Fix the login bug on settings page';
      const tasks = service.decomposeWithRegexAndCreate(originalMessage, 'msg-6');

      if (tasks.length > 0) {
        const taskService = IntentTaskService.getInstance();
        const groups = taskService.listMessageGroups();
        expect(groups.length).toBeGreaterThanOrEqual(1);
        expect(groups[0].originalMessage).toBe(originalMessage);
      }
    });

    it('should skip messages exceeding max length', () => {
      const longMessage = 'Fix '.repeat(2000);
      const tasks = service.decomposeWithRegexAndCreate(longMessage, 'msg-7');
      expect(tasks).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Singleton
  // ===========================================================================

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = IntentDecompositionService.getInstance();
      const b = IntentDecompositionService.getInstance();
      expect(a).toBe(b);
    });

    it('should reset correctly', () => {
      const a = IntentDecompositionService.getInstance();
      IntentDecompositionService.resetInstance();
      const b = IntentDecompositionService.getInstance();
      expect(a).not.toBe(b);
    });
  });
});
