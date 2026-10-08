/**
 * Remote MCP servers — owner-only API behind the "Remote MCP servers" card
 * in Connections.
 *
 * - GET    /api/connectors/remote-mcp           — list (URL masked, header values withheld)
 * - POST   /api/connectors/remote-mcp           — add `{ label, url, headers?, provider? }`
 * - PATCH  /api/connectors/remote-mcp/:id       — rename `{ label }`
 * - DELETE /api/connectors/remote-mcp/:id       — remove (and its allowlist)
 * - POST   /api/connectors/remote-mcp/:id/test  — MCP initialize + tools/list
 * - POST   /api/connectors/remote-mcp/:id/rename — same as PATCH (relay: GET/POST only)
 * - POST   /api/connectors/remote-mcp/:id/remove — same as DELETE (relay: GET/POST only)
 * - POST   /api/connectors/remote-mcp/:id/access — `{ allowedRoles }` for this server only
 * - POST   /api/connectors/remote-mcp/:id/authorize — start (or reuse) an OAuth sign-in → `{ url, expiresAt, posted }`
 *
 * OAuth servers (Zoho MCP answers 401 + `resource_metadata`) are detected on
 * add and on test: the response then carries `authorize: { url, expiresAt }`
 * — a single-use Crewly Cloud link the owner can open on a phone — and the
 * owner gets the same link as a Slack card. Each server's view carries
 * `auth` (needs_auth / connected / error, scopes, expiry).
 *
 * Which agents get a server is its `mcp:<id>` allowlist
 * (`PUT /api/connectors/access/mcp:<id>`). Changes reach an agent the next
 * time it starts.
 *
 * @module controllers/connector/remote-mcp.controller
 */

import type { Request, Response } from 'express';
import { LoggerService } from '../../services/core/logger.service.js';
import { rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { RemoteMcpService, RemoteMcpValidationError, remoteMcpConnectorId, toView } from '../../services/connector/remote-mcp.service.js';
import { ConnectorAccessService } from '../../services/connector/connector-access.service.js';
import { probeRemoteMcp, type RemoteMcpProbeResult } from '../../services/connector/remote-mcp-probe.service.js';
import { RemoteMcpAuthError, RemoteMcpAuthService, type RemoteMcpAuthView } from '../../services/connector/remote-mcp-auth.service.js';
import { parseWwwAuthenticate } from '../../services/connector/remote-mcp-oauth.js';
import type { RemoteMcpServer, RemoteMcpServerView } from '../../services/connector/remote-mcp.service.js';

const logger = LoggerService.getInstance().createComponentLogger('RemoteMcpController');

/** Told to the owner after every change. */
export const NEXT_LAUNCH_NOTE = 'Agents pick this up the next time they start (restart an agent to apply it now).';

/** 403 body for an agent. */
const AGENT_REFUSAL = { success: false, error: 'owner_only', message: 'Only the owner can manage remote MCP servers (Connections).' };

/**
 * Send a failure without leaking anything from the error.
 *
 * @param res - Response
 * @param err - Error
 * @param what - Action for the log
 */
function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof RemoteMcpValidationError) {
    res.status(400).json({ success: false, error: 'validation', message: err.message });
    return;
  }
  // Store errors are fs errors (paths, codes) — never the URL.
  logger.error(`Remote MCP: ${what} failed`, { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ success: false, error: 'internal', message: `Could not ${what} the remote MCP server` });
}

/**
 * A server's view plus its sign-in state.
 *
 * @param server - Stored server
 * @returns View with `auth` for OAuth servers
 */
async function viewWithAuth(server: RemoteMcpServer): Promise<RemoteMcpServerView & { auth?: RemoteMcpAuthView }> {
  const auth = await RemoteMcpAuthService.getInstance().view(server.id).catch(() => undefined);
  return { ...toView(server), ...(auth ? { auth } : {}) };
}

/**
 * Start a sign-in and describe the outcome for a response.
 *
 * @param server - Stored server
 * @param challenge - Raw `WWW-Authenticate`, when a probe saw one
 * @param notify - Post the Slack card too
 * @returns `{ url, expiresAt, posted }`, or `{ error }`
 */
async function startSignIn(server: RemoteMcpServer, challenge: string | undefined, notify: boolean): Promise<{ url: string; expiresAt: string; posted: boolean } | { error: string }> {
  try {
    return await RemoteMcpAuthService.getInstance().startAuthorization(server, {
      notify,
      ...(challenge !== undefined ? { challenge: parseWwwAuthenticate(challenge) } : {}),
    });
  } catch (err) {
    const message = err instanceof RemoteMcpAuthError ? err.message : 'Could not start the sign-in.';
    logger.warn('Remote MCP: sign-in not started', { id: server.id, error: message });
    return { error: message };
  }
}

