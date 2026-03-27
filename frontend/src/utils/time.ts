/**
 * Time Utilities
 *
 * Helper functions for formatting and manipulating dates and times.
 *
 * @module utils/time
 */

/** Time intervals in milliseconds */
const TIME_INTERVALS = {
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
  MONTH: 30 * 24 * 60 * 60 * 1000,
  YEAR: 365 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Format a timestamp into a human-readable relative time string.
 *
 * Examples:
 * - "just now" for times less than a minute ago
 * - "5 minutes ago" for times less than an hour ago
 * - "2 hours ago" for times less than a day ago
 * - "Yesterday" for times between 1-2 days ago
 * - "3 days ago" for times less than a week ago
 * - "2 weeks ago" for times less than a month ago
 * - Full date for older times
 *
 * @param timestamp - ISO timestamp string or Date object
 * @param now - Optional reference time (defaults to current time)
 * @returns Human-readable relative time string
 *
 * @example
 * ```typescript
 * formatRelativeTime('2024-01-15T10:30:00Z'); // "5 minutes ago"
 * formatRelativeTime(new Date()); // "just now"
 * ```
 */
export function formatRelativeTime(
  timestamp: string | Date,
  now: Date = new Date()
): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const diff = now.getTime() - date.getTime();

  // Future times
  if (diff < 0) {
    return formatFutureTime(Math.abs(diff));
  }

  // Past times
  if (diff < TIME_INTERVALS.MINUTE) {
    return 'just now';
  }

  if (diff < TIME_INTERVALS.HOUR) {
    const minutes = Math.floor(diff / TIME_INTERVALS.MINUTE);
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }

  if (diff < TIME_INTERVALS.DAY) {
    const hours = Math.floor(diff / TIME_INTERVALS.HOUR);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }

  if (diff < TIME_INTERVALS.DAY * 2) {
    return 'Yesterday';
  }

  if (diff < TIME_INTERVALS.WEEK) {
    const days = Math.floor(diff / TIME_INTERVALS.DAY);
    return `${days} days ago`;
  }

  if (diff < TIME_INTERVALS.MONTH) {
    const weeks = Math.floor(diff / TIME_INTERVALS.WEEK);
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  }

  if (diff < TIME_INTERVALS.YEAR) {
    const months = Math.floor(diff / TIME_INTERVALS.MONTH);
    return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  }

  // Older than a year, show full date
  return formatDate(date);
}

/**
 * Format a future time difference into a human-readable string.
 *
 * @param diff - Time difference in milliseconds (positive value)
 * @returns Human-readable future time string
 */
function formatFutureTime(diff: number): string {
  if (diff < TIME_INTERVALS.MINUTE) {
    return 'in a moment';
  }

  if (diff < TIME_INTERVALS.HOUR) {
    const minutes = Math.floor(diff / TIME_INTERVALS.MINUTE);
    return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }

  if (diff < TIME_INTERVALS.DAY) {
    const hours = Math.floor(diff / TIME_INTERVALS.HOUR);
    return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }

  if (diff < TIME_INTERVALS.DAY * 2) {
    return 'Tomorrow';
  }

  const days = Math.floor(diff / TIME_INTERVALS.DAY);
  return `in ${days} days`;
}

/**
 * Format a date into a localized string.
 *
 * @param date - Date to format
 * @param options - Optional Intl.DateTimeFormat options
 * @returns Formatted date string
 *
 * @example
 * ```typescript
 * formatDate(new Date()); // "Jan 15, 2024"
 * formatDate(new Date(), { weekday: 'long' }); // "Monday, Jan 15, 2024"
 * ```
 */
export function formatDate(
  date: Date,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const defaultOptions: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  };

  return date.toLocaleDateString(undefined, defaultOptions);
}

/**
 * Format a time into a localized string.
 *
 * @param date - Date to format
 * @param options - Optional Intl.DateTimeFormat options
 * @returns Formatted time string
 *
 * @example
 * ```typescript
 * formatTime(new Date()); // "10:30 AM"
 * formatTime(new Date(), { hour12: false }); // "10:30"
 * ```
 */
export function formatTime(
  date: Date,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const defaultOptions: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    ...options,
  };

  return date.toLocaleTimeString(undefined, defaultOptions);
}

/**
 * Format a date and time into a localized string.
 *
 * @param date - Date to format
 * @returns Formatted date and time string
 *
 * @example
 * ```typescript
 * formatDateTime(new Date()); // "Jan 15, 2024, 10:30 AM"
 * ```
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return `${formatDate(d)}, ${formatTime(d)}`;
}

/**
 * Check if two dates are on the same day.
 *
 * @param date1 - First date
 * @param date2 - Second date
 * @returns True if both dates are on the same calendar day
 *
 * @example
 * ```typescript
 * isSameDay(new Date('2024-01-15T10:00:00'), new Date('2024-01-15T20:00:00')); // true
 * isSameDay(new Date('2024-01-15'), new Date('2024-01-16')); // false
 * ```
 */
export function isSameDay(date1: Date | string, date2: Date | string): boolean {
  const d1 = typeof date1 === 'string' ? new Date(date1) : date1;
  const d2 = typeof date2 === 'string' ? new Date(date2) : date2;

  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

/**
 * Check if a date is today.
 *
 * @param date - Date to check
 * @returns True if the date is today
 */
export function isToday(date: Date | string): boolean {
  return isSameDay(date, new Date());
}

/**
 * Check if a date is yesterday.
 *
 * @param date - Date to check
 * @returns True if the date is yesterday
 */
export function isYesterday(date: Date | string): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return isSameDay(date, yesterday);
}

/**
 * Format a timestamp into a compact relative time string.
 *
 * Produces short labels suitable for tight UI spaces (status bars, badges,
 * device rows) where the verbose "5 minutes ago" is too wide.
 *
 * Examples:
 * - "Just now" for times less than 5 seconds ago
 * - "30s ago" for times less than a minute ago
 * - "5m ago" for times less than an hour ago
 * - "3h ago" for times less than a day ago
 * - "2d ago" for older times
 *
 * @param timestamp - ISO timestamp string, Date object, or null
 * @returns Compact relative time string, or "—" for null/invalid input
 *
 * @example
 * ```typescript
 * formatRelativeTimeCompact('2026-03-26T10:30:00Z'); // "5m ago"
 * formatRelativeTimeCompact(null); // "—"
 * ```
 */
export function formatRelativeTimeCompact(
  timestamp: string | Date | null,
): string {
  if (!timestamp) return '—';

  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  if (isNaN(date.getTime())) return '—';

  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/** Export TIME_INTERVALS for use in tests */
export { TIME_INTERVALS };
