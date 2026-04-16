/**
 * Expert Routes
 *
 * REST API routes for expert profile management.
 *
 * @module controllers/expert/expert.routes
 */

import { Router } from 'express';
import { listExperts } from './expert.controller.js';

/**
 * Creates the expert router with all expert-related endpoints.
 *
 * @returns Express router for /api/experts
 */
export function createExpertRouter(): Router {
  const router = Router();

  // GET /api/experts — list all available expert profiles
  router.get('/', listExperts);

  return router;
}
