/**
 * Connector access — who may use a connected account.
 *
 * `GET /api/connectors/access` and `PUT /api/connectors/access/:id` back the
 * "which agents may use this" control on each connector card, and
 * {@link requireConnectorAccess} is the middleware the Google / Canva data
 * routes sit behind.
 *
 * @module controllers/connector/connector.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { LoggerService } from '../../services/core/logger.service.js';
import { ConnectorAccessService, GATED_CONNECTORS } from '../../services/connector/connector-access.service.js';
import { resolveAgentCaller } from '../../utils/agent-caller.utils.js';

const logger = LoggerService.getInstance().createComponentLogger('ConnectorController');

/**
 * Express middleware refusing an agent whose role is not on the
 * connector's allowlist. The owner (no `X-Agent-Session`) always passes,
 * and a connector with no allowlist is open to every agent.
 *
 * @param connectorId - Connector this route belongs to
 * @returns The middleware
 */
export function requireConnectorAccess(connectorId: string) {
  return async function connectorAccessGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const caller = await resolveAgentCaller(req);
      if (await ConnectorAccessService.getInstance().isAllowed(connectorId, caller.role)) {
        next();
        return;
      }
      const allowed = await ConnectorAccessService.getInstance().allowedRoles(connectorId);
      logger.warn('Connector access refused', { connectorId, session: caller.session, role: caller.role, allowed });
      res.status(403).json({
        success: false,
        error: 'connector_forbidden',
        message: `Your role (${caller.role}) may not use the ${connectorId} connection.`,
        hint: `The owner limited it to: ${allowed.join(', ')}. Ask them to add your role in Connections, or ask a colleague with one of those roles.`,
      });
    } catch (err) {
      // A bookkeeping failure must not lock the owner out of their own data.
      logger.error('Connector access check failed — allowing the call', {
        connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
      next();
    }
  };
}

/**
 * GET /api/connectors/access — every connector's allowlist.
 *
 * @param _req - Request
 * @param res - `{ success, data: { <id>: { allowedRoles } } }` with an entry per gated connector
 */
export async function getConnectorAccess(_req: Request, res: Response): Promise<void> {
  try {
    const stored = await ConnectorAccessService.getInstance().list();
    const data: Record<string, { allowedRoles: string[] }> = {};
    for (const id of GATED_CONNECTORS) data[id] = { allowedRoles: stored[id]?.allowedRoles ?? [] };
    for (const [id, rule] of Object.entries(stored)) data[id] = rule;
    res.json({ success: true, data });
  } catch (err) {
    logger.error('Failed to read connector access', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ success: false, error: 'internal', message: 'Could not read connector access' });
  }
}

/**
 * PUT /api/connectors/access/:connectorId — body `{ allowedRoles: string[] }`
 * (empty array = every agent).
 *
 * @param req - Request
 * @param res - `{ success, data: { connectorId, allowedRoles } }`
 */
export async function updateConnectorAccess(req: Request, res: Response): Promise<void> {
  try {
    const connectorId = String(req.params.connectorId ?? '').trim();
    if (!connectorId) {
      res.status(400).json({ success: false, error: 'validation', message: 'connectorId is required' });
      return;
    }
    const body = (req.body ?? {}) as { allowedRoles?: unknown };
    if (!Array.isArray(body.allowedRoles)) {
      res.status(400).json({ success: false, error: 'validation', message: 'allowedRoles must be an array of role names (empty = every agent)' });
      return;
    }
    const rule = await ConnectorAccessService.getInstance().setAllowedRoles(connectorId, body.allowedRoles.map((r) => String(r)));
    res.json({ success: true, data: { connectorId, ...rule } });
  } catch (err) {
    logger.error('Failed to update connector access', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ success: false, error: 'internal', message: 'Could not update connector access' });
  }
}
