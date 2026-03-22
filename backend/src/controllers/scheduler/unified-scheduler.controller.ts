/**
 * Unified Scheduler REST API Controller
 *
 * Handlers for unified schedule CRUD operations, pause/resume,
 * manual trigger, and scheduler health reporting.
 *
 * @module controllers/scheduler/unified-scheduler.controller
 */

import type { Request, Response } from 'express';
import { UnifiedSchedulerService } from '../../services/workflow/unified-scheduler.service.js';

/** Valid schedule types accepted by the API. */
const VALID_SCHEDULE_TYPES = ['cron', 'interval', 'idle'] as const;
type ScheduleType = (typeof VALID_SCHEDULE_TYPES)[number];

/**
 * Validates a 5-field cron expression (minute hour dom month dow).
 *
 * Performs a basic structural check — five space-separated fields,
 * each consisting of digits, wildcards, ranges, steps, or lists.
 *
 * @param expr - The cron expression string to validate
 * @returns true if the expression has the correct structure
 */
function isValidCronExpression(expr: string): boolean {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const fieldPattern = /^[0-9*,/\-]+$/;
	return parts.every((p) => fieldPattern.test(p));
}

/**
 * Validates the request body for creating or updating a schedule.
 *
 * @param body - The request body object
 * @param isUpdate - When true, all fields are optional (partial update)
 * @returns An error message string if validation fails, or null if valid
 */
function validateScheduleBody(
	body: Record<string, unknown>,
	isUpdate: boolean,
): string | null {
	if (!isUpdate) {
		if (!body.target || typeof body.target !== 'string') {
			return 'Missing required field: target';
		}
		if (!body.type || !VALID_SCHEDULE_TYPES.includes(body.type as ScheduleType)) {
			return `Invalid or missing field: type (must be one of: ${VALID_SCHEDULE_TYPES.join(', ')})`;
		}
		if (!body.message || typeof body.message !== 'string') {
			return 'Missing required field: message';
		}
	}

	const type = body.type as ScheduleType | undefined;

	if (type === 'cron') {
		if (!body.cron || typeof body.cron !== 'string' || !isValidCronExpression(body.cron)) {
			return 'Field cron is required and must be a valid 5-field cron expression when type is cron';
		}
	}

	if (type === 'interval') {
		if (
			body.intervalMinutes === undefined ||
			typeof body.intervalMinutes !== 'number' ||
			body.intervalMinutes <= 0
		) {
			return 'Field intervalMinutes is required and must be > 0 when type is interval';
		}
	}

	if (type === 'idle') {
		if (
			body.idleTimeoutMinutes === undefined ||
			typeof body.idleTimeoutMinutes !== 'number' ||
			body.idleTimeoutMinutes <= 0
		) {
			return 'Field idleTimeoutMinutes is required and must be > 0 when type is idle';
		}
	}

	// For updates, validate type if provided
	if (isUpdate && body.type !== undefined) {
		if (!VALID_SCHEDULE_TYPES.includes(body.type as ScheduleType)) {
			return `Invalid field: type (must be one of: ${VALID_SCHEDULE_TYPES.join(', ')})`;
		}
	}

	return null;
}

/**
 * GET /api/unified-scheduler/schedules
 *
 * Lists all schedules. Supports optional `?target=session-name` filter.
 *
 * @param req - Express request (query: target?)
 * @param res - Express response with schedule array
 */
export async function listSchedules(req: Request, res: Response): Promise<void> {
	try {
		const service = UnifiedSchedulerService.getInstance();
		const target = req.query.target as string | undefined;
		const schedules = await service.list(target);
		res.json({ schedules });
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : 'Failed to list schedules',
		});
	}
}

/**
 * POST /api/unified-scheduler/schedules
 *
 * Creates a new schedule after validating required fields and type-specific constraints.
 *
 * @param req - Express request with schedule data in body
 * @param res - Express response with created schedule (201)
 */
export async function createSchedule(req: Request, res: Response): Promise<void> {
	try {
		const validationError = validateScheduleBody(req.body, false);
		if (validationError) {
			res.status(400).json({ error: validationError });
			return;
		}

		const service = UnifiedSchedulerService.getInstance();
		const schedule = await service.create(req.body);
		res.status(201).json(schedule);
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : 'Failed to create schedule',
		});
	}
}

