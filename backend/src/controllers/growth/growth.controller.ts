/**
 * Growth Controller
 *
 * Handles API endpoints for agent growth tracking.
 * No LLM calls — uses keyword extraction from GrowthAreasService.
 *
 * @module controllers/growth/growth.controller
 */

import type { Request, Response } from 'express';
import { GrowthAreasService } from '../../services/ai/self-improvement/growth-areas.service.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('GrowthController');

/**
 * POST /api/growth/extract-areas
 *
 * Extracts growth areas from text using keyword matching.
 * Called by report-status skill after task completion.
 *
 * @param req - Express request with { sessionName, text }
 * @param res - Express response
 */
export async function extractAreas(req: Request, res: Response): Promise<void> {
  const { sessionName, text } = req.body as { sessionName?: string; text?: string };

  if (!sessionName || !text) {
    res.status(400).json({ success: false, error: 'sessionName and text are required' });
    return;
  }

  try {
    const service = new GrowthAreasService();
    const newAreas = await service.extractFromText(sessionName, text);

    res.json({
      success: true,
      data: { extracted: newAreas.length, areas: newAreas },
    });

    if (newAreas.length > 0) {
      logger.info('Growth areas extracted via API', {
        sessionName,
        areas: newAreas.map(a => a.area),
      });
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to extract growth areas',
    });
  }
}

/**
 * GET /api/growth/areas/:sessionName
 *
 * Returns the growth areas for an agent.
 *
 * @param req - Express request with sessionName param
 * @param res - Express response
 */
export async function getAreas(req: Request, res: Response): Promise<void> {
  const { sessionName } = req.params;

  if (!sessionName) {
    res.status(400).json({ success: false, error: 'sessionName param is required' });
    return;
  }

  try {
    const service = new GrowthAreasService();
    const data = await service.getGrowthAreas(sessionName);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get growth areas',
    });
  }
}
