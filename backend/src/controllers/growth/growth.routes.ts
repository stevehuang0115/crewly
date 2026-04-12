/**
 * Growth Routes
 *
 * Router for agent growth tracking endpoints.
 * Mounted at `/api/growth` in the main API router.
 *
 * @module controllers/growth/growth.routes
 */

import { Router } from 'express';
import { extractAreas, getAreas } from './growth.controller.js';

/**
 * Creates the growth router.
 *
 * Routes:
 * - POST /extract-areas  — extract growth areas from text
 * - GET  /areas/:session  — get growth areas for an agent
 *
 * @returns Express router for /api/growth routes
 */
export function createGrowthRouter(): Router {
  const router = Router();

  router.post('/extract-areas', extractAreas);
  router.get('/areas/:sessionName', getAreas);

  return router;
}
