/**
 * Onboarding checklist routes — mounted at `/api/onboarding`, before the
 * Cloud Portal onboarding-session router that shares the prefix
 * (specs/onboarding-harness-login.md, Phase 3).
 *
 * @module controllers/onboarding/onboarding-checklist.routes
 */

import { Router } from 'express';
import type { OnboardingChecklistService } from '../../services/onboarding/onboarding-checklist.service.js';
import { getOnboardingChecklistService } from '../../services/onboarding/onboarding-checklist.factory.js';
import { createOnboardingChecklistController } from './onboarding-checklist.controller.js';

/**
 * Create the checklist router.
 *
 * Routes (GET and POST only, so the phone / portal relay can carry them):
 * - GET  /checklist           — steps { id, done, detail }, counts, dismissed
 * - POST /checklist/dismiss   — hide / show the dashboard card { dismissed? }
 * - GET  /starters            — starter teams (Personal Assistant, Marketing, Blank)
 * - POST /starter-team        — create the first team { starterId }
 * - POST /first-task          — hand the first task to the orchestrator { text, teamId? }
 *
 * @param getService - Service accessor (tests inject a fake)
 * @returns Express router
 */
export function createOnboardingChecklistRouter(
	getService: () => OnboardingChecklistService = getOnboardingChecklistService,
): Router {
	const router = Router();
	const controller = createOnboardingChecklistController(getService);
	router.get('/checklist', controller.getChecklist);
	router.post('/checklist/dismiss', controller.setDismissed);
	router.get('/starters', controller.listStarters);
	router.post('/starter-team', controller.createStarterTeam);
	router.post('/first-task', controller.sendFirstTask);
	return router;
}
