import { Router } from 'express';
import { ApiController } from '../../controllers/api.controller.js';
import * as taskMgmtHandlers from '../../controllers/task-management/task-management.controller.js';
import * as inProgressHandlers from '../../controllers/task-management/in-progress-tasks.controller.js';

export function registerTaskManagementRoutes(router: Router, apiController: ApiController): void {
  // Task Management Routes (for MCP tools)
  router.post('/task-management/create', (req, res) => taskMgmtHandlers.createTask.call(apiController, req, res));
  router.post('/task-management/assign', (req, res) => taskMgmtHandlers.assignTask.call(apiController, req, res));
  router.post('/task-management/complete', (req, res) => taskMgmtHandlers.completeTask.call(apiController, req, res));
  router.post('/task-management/block', (req, res) => taskMgmtHandlers.blockTask.call(apiController, req, res));
  router.post('/task-management/unblock', (req, res) => taskMgmtHandlers.unblockTask.call(apiController, req, res));
  router.post('/task-management/read-task', (req, res) => taskMgmtHandlers.readTask.call(apiController, req, res));
  router.post('/task-management/take-next', (req, res) => taskMgmtHandlers.takeNextTask.call(apiController, req, res));
  router.post('/task-management/sync', (req, res) => taskMgmtHandlers.syncTaskStatus.call(apiController, req, res));
  router.get('/task-management/team-progress', (req, res) => taskMgmtHandlers.getTeamProgress.call(apiController, req, res));

  // Task Execution Routes (for UI)
  router.post('/task-management/start-execution', (req, res) => taskMgmtHandlers.startTaskExecution.call(apiController, req, res));

  // Task Recovery Routes (for orchestrator startup)
  router.post('/task-management/recover-abandoned-tasks', (req, res) => taskMgmtHandlers.recoverAbandonedTasks.call(apiController, req, res));

  // Task Creation Routes
  router.post('/tasks/create-from-config', (req, res) => taskMgmtHandlers.createTasksFromConfig.call(apiController, req, res));

  // Task output retrieval endpoint
  router.post('/task-management/get-output', (req, res) => taskMgmtHandlers.getTaskOutput.call(apiController, req, res));

  // Review request endpoint (for agents to request code reviews)
  router.post('/task-management/request-review', (req, res) => taskMgmtHandlers.requestReview.call(apiController, req, res));

  // Monitoring linkage endpoint (for delegate-task auto-monitoring)
  router.post('/task-management/add-monitoring', (req, res) => taskMgmtHandlers.addMonitoring.call(apiController, req, res));

  // Session-based task completion (for report-status auto-completion)
  router.post('/task-management/complete-by-session', (req, res) => taskMgmtHandlers.completeTasksBySession.call(apiController, req, res));

  // Orphan task detection and cleanup (#168)
  router.post('/task-management/cleanup', (req, res) => taskMgmtHandlers.cleanupOrphanTasks.call(apiController, req, res));

  // List tasks for a project (used by get_tasks tool)
  router.get('/task-management/tasks', (req, res) => taskMgmtHandlers.listTasks.call(apiController, req, res));

  // Task quality scoring (#174 — auditor score-task skill)
  router.post('/tasks/score', (req, res) => taskMgmtHandlers.scoreTask.call(apiController, req, res));

  // Task handoff (F12 — multi-agent A→B handoff)
  router.post('/task-management/handoff', (req, res) => taskMgmtHandlers.recordHandoff.call(apiController, req, res));

  // Task acceptance handshake (Architecture Upgrade Phase 5)
  router.post('/task-management/accept', (req, res) => taskMgmtHandlers.acceptTask.call(apiController, req, res));
  router.post('/task-management/clarify', (req, res) => taskMgmtHandlers.requestClarification.call(apiController, req, res));

  // Working memory (Memory v2 Phase 2)
  router.post('/task-management/save-working-notes', (req, res) => taskMgmtHandlers.saveWorkingNotes.call(apiController, req, res));

  // In-Progress Tasks Routes
  router.get('/in-progress-tasks', (req, res) => inProgressHandlers.getInProgressTasks.call(apiController, req, res));
}
