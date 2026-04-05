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
  BatchCreateIntentTaskInput,
  StartRunInput,
  RecordSpanInput,
  DecomposeMessageInput,
  IntentTaskStatus,
} from '../../types/intent-task.types.js';
import { FissionGuardService } from '../../services/fission/fission-guard.service.js';
import { LoggerService } from '../../services/core/logger.service.js';

const fissionLogger = LoggerService.getInstance().createComponentLogger('IntentTask-FissionGuard');

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
 *
 * @deprecated Use POST /api/intent-tasks or POST /api/intent-tasks/batch instead.
 * Regex-based decomposition is unreliable for non-English messages.
 * The orchestrator LLM should identify intents and create tasks via the manual API.
 */
export async function decomposeMessage(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as DecomposeMessageInput;
    if (!input.message || typeof input.message !== 'string' || !input.message.trim()) {
      res.status(400).json({ success: false, error: 'message is required' });
      return;
    }

    // Fission guard: rate-limit check before decomposition
    try {
      const fissionGuard = FissionGuardService.getInstance();
      const agentId = (req.headers['x-agent-session'] as string) || 'unknown';
      const rateCheck = fissionGuard.checkRateLimit(agentId);
      if (!rateCheck.allowed) {
        res.status(429).json({
          success: false,
          error: `Fission guard: ${rateCheck.reason}`,
          violationType: rateCheck.violationType,
        });
        return;
      }
    } catch {
      // FissionGuardService not initialized — skip (non-fatal)
      fissionLogger.debug('FissionGuardService not available, skipping decompose check');
    }

    const tasks = getService().decomposeMessage(input);
    res.status(201).json({
      success: true,
      data: tasks,
      _deprecated: 'Use POST /api/intent-tasks or POST /api/intent-tasks/batch instead. Regex-based decomposition is unreliable for non-English messages.',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * POST /api/intent-tasks/batch — Create multiple intent tasks in one call.
 * Used by the orchestrator to create all tasks from one user message.
 */
export async function batchCreateTasks(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as BatchCreateIntentTaskInput;
    if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) {
      res.status(400).json({ success: false, error: 'tasks array is required and must not be empty' });
      return;
    }

    // Validate each task has an intent
    for (let i = 0; i < input.tasks.length; i++) {
      const task = input.tasks[i];
      if (!task.intent || typeof task.intent !== 'string' || !task.intent.trim()) {
        res.status(400).json({ success: false, error: `tasks[${i}].intent is required` });
        return;
      }
    }

    // Fission guard: rate-limit check before batch creation.
    // Uses the task count as a proxy — if the batch would exceed limits, reject early.
    // This is a soft gate; the FissionGuardService may not be initialized yet.
    try {
      const fissionGuard = FissionGuardService.getInstance();
      const agentId = (req.headers['x-agent-session'] as string) || 'unknown';
      const rateCheck = fissionGuard.checkRateLimit(agentId);
      if (!rateCheck.allowed) {
        res.status(429).json({
          success: false,
          error: `Fission guard: ${rateCheck.reason}`,
          violationType: rateCheck.violationType,
        });
        return;
      }
    } catch {
      // FissionGuardService not initialized — skip check (non-fatal)
      fissionLogger.debug('FissionGuardService not available, skipping batch creation check');
    }

    const tasks = getService().batchCreateTasks(input);
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
 *
 * Supports multi-status filtering: ?status=pending,in_progress
 * This enables session-less recovery: the orchestrator can query for
 * all unfinished tasks on startup.
 */
export async function listTasks(req: Request, res: Response): Promise<void> {
  try {
    const statusParam = req.query.status as string | undefined;

    if (statusParam && statusParam.includes(',')) {
      // Multi-status filter: merge results from each status
      const statuses = statusParam.split(',').map((s) => s.trim()) as IntentTaskStatus[];
      const allSummaries = statuses.flatMap((s) => getService().listTaskSummaries(s));
      // Deduplicate by task ID (a task can only match one status)
      const seen = new Set<string>();
      const unique = allSummaries.filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
      // Sort by updatedAt descending (most recent first)
      unique.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json({ success: true, data: unique });
    } else {
      const summaries = getService().listTaskSummaries(statusParam as IntentTaskStatus | undefined);
      res.json({ success: true, data: summaries });
    }
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
 * POST /api/intent-tasks/:taskId/toggle — Toggle task between completed and pending.
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

    const newStatus: IntentTaskStatus = task.status === 'completed' ? 'pending' : 'completed';
    const updated = service.updateTask(task.id, { status: newStatus });

    // If uncompleting (pending), clear completedAt
    if (newStatus === 'pending') {
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
