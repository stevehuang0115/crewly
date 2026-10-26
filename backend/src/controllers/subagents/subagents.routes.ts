/**
 * Sub-agents Routes
 *
 * Router for `/api/subagents` (#1317).
 *
 * @module controllers/subagents/subagents.routes
 */

import { Router } from 'express';
import { runSubagent } from './subagents.controller.js';

/**
 * Create the sub-agents router.
 *
 * @returns Express router for /api/subagents routes
 */
export function createSubagentsRouter(): Router {
  const router = Router();

  // Run one bounded helper for the calling agent and reply with its outcome
  router.post('/', runSubagent);

  return router;
}
