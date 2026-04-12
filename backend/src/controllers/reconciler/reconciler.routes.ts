/**
 * Reconciler Routes
 *
 * Router configuration for Reconciler monitoring and control endpoints.
 *
 * @module controllers/reconciler/reconciler.routes
 */

import { Router } from 'express';
import {
  getReconcilerStatus,
  runReconcile,
  getReconcilerHistory,
} from './reconciler.controller.js';

/**
 * Create the reconciler router with status, trigger, and history endpoints.
 *
 * @returns Express router for /api/reconciler routes
 */
export function createReconcilerRouter(): Router {
  const router = Router();

  // Get current reconciler status (last result, next run times, config)
  router.get('/status', getReconcilerStatus);

  // Manually trigger a full reconciliation pass
  router.post('/run', runReconcile);

  // Get recent reconciliation history (supports ?limit=N)
  router.get('/history', getReconcilerHistory);

  return router;
}