/**
 * Probe a server, with its OAuth token when it has one (refreshed once on 401).
 *
 * @param server - Stored server
 * @returns Probe result
 */
async function probeWithAuth(server: RemoteMcpServer): Promise<RemoteMcpProbeResult> {
  const auth = RemoteMcpAuthService.getInstance();
  if (!(await auth.usesOAuth(server.id))) return probeRemoteMcp(server);
  const run = async (token: string | null) => probeRemoteMcp({ url: server.url, headers: { ...(server.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const token = await auth.getAccessToken(server.id);
  if (!token) return { ok: false, error: 'Sign in to this server first.', needsAuth: true };
  const first = await run(token);
  if (first.ok || !first.needsAuth) return first;
  const fresh = await auth.getAccessToken(server.id, { force: true });
  return fresh ? run(fresh) : first;
}

/**
 * GET /api/connectors/remote-mcp
 *
 * @param req - Request
 * @param res - `{ success, data: RemoteMcpServerView[] }`
 */
export async function listRemoteMcp(req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, AGENT_REFUSAL)) return;
  try {
    const servers = await RemoteMcpService.getInstance().list();
    res.json({ success: true, data: await Promise.all(servers.map(viewWithAuth)) });
  } catch (err) {
    fail(res, err, 'list');
  }
}

/**
 * POST /api/connectors/remote-mcp — body `{ label, url, headers?, provider? }`.
 *
 * @param req - Request
 * @param res - 201 `{ success, data: view, note }`
 */
export async function addRemoteMcp(req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, AGENT_REFUSAL)) return;
  try {
    const body = (req.body ?? {}) as { label?: unknown; url?: unknown; headers?: unknown; provider?: unknown; oauthClientId?: unknown; oauthClientSecret?: unknown };
    const clientId = typeof body.oauthClientId === 'string' ? body.oauthClientId.trim() : '';
    const clientSecret = typeof body.oauthClientSecret === 'string' ? body.oauthClientSecret.trim() : '';
    if ((clientId && !/^[\x21-\x7e]{1,256}$/.test(clientId)) || (clientSecret && !/^[\x21-\x7e]{1,512}$/.test(clientSecret))) {
      res.status(400).json({ success: false, error: 'validation', message: 'The OAuth client ID / secret must be single-line text.' });
      return;
    }
    const server = await RemoteMcpService.getInstance().add({
      label: typeof body.label === 'string' ? body.label : '',
      url: typeof body.url === 'string' ? body.url : '',
      headers: body.headers as Record<string, string> | undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
    });
    // Does it want OAuth? (Zoho MCP: 401 + resource_metadata.) Then start the
    // sign-in right away and send the owner the phone link.
    const auth = RemoteMcpAuthService.getInstance();
    if (clientId) await auth.setManualClient(server.id, { clientId, ...(clientSecret ? { clientSecret } : {}) });
    const challenge = await auth.detect(server);
    let authorize: Awaited<ReturnType<typeof startSignIn>> | undefined;
    if (challenge) {
      try {
        await auth.markOAuth(server, challenge);
        authorize = await startSignIn(server, undefined, true);
      } catch (err) {
        authorize = { error: err instanceof RemoteMcpAuthError ? err.message : 'Could not work out how to sign in to this server.' };
      }
    }
    res.status(201).json({ success: true, data: await viewWithAuth(server), ...(authorize ? { authorize } : {}), note: NEXT_LAUNCH_NOTE });
  } catch (err) {
    fail(res, err, 'add');
  }
}

/**
 * PATCH /api/connectors/remote-mcp/:id — body `{ label }`.
 *
 * @param req - Request
 * @param res - `{ success, data: view, note }`, 404 when unknown
 */
export async function renameRemoteMcp(req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, AGENT_REFUSAL)) return;
  try {
    const label = (req.body as { label?: unknown } | undefined)?.label;
    const server = await RemoteMcpService.getInstance().rename(String(req.params.id ?? ''), typeof label === 'string' ? label : '');
    if (!server) {
      res.status(404).json({ success: false, error: 'not_found', message: 'No such remote MCP server' });
      return;
    }
    res.json({ success: true, data: toView(server), note: NEXT_LAUNCH_NOTE });
  } catch (err) {
    fail(res, err, 'rename');
  }
}

