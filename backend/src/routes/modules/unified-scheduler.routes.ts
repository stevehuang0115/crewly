/**
 * Unified Scheduler Routes
 *
 * Defines Express routes for the unified scheduler API,
 * mapping HTTP verbs + paths to controller handlers.
 *
 * @module routes/modules/unified-scheduler.routes
 */

import { Router } from 'express';
import * as ctrl from '../../controllers/scheduler/unified-scheduler.controller.js';

/**
 * Creates and returns the Express router for unified scheduler endpoints.
 *
 * Mounts the following routes (relative to wherever this router is mounted):
 * - GET    /schedules           — List all schedules
 * - POST   /schedules           — Create a schedule
 * - GET    /schedules/:id       — Get a single schedule
 * - PUT    /schedules/:id       — Update a schedule
 * - DELETE /schedules/:id       — Delete a schedule
 * - POST   /schedules/:id/pause  — Pause a schedule
 * - POST   /schedules/:id/resume — Resume a schedule
 * - POST   /schedules/:id/trigger — Manually trigger a schedule
 * - GET    /health              — Scheduler health stats
 *
 * @returns Express Router with all unified scheduler routes registered
 */
export function createUnifiedSchedulerRoutes(): Router {
	const router = Router();

	router.get('/schedules', ctrl.listSchedules);
	router.post('/schedules', ctrl.createSchedule);
	router.get('/schedules/:id', ctrl.getSchedule);
	router.put('/schedules/:id', ctrl.updateSchedule);
	router.delete('/schedules/:id', ctrl.deleteSchedule);
	router.post('/schedules/:id/pause', ctrl.pauseSchedule);
	router.post('/schedules/:id/resume', ctrl.resumeSchedule);
	router.post('/schedules/:id/trigger', ctrl.triggerSchedule);
	router.get('/health', ctrl.getHealth);

	return router;
}
