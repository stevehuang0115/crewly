/**
 * Connector access routes — mounted at `/api/connectors`.
 *
 * - GET /access               — every connector's role allowlist
 * - PUT /access/:connectorId  — { allowedRoles: string[] } (empty = every agent)
 * - /remote-mcp                — remote MCP servers (owner only; see remote-mcp.controller)
 *
 * @module controllers/connector/connector.routes
 */

import { Router } from 'express';
import { getConnectorAccess, updateConnectorAccess } from './connector.controller.js';
import { addRemoteMcp, listRemoteMcp, removeRemoteMcp, renameRemoteMcp, testRemoteMcp } from './remote-mcp.controller.js';

/**
 * Creates the connector router.
 *
 * @returns Express router
 */
export function createConnectorRouter(): Router {
  const router = Router();
  router.get('/access', getConnectorAccess);
  router.put('/access/:connectorId', updateConnectorAccess);
  router.get('/remote-mcp', listRemoteMcp);
  router.post('/remote-mcp', addRemoteMcp);
  router.patch('/remote-mcp/:id', renameRemoteMcp);
  router.delete('/remote-mcp/:id', removeRemoteMcp);
  router.post('/remote-mcp/:id/test', testRemoteMcp);
  return router;
}
