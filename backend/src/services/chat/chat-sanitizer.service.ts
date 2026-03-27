/**
 * Chat Sanitizer Service
 *
 * Masks sensitive metadata in chat messages before they are returned to
 * the frontend. Detects and redacts JWT tokens, file system paths,
 * API keys, and other secrets using pattern matching.
 *
 * @module services/chat/chat-sanitizer.service
 */

// =============================================================================
// Constants
// =============================================================================

/** Placeholder used to replace matched sensitive content */
const MASK = '***';

/**
 * Patterns for sensitive content detection.
 * Each entry has a descriptive name and a RegExp that matches the secret format.
 * Order matters: more specific patterns should appear before generic ones.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // JWT tokens (header.payload.signature, each part is base64url, min 4 chars per segment)
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g },

  // OpenAI / Anthropic API keys (sk-proj-..., sk-ant-..., sk-...)
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9_-]{20,}/g },

  // GitHub personal access tokens (classic + fine-grained)
  { name: 'github_pat', pattern: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'github_pat_fine', pattern: /github_pat_[A-Za-z0-9_]{30,}/g },

  // GitHub OAuth tokens
  { name: 'github_oauth', pattern: /gho_[A-Za-z0-9]{36,}/g },

  // AWS access keys
  { name: 'aws_key', pattern: /AKIA[A-Z0-9]{16}/g },

  // Slack tokens
  { name: 'slack_token', pattern: /xox[bpras]-[A-Za-z0-9-]{10,}/g },

  // Generic bearer tokens in Authorization headers
  { name: 'bearer', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },

  // Unix-style absolute paths (e.g. /Users/john, /home/user, /var/log)
  { name: 'unix_path', pattern: /\/(?:Users|home|var|tmp|etc|opt|root|mnt|srv)\/[^\s"'`,;)}\]]{2,}/g },

  // Windows-style absolute paths (e.g. C:\Users\john)
  { name: 'windows_path', pattern: /[A-Z]:\\(?:Users|Documents and Settings|Windows|Program Files)[^\s"'`,;)}\]]{2,}/gi },
];

// =============================================================================
// Types
// =============================================================================

/**
 * Result of a sanitization operation.
 */
export interface SanitizeResult {
  /** The sanitized text with sensitive content masked */
  sanitized: string;
  /** Whether any content was actually masked */
  wasMasked: boolean;
  /** Names of the pattern types that matched (for logging/debugging) */
  matchedPatterns: string[];
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Sanitize a single text string by masking all detected sensitive content.
 *
 * Iterates through all known sensitive patterns and replaces matches with
 * the mask placeholder. Returns a result object indicating whether any
 * masking occurred and which pattern types matched.
 *
 * @param text - The text to sanitize
 * @returns SanitizeResult with sanitized text, masking flag, and matched patterns
 *
 * @example
 * ```typescript
 * const result = sanitizeText('Token: eyJhbGciOi...');
 * // result.sanitized === 'Token: ***'
 * // result.wasMasked === true
 * // result.matchedPatterns === ['jwt']
 * ```
 */
export function sanitizeText(text: string): SanitizeResult {
  if (!text || typeof text !== 'string') {
    return { sanitized: text, wasMasked: false, matchedPatterns: [] };
  }

  let sanitized = text;
  const matchedPatterns: string[] = [];

  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regex patterns
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, MASK);
      matchedPatterns.push(name);
    }
  }

  return {
    sanitized,
    wasMasked: matchedPatterns.length > 0,
    matchedPatterns,
  };
}

/**
 * Sanitize the metadata of a chat message object (shallow clone).
 *
 * Creates a shallow copy of the message and sanitizes:
 * - message.content (the user-visible text)
 * - message.metadata.rawOutput (if present — raw terminal output)
 *
 * Does NOT mutate the original message object.
 *
 * @param message - The chat message to sanitize (any object with content and optional metadata)
 * @returns A new message object with sensitive fields masked
 *
 * @example
 * ```typescript
 * const clean = sanitizeMessage(rawMessage);
 * // clean.content has secrets masked
 * // clean.metadata.rawOutput has secrets masked
 * ```
 */
export function sanitizeMessage<T extends { content: string; metadata?: Record<string, unknown> }>(
  message: T
): T {
  const contentResult = sanitizeText(message.content);
  const clone = { ...message, content: contentResult.sanitized };

  if (clone.metadata && typeof clone.metadata === 'object') {
    const metaClone = { ...clone.metadata };

    // Sanitize rawOutput if present
    if (typeof metaClone.rawOutput === 'string') {
      metaClone.rawOutput = sanitizeText(metaClone.rawOutput).sanitized;
    }

    clone.metadata = metaClone;
  }

  return clone;
}

/**
 * Sanitize an array of chat messages.
 *
 * Convenience wrapper that applies sanitizeMessage to each message in the array.
 * Returns a new array — does not mutate the originals.
 *
 * @param messages - Array of chat messages to sanitize
 * @returns New array with all messages sanitized
 */
export function sanitizeMessages<T extends { content: string; metadata?: Record<string, unknown> }>(
  messages: T[]
): T[] {
  return messages.map(sanitizeMessage);
}
