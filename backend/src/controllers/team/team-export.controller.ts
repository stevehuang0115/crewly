/**
 * Team Export/Import Controller
 *
 * HTTP handlers for exporting and importing complete team bundles.
 * Part of the team-scoped cron feature (Phase 3).
 *
 * @module controllers/team/team-export.controller
 */

import type { Request, Response } from 'express';
import type { ApiContext } from '../types.js';
import { TeamExportService } from '../../services/core/team-export.service.js';
import type { TeamExport } from '../../services/core/team-export.service.js';
import { formatError } from '../../utils/format-error.js';

/**
 * GET /api/teams/:teamId/export
 *
 * Exports a team and all associated data (config, prompts, norms, cron tasks)
 * as a single JSON bundle for backup or migration.
 *
 * @param req - Express request with teamId parameter
 * @param res - Express response with TeamExport JSON
 */
export async function exportTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  const { teamId } = req.params;

  try {
    const service = new TeamExportService(this.storageService);
    const exportData = await service.exportTeam(teamId);
    res.json({ success: true, data: exportData });
  } catch (error) {
    const message = formatError(error);
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, message });
  }
}

/**
 * POST /api/teams/import
 *
 * Imports a team from a complete export bundle. Creates the team,
 * writes prompts and norms, and creates cron tasks with new IDs
 * to avoid conflicts.
 *
 * @param req - Express request with TeamExport body
 * @param res - Express response with import result
 */
export async function importTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  const data = req.body as Partial<TeamExport>;

  if (!data.version || !data.team) {
    res.status(400).json({
      success: false,
      message: 'Invalid team export format: missing version or team data',
    });
    return;
  }

  try {
    const service = new TeamExportService(this.storageService);
    const result = await service.importTeam(data as TeamExport);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: formatError(error) });
  }
}
