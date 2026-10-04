/**
 * Caller identity (#999, specs/2026-10-03-owner-auth.md).
 *
 * Decides who made an `/api` request from the credentials it carries — never
 * from a header it left out:
 *
 * | kind          | credential                                                    |
 * |---------------|---------------------------------------------------------------|
 * | `agent`       | a valid agent badge, or (migration window) `X-Agent-Session`  |
 * | `relay-owner` | the in-memory relay credential (phone / portal over the relay) |
 * | `cloud`       | the in-memory cloud credential (Cloud-forwarded Slack)        |
 * | `owner`       | the owner session cookie (+ CSRF on writes) or the API token  |
 * | `anonymous`   | nothing of the above — never the owner                        |
 *
 * Any sign of an agent wins over an owner credential. The owner API token
 * presented from THIS machine is checked against the process tree: a client
 * process that belongs to an agent is that agent, not the owner.
 *
 * The answer is kept per request in a WeakMap (a client cannot set it) and
 * read through {@link getCallerIdentity}, {@link isOwnerCaller} and
 * {@link rejectNonOwner}.
 *
 * @module middleware/caller-identity
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { OWNER_AUTH_CONSTANTS, API_SECURITY_CONSTANTS } from '../constants.js';
import {
  ownerSessionCookieName,
  verifyAgentBadge,
  verifyCsrfToken,
  verifyInternalCredential,
  verifyOwnerSession,
} from '../services/core/owner-auth.service.js';
import { createHash } from 'crypto';
import { getApiTokenFingerprint, verifyApiToken } from '../services/core/api-token.service.js';
import { PeerProcessService, isHostAddress, type PeerVerdict } from '../services/core/peer-process.service.js';
import { LoggerService } from '../services/core/logger.service.js';
import { extractPresentedTokenWithSource, parseCookieHeader } from './api-token.middleware.js';
import { getAgentOriginCorrection } from './agent-origin-correction.js';

const logger = LoggerService.getInstance().createComponentLogger('CallerIdentity');

/** Who a caller is. */
export type CallerKind = 'owner' | 'agent' | 'relay-owner' | 'cloud' | 'anonymous';

/** How the caller was identified. */
export type CallerVia =
  | 'owner-session'
  | 'api-token'
  | 'agent-badge'
  | 'legacy-header'
  | 'process-tree'
  | 'relay'
  | 'cloud'
  | 'none';

/** The identity of one request's caller. */
export interface CallerIdentity {
  kind: CallerKind;
  via: CallerVia;
  /** The agent session (agents only; may be unknown for a process-tree match) */
  session?: string;
  /** The owner session id (owner via session only) */
  ownerSessionId?: string;
  /** Why an owner-looking credential was not accepted, or other detail for logs */
  note?: string;
}

/** The request parts classification reads. */
export type IdentifiableRequest = Pick<Request, 'headers'> & {
  method?: string;
  socket?: { remoteAddress?: string; remotePort?: number; localPort?: number } | null;
};

/**
 * Exhaustiveness guard: a new verdict kind must be handled explicitly.
 *
 * @param value - The unhandled value
 * @throws Always
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled peer verdict: ${JSON.stringify(value)}`);
}

/** Sentinel: the answer depends on which local process sent the request. */
const NEEDS_PEER = Symbol('needs-peer');

const identities = new WeakMap<object, CallerIdentity>();

/**
 * First value of a header.
 *
 * @param req - Request
 * @param name - Lower-case header name
 * @returns Trimmed value or undefined
 */
