/**
 * Utility helpers for the eval base project fixture.
 *
 * Provides simple functions that eval tasks can discover via
 * glob and grep operations.
 */

/**
 * Format a Date object into a human-readable string (YYYY-MM-DD).
 *
 * @param date - the date to format
 * @returns formatted date string
 *
 * @example
 * ```typescript
 * const formatted = formatDate(new Date('2025-06-15'));
 * // formatted === '2025-06-15'
 * ```
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
