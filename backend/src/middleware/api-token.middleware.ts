/**
 * API token middleware.
 *
 * Gates `/api/*`, Socket.IO and raw WebSocket upgrades behind the shared
 * API token for every caller that is NOT on loopback. Loopback callers
 * (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) pass without a token — that is
 * how local skills (`api_call` in `config/skills/_common/lib.sh`) and the
 * local dashboard work with zero setup.
 *
 * The token can be presented as `Authorization: Bearer <token>`,
 * `X-Crewly-Token: <token>`, a `crewly_token` cookie, or (WebSocket /
 * dashboard deep link only) a `?token=` query parameter.
 *
 * `X-Forwarded-For` is honoured ONLY when `CREWLY_TRUST_PROXY=1`, otherwise
 * any LAN caller could spoof a loopback origin.
 *
 * The existing `require-auth.middleware.ts` (HS256 JWT for chat-v2) is
 * untouched; this module only re-uses its verifier so that `/ws/chat`
 * clients holding a valid JWT keep working when `CREWLY_JWT_SECRET` is set.
 *
 * @module middleware/api-token
 */

import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Socket } from 'net';
import { API_SECURITY_CONSTANTS } from '../../../config/constants.js';
import { verifyApiToken, getApiTokenFingerprint } from '../services/core/api-token.service.js';
import { verifyHs256Token } from './require-auth.middleware.js';
import { LoggerService } from '../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('ApiTokenMiddleware');

/** Path prefix of the chat-v2 WebSocket gateway (has its own JWT verifier). */
const CHAT_WS_PATH = '/ws/chat';

/** Header carrying the agent session identity (set by skill `api_call`). */
const AGENT_SESSION_HEADER = 'x-agent-session';

/** Minimal request shape shared by Express requests and raw upgrade requests. */
export interface AddressableRequest {
  headers: IncomingMessage['headers'];
  socket?: { remoteAddress?: string } | null;
  url?: string;
}

/**
 * Whether `X-Forwarded-For` should be trusted for loopback classification.
 *
 * @returns True when `CREWLY_TRUST_PROXY` is `1` or `true`
 */
export function isProxyTrusted(): boolean {
  const raw = process.env[API_SECURITY_CONSTANTS.ENV.TRUST_PROXY];
  return raw === '1' || raw === 'true';
}

/**
 * Resolve the address a request originates from.
 *
 * @param req - Express request or raw upgrade request
 * @returns Remote address string, or empty string when unknown
 */
export function getClientAddress(req: AddressableRequest): string {
  if (isProxyTrusted()) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket?.remoteAddress ?? '';
}

/**
 * Whether an address is one of the loopback forms Node reports.
 *
 * @param address - Remote address
 * @returns True for `127.0.0.1`, `::1` and `::ffff:127.0.0.1`
 */
export function isLoopbackAddress(address: string): boolean {
  return (API_SECURITY_CONSTANTS.LOOPBACK_ADDRESSES as readonly string[]).includes(address);
}

/**
 * Whether a request originates from loopback (honouring the proxy rule).
 *
 * @param req - Express request or raw upgrade request
 * @returns True when the caller is local
 */
export function isLoopbackRequest(req: AddressableRequest): boolean {
  return isLoopbackAddress(getClientAddress(req));
}

/**
 * Parse a `Cookie` header into a name → value map.
 *
 * @param header - Raw cookie header
 * @returns Parsed cookies (URL-decoded values)
 */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Extract the token a caller presented, if any.
 *
 * Order: `Authorization: Bearer`, `X-Crewly-Token`, `crewly_token` cookie,
 * then (when `allowQuery`) the `?token=` query parameter.
 *
 * @param req - Request carrying headers and url
 * @param allowQuery - Whether to consult the query string (WebSocket handshakes)
 * @returns Presented token or null
 */
export function extractPresentedToken(req: AddressableRequest, allowQuery: boolean): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const value = auth.slice('Bearer '.length).trim();
    if (value) return value;
  }
  const headerToken = req.headers[API_SECURITY_CONSTANTS.TOKEN_HEADER];
  const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (headerValue) return headerValue.trim();

  const cookies = parseCookies(req.headers.cookie);
  const cookieValue = cookies[API_SECURITY_CONSTANTS.TOKEN_COOKIE];
  if (cookieValue) return cookieValue;

  if (allowQuery && req.url) {
    try {
      const host = req.headers.host || 'localhost';
      const queryValue = new URL(req.url, `http://${host}`).searchParams.get(
        API_SECURITY_CONSTANTS.TOKEN_QUERY_PARAM,
      );
      if (queryValue) return queryValue;
    } catch {
      // Malformed URL — treat as no token
    }
  }
  return null;
}

/**
 * Whether a request presented a valid API token.
 *
 * @param req - Request carrying headers and url
 * @param allowQuery - Whether to consult the query string
 * @returns True when the presented token matches
 */
export function hasValidApiToken(req: AddressableRequest, allowQuery: boolean): boolean {
  return verifyApiToken(extractPresentedToken(req, allowQuery));
}

/**
 * Send the standard 401 challenge.
 *
 * @param res - Express response
 */
function sendUnauthorized(res: Response): void {
  res.setHeader('WWW-Authenticate', API_SECURITY_CONSTANTS.AUTH_SCHEME);
  res.status(401).json({
    success: false,
    error: API_SECURITY_CONSTANTS.ERRORS.UNAUTHORIZED,
    hint: API_SECURITY_CONSTANTS.UNAUTHORIZED_HINT,
  });
}

