/**
 * Time helpers for bundle first-week tasks: "day 2 at 09:00 in the
 * bundle's timezone" as a UTC instant, independent of the server's own
 * timezone (hosted servers run in UTC; owners mostly do not).
 *
 * @module services/bundle/bundle-time
 */

import { BUNDLE_CONSTANTS } from '../../constants.js';

/** Calendar date and time in some timezone. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Whether a string is a valid IANA timezone.
 *
 * @param tz - Candidate
 * @returns True when Intl accepts it
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Calendar parts of an instant in a timezone.
 *
 * @param date - Instant
 * @param tz - IANA timezone
 * @returns Year, month (1-12), day, hour, minute
 */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = new Map<string, string>();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  for (const p of formatter.formatToParts(date)) parts.set(p.type, p.value);
  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    hour: Number(parts.get('hour')) % 24,
    minute: Number(parts.get('minute')),
  };
}

/**
 * The UTC instant of a wall-clock time in a timezone.
 *
 * Starts from the wall time read as UTC, then corrects by the zone's offset
 * at that instant (twice, which settles DST edges).
 *
 * @param wall - Calendar date and time in `tz`
 * @param tz - IANA timezone
 * @returns The instant
 */
export function zonedTimeToUtc(wall: ZonedParts, tz: string): Date {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const seen = zonedParts(new Date(guess), tz);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += target - seenAsUtc;
  }
  return new Date(guess);
}

/**
 * When a first-week task is due.
 *
 * Day 0 is due at `deployedAt`. Day n is due at `time` (default 09:00) on
 * the n-th calendar day after the deploy day, in `tz`.
 *
 * @param deployedAt - When the bundle was applied
 * @param day - 0-based day
 * @param time - `HH:MM` (optional)
 * @param tz - IANA timezone
 * @returns ISO timestamp
 *
 * @example
 * firstWeekDueAt(new Date('2026-09-25T02:00:00Z'), 1, '09:00', 'Asia/Shanghai') // '2026-09-26T01:00:00.000Z'
 */
export function firstWeekDueAt(deployedAt: Date, day: number, time: string | undefined, tz: string): string {
  if (day <= 0) return deployedAt.toISOString();
  const [hour, minute] = (time ?? BUNDLE_CONSTANTS.DEFAULT_FIRST_WEEK_TIME).split(':').map(Number);
  const today = zonedParts(deployedAt, tz);
  // Calendar arithmetic on a UTC date avoids month/year rollover bugs.
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day + day));
  return zonedTimeToUtc(
    { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute },
    tz,
  ).toISOString();
}
