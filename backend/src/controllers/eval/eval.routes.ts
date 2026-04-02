/**
 * Eval Routes
 *
 * Mounts evaluation API endpoints for running benchmark tasks
 * against the Crewly Agent runtime.
 *
 * Endpoints:
 * - GET  /api/eval/status          — health check and framework info
 * - GET  /api/eval/tasks           — list all tasks (optional ?level=L1)
 * - GET  /api/eval/tasks/:taskId   — get single task details
 * - GET  /api/eval/dimensions      — scoring dimensions and weights
 * - POST /api/eval/run             — execute a single eval task
 *
 * @module controllers/eval/eval.routes
 */

import { Router } from 'express';
import {
  runEvalTask,
  getEvalStatus,
  listTasks,
  getTask,
  getDimensions,
} from './eval.controller.js';

/**
 * Create the eval router with all evaluation endpoints.
 *
 * @returns Express router with eval routes
 */
export function createEvalRouter(): Router {
  const router = Router();

  // GET /api/eval/status — health check + framework info
  router.get('/status', getEvalStatus);

  // GET /api/eval/tasks — list available tasks
  router.get('/tasks', listTasks);

  // GET /api/eval/tasks/:taskId — get task details
  router.get('/tasks/:taskId', getTask);

  // GET /api/eval/dimensions — scoring dimensions
  router.get('/dimensions', getDimensions);

  // POST /api/eval/run — execute a single eval task
  router.post('/run', runEvalTask);

  return router;
}
