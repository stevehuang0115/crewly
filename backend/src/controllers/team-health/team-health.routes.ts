/**
 * Team-Health-Watchdog (THW) Routes
 *
 * @module controllers/team-health/team-health.routes
 */

import { Router } from 'express';
import {
  getTeamHealthScan,
  runTeamHealthSweep,
  silenceTeamHealthAlerts,
} from './team-health.controller.js';

/**
 * Create the team-health router.
 *
 * @returns Express router for /api/team-health
 */
export function createTeamHealthRouter(): Router {
  const router = Router();
  router.get('/scan', getTeamHealthScan);
  router.post('/run', runTeamHealthSweep);
  router.post('/silence', silenceTeamHealthAlerts);
  return router;
}