function header(req: IdentifiableRequest, name: string): string | undefined {
  const raw = (req.headers ?? {})[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The `X-Agent-Session` (or legacy alias) a request carries.
 *
 * @param req - Request
 * @returns Session or undefined
 */
function rawSessionHeader(req: IdentifiableRequest): string | undefined {
  return header(req, API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER) ?? header(req, API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER_LEGACY);
}

/**
 * Whether the method changes state.
 *
 * @param req - Request
 * @returns True for POST/PUT/PATCH/DELETE (and for an unknown method — fail safe)
 */
function isWrite(req: IdentifiableRequest): boolean {
  const method = (req.method ?? 'POST').toUpperCase();
  return OWNER_AUTH_CONSTANTS.MUTATING_METHODS.includes(method);
}

/**
 * The owner session a request's cookies carry, if any verifies. Every
 * `crewly_owner_*` cookie is tried: the port suffix only keeps instances on
 * one host from overwriting each other, and a cookie from another instance
 * was signed with another secret and simply does not verify.
 *
 * @param req - Request
 * @returns The session, or null
 */
export function readOwnerSession(req: IdentifiableRequest): { id: string } | null {
  const cookies = parseCookieHeader(typeof req.headers?.cookie === 'string' ? req.headers.cookie : undefined);
  const preferred = ownerSessionCookieName(req.socket?.localPort);
  const names = [preferred, ...Object.keys(cookies).filter((n) => n !== preferred && n.startsWith(OWNER_AUTH_CONSTANTS.OWNER_SESSION_COOKIE_PREFIX))];
  for (const name of names) {
    const session = verifyOwnerSession(cookies[name]);
    if (session) return session;
  }
  return null;
}

/**
 * Classify a request. Returns {@link NEEDS_PEER} when the only credential is
 * the owner API token from this machine and no peer verdict was given.
 *
 * @param req - Request
 * @param peer - Verdict on the local client process, when known
 * @returns The identity, or NEEDS_PEER
 */
function classify(req: IdentifiableRequest, peer?: PeerVerdict): CallerIdentity | typeof NEEDS_PEER {
  const headerSession = rawSessionHeader(req);
  const badgeRaw = header(req, OWNER_AUTH_CONSTANTS.AGENT_BADGE_HEADER);
  const badgeSession = verifyAgentBadge(badgeRaw);

  // 1. A valid badge: always that agent — unless the process tree proved the
  //    shell belongs to another agent PTY (a runtime leaked the environment).
  if (badgeSession) {
    const correction = getAgentOriginCorrection(req);
    const session = correction && correction.claimed === badgeSession ? correction.actual : badgeSession;
    return { kind: 'agent', via: 'agent-badge', session, ...(session !== badgeSession ? { note: `process tree overrode badge ${badgeSession}` } : {}) };
  }
  // 2. Any X-Agent-Session: an agent (migration window). Never the owner.
  if (headerSession) {
    return { kind: 'agent', via: 'legacy-header', session: headerSession, ...(badgeRaw ? { note: 'invalid agent badge' } : {}) };
  }
  // An invalid badge with no session header is not anybody we know.
  if (badgeRaw) return { kind: 'anonymous', via: 'none', note: 'invalid agent badge' };

  // 3. The in-process forwarders.
  const internal = verifyInternalCredential(header(req, OWNER_AUTH_CONSTANTS.INTERNAL_HEADER));
  if (internal === 'relay') return { kind: 'relay-owner', via: 'relay' };
  if (internal === 'cloud') return { kind: 'cloud', via: 'cloud' };

  // 4. The dashboard's session (CSRF on writes).
  let note: string | undefined;
  const ownerSession = readOwnerSession(req);
  if (ownerSession) {
    if (!isWrite(req) || verifyCsrfToken(ownerSession.id, header(req, OWNER_AUTH_CONSTANTS.CSRF_HEADER))) {
      return { kind: 'owner', via: 'owner-session', ownerSessionId: ownerSession.id };
    }
    note = 'owner session without a valid CSRF token on a write';
  }

  // 5. The owner API token.
  const presented = extractPresentedTokenWithSource(req);
  if (presented && verifyApiToken(presented.token)) {
    if (presented.source === 'cookie' && isWrite(req)) {
      return { kind: 'anonymous', via: 'none', note: 'API token only in a cookie on a write' };
    }
    if (!peer) {
      const address = req.socket?.remoteAddress ?? '';
      // An empty address is a socket the sender already closed, not a remote
      // caller: never the owner on that basis (#1010 review).
      if (address && !isHostAddress(address)) return { kind: 'owner', via: 'api-token' };
      return NEEDS_PEER;
    }
    switch (peer.kind) {
      case 'agent':
        return {
          kind: 'agent',
          via: 'process-tree',
          ...(peer.session ? { session: peer.session } : {}),
          note: `agent process (${peer.signal}) presented the owner API token`,
        };
      case 'gone':
        // The lookup ran and the sender was not there (it exited first — an
        // agent can write over a raw socket and quit). Fail closed.
        return { kind: 'anonymous', via: 'none', note: `owner token from a vanished local process: ${peer.reason}` };
      case 'unknown':
        // The lookup could not run (tool missing, timeout): fail open.
        return { kind: 'owner', via: 'api-token', note: `process check skipped: ${peer.reason}` };
      case 'remote':
      case 'self':
      case 'not-agent':
        return { kind: 'owner', via: 'api-token' };
      default:
        return assertNever(peer);
    }
  }

  return { kind: 'anonymous', via: 'none', ...(note ? { note } : {}) };
}

/**
 * Classify without a process lookup. A local API-token caller is anonymous
 * here (it needs {@link callerIdentityMiddleware}'s process check to be the
 * owner); everything else is decided exactly as the middleware would.
 *
 * @param req - Request
 * @returns The identity
 */
export function classifyCallerSync(req: IdentifiableRequest): CallerIdentity {
  const result = classify(req);
  return result === NEEDS_PEER ? { kind: 'anonymous', via: 'none', note: 'local API token needs the process check' } : result;
}

/**
 * Classify with the process check for a local API-token caller.
 *
 * @param req - Request
 * @param peers - Process classifier
 * @returns The identity
 */
export async function classifyCaller(req: IdentifiableRequest, peers: PeerProcessService): Promise<CallerIdentity> {
  const first = classify(req);
  if (first !== NEEDS_PEER) return first;
  const verdict = await peers.classify(req.socket ?? null);
  const second = classify(req, verdict);
  return second === NEEDS_PEER ? { kind: 'anonymous', via: 'none' } : second;
}

/**
 * Store a request's identity (the middleware; tests).
 *
 * @param req - Request
 * @param identity - Identity
 */
export function setCallerIdentity(req: object, identity: CallerIdentity): void {
  identities.set(req, identity);
}

/**
 * The identity of a request's caller: what the middleware decided, or a
 * synchronous classification for a request it did not see (unit tests that
 * mount a router alone).
 *
 * @param req - Request
 * @returns The identity
 */
export function getCallerIdentity(req: IdentifiableRequest): CallerIdentity {
  return identities.get(req) ?? classifyCallerSync(req);
}

/**
 * Whether the caller holds an owner credential: the dashboard session, the
 * owner API token, or the phone / portal relay.
 *
 * @param req - Request
 * @returns True for the owner
 */
export function isOwnerCaller(req: IdentifiableRequest): boolean {
  const { kind } = getCallerIdentity(req);
  return kind === 'owner' || kind === 'relay-owner';
}

/**
 * The agent session of the caller, when it is an agent.
 *
 * @param req - Request
 * @returns Session or undefined
 */
export function callerAgentSession(req: IdentifiableRequest): string | undefined {
  const id = getCallerIdentity(req);
  return id.kind === 'agent' ? id.session : undefined;
}

/** The 401 body for a caller with no owner credential. */
export const OWNER_AUTH_REQUIRED_BODY = Object.freeze({
  success: false,
  error: OWNER_AUTH_CONSTANTS.ERRORS.OWNER_AUTH_REQUIRED,
  code: OWNER_AUTH_CONSTANTS.ERRORS.OWNER_AUTH_REQUIRED,
  message: 'This action needs the owner: use the dashboard on this machine, the phone app, or the API token (`crewly token`).',
});

/**
 * Whether a request comes from a browser that holds no valid owner session:
 * a dashboard tab opened before the upgrade (its bundle never asks for a
 * session), or one whose session ended with a backend restart.
 *
 * @param req - Request
 * @returns True for a browser request without a session
 */
export function isBrowserWithoutSession(req: IdentifiableRequest): boolean {
  const h = req.headers ?? {};
  const browser = Boolean(
    h['sec-fetch-site'] || h['sec-fetch-mode'] || h.origin || h.referer || /Mozilla\//.test(String(h['user-agent'] ?? '')),
  );
  return browser && !readOwnerSession(req);
}

/**
 * The 401 body for a caller with no owner credential. A browser without a
 * session gets the plain instruction in `error` — what an old dashboard tab
 * shows the owner — and every body carries `code: owner_auth_required`,
 * which the new dashboard reacts to by refreshing its session and retrying.
 *
 * @param req - Request (optional)
 * @returns Response body
 */
export function ownerAuthRequiredBody(req?: IdentifiableRequest): Record<string, unknown> {
  if (req && isBrowserWithoutSession(req)) {
    return {
      success: false,
      error: OWNER_AUTH_CONSTANTS.RELOAD_MESSAGE,
      code: OWNER_AUTH_CONSTANTS.ERRORS.OWNER_AUTH_REQUIRED,
      reload: true,
      message: OWNER_AUTH_CONSTANTS.RELOAD_MESSAGE,
    };
  }
  return { ...OWNER_AUTH_REQUIRED_BODY };
}

/**
 * Thrown by handlers that map errors to responses themselves (decisions,
 * project tickets): carries the owner-auth 401 body.
 */
export class OwnerAuthRequiredError extends Error {
  readonly status = 401;

  /**
   * @param body - The 401 body ({@link ownerAuthRequiredBody})
   */
  constructor(readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

/**
 * Answer 401 owner_auth_required. No `WWW-Authenticate: Crewly-Token`: the
 * dashboard refreshes its session instead of prompting for the API token.
 *
 * @param res - Response
 * @param req - Request, so a browser without a session is told to reload
 */
export function sendOwnerAuthRequired(res: Response, req?: IdentifiableRequest): void {
  res.status(401).json(ownerAuthRequiredBody(req));
}

/**
 * Refuse a caller that is not the owner. Agents get `agentBody` (403, the
 * route's own wording); everyone else without an owner credential gets 401.
 *
 * @param req - Request
 * @param res - Response
 * @param agentBody - 403 body for an agent
 * @returns True when refused (response written)
 *
 * @example
 * ```ts
 * if (rejectNonOwner(req, res, { success: false, error: 'Only the owner can dismiss a ticket' })) return;
 * ```
 */
export function rejectNonOwner(
  req: Request,
  res: Response,
  agentBody: Record<string, unknown> = { success: false, error: OWNER_AUTH_CONSTANTS.ERRORS.OWNER_ONLY, message: 'Only the owner can do this.' },
): boolean {
  const id = getCallerIdentity(req);
  if (id.kind === 'owner' || id.kind === 'relay-owner') return false;
  if (id.kind === 'agent') {
    res.status(403).json(agentBody);
    return true;
  }
  sendOwnerAuthRequired(res, req);
  return true;
}

/**
 * Express middleware form of {@link rejectNonOwner}.
 *
 * @param req - Request
 * @param res - Response
 * @param next - Next
 */
export const requireOwner: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  if (rejectNonOwner(req, res)) return;
  next();
};

/**
 * Owner-only decisions with an audit fingerprint (OKR approve/reject, signal
 * digest items). Agents get 403 `owner_approval_required`; a caller with no
 * owner credential gets 401. Before #999 this required the raw API token
 * even from loopback, so the local dashboard could not use it; the owner
 * session now counts too.
 *
 * On success `res.locals.ownerTokenFingerprint` names the credential for the
 * audit trail: 8 hex of sha256(API token), `session-<8 hex>` for a dashboard
 * session, or `relay`.
 *
 * @param req - Request
 * @param res - Response
 * @param next - Next
 */
export const requireOwnerToken: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const id = getCallerIdentity(req);
  if (id.kind === 'agent') {
    res.status(403).json({
      success: false,
      error: API_SECURITY_CONSTANTS.ERRORS.OWNER_APPROVAL_REQUIRED,
      hint: 'This decision must be made by the owner from the dashboard or with the API token, not by an agent session.',
    });
    return;
  }
  if (id.kind !== 'owner' && id.kind !== 'relay-owner') {
    sendOwnerAuthRequired(res, req);
    return;
  }
  if (id.via === 'api-token') {
    res.locals.ownerTokenFingerprint = getApiTokenFingerprint(extractPresentedTokenWithSource(req)?.token);
  } else if (id.via === 'owner-session' && id.ownerSessionId) {
    res.locals.ownerTokenFingerprint = `session-${createHash('sha256').update(id.ownerSessionId).digest('hex').slice(0, 8)}`;
  } else {
    res.locals.ownerTokenFingerprint = id.via;
  }
  next();
};

/**
 * {@link requireOwner} with the route's own 403 wording for agents.
 *
 * @param agentBody - 403 body for an agent
 * @returns Express middleware
 */
export function ownerOnly(agentBody: Record<string, unknown>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (rejectNonOwner(req, res, agentBody)) return;
    next();
  };
}

/**
 * Whether an identity is an agent proven by a credential: its badge, or the
 * process tree (an agent PTY's process presented the owner token). The
 * legacy `X-Agent-Session` header alone is not proof — any local process can
 * set it.
 *
 * @param identity - Caller identity
 * @returns True for a badge or process-tree agent with a known session
 */
export function isVerifiedAgent(identity: CallerIdentity): boolean {
  return identity.kind === 'agent' && Boolean(identity.session) && (identity.via === 'agent-badge' || identity.via === 'process-tree');
}

/**
 * Refuse a caller that is neither the owner nor a verified agent
 * ({@link isVerifiedAgent}). An agent with only the legacy header gets 403
 * `agent_badge_required`; everyone else without a credential gets 401.
 *
 * @param req - Request
 * @param res - Response
 * @param action - What the caller tried, for the 403 message (e.g. "Writing into an agent's terminal")
 * @returns True when refused (response written)
 */
export function rejectUnverifiedCaller(req: Request, res: Response, action: string): boolean {
  const id = getCallerIdentity(req);
  if (id.kind === 'owner' || id.kind === 'relay-owner' || isVerifiedAgent(id)) return false;
  if (id.kind === 'agent') {
    res.status(403).json({
      success: false,
      error: OWNER_AUTH_CONSTANTS.ERRORS.AGENT_BADGE_REQUIRED,
      code: OWNER_AUTH_CONSTANTS.ERRORS.AGENT_BADGE_REQUIRED,
      message: `${action} needs the agent badge (CREWLY_AGENT_BADGE). Restart the agent so it gets one.`,
    });
    return true;
  }
  sendOwnerAuthRequired(res, req);
  return true;
}

/**
 * Express middleware form of {@link rejectUnverifiedCaller}: the owner, or an
 * agent identified by its badge (or the process tree).
 *
 * @param action - What the route does, for the 403 message
 * @returns Express middleware
 *
 * @example
 * ```ts
 * router.post('/terminal/:s/write', ownerOrVerifiedAgent("Writing into an agent's terminal"), handler);
 * ```
 */
export function ownerOrVerifiedAgent(action: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (rejectUnverifiedCaller(req, res, action)) return;
    next();
  };
}

