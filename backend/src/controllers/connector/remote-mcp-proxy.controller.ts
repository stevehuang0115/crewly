/**
 * Agent → remote MCP proxy: `/api/connectors/remote-mcp/:id/mcp`.
 *
 * Agents' MCP configs point here instead of at the server, so the server's
 * URL (Zoho's carries its key) and OAuth tokens never sit in an agent's
 * config. Each request:
 *
 * 1. must come from an agent (its badge or session header — the owner and
 *    anonymous callers are refused with 403, never 401: a 401 would make
 *    Claude Code start its own localhost OAuth flow against us);
 * 2. passes the server's `mcp:<id>` role allowlist;
 * 3. is forwarded with the server's static headers plus a fresh
 *    `Authorization: Bearer` for OAuth servers — streamable HTTP as is:
 *    JSON or `text/event-stream` responses stream through, `Mcp-Session-Id`,
 *    `MCP-Protocol-Version` and `Last-Event-ID` pass both ways;
 * 4. on an upstream 401 the token is refreshed once and the request
 *    retried; when that fails the owner gets a sign-in card (throttled) and
 *    the agent gets a JSON-RPC error saying so.
 *
 * Nothing about the URL, token or body is logged.
 *
 * @module controllers/connector/remote-mcp-proxy.controller
 */

import type { Request, Response } from 'express';
import { Readable } from 'stream';
import { LoggerService } from '../../services/core/logger.service.js';
import { getCallerIdentity } from '../../middleware/caller-identity.middleware.js';
import { resolveAgentCaller } from '../../utils/agent-caller.utils.js';
import { ConnectorAccessService } from '../../services/connector/connector-access.service.js';
import { RemoteMcpService, remoteMcpConnectorId, type RemoteMcpServer } from '../../services/connector/remote-mcp.service.js';
import { RemoteMcpAuthService } from '../../services/connector/remote-mcp-auth.service.js';
import { REMOTE_MCP_CONSTANTS } from '../../constants.js';

const logger = LoggerService.getInstance().createComponentLogger('RemoteMcpProxy');
const C = REMOTE_MCP_CONSTANTS;

/** Request headers passed upstream. */
const FORWARD_REQUEST = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
/** Response headers passed back. */
const FORWARD_RESPONSE = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control'];

/** Upstream response shape the proxy needs (fetch's Response). */
export interface UpstreamResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/** Collaborators (tests inject). */
export interface ProxyDeps {
  servers: () => Pick<RemoteMcpService, 'get'>;
  auth: () => Pick<RemoteMcpAuthService, 'usesOAuth' | 'getAccessToken' | 'onUnauthorized' | 'view'>;
  access: () => Pick<ConnectorAccessService, 'isAllowed' | 'allowedRoles'>;
  fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<UpstreamResponse>;
}

let deps: ProxyDeps = {
  servers: () => RemoteMcpService.getInstance(),
  auth: () => RemoteMcpAuthService.getInstance(),
  access: () => ConnectorAccessService.getInstance(),
  fetchImpl: (url, init) => fetch(url, init) as unknown as Promise<UpstreamResponse>,
};

/**
 * Replace collaborators (tests).
 *
 * @param next - Partial overrides
 */
export function setRemoteMcpProxyDeps(next: Partial<ProxyDeps>): void {
  deps = { ...deps, ...next };
}

/**
 * The JSON-RPC id of a request body, if it is a request (not a notification).
 *
 * @param body - Raw body
 * @returns The id, or undefined
 */
export function rpcIdOf(body: string | undefined): string | number | null | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { id?: string | number | null } | Array<{ id?: string | number | null }>;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return first && 'id' in first ? first.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answer the agent without reaching the server.
 *
 * @param res - Response
 * @param body - Raw request body (decides JSON-RPC error vs plain)
 * @param message - What the agent should know
 * @param httpStatus - Status when it is not a JSON-RPC request
 */
function refuse(res: Response, body: string | undefined, message: string, httpStatus: number, rpcCode = -32000): void {
  const id = rpcIdOf(body);
  if (id !== undefined) {
    res.status(200).json({ jsonrpc: '2.0', id, error: { code: rpcCode, message } });
    return;
  }
  res.status(httpStatus).json({ success: false, error: message });
}

