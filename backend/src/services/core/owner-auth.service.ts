/**
 * Owner-auth credentials (#999, specs/2026-10-03-owner-auth.md).
 *
 * Mints and verifies the credentials that tell the owner apart from agents:
 * - **agent badge** — per-session, injected into each agent's environment at
 *   launch (`CREWLY_AGENT_BADGE`) and sent by the skills as `X-Agent-Badge`;
 * - **owner session** — the dashboard's HttpOnly cookie, plus a CSRF token
 *   derived from it;
 * - **internal credential** — what the in-process relay / Cloud forwarders
 *   present when they call this backend over loopback, and (`scheduler`) what
 *   the scheduled-commands runner hands each command it spawns so it can
 *   message agents and do nothing else.
 *
 * Everything is an HMAC under one secret that lives only in this process's
 * memory. It is never written to disk and never put in an environment, so an
 * agent (same OS user) cannot read it from a file the way it can read
 * `~/.crewly/api-token`. A restart rotates it: dashboards re-bootstrap their
 * session and the restarted agents get new badges.
 *
 * @module services/core/owner-auth.service
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { OWNER_AUTH_CONSTANTS } from '../../constants.js';

/** Purposes an internal credential can carry. */
export type InternalCredentialPurpose = 'relay' | 'cloud' | 'scheduler';

/** A verified owner session. */
export interface OwnerSession {
  /** Random session id (base64url) */
  id: string;
  /** Issue time, epoch seconds */
  issuedAt: number;
}

/** A freshly minted owner session. */
export interface MintedOwnerSession extends OwnerSession {
  /** Cookie value */
  value: string;
  /** CSRF token for this session */
  csrfToken: string;
}

let secret: Buffer | null = null;

/**
 * The process-lifetime signing secret (lazily generated).
 *
 * @returns 32 random bytes
 */
function signingSecret(): Buffer {
  if (!secret) secret = randomBytes(32);
  return secret;
}

/**
 * HMAC-SHA256 of `purpose:payload`, base64url.
 *
 * @param purpose - Domain separator (badge / session / csrf / internal)
 * @param payload - Signed content
 * @returns MAC
 */
function mac(purpose: string, payload: string): string {
  return createHmac('sha256', signingSecret()).update(`${purpose}:${payload}`).digest('base64url');
}

/**
 * Constant-time string comparison.
 *
 * @param a - First value
 * @param b - Second value
 * @returns True when equal
 */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Mint the agent badge for a session. Deterministic for the process
 * lifetime, so minting twice for the same session gives the same badge.
 *
 * @param session - Agent session name
 * @returns `cab1.<base64url session>.<mac>`
 *
 * @example
 * ```ts
 * env[OWNER_AUTH_CONSTANTS.AGENT_BADGE_ENV] = mintAgentBadge('crewly-orc');
 * ```
 */
export function mintAgentBadge(session: string): string {
  const encoded = Buffer.from(session, 'utf8').toString('base64url');
  return `${OWNER_AUTH_CONSTANTS.AGENT_BADGE_PREFIX}.${encoded}.${mac('badge', encoded)}`;
}

/**
 * Verify an agent badge.
 *
 * @param badge - Presented badge (may be missing)
 * @returns The session it was minted for, or null when invalid
 */
export function verifyAgentBadge(badge: string | null | undefined): string | null {
  if (typeof badge !== 'string') return null;
  const parts = badge.trim().split('.');
  if (parts.length !== 3 || parts[0] !== OWNER_AUTH_CONSTANTS.AGENT_BADGE_PREFIX) return null;
  const [, encoded, presented] = parts;
  if (!encoded || !presented || !safeEqual(presented, mac('badge', encoded))) return null;
  const session = Buffer.from(encoded, 'base64url').toString('utf8');
  return session.length > 0 ? session : null;
}

/**
 * Headers for a backend-internal call made on an agent's behalf (the
 * WorkItem dispatcher, TL auto-verify, the ticket assignee waker …).
 *
 * @param session - The agent session the call acts as
 * @returns `X-Agent-Session` plus that session's badge
 */
