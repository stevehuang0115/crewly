/**
 * Fission Routes
 *
 * Router configuration for Fission Guardrail endpoints.
 *
 * @module controllers/fission/fission.routes
 */

import { Router } from 'express';
import {
  getFissionConfig,
  updateFissionConfig,
  getFissionStats,
  getFissionViolations,
  checkFission,
} from './fission.controller.js';

/**
 * Create the fission guardrail router.
 *
 * @returns Express router for /api/fission routes
 */
export function createFissionRouter(): Router {
  const router = Router();

  // Get current fission guardrail configuration
  router.get('/config', getFissionConfig);

  // Update fission guardrail configuration
  router.put('/config', updateFissionConfig);

  // Get fission statistics (violation counts by type)
  router.get('/stats', getFissionStats);

  // Get recent violations (audit log, supports ?limit=N&type=max_depth)
  router.get('/violations', getFissionViolations);

  // Pre-check whether a sub-task creation would be allowed
  router.post('/check', checkFission);

  return router;
}
