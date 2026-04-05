/**
 * Mission Policy Routes
 *
 * Router configuration for MissionPolicy CRUD API endpoints.
 * Mounted at `/api/missions` in the main API router.
 *
 * @module controllers/mission/mission-policy.routes
 */

import { Router } from 'express';
import {
  getPolicy,
  updatePolicy,
  checkPolicy,
} from './mission-policy.controller.js';

/**
 * Creates the mission policy router.
 *
 * Routes:
 * - GET  /:id/policy       — retrieve mission policy
 * - PUT  /:id/policy       — update mission policy (partial)
 * - POST /:id/policy/check — dry-run action check
 *
 * @returns Express router for /api/missions routes
 */
export function createMissionPolicyRouter(): Router {
  const router = Router();

  // Get mission policy
  router.get('/:id/policy', getPolicy);

  // Update mission policy (partial update)
  router.put('/:id/policy', updatePolicy);

  // Dry-run: check if an action is allowed
  router.post('/:id/policy/check', checkPolicy);

  return router;
}
