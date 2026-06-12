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
  synthesizeHierarchyRoute,
  materializeHierarchyRoute,
} from './orchestrator-onboarding.controller.js';

/**
 * Build the orchestrator-onboarding router.
 *
 * Endpoints:
 *   - POST /recommend-team         — turn discovery answers into a proposal
 *   - POST /materialize-team       — provision the (flat) team + flip the flag
 *   - POST /synthesize-hierarchy   — plan a nested parent+child-team shape
 *                                    for a multi-stream goal (pure, P3)
 *   - POST /materialize-hierarchy  — instantiate an approved hierarchy plan
 *                                    (parent + linked child teams, P3)
 *
 * @returns Configured Express router.
 */
export function createOrchestratorOnboardingRouter(): Router {
  const router = Router();
  router.post('/recommend-team', recommendTeamRoute);
  router.post('/materialize-team', materializeTeamRoute);
  router.post('/synthesize-hierarchy', synthesizeHierarchyRoute);
  router.post('/materialize-hierarchy', materializeHierarchyRoute);
  return router;
}
