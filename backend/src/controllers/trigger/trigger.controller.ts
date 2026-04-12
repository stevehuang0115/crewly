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
import type { CreateTriggerInput, TriggerStatus } from '../../types/v2/trigger.types.js';
import { validateCreateTriggerInput, isValidTriggerStatus } from '../../types/v2/trigger.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function engine(): TriggerEngine {
  return TriggerEngine.getInstance();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/triggers
 * Lists all triggers, optionally filtered by ?status=
 */
export async function listTriggers(req: Request, res: Response): Promise<void> {
  const { status } = req.query;
  const statusFilter = typeof status === 'string' && isValidTriggerStatus(status)
    ? (status as TriggerStatus)
    : undefined;
  const triggers = engine().list(statusFilter);
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
 * Creates a new trigger
 */
export async function createTrigger(req: Request, res: Response): Promise<void> {
  const input: CreateTriggerInput = req.body;
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
