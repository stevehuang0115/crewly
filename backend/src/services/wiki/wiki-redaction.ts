/**
 * Confidentiality gate for vault writes.
 *
 * Secrets (tokens, keys, passwords) are never allowed into a vault: the
 * write is refused and the pattern that matched is named — never the
 * value. PII (emails, phone numbers) is governed per vault by the
 * `privacy:` block in SCHEMA.md: a personal vault refuses or masks
 * inbound customer detail, an enterprise vault holds customer data by
 * design and the rule flips to "mask on the way out" (visibility).
 *
 * @module services/wiki/wiki-redaction
 */

/** A detector: name + regex; `mask` is what replaces a match when masking. */
export interface RedactionPattern {
  name: string;
  regex: RegExp;
  mask: string;
}

/** Secret detectors — always enforced, never configurable off. */
export const SECRET_PATTERNS: readonly RedactionPattern[] = [
  { name: 'slack_token', regex: /\bxox[abprse]-\d{6,}-[A-Za-z0-9-]{8,}/g, mask: '[REDACTED slack_token]' },
  { name: 'slack_config_token', regex: /\bxoxe(?:\.xoxp)?-\d-[A-Za-z0-9-]{20,}/g, mask: '[REDACTED slack_config_token]' },
  { name: 'openai_key', regex: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, mask: '[REDACTED api_key]' },
  { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g, mask: '[REDACTED aws_key]' },
  { name: 'github_token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, mask: '[REDACTED github_token]' },
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{30,}/g, mask: '[REDACTED google_key]' },
  { name: 'private_key_block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, mask: '[REDACTED private_key]' },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, mask: '[REDACTED jwt]' },
  { name: 'bearer_header', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, mask: 'Bearer [REDACTED]' },
  { name: 'password_assignment', regex: /\b(?:password|passwd|pwd|secret)\s*[:=]\s*["']?(?!\s)[^\s"',;]{6,}/gi, mask: 'password=[REDACTED]' },
  { name: 'connection_string', regex: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s:@/]+:[^\s@/]+@/g, mask: '[REDACTED connection_string]' },
];

/** PII detectors — enforced per the vault's `privacy:` policy. */
export const PII_PATTERNS: readonly RedactionPattern[] = [
  { name: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, mask: '[email]' },
  { name: 'phone', regex: /(?<![\d-])(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3}\)?[\s-]?)\d{3}[\s-]?\d{4}(?![\d-])/g, mask: '[phone]' },
  { name: 'cn_id_number', regex: /\b\d{17}[\dXx]\b/g, mask: '[id-number]' },
];

/** What the vault wants done with PII on the way in. */
export type PiiMode = 'allow' | 'mask' | 'refuse';

/** Privacy policy of a vault (SCHEMA.md `privacy:` block; defaults shown). */
export interface VaultPrivacyPolicy {
  /** `allow` (enterprise KB: customer data is the content), `mask`, or `refuse` (personal KB). Default `allow`. */
  pii: PiiMode;
}

/** Outcome of scanning a body. */
export interface RedactionScan {
  /** Names of secret patterns that matched (values are never returned). */
  secrets: string[];
  /** Names of PII patterns that matched. */
  pii: string[];
}

/**
 * Scan text for secrets and PII without altering it.
 *
 * @param text - Body to scan
 * @returns Which pattern names matched
 */
export function scanForSensitive(text: string): RedactionScan {
  const hit = (patterns: readonly RedactionPattern[]): string[] =>
    patterns.filter((p) => { p.regex.lastIndex = 0; return p.regex.test(text); }).map((p) => p.name);
  return { secrets: hit(SECRET_PATTERNS), pii: hit(PII_PATTERNS) };
}

/**
 * Replace every secret match with its mask (and PII when asked). Used for
 * archives and outbound copies where the text must survive but the values
 * must not.
 *
 * @param text - Body
 * @param includePii - Also mask PII
 * @returns Masked text
 */
export function redactSensitive(text: string, includePii = false): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p.regex, p.mask);
  if (includePii) for (const p of PII_PATTERNS) out = out.replace(p.regex, p.mask);
  return out;
}

/** Result of applying a vault's policy to an inbound body. */
export type PrivacyGateResult =
  | { ok: true; body: string; masked: string[] }
  | { ok: false; reason: 'secret_detected' | 'pii_refused'; patterns: string[]; message: string };

/**
 * Apply the confidentiality gate to a body about to be written.
 * Secrets always refuse; PII follows `policy.pii`.
 *
 * @param body - Text to write
 * @param policy - The vault's privacy policy
 * @returns The (possibly masked) body, or a refusal naming the patterns
 */
export function applyPrivacyGate(body: string, policy: VaultPrivacyPolicy): PrivacyGateResult {
  const scan = scanForSensitive(body);
  if (scan.secrets.length > 0) {
    return {
      ok: false,
      reason: 'secret_detected',
      patterns: scan.secrets,
      message: `Refused: the body contains what looks like a credential (${scan.secrets.join(', ')}). Remove it — a vault never stores secrets.`,
    };
  }
  if (scan.pii.length > 0) {
    if (policy.pii === 'refuse') {
      return {
        ok: false,
        reason: 'pii_refused',
        patterns: scan.pii,
        message: `Refused: this vault does not accept personal data (${scan.pii.join(', ')}). Describe the fact without the identifying detail.`,
      };
    }
    if (policy.pii === 'mask') {
      return { ok: true, body: redactSensitive(body, true), masked: scan.pii };
    }
  }
  return { ok: true, body, masked: [] };
}