/**
 * ALL /api/connectors/remote-mcp/:id/mcp
 *
 * @param req - Agent request (JSON-RPC over streamable HTTP)
 * @param res - The server's answer, streamed
 */
export async function proxyRemoteMcp(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const raw = (req as Request & { rawBody?: string }).rawBody;
  const body = req.method === 'POST' ? (raw ?? (req.body && Object.keys(req.body as object).length ? JSON.stringify(req.body) : undefined)) : undefined;

  const identity = getCallerIdentity(req);
  if (identity.kind !== 'agent') {
    res.status(403).json({ success: false, error: 'agents_only', message: 'This endpoint is for Crewly agents. The owner manages servers in Connections.' });
    return;
  }
  const caller = await resolveAgentCaller(req);
  let server: RemoteMcpServer | undefined;
  try {
    server = await deps.servers().get(id);
  } catch {
    server = undefined;
  }
  if (!server) {
    refuse(res, body, 'No such remote MCP server on this machine.', 404);
    return;
  }
  if (!(await deps.access().isAllowed(remoteMcpConnectorId(server.id), caller.role || 'unknown'))) {
    const allowed = await deps.access().allowedRoles(remoteMcpConnectorId(server.id)).catch(() => [] as string[]);
    logger.warn('Remote MCP proxy: role not allowed', { id, session: caller.session, role: caller.role, allowed });
    refuse(res, body, `Your role (${caller.role}) may not use ${server.label}. The owner limited it to: ${allowed.join(', ')}.`, 403);
    return;
  }

  const auth = deps.auth();
  const oauth = await auth.usesOAuth(server.id);
  const needsSignIn = async (): Promise<void> => {
    void auth.onUnauthorized(server!, caller.session).catch(() => undefined);
    logger.info('Remote MCP proxy: owner sign-in needed', { id, session: caller.session });
    refuse(
      res,
      body,
      `${server!.label} needs the owner to sign in once. A sign-in link was sent to the owner in Slack (and is on the Connections page). Tell the owner, then try again after they authorize.`,
      503,
      C.PROXY_NEEDS_AUTH_RPC_CODE,
    );
  };

  let token: string | null = null;
  if (oauth) {
    token = await auth.getAccessToken(server.id);
    if (!token) {
      await needsSignIn();
      return;
    }
  }

  const controller = new AbortController();
  // `close` on the response fires when the agent goes away (or we finish).
  res.on('close', () => controller.abort());

  const send = (bearer: string | null): Promise<UpstreamResponse> => {
    const headers: Record<string, string> = { ...(server!.headers ?? {}) };
    for (const name of FORWARD_REQUEST) {
      const v = req.headers[name];
      if (typeof v === 'string' && v) headers[name] = v;
    }
    if (!headers['accept']) headers['accept'] = 'application/json, text/event-stream';
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    return deps.fetchImpl(server!.url, { method: req.method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal });
  };

  let upstream: UpstreamResponse;
  try {
    upstream = await send(token);
    if (upstream.status === 401 && oauth) {
      await upstream.text().catch(() => '');
      const fresh = await auth.getAccessToken(server.id, { force: true });
      if (!fresh) {
        await needsSignIn();
        return;
      }
      upstream = await send(fresh);
      if (upstream.status === 401) {
        await upstream.text().catch(() => '');
        await needsSignIn();
        return;
      }
    } else if (upstream.status === 401) {
      // A static-key server refused: the URL/key is wrong, or it moved to OAuth.
      await upstream.text().catch(() => '');
      logger.warn('Remote MCP proxy: upstream refused a static-key server', { id });
      refuse(res, body, `${server.label} refused the request (401). The owner should press Test on it in Connections.`, 502);
      return;
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    logger.warn('Remote MCP proxy: upstream unreachable', { id, error: err instanceof Error ? err.name : 'unknown' });
    refuse(res, body, `${server.label} is unreachable right now.`, 502);
    return;
  }

  res.status(upstream.status);
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v) res.setHeader(name, v);
  }
  if ((upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body as unknown as import('stream/web').ReadableStream);
  stream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  stream.pipe(res);
}
