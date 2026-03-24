/**
 * Cron Task API Controller
 *
 * Handlers for cron task CRUD operations.
 * All responses follow standard ApiResponse format: { success, data?, error? }
 *
 * @module controllers/system/cron-task.controller
 */

import type { Request, Response } from 'express';
import { CronTaskService } from '../../services/workflow/cron-task.service.js';

/**
 * POST /api/cron-tasks — Create a new cron task.
 */
export async function createCronTask(req: Request, res: Response): Promise<void> {
	try {
		const { cronExpression, timezone, targetAgent, targetTeamId, taskDescription, createdBy } = req.body;

		if (!cronExpression || !targetAgent || !targetTeamId || !taskDescription) {
			res.status(400).json({
				success: false,
				error: 'Missing required fields: cronExpression, targetAgent, targetTeamId, taskDescription',
			});
			return;
		}

		const task = await CronTaskService.getInstance().create({
			cronExpression,
			timezone,
			targetAgent,
			targetTeamId,
			taskDescription,
			createdBy: createdBy || 'user',
		});

		res.status(201).json({ success: true, data: task });
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to create cron task',
		});
	}
}

/**
 * GET /api/cron-tasks — List cron tasks, optionally filtered.
 */
export async function listCronTasks(req: Request, res: Response): Promise<void> {
	try {
		const targetAgent = req.query.targetAgent as string | undefined;
		const enabled = req.query.enabled !== undefined
			? req.query.enabled === 'true'
			: undefined;

		const tasks = await CronTaskService.getInstance().list({ targetAgent, enabled });
		res.json({ success: true, data: tasks });
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to list cron tasks',
		});
	}
}

/**
 * PATCH /api/cron-tasks/:id — Update a cron task.
 */
export async function updateCronTask(req: Request, res: Response): Promise<void> {
	try {
		const { id } = req.params;
		const { cronExpression, timezone, taskDescription, enabled } = req.body;

		const task = await CronTaskService.getInstance().update(id, {
			cronExpression,
			timezone,
			taskDescription,
			enabled,
		});

		if (!task) {
			res.status(404).json({ success: false, error: `Cron task ${id} not found` });
			return;
		}

		res.json({ success: true, data: task });
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to update cron task',
		});
	}
}

/**
 * DELETE /api/cron-tasks/:id — Delete a cron task (user/orchestrator only).
 */
export async function deleteCronTask(req: Request, res: Response): Promise<void> {
	try {
		const { id } = req.params;
		const deleted = await CronTaskService.getInstance().delete(id);

		if (!deleted) {
			res.status(404).json({ success: false, error: `Cron task ${id} not found` });
			return;
		}

		res.json({ success: true, data: { id } });
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to delete cron task',
		});
	}
}
