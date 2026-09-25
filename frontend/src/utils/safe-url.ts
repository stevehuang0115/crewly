/**
 * Safe URL helpers
 *
 * The login broker extracts URLs from terminal screen text, so anything it
 * returns is treated as untrusted before it becomes a link.
 *
 * @module utils/safe-url
 */

/** Schemes allowed for links opened from scraped text. */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['https:', 'http:']);

/**
 * Whether a string is an absolute http(s) URL (rejects `javascript:`, `data:` etc.).
 *
 * @param value - Candidate URL
 * @returns True when safe to open
 */
export function isSafeHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return SAFE_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}