const lastWarned = new Map<string, number>();

/**
 * Warn at most once per LEGACY_WARN_THROTTLE_MS per key.
 *
 * @param key - Throttle key
 * @param message - Message
 * @param meta - Fields
 */
function warnThrottled(key: string, message: string, meta: Record<string, unknown>): void {
  const now = Date.now();
  const last = lastWarned.get(key);
  if (last !== undefined && now - last < OWNER_AUTH_CONSTANTS.LEGACY_WARN_THROTTLE_MS) return;
  if (lastWarned.size > 1000) lastWarned.clear();
  lastWarned.set(key, now);
  logger.warn(message, meta);
}

/**
 * Point `X-Agent-Session` at the identified agent, so code that reads the
 * header sees the authenticated identity. Never adds the header: a call
 * that left it out on purpose (`remote-browser --no-bind`) keeps it out.
 *
 * @param req - Request (headers mutated)
 * @param identity - Its identity
 */
function normaliseSessionHeader(req: Request, identity: CallerIdentity): void {
  if (identity.kind !== 'agent' || !identity.session) return;
  for (const name of [API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER, API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER_LEGACY]) {
    const current = header(req, name);
    if (current !== undefined && current !== identity.session) req.headers[name] = identity.session;
  }
}

/**
 * Build the `/api` middleware.
 *
 * @param peers - Process classifier. The server passes one that knows the
 *   live agent PTYs (`liveSessionPids` from the agent-origin middleware), so
 *   the terminal check and session names work; without it only the
 *   ancestry and environment checks run.
 * @returns Express middleware
 */
