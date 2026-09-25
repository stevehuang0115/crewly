/**
 * Tests for first-week due times: day 0 is now; later days land on the
 * wall-clock time in the bundle's timezone, across month ends and DST.
 */

import { firstWeekDueAt, isValidTimezone, zonedParts, zonedTimeToUtc } from './bundle-time.js';

describe('bundle time helpers', () => {
  it('isValidTimezone', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });

  it('zonedParts reads the calendar in a timezone', () => {
    expect(zonedParts(new Date('2026-09-25T16:30:00Z'), 'Asia/Shanghai')).toEqual({ year: 2026, month: 9, day: 26, hour: 0, minute: 30 });
  });

  it('zonedTimeToUtc converts a wall time to an instant', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 9, day: 26, hour: 9, minute: 0 }, 'Asia/Shanghai').toISOString()).toBe('2026-09-26T01:00:00.000Z');
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });

  it('day 0 is due at deploy time', () => {
    const at = new Date('2026-09-25T02:00:00.000Z');
    expect(firstWeekDueAt(at, 0, '09:00', 'Asia/Shanghai')).toBe(at.toISOString());
  });

  it('day n is due at the given time (default 09:00) n calendar days later in the timezone', () => {
    const at = new Date('2026-09-25T02:00:00.000Z'); // 10:00 in Shanghai
    expect(firstWeekDueAt(at, 1, undefined, 'Asia/Shanghai')).toBe('2026-09-26T01:00:00.000Z');
    expect(firstWeekDueAt(at, 2, '10:30', 'Asia/Shanghai')).toBe('2026-09-27T02:30:00.000Z');
  });

  it('counts calendar days in the owner timezone, not the server one', () => {
    // 23:30 UTC on 30 Sep is already 1 Oct in Shanghai: day 1 is 2 Oct.
    expect(firstWeekDueAt(new Date('2026-09-30T23:30:00.000Z'), 1, '09:00', 'Asia/Shanghai')).toBe('2026-10-02T01:00:00.000Z');
  });

  it('crosses a DST change', () => {
    // US DST ends 1 Nov 2026: 09:00 EST is 14:00 UTC.
    expect(firstWeekDueAt(new Date('2026-10-31T15:00:00.000Z'), 1, '09:00', 'America/New_York')).toBe('2026-11-01T14:00:00.000Z');
  });
});
