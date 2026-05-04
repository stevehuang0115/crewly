/**
 * Teams Backup Controller
 *
 * HTTP request handlers for the teams backup and restore system.
 * Provides endpoints to check backup status and restore teams from backup.
 *
 * @module controllers/teams-backup/teams-backup.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { StorageService } from '../../services/core/storage.service.js';
import { TeamsBackupService } from '../../services/core/teams-backup.service.js';
import { LoggerService, ComponentLogger } from '../../services/core/logger.service.js';

/** Logger instance */
const logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('TeamsBackupController');

/**
 * GET /api/teams/backup/status
 *
 * Compare current teams data against the backup file.
 * Returns mismatch flag, counts, and timestamp.
 *
 * @param req - Request
 * @param res - Response with TeamsBackupStatus
 * @param next - Next middleware
 */
export async function getBackupStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const storageService = StorageService.getInstance();
    const backupService = TeamsBackupService.getInstance();

    const currentTeams = await storageService.getTeams();
    const status = await backupService.getBackupStatus(currentTeams);

    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Error checking backup status', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/teams/backup/restore
 *
 * Restore teams from the backup file. Reads the backup, saves each team
 * via StorageService, and returns the restored count.
 *
 * @param req - Request
 * @param res - Response with restore result
 * @param next - Next middleware
 */
export async function restoreFromBackup(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const storageService = StorageService.getInstance();
    const backupService = TeamsBackupService.getInstance();

    const backup = await backupService.readBackup();
    if (!backup || backup.teams.length === 0) {
      res.status(404).json({
        success: false,
        error: 'No backup found or backup is empty',
      });
      return;
    }

    let restoredCount = 0;
    const errors: string[] = [];

    for (const team of backup.teams) {
      try {
        await storageService.saveTeam(team);
        restoredCount++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to restore team ${team.name}: ${msg}`);
        logger.warn('Failed to restore individual team', {
          teamId: team.id,
          teamName: team.name,
          error: msg,
        });
      }
    }

    logger.info('Teams restored from backup', {
      restoredCount,
      totalInBackup: backup.teams.length,
      errors: errors.length,
    });

    res.json({
      success: true,
      data: {
        restoredCount,
        totalInBackup: backup.teams.length,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error) {
    logger.error('Error restoring from backup', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /api/teams/backup/history
 *
 * List all populated rotating-snapshot slots, newest first.
 * Used by an admin UI to pick a slot to restore from.
 *
 * @param req - Request
 * @param res - Response with TeamsBackupHistoryEntry[]
 * @param next - Next middleware
 */
export async function getBackupHistory(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const backupService = TeamsBackupService.getInstance();
    const history = await backupService.getBackupHistory();
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Error reading backup history', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/teams/backup/restore/:slot
 *
 * Restore teams from a specific rotating-snapshot slot. Reads the slot,
 * saves each team via StorageService, and returns the restored count.
 *
 * @param req - Request with `slot` URL param (0..MAX_HISTORY_SLOTS-1)
 * @param res - Response with restore result
 * @param next - Next middleware
 */
export async function restoreFromSlot(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const slot = Number(req.params.slot);
    if (!Number.isInteger(slot) || slot < 0) {
      res.status(400).json({ success: false, error: 'Invalid slot' });
      return;
    }

    const storageService = StorageService.getInstance();
    const backupService = TeamsBackupService.getInstance();

    const snapshot = await backupService.restoreFromSlot(slot);
    if (!snapshot || snapshot.teams.length === 0) {
      res.status(404).json({
        success: false,
        error: `Slot ${slot} is empty or not found`,
      });
      return;
    }

    let restoredCount = 0;
    const errors: string[] = [];

    for (const team of snapshot.teams) {
      try {
        await storageService.saveTeam(team);
        restoredCount++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to restore team ${team.name}: ${msg}`);
        logger.warn('Failed to restore individual team from slot', {
          slot,
          teamId: team.id,
          teamName: team.name,
          error: msg,
        });
      }
    }

    logger.info('Teams restored from rotating snapshot', {
      slot,
      restoredCount,
      totalInSnapshot: snapshot.teams.length,
      errors: errors.length,
    });

    res.json({
      success: true,
      data: {
        slot,
        snapshotTimestamp: snapshot.timestamp,
        restoredCount,
        totalInSnapshot: snapshot.teams.length,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error) {
    logger.error('Error restoring from slot', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}
