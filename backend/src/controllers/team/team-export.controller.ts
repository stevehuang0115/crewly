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
import { rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { collectSecretEnvValues } from '../../utils/secret-env.js';
import { TEAM_EXPORT_CONSTANTS } from '../../constants.js';

/** The refusal an agent gets: a package holds every prompt and schedule of a team. */
const OWNER_ONLY = { success: false, error: 'owner_only', message: 'Only the owner can export or import a team package.' };

/**
 * A safe file name for a downloaded package.
 *
 * @param teamName - Team name
 * @returns e.g. `crewly-team-ce-site.json`
 */
export function exportFileName(teamName: string): string {
  const slug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
  return TEAM_EXPORT_CONSTANTS.DOWNLOAD_FILE_NAME.replace('<slug>', slug);
}

/**
 * GET /api/teams/:teamId/export[?download=1][&wiki=1]
 *
 * Exports a team and all associated data (config, prompts, norms, cron tasks)
 * as a single portable, secret-free JSON bundle for backup or migration
 * (#880). Owner only. With `download=1` the package itself is the body, as
 * an attachment; otherwise it sits under `data`. With `wiki=1` the team's
 * wiki pages are in the package; without it they are only counted.
 *
 * @param req - Express request with teamId parameter
 * @param res - Express response with TeamExport JSON
 */
export async function exportTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, OWNER_ONLY)) return;
  const { teamId } = req.params;

  try {
    const service = new TeamExportService(this.storageService);
    const includeWiki = req.query['wiki'] === '1' || req.query['wiki'] === 'true';
    const exportData = await service.exportTeam(teamId, { knownSecrets: collectSecretEnvValues(process.env), includeWiki });
    if (req.query['download'] === '1' || req.query['download'] === 'true') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(exportData.team.name)}"`);
      res.send(JSON.stringify(exportData, null, 2));
      return;
    }
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
  if (rejectNonOwner(req, res, OWNER_ONLY)) return;
  // `crewly team export` writes the package itself; a saved API answer still has it under `data`.
  const raw = req.body as Partial<TeamExport> | { success?: boolean; data?: Partial<TeamExport> };
  const data = (raw && typeof raw === 'object' && 'data' in raw && raw.data && typeof raw.data === 'object' ? raw.data : raw) as Partial<TeamExport>;

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
    const message = formatError(error);
    res.status(message.startsWith('Unsupported team export version') ? 400 : 500).json({ success: false, message });
  }
}
