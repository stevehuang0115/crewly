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
import { probeRemoteMcp } from '../../services/connector/remote-mcp-probe.service.js';

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
 * GET /api/connectors/remote-mcp
 *
 * @param req - Request
 * @param res - `{ success, data: RemoteMcpServerView[] }`
 */
export async function listRemoteMcp(req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, AGENT_REFUSAL)) return;
  try {
    const servers = await RemoteMcpService.getInstance().list();
    res.json({ success: true, data: servers.map(toView) });
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
    const body = (req.body ?? {}) as { label?: unknown; url?: unknown; headers?: unknown; provider?: unknown };
    const server = await RemoteMcpService.getInstance().add({
      label: typeof body.label === 'string' ? body.label : '',
      url: typeof body.url === 'string' ? body.url : '',
      headers: body.headers as Record<string, string> | undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
    });
    res.status(201).json({ success: true, data: toView(server), note: NEXT_LAUNCH_NOTE });
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
    const result = await probeRemoteMcp(server);
    logger.info('Remote MCP test', { id: server.id, ok: result.ok, toolCount: result.ok ? result.toolCount : undefined });
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err, 'test');
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
