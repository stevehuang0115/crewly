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
  SCHEDULE_FORM_TEXT,
  CREATOR_LABEL,
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
    expect(SCHEDULE_TEXT.RUNS_OF(2, 58)).toBe('Ran 2/58');
    expect(SCHEDULE_TEXT.REMAINING(56)).toBe('56 left');
    expect(SCHEDULE_TEXT.RUNS(1)).toBe('Ran 1 time');
    expect(SCHEDULE_TEXT.ENDS_AROUND('Nov 24')).toBe('Ends ~Nov 24');
    expect(TIMEZONE_SHORT_LABEL['America/New_York']).toBe('ET');
    expect(WEEKDAY_LABEL).toHaveLength(7);
  });

  it('has no Chinese in any page label (English-first UI)', () => {
    const cjk = /[\u4e00-\u9fff]/;
    const labels = [
      ...Object.values(SCHEDULE_TEXT).map((v) => (typeof v === 'function' ? (v as (...a: unknown[]) => string)(1, 2) : v)),
      ...Object.values(SCHEDULE_FORM_TEXT),
      ...Object.values(CREATOR_LABEL),
      ...Object.values(TIMEZONE_SHORT_LABEL),
      ...WEEKDAY_LABEL,
    ];
    for (const label of labels) expect(label).not.toMatch(cjk);
  });
});
