/**
 * Task Projection Controller (V3.1)
 *
 * REST API for TaskRecord + TaskEvent data.
 * Mounted at /api/task-projection.
 *
 * @module controllers/task-projection/task-projection.controller
 */

import type { Request, Response } from 'express';
import { TaskProjectionService } from '../../services/v3/task-projection.service.js';
import type {
  CreateTaskRecordInput,
  UpdateTaskRecordInput,
  RecordTaskEventInput,
  TokenUsage,
} from '../../types/v3/task-record.types.js';

function svc(): TaskProjectionService {
  return TaskProjectionService.getInstance();
}

/**
 * GET /api/task-projection/records
 * Lists TaskRecords with optional filters: ?requestId=, ?ownerAgent=, ?status=
 */
export async function listRecords(req: Request, res: Response): Promise<void> {
  const { requestId, ownerAgent, status, workItemId } = req.query;
  const records = svc().listRecords({
    requestId: requestId as string | undefined,
    ownerAgent: ownerAgent as string | undefined,
    status: status as string | undefined,
    workItemId: workItemId as string | undefined,
  });
  res.json({ success: true, data: records });
}

/**
 * GET /api/task-projection/records/summary
 * Returns task counts by status/type/agent
 */
export async function getSummary(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: svc().getSummary() });
}

/**
 * GET /api/task-projection/records/:id
 * Gets a single TaskRecord
 */
export async function getRecord(req: Request, res: Response): Promise<void> {
  const record = svc().getRecord(req.params.id);
  if (!record) {
    res.status(404).json({ success: false, error: 'TaskRecord not found' });
    return;
  }
  res.json({ success: true, data: record });
}

/**
 * POST /api/task-projection/records
 * Creates a new TaskRecord (system/agent can call this)
 */
export async function createRecord(req: Request, res: Response): Promise<void> {
  const input: CreateTaskRecordInput = req.body;
  if (!input.title || !input.type || !input.ownerAgent) {
    res.status(400).json({ success: false, error: 'title, type, and ownerAgent are required' });
    return;
  }
  try {
    const record = await svc().createRecord(input);
    res.status(201).json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Failed to create record' });
  }
}

/**
 * PATCH /api/task-projection/records/:id
 * Updates a TaskRecord (status, timestamps, token usage)
 */
export async function updateRecord(req: Request, res: Response): Promise<void> {
  const updates: UpdateTaskRecordInput = req.body;
  const record = await svc().updateRecord(req.params.id, updates);
  if (!record) {
    res.status(404).json({ success: false, error: 'TaskRecord not found' });
    return;
  }
  res.json({ success: true, data: record });
}

/**
 * POST /api/task-projection/records/:id/start
 * Marks a task as started
 */
export async function startRecord(req: Request, res: Response): Promise<void> {
  const { agentId } = req.body;
  if (!agentId) { res.status(400).json({ success: false, error: 'agentId required' }); return; }
  await svc().markStarted(req.params.id, agentId);
  res.json({ success: true, data: svc().getRecord(req.params.id) });
}

/**
 * POST /api/task-projection/records/:id/done
 * Marks a task as completed
 */
export async function completeRecord(req: Request, res: Response): Promise<void> {
  const { agentId, tokenUsage } = req.body;
  if (!agentId) { res.status(400).json({ success: false, error: 'agentId required' }); return; }
  await svc().markDone(req.params.id, agentId, tokenUsage as TokenUsage | undefined);
  res.json({ success: true, data: svc().getRecord(req.params.id) });
}

/**
 * POST /api/task-projection/records/:id/fail
 * Marks a task as failed
 */
export async function failRecord(req: Request, res: Response): Promise<void> {
  const { agentId, reason } = req.body;
  if (!agentId) { res.status(400).json({ success: false, error: 'agentId required' }); return; }
  await svc().markFailed(req.params.id, agentId, reason as string | undefined);
  res.json({ success: true, data: svc().getRecord(req.params.id) });
}

/**
 * POST /api/task-projection/records/:id/block
 * Marks a task as blocked
 */
export async function blockRecord(req: Request, res: Response): Promise<void> {
  const { agentId, reason } = req.body;
  if (!agentId) { res.status(400).json({ success: false, error: 'agentId required' }); return; }
  await svc().markBlocked(req.params.id, agentId, reason as string | undefined);
  res.json({ success: true, data: svc().getRecord(req.params.id) });
}

/**
 * POST /api/task-projection/skills
 * Records a skill execution event (called by agents or skill executor)
 */
export async function recordSkill(req: Request, res: Response): Promise<void> {
  const { taskId, agentId, skillName, success, tokenUsage, durationMs, error } = req.body;
  if (!taskId || !agentId || !skillName) {
    res.status(400).json({ success: false, error: 'taskId, agentId, skillName required' });
    return;
  }
  try {
    await svc().recordSkillCall({ taskId, agentId, skillName, success: !!success, tokenUsage, durationMs, error });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Failed to record skill' });
  }
}

/**
 * GET /api/task-projection/events
 * Lists TaskEvents with optional filters: ?taskId=, ?eventType=, ?limit=
 */
export async function listEvents(req: Request, res: Response): Promise<void> {
  const { taskId, eventType, limit } = req.query;
  const events = svc().listEvents(
    { taskId: taskId as string | undefined, eventType: eventType as string | undefined },
    limit ? parseInt(limit as string, 10) : 200,
  );
  res.json({ success: true, data: events });
}

/**
 * GET /api/task-projection/aggregate/request
 * Returns token usage aggregated per request
 */
export async function aggregateByRequest(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: svc().aggregateByRequest() });
}

/**
 * GET /api/task-projection/aggregate/agent
 * Returns token usage aggregated per agent
 */
export async function aggregateByAgent(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: svc().aggregateByAgent() });
}
