/**
 * Provisioning Routes
 *
 * Router configuration for deployment provisioning endpoints.
 *
 * @module controllers/provisioning/provisioning.routes
 */

import { Router } from 'express';

import {
  createDeployment,
  getDeploymentStatus,
  listDeployments,
  removeDeployment,
} from './provisioning.controller.js';
import { requireAuth } from '../../middleware/require-auth.middleware.js';

/**
 * Creates the provisioning router with all deployment-related endpoints.
 * All provisioning endpoints require authentication.
 *
 * @returns Express router configured with provisioning routes
 */
export function createProvisioningRouter(): Router {
  const router = Router();

  // POST /api/provisioning/deployments — trigger a new deployment (auth required)
  router.post('/deployments', requireAuth, createDeployment);

  // GET /api/provisioning/deployments — list all deployments
  router.get('/deployments', listDeployments);

  // GET /api/provisioning/deployments/:id/status — get deployment status
  router.get('/deployments/:id/status', getDeploymentStatus);

  // DELETE /api/provisioning/deployments/:id — remove deployment record
  router.delete('/deployments/:id', removeDeployment);

  return router;
}