/**
 * GET /api/unified-scheduler/schedules/:id
 *
 * Retrieves a single schedule by its ID.
 *
 * @param req - Express request with id param
 * @param res - Express response with schedule or 404
 */
export async function getSchedule(req: Request, res: Response): Promise<void> {
	try {
		const service = UnifiedSchedulerService.getInstance();
		const schedule = await service.get(req.params.id);

		if (!schedule) {
			res.status(404).json({ error: `Schedule ${req.params.id} not found` });
			return;
		}

		res.json(schedule);
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : 'Failed to get schedule',
		});
	}
}

/**
 * PUT /api/unified-scheduler/schedules/:id
 *
 * Partially updates a schedule. Only provided fields are changed.
 *
 * @param req - Express request with id param and partial schedule in body
 * @param res - Express response with updated schedule or 404
 */
export async function updateSchedule(req: Request, res: Response): Promise<void> {
	try {
		const validationError = validateScheduleBody(req.body, true);
		if (validationError) {
			res.status(400).json({ error: validationError });
			return;
		}

		const service = UnifiedSchedulerService.getInstance();
		const schedule = await service.update(req.params.id, req.body);

		if (!schedule) {
			res.status(404).json({ error: `Schedule ${req.params.id} not found` });
			return;
		}

		res.json(schedule);
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : 'Failed to update schedule',
		});
	}
}

/**
 * DELETE /api/unified-scheduler/schedules/:id
 *
 * Deletes a schedule by its ID.
 *
 * @param req - Express request with id param
 * @param res - Express response with success flag or 404
 */
export async function deleteSchedule(req: Request, res: Response): Promise<void> {
	try {
		const service = UnifiedSchedulerService.getInstance();
		const deleted = await service.delete(req.params.id);

		if (!deleted) {
			res.status(404).json({ error: `Schedule ${req.params.id} not found` });
			return;
		}

		res.json({ success: true, id: req.params.id });
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : 'Failed to delete schedule',
		});
	}
}

/**
 * POST /api/unified-scheduler/schedules/:id/pause
 *
 * Pauses an active schedule.
 *
 * @param req - Express request with id param
 * @param res - Express response with updated schedule or 404
 */
export async function pauseSchedule(req: Request, res: Response): Promise<void> {
	try {
		const service = UnifiedSchedulerService.getInstance();
		const schedule = await service.pause(req.params.id);

		if (!schedule) {
			res.status(404).json({ error: `Schedule ${req.params.id} not found` });
			return;
		}

		res.json(schedule);
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : 'Failed to pause schedule',
		});
	}
}

/**
 * POST /api/unified-scheduler/schedules/:id/resume
 *
 * Resumes a paused schedule.
 *
 * @param req - Express request with id param
 * @param res - Express response with updated schedule or 404
 */
export async function resumeSchedule(req: Request, res: Response): Promise<void> {
	try {
		const service = UnifiedSchedulerService.getInstance();
		const schedule = await service.resume(req.params.id);

		if (!schedule) {
			res.status(404).json({ error: `Schedule ${req.params.id} not found` });
			return;
		}

		res.json(schedule);
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : 'Failed to resume schedule',
		});
	}
}

/**
 * POST /api/unified-scheduler/schedules/:id/trigger
 *
 * Manually triggers a schedule immediately, regardless of its timer.
 *
 * @param req - Express request with id param
 * @param res - Express response with trigger result or 404
 */
export async function triggerSchedule(req: Request, res: Response): Promise<void> {
	try {
		const service = UnifiedSchedulerService.getInstance();
		const result = await service.triggerNow(req.params.id);

		if (!result) {
			res.status(404).json({ error: `Schedule ${req.params.id} not found` });
			return;
		}

		res.json(result);
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : 'Failed to trigger schedule',
		});
	}
}

/**
 * GET /api/unified-scheduler/health
 *
 * Returns scheduler health statistics: state, active/paused counts, total triggers.
 *
 * @param _req - Express request (unused)
 * @param res - Express response with health data
 */
export async function getHealth(_req: Request, res: Response): Promise<void> {
	try {
		const service = UnifiedSchedulerService.getInstance();
		const health = await service.getHealth();
		res.json(health);
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : 'Failed to get scheduler health',
		});
	}
}
