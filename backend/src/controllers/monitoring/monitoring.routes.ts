/**
 * Monitoring Routes
 *
 * Router configuration for monitoring-related endpoints including
 * token usage tracking.
 *
 * @module controllers/monitoring/monitoring.routes
 */

import { Router } from 'express';
import type { ApiContext } from '../types.js';
import { getTokenUsage, resetTokenUsage } from './token-usage.controller.js';
import { receiveExtensionLogs } from './extension-logs.controller.js';

/**
 * Creates monitoring router with all monitoring-related endpoints.
 *
 * @param _context - Optional API context (unused, kept for backward compatibility)
 * @returns Express router configured with monitoring routes
 */
export function createMonitoringRouter(_context?: ApiContext): Router {
  const router = Router();

  // GET /api/monitoring/token-usage — per-session token usage summaries
  router.get('/token-usage', getTokenUsage);

  // POST /api/monitoring/token-usage/reset — clear all tracking data
  router.post('/token-usage/reset', resetTokenUsage);

  // POST /api/monitoring/extension-logs — receive Chrome Extension log batches
  router.post('/extension-logs', receiveExtensionLogs);

  return router;
}
