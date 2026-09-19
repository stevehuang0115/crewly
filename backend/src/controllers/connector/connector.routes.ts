/**
 * Connector access routes — mounted at `/api/connectors`.
 *
 * - GET /access               — every connector's role allowlist
 * - PUT /access/:connectorId  — { allowedRoles: string[] } (empty = every agent)
 *
 * @module controllers/connector/connector.routes
 */

import { Router } from 'express';
import { getConnectorAccess, updateConnectorAccess } from './connector.controller.js';

/**
 * Creates the connector router.
 *
 * @returns Express router
 */
export function createConnectorRouter(): Router {
  const router = Router();
  router.get('/access', getConnectorAccess);
  router.put('/access/:connectorId', updateConnectorAccess);
  return router;
}
