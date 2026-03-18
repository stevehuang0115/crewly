/**
 * Token Usage Controller
 *
 * Handles HTTP requests for token usage monitoring endpoints.
 *
 * @module controllers/monitoring/token-usage.controller
 */

import type { Request, Response } from 'express';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';

/**
 * GET /api/monitoring/token-usage
 *
 * Returns per-session token usage summaries for the dashboard.
 *
 * @param _req - Express request (unused)
 * @param res - Express response
 */
export function getTokenUsage(_req: Request, res: Response): void {
  const service = TokenUsageService.getInstance();
  const sessions = service.getUsageBySessions();
  res.json({ success: true, data: sessions });
}

/**
 * POST /api/monitoring/token-usage/reset
 *
 * Clears all tracked token usage data.
 *
 * @param _req - Express request (unused)
 * @param res - Express response
 */
export function resetTokenUsage(_req: Request, res: Response): void {
  const service = TokenUsageService.getInstance();
  service.resetUsage();
  res.json({ success: true, message: 'Token usage data cleared' });
}
