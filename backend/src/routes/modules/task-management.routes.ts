/**
 * Task Management Routes — checklist-only after v1 deprecation.
 *
 * Per spec/2026-05-06-task-management-v1-deprecation.md, the v1
 * task-management subsystem (`.md`-file-based task lifecycle) has been
 * retired in favor of the V3 task-pool. Producers and consumers all go
 * through `/api/task-pool/*` now.
 *
 * The checklist endpoints survive because checklists are a separate
 * quality-gate concern (not the task lifecycle itself). They are mounted
 * at the same legacy paths to keep the `team-leader/design-checklist`
 * and `team-leader/verify-output` skills working unchanged.
 *
 * @module routes/modules/task-management.routes
 */

import { Router } from 'express';
import { ApiController } from '../../controllers/api.controller.js';
import * as inProgressHandlers from '../../controllers/task-management/in-progress-tasks.controller.js';
import {
  submitChecklist,
  approveChecklist,
  getChecklist,
} from '../../controllers/checklist/checklist.controller.js';

export function registerTaskManagementRoutes(router: Router, apiController: ApiController): void {
  // Checklist Management — TL acceptance checklist alignment.
  // Mounted under `/task-management/*` for path-stability with the
  // pre-deprecation skills; logically these are checklist endpoints.
  router.post('/task-management/:taskId/checklist', submitChecklist);
  router.post('/task-management/:taskId/checklist/approve', approveChecklist);
  router.get('/task-management/:taskId/checklist', getChecklist);

  // In-Progress Tasks Routes (UI-facing; reads V3 projection state).
  router.get('/in-progress-tasks', (req, res) =>
    inProgressHandlers.getInProgressTasks.call(apiController, req, res),
  );
}
