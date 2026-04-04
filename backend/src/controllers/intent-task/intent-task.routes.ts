/**
 * Intent Task Routes — V2
 *
 * Router configuration for intent task tracking endpoints.
 * V2 adds: decompose, message groups, project task status, toggle.
 *
 * @module controllers/intent-task/intent-task.routes
 */

import { Router } from 'express';
import {
  decomposeMessage,
  createTask,
  listTasks,
  getStatistics,
  listMessageGroups,
  getProjectTaskStatus,
  getTask,
  updateTask,
  toggleTask,
  deleteTask,
  startRun,
  completeRun,
  failRun,
  recordSpan,
} from './intent-task.controller.js';

/**
 * Creates the intent task router with all endpoints.
 *
 * Route order matters: specific paths before parameterized paths.
 *
 * @returns Express router configured with intent task routes
 */
export function createIntentTaskRouter(): Router {
  const router = Router();

  // Message decomposition (v2)
  router.post('/decompose', decomposeMessage);

  // Task CRUD
  router.post('/', createTask);
  router.get('/', listTasks);
  router.get('/statistics', getStatistics);
  router.get('/messages', listMessageGroups);
  router.get('/project/:projectTaskId', getProjectTaskStatus);
  router.get('/:taskId', getTask);
  router.put('/:taskId', updateTask);
  router.post('/:taskId/toggle', toggleTask);
  router.delete('/:taskId', deleteTask);

  // Run management
  router.post('/:taskId/runs', startRun);
  router.post('/:taskId/runs/:runId/complete', completeRun);
  router.post('/:taskId/runs/:runId/fail', failRun);

  // Span recording
  router.post('/:taskId/runs/:runId/spans', recordSpan);

  return router;
}
