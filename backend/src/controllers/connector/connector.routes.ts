/**
 * Connector access routes — mounted at `/api/connectors`.
 *
 * - GET /access               — every connector's role allowlist
 * - PUT /access/:connectorId  — { allowedRoles: string[] } (empty = every agent)
 * - /remote-mcp                — remote MCP servers (owner only; see remote-mcp.controller)
 *
 * Rename / remove also answer on POST (`/remote-mcp/:id/rename`,
 * `/remote-mcp/:id/remove`), and a server's role allowlist on
 * `POST /remote-mcp/:id/access`: the Cloud relay only forwards GET and POST,
 * so this is how the portal manages servers on a machine the owner is not at.
 *
 * @module controllers/connector/connector.routes
 */

import { Router } from 'express';
import { getConnectorAccess, updateConnectorAccess } from './connector.controller.js';
import { addRemoteMcp, authorizeRemoteMcp, listRemoteMcp, removeRemoteMcp, renameRemoteMcp, setRemoteMcpAccess, testRemoteMcp } from './remote-mcp.controller.js';
import { proxyRemoteMcp } from './remote-mcp-proxy.controller.js';

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
  // Start (or reuse) an OAuth sign-in; returns the phone-friendly link.
  router.post('/remote-mcp/:id/authorize', authorizeRemoteMcp);
  // Agents only: streamable-HTTP proxy to the server (URL + tokens stay here).
  router.all('/remote-mcp/:id/mcp', proxyRemoteMcp);
  // POST twins for the relay (GET/POST only).
  router.post('/remote-mcp/:id/rename', renameRemoteMcp);
  router.post('/remote-mcp/:id/remove', removeRemoteMcp);
  router.post('/remote-mcp/:id/access', setRemoteMcpAccess);
  return router;
}