export function createCallerIdentityMiddleware(peers: PeerProcessService = new PeerProcessService()): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    classifyCaller(req, peers)
      .then((identity) => {
        identities.set(req, identity);
        normaliseSessionHeader(req, identity);
        if (identity.via === 'legacy-header') {
          warnThrottled(`legacy:${identity.session}`, 'Agent call without an agent badge — accepted as that agent for this release only. Restart the agent so it gets CREWLY_AGENT_BADGE.', {
            session: identity.session,
            path: req.path,
          });
        } else if (identity.via === 'process-tree') {
          warnThrottled(`tree:${identity.session ?? '?'}`, 'An agent process presented the owner API token — treated as that agent, not the owner.', {
            session: identity.session,
            path: req.path,
          });
        } else if (identity.note?.startsWith('process check skipped')) {
          warnThrottled('peer-unknown', 'Could not tell which local process sent an owner-token request — accepted as the owner (fail open).', {
            reason: identity.note,
            path: req.path,
          });
        }
        next();
      })
      .catch((error: unknown) => {
        // Classification never throws in practice; if it does, the request is anonymous.
        identities.set(req, { kind: 'anonymous', via: 'none', note: 'classification failed' });
        logger.warn('Caller classification failed — treating the request as anonymous', {
          error: error instanceof Error ? error.message : String(error),
        });
        next();
      });
  };
}
