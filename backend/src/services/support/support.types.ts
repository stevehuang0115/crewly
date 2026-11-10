/**
 * Types and guards of support access on the instance (crewly#1558 slice 2).
 *
 * The Cloud relay vouches for a grantee's `api_request` by adding a
 * `supportGrant` envelope at the top level of the relay wrapper (it strips
 * that key from every sender-supplied payload). The instance validates the
 * envelope's shape here and turns it into a {@link SupportCaller}: the only
 * identity the support API accepts. A caller is never the owner.
 *
 * `specs/2026-11-10-support-access-instance.md`
 *
 * @module services/support/support.types
 */

import { SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';

/** Grant roles: viewer reads; admin reads and restarts agents. */
export type SupportRole = 'viewer' | 'admin';

/** The envelope the relay adds to a granted request (crewly-services `relay/src/support-grants.ts`). */
export interface SupportGrantEnvelope {
  grantId: string;
  role: SupportRole;
  includePrivate: boolean;
  granteeEmail: string;
  granteeAccountId: string;
  /** The grantee's relay queue the instance answers to (relay-validated) */
  replyQueueId: string;
}

/**
 * The identity a support call runs under. Built only by the support relay
 * from a validated envelope; frozen so no handler can widen it.
 */
export interface SupportCaller extends Readonly<SupportGrantEnvelope> {
  readonly kind: 'support';
}

/** A request as the support API sees it. */
export interface SupportApiRequest {
  method: string;
  /** Path relative to `/api`, starting `/support/`, optionally with a query */
  path: string;
  body?: unknown;
}

/** A support API answer (sent back as the `api_response` status / body). */
export interface SupportApiResponse {
  status: number;
  body: unknown;
}

/** Longest string field accepted in an envelope. */
const MAX_FIELD = 512;

/**
 * Whether a value is a non-empty string of sane length.
 *
 * @param v - Candidate
 * @returns True for 1..MAX_FIELD characters
 */
function isField(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD;
}

/**
 * Whether a value has the exact shape of a relay support envelope.
 * `includePrivate` must be a real boolean; anything else is refused rather
 * than guessed.
 *
 * @param value - The wrapper's `supportGrant` value
 * @returns True when it is a well-formed envelope
 */
export function isSupportGrantEnvelope(value: unknown): value is SupportGrantEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    isField(v['grantId']) &&
    (v['role'] === 'viewer' || v['role'] === 'admin') &&
    typeof v['includePrivate'] === 'boolean' &&
    typeof v['granteeEmail'] === 'string' &&
    v['granteeEmail'].length <= MAX_FIELD &&
    isField(v['granteeAccountId']) &&
    isField(v['replyQueueId'])
  );
}

/**
 * Parse the `supportGrant` value of a relay wrapper.
 *
 * @param value - Raw value (undefined when the wrapper had no such key)
 * @returns The envelope (copied, only known fields), or null when malformed
 */
export function parseSupportGrantEnvelope(value: unknown): SupportGrantEnvelope | null {
  if (!isSupportGrantEnvelope(value)) return null;
  return {
    grantId: value.grantId,
    role: value.role,
    includePrivate: value.includePrivate === true,
    granteeEmail: value.granteeEmail,
    granteeAccountId: value.granteeAccountId,
    replyQueueId: value.replyQueueId,
  };
}

/**
 * The caller identity of a validated envelope (frozen).
 *
 * @param envelope - Validated envelope
 * @returns Caller
 */
export function supportCallerFromEnvelope(envelope: SupportGrantEnvelope): SupportCaller {
  return Object.freeze({ kind: 'support' as const, ...envelope });
}

/** One path segment: unreserved characters only (the relay's rule). */
const SEGMENT = /^[A-Za-z0-9._~:@,+=-]+$/;

/**
 * Whether a request path is a clean path under `/support/`: no percent
 * escapes, backslashes, `#`, whitespace, dot or empty segments; a query is
 * allowed after `?`. The instance re-checks what the relay already checked.
 *
 * @param path - `data.path` of the request
 * @returns True when it may reach the support API
 */
export function isSupportApiPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > SUPPORT_ACCESS_CONSTANTS.MAX_PATH_LENGTH) return false;
  if (/[%\\#\s]/.test(path)) return false;
  const q = path.indexOf('?');
  const pathname = q < 0 ? path : path.slice(0, q);
  if (!pathname.startsWith(SUPPORT_ACCESS_CONSTANTS.PATH_PREFIX)) return false;
  const segments = pathname.slice(1).split('/');
  if (segments.length < 2) return false;
  return segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
}

/**
 * Whether a role may use a method.
 *
 * @param role - Grant role
 * @param method - HTTP method
 * @returns True when allowed
 */
export function roleAllowsMethod(role: SupportRole, method: string): boolean {
  return SUPPORT_ACCESS_CONSTANTS.ROLE_METHODS[role]?.includes(method) ?? false;
}

/**
 * Split a support path into its segments after `/support/` and its query.
 *
 * @param path - A path accepted by {@link isSupportApiPath}
 * @returns Segments (e.g. `['conversations', 'c1', 'messages']`) and query parameters
 */
export function splitSupportPath(path: string): { segments: string[]; query: URLSearchParams; pathname: string } {
  const q = path.indexOf('?');
  const pathname = q < 0 ? path : path.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : path.slice(q + 1));
  return { segments: pathname.slice(SUPPORT_ACCESS_CONSTANTS.PATH_PREFIX.length).split('/'), query, pathname };
}
