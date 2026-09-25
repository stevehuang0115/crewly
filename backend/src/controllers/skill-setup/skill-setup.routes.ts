/**
 * Skill setup routes — mounted at `/api/skill-setup` (specs/skill-auto-install.md).
 *
 * @module controllers/skill-setup/skill-setup.routes
 */

import { Router } from 'express';
import { createSkillSetupController, type SkillSetupControllerDeps } from './skill-setup.controller.js';

/**
 * Create the skill setup router.
 *
 * Routes:
 * - GET  /find?query=…&limit=…  — find skills for a need (find-skill)
 * - POST /install               — install + set up in the background (install-skill)
 * - GET  /jobs/:jobId           — install job progress
 * - GET  /status/:id            — installed / set-up state of one skill (checks only)
 *
 * @param deps - Service accessors (tests inject fakes)
 * @returns Express router
 */
export function createSkillSetupRouter(deps: SkillSetupControllerDeps = {}): Router {
	const router = Router();
	const controller = createSkillSetupController(deps);
	router.get('/find', controller.find);
	router.post('/install', controller.install);
	router.get('/jobs/:jobId', controller.getJob);
	router.get('/status/:id', controller.status);
	return router;
}