/**
 * Express middleware: loopback passes, everyone else needs the API token.
 *
 * Mounted in front of `/api` in `backend/src/index.ts`. `/health`, static
 * assets and the SPA shell are not under `/api` and stay open.
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Express next
 */
export function apiTokenMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isLoopbackRequest(req)) {
    next();
    return;
  }
  if (hasValidApiToken(req, false)) {
    next();
    return;
  }
  logger.warn('Rejected unauthenticated non-loopback API request', {
    address: getClientAddress(req),
    method: req.method,
    path: req.originalUrl,
  });
  sendUnauthorized(res);
}

/**
 * Express middleware for owner-only decisions (OKR approve/reject).
 *
 * Requires the API token EVEN from loopback — agents on the box do not have
 * it (the server strips `CREWLY_API_TOKEN` from agent PTY environments and
 * the token file is 0600), the dashboard does. Any request carrying an
 * `X-Agent-Session` header is refused outright with 403 so an agent cannot
 * approve its own proposal even if it somehow obtained the token.
 *
 * On success `res.locals.ownerTokenFingerprint` holds the first 8 hex chars
 * of sha256(token) for the audit trail.
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Express next
 */
export function requireOwnerToken(req: Request, res: Response, next: NextFunction): void {
  const agentSession = req.headers[AGENT_SESSION_HEADER];
  if (typeof agentSession === 'string' && agentSession.length > 0) {
    res.status(403).json({
      success: false,
      error: API_SECURITY_CONSTANTS.ERRORS.OWNER_APPROVAL_REQUIRED,
      hint: 'This decision must be made by the owner from the dashboard or with the API token, not by an agent session.',
    });
    return;
  }
  const presented = extractPresentedToken(req, false);
  if (!verifyApiToken(presented)) {
    sendUnauthorized(res);
    return;
  }
  res.locals.ownerTokenFingerprint = getApiTokenFingerprint(presented as string);
  next();
}

/**
 * Decide whether a raw HTTP request (WebSocket upgrade or Engine.IO
 * handshake) may proceed.
 *
 * Loopback passes. Otherwise the API token must be present (query `token`
 * accepted here because browsers cannot set headers on WebSocket
 * handshakes). `/ws/chat` additionally accepts a valid chat JWT when
 * `CREWLY_JWT_SECRET` is configured, since that gateway has its own auth.
 *
 * @param req - Incoming HTTP request
 * @returns True when the connection is allowed
 */
export function isUpgradeAllowed(req: IncomingMessage): boolean {
  if (isLoopbackRequest(req)) return true;
  if (hasValidApiToken(req, true)) return true;

  const jwtSecret = process.env['CREWLY_JWT_SECRET'];
  if (jwtSecret && req.url) {
    try {
      const host = req.headers.host || 'localhost';
      const parsed = new URL(req.url, `http://${host}`);
      if (parsed.pathname === CHAT_WS_PATH) {
        const jwt = parsed.searchParams.get(API_SECURITY_CONSTANTS.TOKEN_QUERY_PARAM);
        if (jwt && verifyHs256Token(jwt, jwtSecret)?.sub) return true;
      }
    } catch {
      // fall through
    }
  }
  return false;
}

/**
 * Engine.IO `allowRequest` hook for the Socket.IO server. Covers both the
 * polling handshake (which bypasses Express) and the WebSocket transport.
 *
 * @param req - Handshake request
 * @param callback - Engine.IO callback `(err, success)`
 */
export function socketIoAllowRequest(
  req: IncomingMessage,
  callback: (err: string | null | undefined, success: boolean) => void,
): void {
  if (isUpgradeAllowed(req)) {
    callback(null, true);
    return;
  }
  logger.warn('Rejected unauthenticated non-loopback Socket.IO handshake', {
    address: getClientAddress(req),
  });
  callback(API_SECURITY_CONSTANTS.ERRORS.UNAUTHORIZED, false);
}

/**
 * Install the WebSocket upgrade gate on an HTTP server.
 *
 * Wraps `httpServer.emit` (the same exclusive-handoff pattern the browser
 * bridge and chat gateway use) so an unauthorised `upgrade` is answered
 * with `401` and closed before ANY gateway sees it. Must be installed
 * AFTER every gateway has attached so this wrapper is the outermost one.
 *
 * @param httpServer - Server whose upgrades to gate
 */
export function installWebSocketGate(httpServer: HttpServer): void {
  const originalEmit = httpServer.emit.bind(httpServer) as (...args: unknown[]) => boolean;
  (httpServer as { emit: (...args: unknown[]) => boolean }).emit = (
    event: unknown,
    ...args: unknown[]
  ): boolean => {
    if (event === 'upgrade') {
      const request = args[0] as IncomingMessage;
      const socket = args[1] as Socket;
      if (!isUpgradeAllowed(request)) {
        logger.warn('Rejected unauthenticated non-loopback WebSocket upgrade', {
          address: getClientAddress(request),
          path: request.url,
        });
        socket.write(
          `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${API_SECURITY_CONSTANTS.AUTH_SCHEME}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        socket.destroy();
        return true;
      }
    }
    return originalEmit(event, ...args);
  };
}
