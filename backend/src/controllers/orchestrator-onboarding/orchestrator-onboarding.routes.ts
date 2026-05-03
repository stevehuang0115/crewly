/**
 * Orchestrator-Onboarding REST Routes
 *
 * Mounts the recommend-team + materialize-team endpoints used by the
 * onboarding-only bash skills. Mounted at `/api/orchestrator/onboarding`
 * by `routes/api.routes.ts`.
 *
 * @module controllers/orchestrator-onboarding/orchestrator-onboarding.routes
 */

import { Router } from 'express';
import {
  recommendTeamRoute,
  materializeTeamRoute,
} from './orchestrator-onboarding.controller.js';

/**
 * Build the orchestrator-onboarding router.
 *
 * Endpoints:
 *   - POST /recommend-team      — turn discovery answers into a proposal
 *   - POST /materialize-team    — write the team config + flip the flag
 *
 * @returns Configured Express router.
 */
export function createOrchestratorOnboardingRouter(): Router {
  const router = Router();
  router.post('/recommend-team', recommendTeamRoute);
  router.post('/materialize-team', materializeTeamRoute);
  return router;
}
