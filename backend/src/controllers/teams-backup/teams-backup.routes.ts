/**
 * Teams Backup Routes
 *
 * Router configuration for teams backup and restore endpoints.
 *
 * @module controllers/teams-backup/teams-backup.routes
 */

import { Router } from 'express';
import {
  getBackupStatus,
  restoreFromBackup,
  getBackupHistory,
  restoreFromSlot,
} from './teams-backup.controller.js';

/**
 * Create the teams backup router.
 *
 * @returns Express router for /api/teams/backup routes
 */
export function createTeamsBackupRouter(): Router {
  const router = Router();

  // Check backup vs current status
  router.get('/status', getBackupStatus);

  // List rotating-snapshot history (A2)
  router.get('/history', getBackupHistory);

  // Restore teams from the live single-file backup
  router.post('/restore', restoreFromBackup);

  // Restore teams from a specific rotating-snapshot slot (A2)
  router.post('/restore/:slot', restoreFromSlot);

  return router;
}
