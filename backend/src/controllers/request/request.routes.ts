/**
 * Request Routes
 *
 * Router configuration for V3 Request API endpoints.
 * Mounted at `/api/requests` in the main API router.
 *
 * @module controllers/request/request.routes
 */

import { Router } from 'express';
import {
  listRequests,
  getRequest,
  createRequestHandler,
  planRequest,
  updateRequest,
} from './request.controller.js';
import { listOpenItems, backfillOpenItemsHandler } from './open-items.controller.js';

/**
 * Creates the request router with all endpoints.
 *
 * Routes:
 * - GET  /       — list all requests
 * - POST /       — create a new request
 * - POST /plan   — plan tasks from a user message
 * - GET  /open-items          — active open items (reply-open-items)
 * - POST /open-items/backfill — scan the last 7 days (dry-run unless apply)
 * - GET  /:id    — get a single request
 * - PUT  /:id    — update a request
 *
 * @returns Express router for /api/requests routes
 */
export function createRequestRouter(): Router {
  const router = Router();

  // List all requests
  router.get('/', listRequests);

  // Create a new request
  router.post('/', createRequestHandler);

  // Plan tasks from a user message (must be before /:id to avoid conflict)
  router.post('/plan', planRequest);

  // Open items: commitments / questions in agents' replies (before /:id)
  router.get('/open-items', listOpenItems);
  router.post('/open-items/backfill', backfillOpenItemsHandler);

  // Get a single request by ID
  router.get('/:id', getRequest);

  // Update a request
  router.put('/:id', updateRequest);

  return router;
}
