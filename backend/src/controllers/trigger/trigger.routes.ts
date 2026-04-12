/**
 * Trigger Routes
 *
 * Router configuration for Trigger API endpoints.
 * Mounted at `/api/triggers` in the main API router.
 *
 * @module controllers/trigger/trigger.routes
 */

import { Router } from 'express';
import {
  listTriggers,
  getTriggerStatus,
  getTrigger,
  createTrigger,
  pauseTrigger,
  resumeTrigger,
  cancelTrigger,
  deleteTrigger,
} from './trigger.controller.js';

/**
 * Creates the trigger router with all endpoints.
 *
 * Routes:
 * - GET    /           — list all triggers (optional ?status= filter)
 * - GET    /status     — engine health + counts
 * - POST   /           — create a new trigger
 * - GET    /:id        — get a single trigger
 * - POST   /:id/pause  — pause an active trigger
 * - POST   /:id/resume — resume a paused trigger
 * - POST   /:id/cancel — permanently cancel a trigger
 * - DELETE /:id        — delete a trigger
 *
 * @returns Express router for /api/triggers routes
 */
export function createTriggerRouter(): Router {
  const router = Router();

  router.get('/', listTriggers);
  router.get('/status', getTriggerStatus);
  router.post('/', createTrigger);
  router.get('/:id', getTrigger);
  router.post('/:id/pause', pauseTrigger);
  router.post('/:id/resume', resumeTrigger);
  router.post('/:id/cancel', cancelTrigger);
  router.delete('/:id', deleteTrigger);

  return router;
}
