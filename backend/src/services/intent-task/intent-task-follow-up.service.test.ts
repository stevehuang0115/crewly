/**
 * Tests for the RETIRED IntentTaskFollowUpService no-op shell.
 *
 * The service previously scheduled follow-up reminders via UnifiedSchedulerService
 * (which never actually fired). When UnifiedSchedulerService was retired, this
 * service became a no-op shell that preserves its public API so the lazy call
 * sites in IntentTaskService keep compiling. These tests lock in the no-op
 * contract — `scheduleFollowUp` returns null, `cancelFollowUp` returns false,
 * and neither throws (best-effort callers must never break).
 *
 * @module services/intent-task/intent-task-follow-up.service.test
 */

import { IntentTaskFollowUpService } from './intent-task-follow-up.service.js';

describe('IntentTaskFollowUpService (retired no-op shell)', () => {
  beforeEach(() => {
    IntentTaskFollowUpService.resetInstance();
  });
  afterEach(() => {
    IntentTaskFollowUpService.resetInstance();
  });

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = IntentTaskFollowUpService.getInstance();
      const b = IntentTaskFollowUpService.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance yields a fresh instance', () => {
      const a = IntentTaskFollowUpService.getInstance();
      IntentTaskFollowUpService.resetInstance();
      const b = IntentTaskFollowUpService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('scheduleFollowUp (no-op)', () => {
    it('returns null and never throws (even for unknown tasks)', () => {
      const svc = IntentTaskFollowUpService.getInstance();
      expect(svc.scheduleFollowUp('task-123')).toBeNull();
      expect(svc.scheduleFollowUp('nonexistent', 30)).toBeNull();
    });
  });

  describe('cancelFollowUp (no-op)', () => {
    it('returns false and never throws', () => {
      const svc = IntentTaskFollowUpService.getInstance();
      expect(svc.cancelFollowUp('task-123')).toBe(false);
    });
  });
});
