import { Request, Response } from 'express';
import type { ApiController } from '../api.controller.js';
import { TaskPoolService } from '../../services/task-pool/task-pool.service.js';
import { projectWorkItems } from '../../services/v3/work-item-projection.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('InProgressTasksController');

/**
 * GET /api/in-progress-tasks
 *
 * Returns the list of currently-active tasks projected from the V3 task-pool
 * into the legacy InProgressTask shape so the frontend dashboard / Tasks tab
 * keeps working unchanged.
 *
 * V3-only as of spec 2026-05-06-task-management-v1-deprecation.md. Replaces
 * the prior reader of `~/.crewly/in_progress_tasks.json` (TaskTrackingService),
 * collapsing the user-visible duplication. The JSON file may still be touched
 * by adjacent services (memory, monitors, websocket); they are migrated in a
 * follow-up.
 *
 * @param req - Express request (no params)
 * @param res - Response with `{ success, tasks, lastUpdated, version }`
 */
export async function getInProgressTasks(this: ApiController, req: Request, res: Response): Promise<void> {
  try {
    const pool = TaskPoolService.getInstance();
    const items = await pool.getAllItems();
    // The frontend Tasks tab shows currently-relevant work — exclude
    // permanently-terminal cancelled/done items unless they are recent.
    // Mirroring v1 semantics: include any item not yet `done`/`cancelled`.
    const active = items.filter((wi) => wi.status !== 'cancelled' && wi.status !== 'done');
    const tasks = projectWorkItems(active);
    res.json({
      success: true,
      tasks,
      lastUpdated: new Date().toISOString(),
      version: '3.0.0',
    });
  } catch (error) {
    logger.error('Error reading in-progress tasks from V3 pool', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to read in-progress tasks data',
      tasks: [],
      lastUpdated: new Date().toISOString(),
      version: '3.0.0',
    });
  }
}