export function internalAgentHeaders(session: string): Record<string, string> {
  return { 'X-Agent-Session': session, 'X-Agent-Badge': mintAgentBadge(session) };
}

/**
 * The CSRF token for a session id.
 *
 * @param sessionId - Owner session id
 * @returns base64url MAC
 */
export function csrfTokenFor(sessionId: string): string {
  return mac('csrf', sessionId);
}

/**
 * Mint a new owner session.
 *
 * @param nowMs - Clock (tests)
 * @returns Cookie value, id, issue time and CSRF token
 */
export function mintOwnerSession(nowMs: number = Date.now()): MintedOwnerSession {
  const id = randomBytes(18).toString('base64url');
  const issuedAt = Math.floor(nowMs / 1000);
  const body = `${OWNER_AUTH_CONSTANTS.OWNER_SESSION_PREFIX}.${id}.${issuedAt}`;
  return { id, issuedAt, value: `${body}.${mac('session', body)}`, csrfToken: csrfTokenFor(id) };
}

/**
 * Verify an owner session cookie value.
 *
 * @param value - Cookie value (may be missing)
 * @param nowMs - Clock (tests)
 * @returns The session, or null when invalid or older than OWNER_SESSION_MAX_AGE_S
 */
export function verifyOwnerSession(value: string | null | undefined, nowMs: number = Date.now()): OwnerSession | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== OWNER_AUTH_CONSTANTS.OWNER_SESSION_PREFIX) return null;
  const [prefix, id, iat, presented] = parts;
  if (!id || !/^\d+$/.test(iat ?? '') || !presented) return null;
  if (!safeEqual(presented, mac('session', `${prefix}.${id}.${iat}`))) return null;
  const issuedAt = Number(iat);
  const age = Math.floor(nowMs / 1000) - issuedAt;
  if (age < -60 || age > OWNER_AUTH_CONSTANTS.OWNER_SESSION_MAX_AGE_S) return null;
  return { id, issuedAt };
}

/**
 * Whether a CSRF token matches a session.
 *
 * @param sessionId - Owner session id
 * @param token - Presented CSRF token (may be missing)
 * @returns True when valid
 */
export function verifyCsrfToken(sessionId: string, token: string | null | undefined): boolean {
  return typeof token === 'string' && token.length > 0 && safeEqual(token, csrfTokenFor(sessionId));
}

/**
 * The credential an in-process forwarder presents on its loopback calls.
 *
 * @param purpose - `relay` (phone / portal REST), `cloud` (Cloud-forwarded Slack envelopes) or `scheduler` (a scheduled command's child process)
 * @returns Header value
 */
export function mintInternalCredential(purpose: InternalCredentialPurpose): string {
  return `${purpose}.${mac('internal', purpose)}`;
}

/**
 * Verify an internal credential.
 *
 * @param value - Presented value (may be missing)
 * @returns Its purpose, or null when invalid
 */
export function verifyInternalCredential(value: string | null | undefined): InternalCredentialPurpose | null {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const purpose = value.slice(0, dot);
  if (purpose !== 'relay' && purpose !== 'cloud' && purpose !== 'scheduler') return null;
  return safeEqual(value, mintInternalCredential(purpose)) ? purpose : null;
}

/**
 * Headers an in-process relay forwarder adds to its loopback call.
 *
 * @param purpose - Credential purpose
 * @returns `{ 'x-crewly-internal': … }`
 */
export function internalCredentialHeaders(purpose: InternalCredentialPurpose): Record<string, string> {
  return { [OWNER_AUTH_CONSTANTS.INTERNAL_HEADER]: mintInternalCredential(purpose) };
}

/**
 * Name of the owner session cookie for a listening port.
 *
 * @param port - The backend's local port
 * @returns e.g. `crewly_owner_8787`
 */
export function ownerSessionCookieName(port: number | string | undefined): string {
  return `${OWNER_AUTH_CONSTANTS.OWNER_SESSION_COOKIE_PREFIX}${port ?? 'default'}`;
}

/**
 * Forget the signing secret (tests): every badge, session and internal
 * credential minted before stops verifying.
 */
export function resetOwnerAuthSecretForTesting(): void {
  secret = null;
}
