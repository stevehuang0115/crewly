/**
 * Token Usage Controller
 *
 * Handles HTTP requests for token usage monitoring endpoints.
 *
 * @module controllers/monitoring/token-usage.controller
 */

import type { Request, Response } from 'express';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';
import { TokenEstimatorService } from '../../services/monitoring/token-estimator.service.js';
import type { EstimateTokensRequest } from '../../services/monitoring/token-estimator.service.js';
import { formatError } from '../../utils/format-error.js';

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

/**
 * GET /api/monitoring/token-quote/:templateId
 *
 * Returns a deployment quote for a specific template.
 *
 * @param req - Express request with templateId param
 * @param res - Express response
 */
export async function getDeploymentQuote(req: Request, res: Response): Promise<void> {
  const { templateId } = req.params;
  try {
    const service = TokenEstimatorService.getInstance();
    const quote = await service.getQuote(templateId);
    res.json({ success: true, data: quote });
  } catch (error) {
    res.status(404).json({ success: false, message: formatError(error) });
  }
}

/**
 * GET /api/monitoring/token-quotes
 *
 * Returns deployment quotes for all available cloud templates.
 *
 * @param _req - Express request (unused)
 * @param res - Express response
 */
export async function getAllDeploymentQuotes(_req: Request, res: Response): Promise<void> {
  try {
    const service = TokenEstimatorService.getInstance();
    const quotes = await service.getAllQuotes();
    res.json({ success: true, data: quotes });
  } catch (error) {
    res.status(500).json({ success: false, message: formatError(error) });
  }
}

/**
 * POST /api/monitoring/estimate-tokens
 *
 * Estimates token consumption for a task before execution.
 * Uses template analysis, complexity heuristics, and historical calibration
 * to predict input/output tokens and cost.
 *
 * @param req - Express request with body { templateId, objective, modelId? }
 * @param res - Express response with TokenEstimate
 */
export async function estimateTokens(req: Request, res: Response): Promise<void> {
  const { templateId, objective, modelId } = req.body as Partial<EstimateTokensRequest>;

  if (!templateId || !objective) {
    res.status(400).json({
      success: false,
      message: 'Missing required fields: templateId and objective',
    });
    return;
  }

  try {
    const estimator = TokenEstimatorService.getInstance();

    // Wire up historical data provider from TokenUsageService for calibration
    const usageService = TokenUsageService.getInstance();
    estimator.setHistoricalDataProvider(() => usageService.getUsageBySessions());

    const estimate = await estimator.estimateTokens({
      templateId,
      objective,
      modelId,
    });
    res.json({ success: true, data: estimate });
  } catch (error) {
    const message = formatError(error);
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, message });
  }
}
