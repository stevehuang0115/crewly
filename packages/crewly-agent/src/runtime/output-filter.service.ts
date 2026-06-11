/**
 * Output Filter Service — API Key Redaction
 *
 * Scans all agent text output for API key patterns and replaces them
 * with [REDACTED] before the output reaches users or logs.
 *
 * Detects patterns from major providers (OpenAI, Anthropic, Google, AWS)
 * as well as generic key/token/secret assignments.
 *
 * @module services/agent/crewly-agent/output-filter.service
 *
 * @example
 * ```typescript
 * const filter = new OutputFilterService();
 * const safe = filter.redact('My key is sk-abc123xyz');
 * // => 'My key is [REDACTED]'
 * ```
 */

/**
 * A single API key detection pattern with a label for audit logging.
 */
export interface KeyPattern {
  /** Regex to match the key in text */
  pattern: RegExp;
  /** Human-readable label for audit/logging */
  label: string;
}

/**
 * Result of scanning text for API keys.
 */
export interface ScanResult {
  /** Whether any keys were detected */
  detected: boolean;
  /** Number of keys found */
  count: number;
  /** Labels of the matched patterns */
  matchedPatterns: string[];
  /** Redacted text with keys replaced */
  redactedText: string;
}

/**
 * API key patterns for major providers and generic secrets.
 *
 * Each pattern uses word boundaries or lookbehind/lookahead to minimize
 * false positives while catching real key formats.
 */
export const API_KEY_PATTERNS: readonly KeyPattern[] = [
  // OpenAI: sk-<org>-<rest> or sk-<48+ chars>
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, label: 'OpenAI API Key' },
  // Anthropic: sk-ant-api03-<rest>
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, label: 'Anthropic API Key' },
  // Google AI: AIza<rest>
  { pattern: /\bAIza[A-Za-z0-9_-]{30,}/g, label: 'Google API Key' },
  // AWS Access Key: AKIA<16 alphanumeric>
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, label: 'AWS Access Key' },
  // AWS Secret Key (often follows access key)
  { pattern: /(?<=aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{30,}/g, label: 'AWS Secret Key' },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}/g, label: 'GitHub Token' },
  // Stripe: sk_live_ or sk_test_
  { pattern: /\bsk_(live|test)_[A-Za-z0-9]{20,}/g, label: 'Stripe API Key' },
  // Supabase anon/service keys (JWT-like, start with eyJ)
  { pattern: /\beyJ[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{20,}/g, label: 'JWT Token' },
  // Generic key=value patterns (key, token, secret, password, api_key, apikey)
  { pattern: /(?<=(?:api[_-]?key|api[_-]?secret|api[_-]?token|secret[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[=:]\s*["']?)[A-Za-z0-9_/+=.-]{16,}/gi, label: 'Generic Secret' },
  // Environment variable assignments with sensitive names
  { pattern: /(?<=(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|AWS_SECRET_ACCESS_KEY|STRIPE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|REDIS_URL)\s*=\s*["']?)[^\s"']{8,}/g, label: 'Environment Variable Secret' },
] as const;

/** Replacement text for redacted keys */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Service that scans and redacts API keys from agent output text.
 */
export class OutputFilterService {
  private readonly patterns: readonly KeyPattern[];

  /**
   * Creates a new OutputFilterService.
   * @param customPatterns - Optional additional patterns to detect (appended to defaults)
   */
  constructor(customPatterns?: KeyPattern[]) {
    this.patterns = customPatterns
      ? [...API_KEY_PATTERNS, ...customPatterns]
      : API_KEY_PATTERNS;
  }

  /**
   * Scans text for API keys and returns detailed results.
   *
   * @param text - Text to scan for API keys
   * @returns Scan result with detection info and redacted text
   */
  scan(text: string): ScanResult {
    if (!text) {
      return { detected: false, count: 0, matchedPatterns: [], redactedText: text };
    }

    let redacted = text;
    let totalCount = 0;
    const matchedLabels: Set<string> = new Set();

    for (const { pattern, label } of this.patterns) {
      // Reset regex lastIndex for global patterns
      const regex = new RegExp(pattern.source, pattern.flags);
      const matches = redacted.match(regex);
      if (matches) {
        totalCount += matches.length;
        matchedLabels.add(label);
        redacted = redacted.replace(regex, REDACTION_PLACEHOLDER);
      }
    }

    return {
      detected: totalCount > 0,
      count: totalCount,
      matchedPatterns: Array.from(matchedLabels),
      redactedText: redacted,
    };
  }

  /**
   * Redacts all API keys in the given text.
   * Convenience method that returns only the redacted string.
   *
   * @param text - Text to redact
   * @returns Text with all detected API keys replaced with [REDACTED]
   */
  redact(text: string): string {
    return this.scan(text).redactedText;
  }

  /**
   * Checks if text contains any API keys without modifying it.
   *
   * @param text - Text to check
   * @returns True if any API key patterns are detected
   */
  containsKeys(text: string): boolean {
    if (!text) return false;
    for (const { pattern } of this.patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      if (regex.test(text)) return true;
    }
    return false;
  }

  /**
   * Redacts API keys from a structured object (recursively scans string values).
   * Useful for sanitizing tool call arguments and results before logging.
   *
   * @param obj - Object to scan and redact
   * @returns Deep copy with all string values redacted
   */
  redactObject(obj: unknown): unknown {
    if (typeof obj === 'string') {
      return this.redact(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item));
    }
    if (typeof obj === 'object' && obj !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.redactObject(value);
      }
      return result;
    }
    return obj;
  }
}
