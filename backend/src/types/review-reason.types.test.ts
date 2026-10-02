/**
 * Tests for ReviewReason type module.
 *
 * @module types/review-reason.test
 */

import { REVIEW_REASONS, isReviewReason, type ReviewReason } from './review-reason.types.js';

describe('ReviewReason types', () => {
  describe('REVIEW_REASONS', () => {
    it('lists every reason in the declared order', () => {
      expect(REVIEW_REASONS).toEqual([
        'scheduled_review',
        'off_track_kr',
        'no_active_work',
        'phase_complete',
        'max_retries_exceeded',
        'task_blocked',
        'gave_up',
        'idle_holder',
      ]);
    });

    it('contains exactly 8 reasons (BRIDGE-1, #841 and #842 additions over the REVIEW-1 baseline)', () => {
      expect(REVIEW_REASONS).toHaveLength(8);
    });
  });

  describe('isReviewReason', () => {
    it('returns true for the original REVIEW-1 reasons', () => {
      expect(isReviewReason('scheduled_review')).toBe(true);
      expect(isReviewReason('off_track_kr')).toBe(true);
      expect(isReviewReason('no_active_work')).toBe(true);
      expect(isReviewReason('phase_complete')).toBe(true);
    });

    it('returns true for the new BRIDGE-1 escalation reasons', () => {
      expect(isReviewReason('max_retries_exceeded')).toBe(true);
      expect(isReviewReason('task_blocked')).toBe(true);
    });

    it('returns false for unknown strings', () => {
      expect(isReviewReason('unknown')).toBe(false);
      expect(isReviewReason('')).toBe(false);
      expect(isReviewReason('OFF_TRACK_KR')).toBe(false); // case-sensitive
    });

    it('returns false for non-string input', () => {
      expect(isReviewReason(null)).toBe(false);
      expect(isReviewReason(undefined)).toBe(false);
      expect(isReviewReason(123)).toBe(false);
      expect(isReviewReason({})).toBe(false);
      expect(isReviewReason(['scheduled_review'])).toBe(false);
    });

    it('narrows to ReviewReason for the type-system happy path', () => {
      // Compile-time assertion: the guard narrows the type correctly. If the
      // narrowing breaks, this block fails to compile — runtime is incidental.
      const candidate: unknown = 'task_blocked';
      if (isReviewReason(candidate)) {
        const narrowed: ReviewReason = candidate;
        expect(narrowed).toBe('task_blocked');
      }
    });
  });
});
