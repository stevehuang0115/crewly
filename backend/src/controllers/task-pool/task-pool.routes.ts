/**
 * Task Pool Routes
 *
 * Router configuration for Task Pool API endpoints.
 *
 * @module controllers/task-pool/task-pool.routes
 */

import { Router } from 'express';
import {
  listAvailable,
  claimItem,
  releaseItem,
  getStats,
  heartbeat,
  extendLease,
  scanExpired,
  revokeAndRelease,
} from './task-pool.controller.js';

/**
 * Creates the task pool router with all endpoints.
 *
 * @returns Express router configured with task pool routes
 */
export function createTaskPoolRouter(): Router {
  const router = Router();

  // Pool statistics (must be before parameterized routes)
  router.get('/stats', getStats);

  // Scan for expired claims
  router.get('/claims/expired', scanExpired);

  // List available work items
  router.get('/', listAvailable);

  // Claim a work item
  router.post('/claim', claimItem);

  // Agent heartbeat for active claim
  router.post('/heartbeat', heartbeat);

  // Extend lease on a claim
  router.post('/extend-lease', extendLease);

  // Release a work item back to pool
  router.post('/release/:workItemId', releaseItem);

  // Revoke a claim and release work item
  router.post('/revoke/:claimId', revokeAndRelease);

  return router;
}
