/**
 * Trigger Controller
 *
 * REST handlers for the TriggerEngine CRUD operations.
 * Mounted at `/api/triggers`.
 *
 * @module controllers/trigger/trigger.controller
 */

import type { Request, Response } from 'express';
import { TriggerEngine } from '../../services/v3/trigger-engine.service.js';
import type { CreateTriggerInput, Trigger, TriggerStatus } from '../../types/v2/trigger.types.js';
import { validateCreateTriggerInput, isValidTriggerStatus, isRecurringTrigger } from '../../types/v2/trigger.types.js';
import { resolveTriggerCreator } from '../../services/v3/trigger-classification.js';
import { readAgentSessionHeader, isOwnerDashboardRequest } from '../../utils/agent-caller.utils.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function engine(): TriggerEngine {
  return TriggerEngine.getInstance();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** A trigger as the list endpoint returns it: stored fields plus projections. */
export type TriggerListEntry = Trigger & {
  /** When a capped recurring trigger will fire for the last time */
  projectedLastFireAt?: string;
};

/**
 * GET /api/triggers
 * Lists all triggers, optionally filtered by ?status=. Active and paused
 * recurring triggers with a `maxFires` cap carry `projectedLastFireAt`.
 */
export async function listTriggers(req: Request, res: Response): Promise<void> {
  const { status } = req.query;
  const statusFilter = typeof status === 'string' && isValidTriggerStatus(status)
    ? (status as TriggerStatus)
    : undefined;
  const eng = engine();
  const triggers: TriggerListEntry[] = eng.list(statusFilter).map((t) => {
    if ((t.status !== 'active' && t.status !== 'paused') || t.maxFires === undefined || !isRecurringTrigger(t)) {
      return t;
    }
    const projectedLastFireAt = eng.projectLastFireAt(t.id);
    return projectedLastFireAt ? { ...t, projectedLastFireAt } : t;
  });
  res.json({ success: true, data: triggers });
}

/**
 * GET /api/triggers/status
 * Returns engine health + counts by status/type
 */
export async function getTriggerStatus(req: Request, res: Response): Promise<void> {
  const status = engine().getStatus();
  res.json({ success: true, data: status });
}

/**
 * GET /api/triggers/:id
 * Returns a single trigger by ID
 */
export async function getTrigger(req: Request, res: Response): Promise<void> {
  const trigger = engine().get(req.params.id);
  if (!trigger) {
    res.status(404).json({ success: false, error: 'Trigger not found' });
    return;
  }
  res.json({ success: true, data: trigger });
}

/**
 * POST /api/triggers
 * Creates a new trigger.
 *
 * `createdBy` / `createdBySession` / `internal` come from the caller, not the
 * body: an `X-Agent-Session` call belongs to that agent, a dashboard call to
 * the owner (see resolveTriggerCreator).
 */
export async function createTrigger(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Partial<CreateTriggerInput>;
  const callerSession = readAgentSessionHeader(req);
  const creator = resolveTriggerCreator({
    requestedCreatedBy: body.createdBy,
    requestedInternal: typeof body.internal === 'boolean' ? body.internal : undefined,
    callerSession,
    callerIsOrchestrator: callerSession === ORCHESTRATOR_SESSION_NAME,
    isOwnerDashboard: isOwnerDashboardRequest(req),
  });
  const input = { ...body, ...creator } as CreateTriggerInput;
  if (!creator.createdBySession) delete input.createdBySession;
  const errors = validateCreateTriggerInput(input);
  if (errors.length > 0) {
    res.status(400).json({ success: false, error: errors.join(', ') });
    return;
  }

  try {
    const trigger = await engine().create(input);
    res.status(201).json({ success: true, data: trigger });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create trigger',
    });
  }
}

/**
 * POST /api/triggers/:id/pause
 * Pauses an active trigger
 */
export async function pauseTrigger(req: Request, res: Response): Promise<void> {
  const paused = await engine().pause(req.params.id);
  if (!paused) {
    res.status(400).json({ success: false, error: 'Trigger not found or not active' });
    return;
  }
  const trigger = engine().get(req.params.id);
  res.json({ success: true, data: trigger });
}

/**
 * POST /api/triggers/:id/resume
 * Resumes a paused trigger
 */
export async function resumeTrigger(req: Request, res: Response): Promise<void> {
  const resumed = await engine().resume(req.params.id);
  if (!resumed) {
    res.status(400).json({ success: false, error: 'Trigger not found or not paused' });
    return;
  }
  const trigger = engine().get(req.params.id);
  res.json({ success: true, data: trigger });
}

/**
 * POST /api/triggers/:id/cancel
 * Permanently cancels a trigger
 */
export async function cancelTrigger(req: Request, res: Response): Promise<void> {
  const cancelled = await engine().cancel(req.params.id);
  if (!cancelled) {
    res.status(400).json({ success: false, error: 'Trigger not found or already cancelled' });
    return;
  }
  const trigger = engine().get(req.params.id);
  res.json({ success: true, data: trigger });
}

/**
 * DELETE /api/triggers/:id
 * Permanently deletes a trigger
 */
export async function deleteTrigger(req: Request, res: Response): Promise<void> {
  const deleted = await engine().delete(req.params.id);
  if (!deleted) {
    res.status(404).json({ success: false, error: 'Trigger not found' });
    return;
  }
  res.json({ success: true });
}
