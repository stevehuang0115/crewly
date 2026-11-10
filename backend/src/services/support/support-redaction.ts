/**
 * What a support grantee may see of a text (crewly#1558 slice 2).
 *
 * Two layers:
 * - **Secrets** are always scrubbed, whatever the grant says: known token
 *   shapes (Slack, OpenAI / Anthropic, GitHub, Google, AWS, JWT, private keys,
 *   connection strings, `password=` assignments), credentials in link query
 *   strings, and long letter+digit runs that look like keys.
 * - **Private content** is withheld unless the grant has `includePrivate`:
 *   a message marked private by #969 (`visibleToPeople`, or
 *   `privateSourcePeople` = written after the agent read a connector), a text
 *   the shared-channel classifier (#1543) says carries children's data,
 *   mentions children, or quotes connector content, and a text naming a
 *   person's age, birthday or school grade. The whole text is then
 *   replaced with a placeholder. Email addresses, phone numbers and ID
 *   numbers left in other texts are masked.
 *
 * Pure functions; never throw.
 *
 * @module services/support/support-redaction
 */

import { PEOPLE_CONSTANTS, SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';
import { redactSecrets } from '../../utils/secret-redactor.js';
import { PII_PATTERNS, SECRET_PATTERNS } from '../wiki/wiki-redaction.js';
import { classifySharedSend, type SharedSendFindingCode } from '../shared-channel/shared-channel-classifier.js';

/** Classifier findings that make a text private for a support viewer. */
const PRIVATE_FINDINGS: ReadonlySet<SharedSendFindingCode> = new Set<SharedSendFindingCode>([
  'children_data',
  'children_mention',
  'private_person_data',
  'owner_connector',
]);

/**
 * Personal details that mark a person's private data even without a word
 * like "child" next to them (the classifier needs one): an age, a birthday
 * or date of birth, a school grade. A name with "8 years old" is a child's
 * record on SteamFun.
 */
const PERSONAL_DETAIL_RE =
  /\b\d{1,2}\s?(?:years?[\s-]old|yo|y\/o)\b|\d{1,2}\s?岁|\bdate of birth\b|\bDOB\b|\bbirthday\b|生日|\bgrade\s*\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\s+grade\b|年级/i;

/** A credential in a link's query string (same shape the classifier refuses). */
const URL_SECRET_PARAM_RE = /([?&#](?:k|key|api_?key|token|access_token|refresh_token|auth|sig|signature|code|secret|password)=)[^\s&#]{8,}/gi;
/** A long run of letters and digits without spaces: an API key, a session token. */
const LONG_TOKEN_RE = /(?<![A-Za-z0-9_\-+/=])(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{32,}(?![A-Za-z0-9_\-+/=])/g;
/** A canonical UUID: an id, not a secret. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a redaction did to a text. */
export interface SupportRedaction {
  /** The text the grantee may see */
  text: string;
  /** True when the whole text was replaced with the placeholder */
  withheld: boolean;
}

/**
 * Scrub secrets from a text. Always applied, even with `includePrivate`.
 *
 * @param text - Any text
 * @returns The text with every secret-looking value replaced
 *
 * @example
 * ```typescript
 * scrubSupportSecrets('key sk-ant-abcdefghijklmnopqrstuvwx'); // 'key [REDACTED api_key]'
 * ```
 */
export function scrubSupportSecrets(text: string): string {
  let out = redactSecrets(String(text ?? ''));
  for (const p of SECRET_PATTERNS) out = out.replace(p.regex, p.mask);
  out = out.replace(URL_SECRET_PARAM_RE, '$1[REDACTED]');
  out = out.replace(LONG_TOKEN_RE, (m) => (UUID_RE.test(m) ? m : '[REDACTED token]'));
  return out;
}

/**
 * Mask email addresses, phone numbers and ID numbers.
 *
 * @param text - Text
 * @returns The text with personal contact details masked
 */
export function maskPersonalDetails(text: string): string {
  let out = text;
  for (const p of PII_PATTERNS) out = out.replace(p.regex, p.mask);
  return out;
}

/**
 * Whether message metadata carries a #969 private mark.
 *
 * @param metadata - chat-v2 message metadata (may be undefined)
 * @returns True when `visibleToPeople` or `privateSourcePeople` names anyone
 */
export function hasPrivateMark(metadata: Record<string, unknown> | undefined | null): boolean {
  if (!metadata) return false;
  const marked = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
  return marked(metadata['visibleToPeople']) || marked(metadata['visible_to_people']) || marked(metadata[PEOPLE_CONSTANTS.PRIVATE_SOURCE_METADATA_KEY]);
}

/**
 * Whether a text holds private content by its shape (children's data, a
 * mention of children or students, connector content, a person's age,
 * birthday or school grade).
 *
 * @param text - Text
 * @returns True when the classifier finds a private shape
 */
export function looksPrivate(text: string): boolean {
  if (PERSONAL_DETAIL_RE.test(text)) return true;
  return classifySharedSend(text).findings.some((f) => PRIVATE_FINDINGS.has(f.code));
}

/**
 * The text a support grantee may see.
 *
 * @param text - Original text
 * @param options.includePrivate - The grant's include-private flag
 * @param options.metadata - The message's metadata, for #969 marks
 * @param options.maxChars - Cut the result to this many characters
 * @returns The visible text and whether it was withheld
 */
export function redactForSupport(
  text: string,
  options: { includePrivate: boolean; metadata?: Record<string, unknown> | null; maxChars?: number },
): SupportRedaction {
  const raw = String(text ?? '');
  if (!options.includePrivate && (hasPrivateMark(options.metadata) || looksPrivate(raw))) {
    return { text: SUPPORT_ACCESS_CONSTANTS.WITHHELD_PLACEHOLDER, withheld: true };
  }
  let out = scrubSupportSecrets(raw);
  if (!options.includePrivate) out = maskPersonalDetails(out);
  const max = options.maxChars;
  if (max !== undefined && out.length > max) out = `${out.slice(0, max)}…`;
  return { text: out, withheld: false };
}
