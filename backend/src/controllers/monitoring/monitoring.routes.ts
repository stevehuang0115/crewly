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
import { getTokenUsage, resetTokenUsage, getDeploymentQuote, getAllDeploymentQuotes, estimateTokens } from './token-usage.controller.js';
import { receiveExtensionLogs } from './extension-logs.controller.js';
import { getPtyStatus } from './pty-status.controller.js';

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

  // GET /api/monitoring/token-quote/:templateId — get deployment quote for a template
  router.get('/token-quote/:templateId', getDeploymentQuote);

  // GET /api/monitoring/token-quotes — get quotes for all templates
  router.get('/token-quotes', getAllDeploymentQuotes);

  // POST /api/monitoring/estimate-tokens — pre-execution token estimation
  router.post('/estimate-tokens', estimateTokens);

  // POST /api/monitoring/extension-logs — receive Chrome Extension log batches
  router.post('/extension-logs', receiveExtensionLogs);

  // GET /api/monitoring/pty-status — PTY isolation status for security overview
  router.get('/pty-status', getPtyStatus);

  return router;
}
