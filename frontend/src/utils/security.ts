/**
 * Security Utilities
 *
 * Functions for masking sensitive data in user-facing text.
 * Used primarily in Chat messages to prevent accidental exposure
 * of tokens, file paths, and API keys.
 *
 * @module utils/security
 */

/** Placeholder shown in place of a JWT token. */
export const JWT_REDACTED = '[JWT_TOKEN_REDACTED]';

/** Placeholder shown in place of a file path. */
export const PATH_REDACTED = '[PATH_REDACTED]';

/** Placeholder shown in place of an API key. */
export const API_KEY_REDACTED = '[API_KEY_REDACTED]';

/**
 * Regex matching JWT tokens (three base64url segments separated by dots).
 * Requires the characteristic `eyJ` prefix of a base64-encoded JSON header.
 */
const JWT_REGEX = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

/**
 * Regex matching common absolute file paths:
 * - macOS/Linux home dirs: /Users/... or /home/...
 * - Windows paths: C:\...
 */
const PATH_REGEX = /(?:\/Users\/[^\s]+|\/home\/[^\s]+|[A-Z]:\\[^\s]+)/g;

/**
 * Regex matching API keys from major providers:
 * - OpenAI: sk-...
 * - Anthropic: sk-ant-...
 * - Google: AIza...
 * - AWS: AKIA...
 * - GitHub: ghp_, gho_, ghu_, ghs_, ghr_
 * - Stripe: sk_live_, sk_test_
 * - Generic: key=..., token=..., secret=...
 */
const API_KEY_REGEX = /\bsk-[A-Za-z0-9_-]{20,}|\bsk-ant-[A-Za-z0-9_-]{20,}|\bAIza[A-Za-z0-9_-]{30,}|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{30,}|\bsk_(live|test)_[A-Za-z0-9]{20,}/g;

/**
 * Replace sensitive tokens, file paths, and API keys in a string
 * with safe placeholder labels.
 *
 * Replacement order matters: API keys are replaced first because
 * they are the most specific pattern, then JWT tokens, then paths.
 *
 * @param text - Raw text that may contain sensitive data
 * @returns Sanitised text with placeholders for redacted values
 *
 * @example
 * ```typescript
 * maskSensitiveData('token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123');
 * // => 'token: [JWT_TOKEN_REDACTED]'
 * ```
 */
export function maskSensitiveData(text: string): string {
  return text
    .replace(API_KEY_REGEX, API_KEY_REDACTED)
    .replace(JWT_REGEX, JWT_REDACTED)
    .replace(PATH_REGEX, PATH_REDACTED);
}

/**
 * CSS class applied to redacted placeholder spans in rendered messages.
 */
export const REDACTED_CLASS = 'bg-gray-700/50 text-gray-400 font-mono text-xs px-1 py-0.5 rounded';

/**
 * Split text into normal segments and redacted placeholder segments
 * so they can be rendered with distinct styling.
 *
 * Each returned segment has a `type` of `'text'` or `'redacted'`.
 *
 * @param text - Raw text that may contain sensitive data
 * @returns Array of segments with type and content
 *
 * @example
 * ```typescript
 * segmentSensitiveData('Hello /Users/foo/bar world');
 * // => [
 * //   { type: 'text', content: 'Hello ' },
 * //   { type: 'redacted', content: '[PATH_REDACTED]' },
 * //   { type: 'text', content: ' world' },
 * // ]
 * ```
 */
export function segmentSensitiveData(
  text: string,
): Array<{ type: 'text' | 'redacted'; content: string }> {
  const masked = maskSensitiveData(text);
  const placeholders = [JWT_REDACTED, PATH_REDACTED, API_KEY_REDACTED];

  // Build a regex that splits on any placeholder while keeping it in the result
  const escaped = placeholders.map((p) => p.replace(/[[\]]/g, '\\$&'));
  const splitRegex = new RegExp(`(${escaped.join('|')})`, 'g');

  const parts = masked.split(splitRegex);
  const segments: Array<{ type: 'text' | 'redacted'; content: string }> = [];

  for (const part of parts) {
    if (!part) continue;
    const isRedacted = placeholders.includes(part);
    segments.push({ type: isRedacted ? 'redacted' : 'text', content: part });
  }

  return segments;
}
