/**
 * Time Utilities Tests
 *
 * Tests for the time utility functions.
 *
 * @module utils/time.test
 */

import { describe, it, expect } from 'vitest';
import {
  formatRelativeTime,
  formatRelativeTimeCompact,
  formatDate,
  formatTime,
  formatDateTime,
  isSameDay,
  isToday,
  isYesterday,
  TIME_INTERVALS,
} from './time';

describe('Time Utilities', () => {
  // ===========================================================================
  // formatRelativeTime Tests
  // ===========================================================================

  describe('formatRelativeTime', () => {
    const baseDate = new Date('2024-01-15T12:00:00Z');

    describe('past times', () => {
      it('should return "just now" for times less than a minute ago', () => {
        const timestamp = new Date(baseDate.getTime() - 30 * 1000); // 30 seconds ago
        expect(formatRelativeTime(timestamp, baseDate)).toBe('just now');
      });

      it('should return "1 minute ago" for exactly one minute', () => {
        const timestamp = new Date(baseDate.getTime() - TIME_INTERVALS.MINUTE);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('1 minute ago');
      });

      it('should return "X minutes ago" for times less than an hour', () => {
        const timestamp = new Date(baseDate.getTime() - 30 * TIME_INTERVALS.MINUTE);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('30 minutes ago');
      });

      it('should return "1 hour ago" for exactly one hour', () => {
        const timestamp = new Date(baseDate.getTime() - TIME_INTERVALS.HOUR);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('1 hour ago');
      });

      it('should return "X hours ago" for times less than a day', () => {
        const timestamp = new Date(baseDate.getTime() - 5 * TIME_INTERVALS.HOUR);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('5 hours ago');
      });

      it('should return "Yesterday" for times 1-2 days ago', () => {
        const timestamp = new Date(baseDate.getTime() - TIME_INTERVALS.DAY - TIME_INTERVALS.HOUR);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('Yesterday');
      });

      it('should return "X days ago" for times less than a week', () => {
        const timestamp = new Date(baseDate.getTime() - 4 * TIME_INTERVALS.DAY);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('4 days ago');
      });

      it('should return "1 week ago" for exactly one week', () => {
        const timestamp = new Date(baseDate.getTime() - TIME_INTERVALS.WEEK);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('1 week ago');
      });

      it('should return "X weeks ago" for times less than a month', () => {
        const timestamp = new Date(baseDate.getTime() - 3 * TIME_INTERVALS.WEEK);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('3 weeks ago');
      });

      it('should return "1 month ago" for exactly one month', () => {
        const timestamp = new Date(baseDate.getTime() - TIME_INTERVALS.MONTH);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('1 month ago');
      });

      it('should return "X months ago" for times less than a year', () => {
        const timestamp = new Date(baseDate.getTime() - 6 * TIME_INTERVALS.MONTH);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('6 months ago');
      });

      it('should return formatted date for times older than a year', () => {
        const timestamp = new Date(baseDate.getTime() - 2 * TIME_INTERVALS.YEAR);
        const result = formatRelativeTime(timestamp, baseDate);
        // Should be a formatted date string
        expect(result).toMatch(/\w+ \d+, \d{4}/);
      });
    });

    describe('future times', () => {
      it('should return "in a moment" for times less than a minute in future', () => {
        const timestamp = new Date(baseDate.getTime() + 30 * 1000);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('in a moment');
      });

      it('should return "in X minutes" for future times', () => {
        const timestamp = new Date(baseDate.getTime() + 30 * TIME_INTERVALS.MINUTE);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('in 30 minutes');
      });

      it('should return "in X hours" for future times', () => {
        const timestamp = new Date(baseDate.getTime() + 5 * TIME_INTERVALS.HOUR);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('in 5 hours');
      });

      it('should return "Tomorrow" for times 1-2 days in future', () => {
        const timestamp = new Date(baseDate.getTime() + TIME_INTERVALS.DAY + TIME_INTERVALS.HOUR);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('Tomorrow');
      });

      it('should return "in X days" for further future times', () => {
        const timestamp = new Date(baseDate.getTime() + 5 * TIME_INTERVALS.DAY);
        expect(formatRelativeTime(timestamp, baseDate)).toBe('in 5 days');
      });
    });

    describe('string timestamps', () => {
      it('should accept ISO string timestamps', () => {
        const timestamp = new Date(baseDate.getTime() - 5 * TIME_INTERVALS.MINUTE).toISOString();
        expect(formatRelativeTime(timestamp, baseDate)).toBe('5 minutes ago');
      });
    });

    describe('default now parameter', () => {
      it('should use current time as default', () => {
        const now = new Date();
        const timestamp = new Date(now.getTime() - 30 * 1000);
        expect(formatRelativeTime(timestamp)).toBe('just now');
      });
    });
  });

  // ===========================================================================
  // formatRelativeTimeCompact Tests
  // ===========================================================================

  describe('formatRelativeTimeCompact', () => {
    it('returns "Just now" for timestamps less than 5 seconds ago', () => {
      const ts = new Date(Date.now() - 2000).toISOString();
      expect(formatRelativeTimeCompact(ts)).toBe('Just now');
    });

    it('returns seconds for timestamps under 1 minute', () => {
      const ts = new Date(Date.now() - 30_000).toISOString();
      expect(formatRelativeTimeCompact(ts)).toBe('30s ago');
    });

    it('returns minutes for timestamps under 1 hour', () => {
      const ts = new Date(Date.now() - 5 * 60_000).toISOString();
      expect(formatRelativeTimeCompact(ts)).toBe('5m ago');
    });

    it('returns hours for timestamps under 1 day', () => {
      const ts = new Date(Date.now() - 3 * 3600_000).toISOString();
      expect(formatRelativeTimeCompact(ts)).toBe('3h ago');
    });

    it('returns days for timestamps over 1 day', () => {
      const ts = new Date(Date.now() - 2 * 86400_000).toISOString();
      expect(formatRelativeTimeCompact(ts)).toBe('2d ago');
    });

    it('returns "—" for null input', () => {
      expect(formatRelativeTimeCompact(null)).toBe('—');
    });

    it('returns "—" for invalid date string', () => {
      expect(formatRelativeTimeCompact('not-a-date')).toBe('—');
    });

    it('accepts a Date object', () => {
      const date = new Date(Date.now() - 120_000);
      expect(formatRelativeTimeCompact(date)).toBe('2m ago');
    });
  });

  // ===========================================================================
  // formatDate Tests
  // ===========================================================================

  describe('formatDate', () => {
    it('should format date with default options', () => {
      const date = new Date('2024-01-15T12:00:00Z');
      const result = formatDate(date);
      // Result depends on locale, but should contain date parts
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should accept custom options', () => {
      const date = new Date('2024-01-15T12:00:00Z');
      const result = formatDate(date, { weekday: 'long' });
      expect(result).toBeTruthy();
    });
  });

  // ===========================================================================
  // formatTime Tests
  // ===========================================================================

  describe('formatTime', () => {
    it('should format time with default options', () => {
      const date = new Date('2024-01-15T14:30:00Z');
      const result = formatTime(date);
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should accept custom options', () => {
      const date = new Date('2024-01-15T14:30:00Z');
      const result = formatTime(date, { hour12: false });
      expect(result).toBeTruthy();
    });
  });

  // ===========================================================================
  // formatDateTime Tests
  // ===========================================================================

  describe('formatDateTime', () => {
    it('should format date and time', () => {
      const date = new Date('2024-01-15T14:30:00Z');
      const result = formatDateTime(date);
      expect(result).toBeTruthy();
      expect(result).toContain(',');
    });

    it('should accept string timestamps', () => {
      const result = formatDateTime('2024-01-15T14:30:00Z');
      expect(result).toBeTruthy();
    });
  });

  // ===========================================================================
  // isSameDay Tests
  // ===========================================================================

  describe('isSameDay', () => {
    it('should return true for same day', () => {
      const date1 = new Date('2024-01-15T10:00:00Z');
      const date2 = new Date('2024-01-15T20:00:00Z');
      expect(isSameDay(date1, date2)).toBe(true);
    });

    it('should return false for different days', () => {
      const date1 = new Date('2024-01-15T10:00:00Z');
      const date2 = new Date('2024-01-16T10:00:00Z');
      expect(isSameDay(date1, date2)).toBe(false);
    });

    it('should accept string timestamps', () => {
      expect(isSameDay('2024-01-15T10:00:00Z', '2024-01-15T20:00:00Z')).toBe(true);
    });

    it('should return false for different months', () => {
      const date1 = new Date('2024-01-15T10:00:00Z');
      const date2 = new Date('2024-02-15T10:00:00Z');
      expect(isSameDay(date1, date2)).toBe(false);
    });

    it('should return false for different years', () => {
      const date1 = new Date('2024-01-15T10:00:00Z');
      const date2 = new Date('2025-01-15T10:00:00Z');
      expect(isSameDay(date1, date2)).toBe(false);
    });
  });

  // ===========================================================================
  // isToday Tests
  // ===========================================================================

  describe('isToday', () => {
    it('should return true for today', () => {
      expect(isToday(new Date())).toBe(true);
    });

    it('should return false for yesterday', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(isToday(yesterday)).toBe(false);
    });

    it('should return false for tomorrow', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(isToday(tomorrow)).toBe(false);
    });

    it('should accept string timestamps', () => {
      expect(isToday(new Date().toISOString())).toBe(true);
    });
  });

  // ===========================================================================
  // isYesterday Tests
  // ===========================================================================

  describe('isYesterday', () => {
    it('should return true for yesterday', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(isYesterday(yesterday)).toBe(true);
    });

    it('should return false for today', () => {
      expect(isYesterday(new Date())).toBe(false);
    });

    it('should return false for two days ago', () => {
      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      expect(isYesterday(twoDaysAgo)).toBe(false);
    });

    it('should accept string timestamps', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(isYesterday(yesterday.toISOString())).toBe(true);
    });
  });

  // ===========================================================================
  // TIME_INTERVALS Tests
  // ===========================================================================

  describe('TIME_INTERVALS', () => {
    it('should have correct values', () => {
      expect(TIME_INTERVALS.MINUTE).toBe(60 * 1000);
      expect(TIME_INTERVALS.HOUR).toBe(60 * 60 * 1000);
      expect(TIME_INTERVALS.DAY).toBe(24 * 60 * 60 * 1000);
      expect(TIME_INTERVALS.WEEK).toBe(7 * 24 * 60 * 60 * 1000);
      expect(TIME_INTERVALS.MONTH).toBe(30 * 24 * 60 * 60 * 1000);
      expect(TIME_INTERVALS.YEAR).toBe(365 * 24 * 60 * 60 * 1000);
    });
  });
});
