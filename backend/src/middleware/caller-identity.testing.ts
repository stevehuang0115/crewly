/**
 * Test helpers for caller identity (#999).
 *
 * Controller tests exercise business logic with a router mounted on its own,
 * without the server's middleware stack. These helpers give such a request
 * the identity a real one would have:
 * - {@link ownerAuthHeaders}: a valid owner session cookie + CSRF header;
 * - {@link agentAuthHeaders}: an agent badge + `X-Agent-Session`;
 * - {@link relayAuthHeaders}: the relay credential;
 * - {@link schedulerAuthHeaders}: the credential of a scheduled command's child;
 * - {@link callerIdentityForTests}: the real classifier, with the process
 *   lookup answering "not an agent" (supertest connects over loopback, and
 *   its client process is the test runner itself);
 * - {@link ownerUnlessAgentForTests}: middleware that marks every request
 *   carrying no agent sign and no other credential as the owner — the shape
 *   of a dashboard request — so a suite about, say, ticket review does not
 *   have to repeat the session headers on every call. The authorization
 *   rules themselves are tested without it (caller-identity tests and
 *   owner-routes.integration.test.ts).
 *
 * @module middleware/caller-identity.testing
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { OWNER_AUTH_CONSTANTS, API_SECURITY_CONSTANTS } from '../constants.js';
import { internalCredentialHeaders, mintAgentBadge, mintOwnerSession, ownerSessionCookieName } from '../services/core/owner-auth.service.js';
import { createCallerIdentityMiddleware, setCallerIdentity, type CallerIdentity } from './caller-identity.middleware.js';
import { PeerProcessService } from '../services/core/peer-process.service.js';

/**
 * Headers of a dashboard request: owner session cookie + CSRF token.
 *
 * @returns Header map for supertest `.set()` or a mock request
 */
export function ownerAuthHeaders(): Record<string, string> {
  const session = mintOwnerSession();
  return {
    cookie: `${ownerSessionCookieName('test')}=${session.value}`,
    [OWNER_AUTH_CONSTANTS.CSRF_HEADER]: session.csrfToken,
  };
}

/**
 * Headers of a skill call by an agent.
 *
 * @param session - Agent session name
 * @returns Header map
 */
export function agentAuthHeaders(session: string): Record<string, string> {
  return { [API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER]: session, [OWNER_AUTH_CONSTANTS.AGENT_BADGE_HEADER]: mintAgentBadge(session) };
}

/**
 * Headers of a call by a command the scheduled-commands runner started.
 *
 * @param name - The scheduled entry's name (sent as the sender label)
 * @returns Header map
 */
export function schedulerAuthHeaders(name = 'crewly-web-release'): Record<string, string> {
  return { ...internalCredentialHeaders('scheduler'), [OWNER_AUTH_CONSTANTS.SCHEDULER_NAME_HEADER]: name };
}

/**
 * Headers of a phone / portal call over the relay.
 *
 * @returns Header map
 */
export function relayAuthHeaders(): Record<string, string> {
  return internalCredentialHeaders('relay');
}

/** The identity a dashboard request has. */
const OWNER: CallerIdentity = Object.freeze({ kind: 'owner', via: 'owner-session' }) as CallerIdentity;

/**
 * Mark a (mock) request as the owner's.
 *
 * @param req - Request object
 * @returns The same request
 */
export function markOwner<T extends object>(req: T): T {
  setCallerIdentity(req, OWNER);
  return req;
}

/**
 * Whether a request carries any credential or agent sign of its own.
 *
 * @param req - Request
 * @returns True when it should be classified normally
 */
function carriesIdentity(req: Request): boolean {
  const h = req.headers ?? {};
  return Boolean(
    h[API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER] ||
      h[API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER_LEGACY] ||
      h[OWNER_AUTH_CONSTANTS.AGENT_BADGE_HEADER] ||
      h[OWNER_AUTH_CONSTANTS.INTERNAL_HEADER] ||
      h[API_SECURITY_CONSTANTS.TOKEN_HEADER] ||
      h.authorization ||
      h.cookie ||
      h['x-test-anonymous'],
  );
}

/**
 * Test middleware: a request with no identity of its own is the owner's
 * (send `X-Test-Anonymous: 1` to opt out); anything else is classified as
 * the server would.
 *
 * @param req - Request
 * @param _res - Response
 * @param next - Next
 */
export function ownerUnlessAgentForTests(req: Request, _res: Response, next: NextFunction): void {
  if (!carriesIdentity(req)) markOwner(req);
  next();
}

/**
 * The real caller-identity middleware for a test app. The local process
 * lookup is replaced by "this caller is not an agent's process", so the
 * owner API token presented over supertest's loopback counts as the owner.
 *
 * @returns Express middleware
 */
export function callerIdentityForTests(): RequestHandler {
  return createCallerIdentityMiddleware(new PeerProcessService({ isHostAddress: () => false }));
}
