/**
 * Tests for the Schedules page constants.
 *
 * @module constants/schedules.constants.test
 */

import { describe, it, expect } from 'vitest';
import {
  SCHEDULES_ROUTE,
  SCHEDULE_EXPIRY_WARN_REMAINING,
  AUTO_FOLLOWUP_NAME_PATTERN,
  SCHEDULE_TEXT,
  TIMEZONE_SHORT_LABEL,
  WEEKDAY_LABEL,
} from './schedules.constants';

describe('schedules constants', () => {
  it('keeps the /triggers route and warns at 7 runs left', () => {
    expect(SCHEDULES_ROUTE).toBe('/triggers');
    expect(SCHEDULE_EXPIRY_WARN_REMAINING).toBe(7);
  });

  it('recognises auto-generated follow-up names only', () => {
    expect(AUTO_FOLLOWUP_NAME_PATTERN.test('followup:1a2b3c4d')).toBe(true);
    expect(AUTO_FOLLOWUP_NAME_PATTERN.test('daily-ops-nightly-2230')).toBe(false);
  });

  it('formats counted labels', () => {
    expect(SCHEDULE_TEXT.RUNS_OF(2, 58)).toBe('已运行 2/58 次');
    expect(SCHEDULE_TEXT.REMAINING(56)).toBe('还剩 56 次');
    expect(TIMEZONE_SHORT_LABEL['America/New_York']).toBe('ET');
    expect(WEEKDAY_LABEL).toHaveLength(7);
  });
});
