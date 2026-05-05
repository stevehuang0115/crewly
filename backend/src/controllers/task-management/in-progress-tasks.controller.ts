import { Request, Response } from 'express';
import type { ApiController } from '../api.controller.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { LoggerService } from '../../services/core/logger.service.js';
import { getCrewlyHomePath } from '../../services/core/crewly-home.utils.js';

const logger = LoggerService.getInstance().createComponentLogger('InProgressTasksController');

/**
 * Gets in-progress tasks data from ~/.crewly/in_progress_tasks.json
 *
 * @param req - Request
 * @param res - Response with in-progress tasks data
 */
export async function getInProgressTasks(this: ApiController, req: Request, res: Response): Promise<void> {
  try {
    const taskTrackingPath = join(getCrewlyHomePath(), 'in_progress_tasks.json');

    // Check if file exists
    if (!existsSync(taskTrackingPath)) {
      res.json({
        success: true,
        tasks: [],
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      });
      return;
    }

    // Read and parse the file
    const content = await readFile(taskTrackingPath, 'utf-8');
    const data = JSON.parse(content);

    res.json({
      success: true,
      ...data
    });
  } catch (error) {
    logger.error('Error reading in-progress tasks', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Failed to read in-progress tasks data',
      tasks: [],
      lastUpdated: new Date().toISOString(),
      version: '1.0.0'
    });
  }
}