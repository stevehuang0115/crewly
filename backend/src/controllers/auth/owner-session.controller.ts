/**
 * Owner session for the dashboard (#999, specs/2026-10-03-owner-auth.md §3).
 *
 * - The served UI sets the owner session cookie on page load
 *   ({@link createOwnerSessionPageMiddleware}, in front of the static files).
 * - `GET /api/auth/session` issues or confirms it and returns the CSRF token
 *   the dashboard sends on every write (`X-Crewly-CSRF`). The frontend calls
 *   it on start and after a `401 owner_auth_required` (a tab that outlived a
 *   backend restart), and the Vite dev server relies on it.
 *
 * Who gets a session:
 * - a caller that already holds an owner credential (session, API token,
 *   relay credential);
 * - a caller on this machine with no agent sign whose client process is not
 *   an agent's (see PeerProcessService) — the owner's browser.
 * Agents and agent processes get 403; remote callers without the API token 401.
 *
 * @module controllers/auth/owner-session.controller
 */

import * as path from 'path';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { OWNER_AUTH_CONSTANTS } from '../../constants.js';
import { csrfTokenFor, mintOwnerSession, ownerSessionCookieName } from '../../services/core/owner-auth.service.js';
import type { PeerProcessService } from '../../services/core/peer-process.service.js';
import { classifyCaller, getCallerIdentity, readOwnerSession, type CallerIdentity } from '../../middleware/caller-identity.middleware.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('OwnerSession');

/** Outcome of an issue attempt. */
export type OwnerSessionDecision =
  | { ok: true; existingSessionId?: string }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Decide whether this caller may hold an owner session.
 *
 * @param req - Request
 * @param identity - The caller's identity
 * @param peers - Process classifier
 * @returns The decision
 */
export async function decideOwnerSession(req: Request, identity: CallerIdentity, peers: PeerProcessService): Promise<OwnerSessionDecision> {
  if (identity.kind === 'owner' || identity.kind === 'relay-owner') {
    return identity.via === 'owner-session' && identity.ownerSessionId ? { ok: true, existingSessionId: identity.ownerSessionId } : { ok: true };
  }
  if (identity.kind === 'agent') return { ok: false, status: 403, reason: 'agents cannot hold an owner session' };
  if (identity.note === 'invalid agent badge') return { ok: false, status: 403, reason: 'invalid agent badge' };
  // A session cookie whose CSRF is missing is still a valid session for a read
  // like this one; anything else needs the process check.
  const existing = readOwnerSession(req);
  const verdict = await peers.classify(req.socket);
  switch (verdict.kind) {
    case 'remote':
      return { ok: false, status: 401, reason: 'remote callers need the API token' };
    case 'agent':
      logger.warn('Refused an owner session to an agent process', { session: verdict.session, signal: verdict.signal, path: req.path });
      return { ok: false, status: 403, reason: 'agent process' };
    case 'unknown':
      logger.warn('Could not tell which local process asked for an owner session — issuing it (fail open)', { reason: verdict.reason });
      return existing ? { ok: true, existingSessionId: existing.id } : { ok: true };
    default:
      return existing ? { ok: true, existingSessionId: existing.id } : { ok: true };
  }
}

/**
 * Write the session cookie.
 *
 * @param req - Request (port, protocol)
 * @param res - Response
 * @param value - Cookie value
 */
function setSessionCookie(req: Request, res: Response, value: string): void {
  const name = ownerSessionCookieName(req.socket?.localPort);
  const secure = req.secure ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${OWNER_AUTH_CONSTANTS.OWNER_SESSION_MAX_AGE_S}${secure}`,
  );
}

/**
 * Issue a session when allowed.
 *
 * @param req - Request
 * @param res - Response (cookie appended)
 * @param identity - The caller's identity
 * @param peers - Process classifier
 * @returns The CSRF token, or the refusal
 */
async function issue(
  req: Request,
  res: Response,
  identity: CallerIdentity,
  peers: PeerProcessService,
): Promise<{ csrfToken: string } | { status: 401 | 403; reason: string }> {
  const decision = await decideOwnerSession(req, identity, peers);
  if (!decision.ok) return { status: decision.status, reason: decision.reason };
  if (decision.existingSessionId) return { csrfToken: csrfTokenFor(decision.existingSessionId) };
  const session = mintOwnerSession();
  setSessionCookie(req, res, session.value);
  return { csrfToken: session.csrfToken };
}

/**
 * The `/api/auth/session` router (mounted under `/api`, after the
 * caller-identity middleware).
 *
 * @param peers - Process classifier
 * @returns Router
 */
export function createOwnerSessionRouter(peers: PeerProcessService): Router {
  const router = Router();
  router.get(OWNER_AUTH_CONSTANTS.SESSION_ROUTE, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await issue(req, res, getCallerIdentity(req), peers);
      if ('status' in result) {
        res.status(result.status).json({ success: false, error: OWNER_AUTH_CONSTANTS.ERRORS.OWNER_AUTH_REQUIRED, message: result.reason });
        return;
      }
      res.json({ success: true, data: { kind: 'owner', csrfToken: result.csrfToken, csrfHeader: OWNER_AUTH_CONSTANTS.CSRF_HEADER } });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}

/**
 * Whether a request is a page load of the dashboard (not an asset or API call).
 *
 * @param req - Request
 * @returns True for an HTML navigation
 */
export function isDashboardPageLoad(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = req.path;
  if (p.startsWith('/api/') || p === '/api' || p === '/health' || p.startsWith('/socket.io') || p.startsWith('/ws')) return false;
  const ext = path.extname(p);
  if (ext && ext !== '.html') return false;
  return typeof req.accepts === 'function' ? req.accepts(['html']) === 'html' : true;
}

/**
 * Middleware in front of the dashboard's static files: a page load from the
 * owner's browser gets the session cookie. Never blocks the page.
 *
 * @param peers - Process classifier
 * @returns Express middleware
 */
export function createOwnerSessionPageMiddleware(peers: PeerProcessService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isDashboardPageLoad(req)) {
      next();
      return;
    }
    classifyCaller(req, peers)
      .then((identity) => issue(req, res, identity, peers))
      .catch((error: unknown) => {
        logger.debug('Owner session not issued on page load', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => next());
  };
}
