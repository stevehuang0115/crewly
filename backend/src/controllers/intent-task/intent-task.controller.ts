/**
 * Intent Task Controller — V2
 *
 * Express request handlers for the Intent Task API.
 * V2 adds: message decomposition, message groups, project task status,
 * and task toggle (complete/uncomplete) for todo-list UI.
 *
 * @module controllers/intent-task/intent-task.controller
 */

import type { Request, Response } from 'express';
import { IntentTaskService } from '../../services/intent-task/intent-task.service.js';
import type {
  CreateIntentTaskInput,
  UpdateIntentTaskInput,
  StartRunInput,
  RecordSpanInput,
  DecomposeMessageInput,
  IntentTaskStatus,
} from '../../types/intent-task.types.js';

/**
 * Get the service instance (lazy singleton).
 */
function getService(): IntentTaskService {
  return IntentTaskService.getInstance();
}

// =============================================================================
// Message Decomposition Endpoint
// =============================================================================

/**
 * POST /api/intent-tasks/decompose — Decompose a message into multiple tasks.
 */
export async function decomposeMessage(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as DecomposeMessageInput;
    if (!input.message || typeof input.message !== 'string' || !input.message.trim()) {
      res.status(400).json({ success: false, error: 'message is required' });
      return;
    }

    const tasks = getService().decomposeMessage(input);
    res.status(201).json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// =============================================================================
// Task Endpoints
// =============================================================================

/**
 * POST /api/intent-tasks — Create a new intent task.
 */
export async function createTask(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as CreateIntentTaskInput;
    if (!input.intent || typeof input.intent !== 'string' || !input.intent.trim()) {
      res.status(400).json({ success: false, error: 'intent is required' });
      return;
    }

    const task = getService().createTask(input);
    res.status(201).json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * GET /api/intent-tasks — List all tasks (optionally filtered by status).
 */
export async function listTasks(req: Request, res: Response): Promise<void> {
  try {
    const status = req.query.status as IntentTaskStatus | undefined;
    const summaries = getService().listTaskSummaries(status);
    res.json({ success: true, data: summaries });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * GET /api/intent-tasks/statistics — Get aggregate statistics.
 */
export async function getStatistics(_req: Request, res: Response): Promise<void> {
  try {
    const stats = getService().getStatistics();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * GET /api/intent-tasks/messages — List tasks grouped by message (todo-list view).
 *
 * Supports optional ?status= query param to filter groups by task status.
 * When filtered, only groups containing tasks with the given status are returned,
 * and the originalMessage is always preserved from the stored text (not rebuilt).
 */
export async function listMessageGroups(req: Request, res: Response): Promise<void> {
  try {
    const status = req.query.status as IntentTaskStatus | undefined;
    const groups = getService().listMessageGroups(status);
    res.json({ success: true, data: groups });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * GET /api/intent-tasks/project/:projectTaskId — Get project task completion status.
 */
export async function getProjectTaskStatus(req: Request, res: Response): Promise<void> {
  try {
    const status = getService().getProjectTaskStatus(req.params.projectTaskId);
    if (!status) {
      res.status(404).json({ success: false, error: 'No tasks linked to this project task' });
      return;
    }
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * GET /api/intent-tasks/:taskId — Get a single task with full detail.
 */
export async function getTask(req: Request, res: Response): Promise<void> {
  try {
    const task = getService().getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    res.json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * PUT /api/intent-tasks/:taskId — Update a task's status/metadata.
 */
export async function updateTask(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as UpdateIntentTaskInput;
    const task = getService().updateTask(req.params.taskId, input);
    res.json({ success: true, data: task });
  } catch (error) {
    const msg = (error as Error).message;
    const status = msg.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: msg });
  }
}

/**
 * POST /api/intent-tasks/:taskId/toggle — Toggle task between completed and classified.
 * Used by the todo-list UI checkbox.
 */
export async function toggleTask(req: Request, res: Response): Promise<void> {
  try {
    const service = getService();
    const task = service.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const newStatus: IntentTaskStatus = task.status === 'completed' ? 'classified' : 'completed';
    const updated = service.updateTask(task.id, { status: newStatus });

    // If uncompleting (classified), clear completedAt
    if (newStatus === 'classified') {
      updated.completedAt = null;
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * DELETE /api/intent-tasks/:taskId — Delete a task.
 */
export async function deleteTask(req: Request, res: Response): Promise<void> {
  try {
    const deleted = getService().deleteTask(req.params.taskId);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// =============================================================================
// Run Endpoints
// =============================================================================

/**
 * POST /api/intent-tasks/:taskId/runs — Start a new run.
 */
export async function startRun(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as StartRunInput;
    if (!input.sessionName || typeof input.sessionName !== 'string') {
      res.status(400).json({ success: false, error: 'sessionName is required' });
      return;
    }
    const run = getService().startRun(req.params.taskId, input);
    res.status(201).json({ success: true, data: run });
  } catch (error) {
    const msg = (error as Error).message;
    const status = msg.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: msg });
  }
}

/**
 * POST /api/intent-tasks/:taskId/runs/:runId/complete — Complete a run.
 */
export async function completeRun(req: Request, res: Response): Promise<void> {
  try {
    const run = getService().completeRun(req.params.taskId, req.params.runId);
    res.json({ success: true, data: run });
  } catch (error) {
    const msg = (error as Error).message;
    const status = msg.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: msg });
  }
}

/**
 * POST /api/intent-tasks/:taskId/runs/:runId/fail — Fail a run.
 */
export async function failRun(req: Request, res: Response): Promise<void> {
  try {
    const errorMsg = (req.body as { error?: string }).error;
    const run = getService().failRun(req.params.taskId, req.params.runId, errorMsg);
    res.json({ success: true, data: run });
  } catch (error) {
    const msg = (error as Error).message;
    const status = msg.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: msg });
  }
}

// =============================================================================
// Span Endpoints
// =============================================================================

/**
 * POST /api/intent-tasks/:taskId/runs/:runId/spans — Record a span.
 */
export async function recordSpan(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as RecordSpanInput;
    if (!input.type || !input.label) {
      res.status(400).json({ success: false, error: 'type and label are required' });
      return;
    }
    const span = getService().recordSpan(req.params.taskId, req.params.runId, input);
    res.status(201).json({ success: true, data: span });
  } catch (error) {
    const msg = (error as Error).message;
    const status = msg.includes('not found') || msg.includes('not in running') ? 400 : 500;
    res.status(status).json({ success: false, error: msg });
  }
}