/**
 * DELETE /api/connectors/remote-mcp/:id
 *
 * @param req - Request
 * @param res - `{ success, note }`, 404 when unknown
 */
export async function removeRemoteMcp(req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, AGENT_REFUSAL)) return;
  try {
    const removed = await RemoteMcpService.getInstance().remove(String(req.params.id ?? ''));
    if (removed) await RemoteMcpAuthService.getInstance().forget(String(req.params.id ?? '')).catch(() => undefined);
    if (!removed) {
      res.status(404).json({ success: false, error: 'not_found', message: 'No such remote MCP server' });
      return;
    }
    res.json({ success: true, note: NEXT_LAUNCH_NOTE });
  } catch (err) {
    fail(res, err, 'remove');
  }
}

/**
 * POST /api/connectors/remote-mcp/:id/test — connect and list its tools.
 *
 * @param req - Request
 * @param res - `{ success, data: { ok, toolCount, tools, serverName? } | { ok: false, error } }`
 */
export async function testRemoteMcp(req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, AGENT_REFUSAL)) return;
  try {
    const server = await RemoteMcpService.getInstance().get(String(req.params.id ?? ''));
    if (!server) {
      res.status(404).json({ success: false, error: 'not_found', message: 'No such remote MCP server' });
      return;
    }
    let result = await probeWithAuth(server);
    let authorize: Awaited<ReturnType<typeof startSignIn>> | undefined;
    if (!result.ok && result.needsAuth) {
      authorize = await startSignIn(server, result.wwwAuthenticate, true);
      result = { ok: false, needsAuth: true, error: 'The server wants you to sign in once. Open the authorize link (it works on your phone).' };
    }
    logger.info('Remote MCP test', { id: server.id, ok: result.ok, toolCount: result.ok ? result.toolCount : undefined, needsAuth: !result.ok && !!result.needsAuth });
    // Never hand the raw challenge to a client.
    const data = result.ok ? result : { ok: false as const, error: result.error, ...(result.needsAuth ? { needsAuth: true } : {}) };
    res.json({ success: true, data, ...(authorize ? { authorize } : {}), server: await viewWithAuth(server) });
  } catch (err) {
    fail(res, err, 'test');
  }
}

/**
 * POST /api/connectors/remote-mcp/:id/authorize — body `{ notify? }`.
 * Starts (or reuses) an OAuth sign-in and returns its phone-friendly link;
 * `notify: true` also posts it to the owner in Slack.
 *
 * @param req - Request
 * @param res - `{ success, data: { url, expiresAt, posted } }`
 */
export async function authorizeRemoteMcp(req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, AGENT_REFUSAL)) return;
  try {
    const server = await RemoteMcpService.getInstance().get(String(req.params.id ?? ''));
    if (!server) {
      res.status(404).json({ success: false, error: 'not_found', message: 'No such remote MCP server' });
      return;
    }
    const notify = (req.body as { notify?: unknown } | undefined)?.notify === true;
    const out = await startSignIn(server, undefined, notify);
    if ('error' in out) {
      res.status(409).json({ success: false, error: 'authorize_failed', message: out.error });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: out });
  } catch (err) {
    fail(res, err, 'authorize');
  }
}

/**
 * POST /api/connectors/remote-mcp/:id/access — body `{ allowedRoles: string[] }`
 * (empty = every agent). The same rule as `PUT /api/connectors/access/mcp:<id>`,
 * scoped to an existing remote MCP server so the relay can reach it without
 * opening every connector's allowlist to the portal.
 *
 * @param req - Request
 * @param res - `{ success, data: { connectorId, allowedRoles }, note }`, 404 when unknown
 */
export async function setRemoteMcpAccess(req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, AGENT_REFUSAL)) return;
  try {
    const body = (req.body ?? {}) as { allowedRoles?: unknown };
    if (!Array.isArray(body.allowedRoles)) {
      res.status(400).json({ success: false, error: 'validation', message: 'allowedRoles must be an array of role names (empty = every agent)' });
      return;
    }
    const server = await RemoteMcpService.getInstance().get(String(req.params.id ?? ''));
    if (!server) {
      res.status(404).json({ success: false, error: 'not_found', message: 'No such remote MCP server' });
      return;
    }
    const connectorId = remoteMcpConnectorId(server.id);
    const rule = await ConnectorAccessService.getInstance().setAllowedRoles(connectorId, body.allowedRoles.map((r) => String(r)));
    res.json({ success: true, data: { connectorId, ...rule }, note: NEXT_LAUNCH_NOTE });
  } catch (err) {
    fail(res, err, 'update access for');
  }
}
