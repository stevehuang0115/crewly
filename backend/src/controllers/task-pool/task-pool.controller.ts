/**
 * Task Pool Controller — HTTP handlers for Task Pool API
 *
 * Endpoints:
 * - GET  /api/task-pool       — list all claimable WorkItems
 * - POST /api/task-pool/claim — agent claims next available item
 * - POST /api/task-pool/release/:workItemId — release item back to pool
 * - GET  /api/task-pool/stats — pool statistics snapshot
 *
 * @module controllers/task-pool/task-pool.controller
 */

import type { Request, Response } from 'express';
import {
  TaskPoolService,
  type PoolFilters,
} from '../../services/task-pool/task-pool.service.js';
import { TaskProjectionService } from '../../services/v3/task-projection.service.js';
import type { TokenUsage } from '../../types/v3/task-record.types.js';
import { formatError } from '../../utils/format-error.js';

/**
 * Maps service-layer errors to appropriate HTTP status codes and sends a JSON error response.
 *
 * @param res - Express response
 * @param error - The caught error
 */
function handleServiceError(res: Response, error: unknown): void {
  const message = formatError(error);
  if (message.includes('not found')) {
    res.status(404).json({ success: false, error: message });
  } else if (message.includes('status must be') || message.includes('Invalid')) {
    res.status(409).json({ success: false, error: message });
  } else {
    res.status(500).json({ success: false, error: message });
  }
}

/**
 * Get the TaskPoolService singleton.
 *
 * @returns TaskPoolService instance
 */
function getService(): TaskPoolService {
  return TaskPoolService.getInstance();
}

/**
 * Get the TaskProjectionService singleton (non-throwing).
 *
 * @returns TaskProjectionService instance or null if unavailable
 */
function getProjection(): TaskProjectionService | null {
  try {
    return TaskProjectionService.getInstance();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/add — Add a WorkItem to the pool
// ---------------------------------------------------------------------------

/**
 * Adds a WorkItem to the Task Pool.
 *
 * This is the HTTP entry point for the V3 pull-mode task path.
 * Used by delegate-task and other orchestration flows to queue
 * execution-ready WorkItems.
 *
 * Request body: a WorkItem object (id, type, owner, title, status='queued', etc.)
 *
 * @param req - Express request with WorkItem body
 * @param res - Express response
 */
export async function addItem(req: Request, res: Response): Promise<void> {
  try {
    const workItem = req.body;

    if (!workItem || typeof workItem !== 'object') {
      res.status(400).json({ success: false, error: 'Request body must be a WorkItem object' });
      return;
    }

    // V3.1 Task Validator
    const validationErrors = await validateWorkItem(workItem);
    if (validationErrors.length > 0) {
      res.status(400).json({ success: false, errors: validationErrors });
      return;
    }

    await getService().addToPool(workItem);

    // V3.1: Project WorkItem entry as a TaskRecord
    const projection = getProjection();
    if (projection) {
      projection.createRecord({
        title: workItem.title || `WorkItem ${workItem.id}`,
        type: workItem.type === 'delegate' ? 'delegation' : 'self_execution',
        ownerAgent: workItem.target || workItem.owner || 'system',
        requestId: workItem.requestId,
        workItemId: workItem.id,
        triggerId: workItem.triggerId,
      }).catch(() => { /* non-blocking */ });
    }

    res.status(201).json({
      success: true,
      message: `WorkItem ${workItem.id} added to pool`,
      data: { workItemId: workItem.id },
    });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// GET /api/task-pool — List available WorkItems
// ---------------------------------------------------------------------------

/**
 * Returns all claimable (queued, unclaimed) WorkItems in the pool.
 *
 * Supports optional query filters:
 * - types: comma-separated WorkItemType values
 * - owner: WorkItemOwner value
 * - target: target agent session name
 * - missionId: filter by mission
 *
 * @param req - Express request
 * @param res - Express response
 */
export async function listAvailable(req: Request, res: Response): Promise<void> {
  try {
    const filters = parseQueryFilters(req);
    const items = await getService().getAvailableItems(filters);
    res.json({ success: true, data: items, count: items.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/claim — Claim a WorkItem
// ---------------------------------------------------------------------------

/**
 * Agent claims the next available WorkItem from the pool.
 *
 * Request body:
 * ```json
 * {
 *   "agentId": "crewly-product-leo-member-n",
 *   "filters": { "types": ["delegate"], "owner": "agent" }
 * }
 * ```
 *
 * @param req - Express request with agentId in body
 * @param res - Express response with claimed item and claim, or 404
 */
export async function claimItem(req: Request, res: Response): Promise<void> {
  try {
    const { agentId, filters } = req.body as {
      agentId?: string;
      filters?: PoolFilters;
    };

    if (!agentId || typeof agentId !== 'string' || !agentId.trim()) {
      res.status(400).json({ success: false, error: 'agentId is required' });
      return;
    }

    const result = await getService().claimFromPool(agentId.trim(), filters);

    if (!result) {
      res.status(404).json({
        success: false,
        error: 'No available WorkItem matching filters',
      });
      return;
    }

    // V3.1: Project task assignment
    const projection = getProjection();
    if (projection) {
      const workItem = result.workItem;
      const records = projection.listRecords({ workItemId: workItem.id });
      const record = records[0];
      if (record) {
        projection.markStarted(record.id, agentId.trim()).catch(() => { /* non-blocking */ });
      }
    }

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/release/:workItemId — Release a WorkItem
// ---------------------------------------------------------------------------

/**
 * Releases a claimed WorkItem back to the pool.
 *
 * Request body:
 * ```json
 * { "reason": "agent busy" }
 * ```
 *
 * @param req - Express request with workItemId param
 * @param res - Express response
 */
export async function releaseItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const { reason } = req.body as { reason?: string };

    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }

    const releaseReason = reason || 'released via API';
    await getService().releaseBack(workItemId, releaseReason);

    res.json({ success: true, message: `WorkItem ${workItemId} released back to pool` });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/complete/:workItemId — Complete a WorkItem
// ---------------------------------------------------------------------------

/**
 * Marks a running WorkItem as completed ('done').
 *
 * Request body:
 * ```json
 * { "agentId": "crewly-product-leo-member-n", "tokenUsage": { ... }, "result": { ... } }
 * ```
 *
 * @param req - Express request with workItemId param
 * @param res - Express response
 */
export async function completeItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const { agentId, tokenUsage, result } = req.body as {
      agentId?: string;
      tokenUsage?: TokenUsage;
      result?: Record<string, unknown>;
    };

    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    if (!agentId) {
      res.status(400).json({ success: false, error: 'agentId is required' });
      return;
    }

    // Capture requestId BEFORE completing (item may be harder to find after status change)
    const preCompleteItem = (await getService().getAllItems()).find(wi => wi.id === workItemId);
    const cascadeRequestId = preCompleteItem?.requestId;

    await getService().completeItem(workItemId, result);

    // V3.1: Project task completion
    const projection = getProjection();
    if (projection) {
      const records = projection.listRecords({ workItemId });
      const record = records[0];
      if (record) {
        projection.markDone(record.id, agentId, tokenUsage).catch(() => { /* non-blocking */ });
        // Roll up token usage to Request
        if (tokenUsage && record.requestId) {
          rollUpTokensToRequest(record.requestId, tokenUsage, projection);
        }
      }
    }

    // Cascade: update parent Request status if all WorkItems are done
    if (cascadeRequestId) {
      setImmediate(async () => {
        try {
          const { RequestService } = await import('../../services/v3/request.service.js');
          const { isValidRequestTransition } = await import('../../types/v2/request.types.js');
          const requestService = RequestService.getInstance();
          const request = await requestService.getById(cascadeRequestId);
          if (!request || request.status === 'done' || request.status === 'cancelled') return;

          const allItems = await getService().getAllItems();
          const siblings = allItems.filter(wi => wi.requestId === cascadeRequestId);
          const statuses = siblings.map(wi => wi.status);

          let newStatus: string | null = null;
          if (statuses.every(s => s === 'done')) newStatus = 'done';
          else if (statuses.some(s => s === 'running')) newStatus = 'running';
          else if (statuses.some(s => s === 'done')) newStatus = 'running';

          if (newStatus && newStatus !== request.status) {
            // Handle multi-step transitions (e.g. blocked → running → done)
            if (isValidRequestTransition(request.status, newStatus as any)) {
              await requestService.update(cascadeRequestId, { status: newStatus as any });
            } else if (newStatus === 'done' && isValidRequestTransition(request.status, 'running')) {
              // Transition through running first, then to done
              await requestService.update(cascadeRequestId, { status: 'running' });
              await requestService.update(cascadeRequestId, { status: 'done' });
            }
          }
        } catch {
          // non-fatal cascade
        }
      });
    }

    res.json({ success: true, message: `WorkItem ${workItemId} completed` });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/block/:workItemId — Block a WorkItem
// ---------------------------------------------------------------------------

/**
 * Marks a WorkItem as blocked.
 *
 * Request body:
 * ```json
 * { "agentId": "crewly-product-leo-member-n", "reason": "waiting for X" }
 * ```
 *
 * @param req - Express request with workItemId param
 * @param res - Express response
 */
export async function blockItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const { agentId, reason } = req.body as { agentId?: string; reason?: string };

    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    if (!agentId) {
      res.status(400).json({ success: false, error: 'agentId is required' });
      return;
    }

    await getService().updateItemStatus(workItemId, 'blocked');

    // V3.1: Project task blocked
    const projection = getProjection();
    if (projection) {
      const records = projection.listRecords({ workItemId });
      const record = records[0];
      if (record) {
        projection.markBlocked(record.id, agentId, reason).catch(() => { /* non-blocking */ });
      }
    }

    res.json({ success: true, message: `WorkItem ${workItemId} blocked` });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/fail/:workItemId — Fail a WorkItem
// ---------------------------------------------------------------------------

/**
 * Marks a running WorkItem as failed.
 *
 * Request body:
 * ```json
 * { "agentId": "crewly-product-leo-member-n", "error": "something went wrong" }
 * ```
 *
 * @param req - Express request with workItemId param
 * @param res - Express response
 */
export async function failItemHandler(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const { agentId, error: errorMsg } = req.body as { agentId?: string; error?: string };

    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    if (!agentId) {
      res.status(400).json({ success: false, error: 'agentId is required' });
      return;
    }

    await getService().failItem(workItemId, errorMsg || 'unknown error');

    // V3.1: Project task failure
    const projection = getProjection();
    if (projection) {
      const records = projection.listRecords({ workItemId });
      const record = records[0];
      if (record) {
        projection.markFailed(record.id, agentId, errorMsg).catch(() => { /* non-blocking */ });
      }
    }

    res.json({ success: true, message: `WorkItem ${workItemId} failed` });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// GET /api/task-pool/stats — Pool statistics
// ---------------------------------------------------------------------------

/**
 * Returns pool statistics: total, claimed, available, avg wait time, breakdowns.
 *
 * @param req - Express request
 * @param res - Express response with PoolSnapshot
 */
export async function getStats(req: Request, res: Response): Promise<void> {
  try {
    const stats = await getService().getPoolStatus();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/heartbeat — Agent heartbeat for active claim
// ---------------------------------------------------------------------------

/**
 * Processes a heartbeat from an agent for their active claim.
 *
 * Request body:
 * ```json
 * { "claimId": "uuid", "agentId": "crewly-product-leo-member-n" }
 * ```
 *
 * @param req - Express request with claimId and agentId in body
 * @param res - Express response
 */
export async function heartbeat(req: Request, res: Response): Promise<void> {
  try {
    const { claimId, agentId } = req.body as {
      claimId?: string;
      agentId?: string;
    };

    if (!claimId || !agentId) {
      res.status(400).json({
        success: false,
        error: 'claimId and agentId are required',
      });
      return;
    }

    const result = await getService().heartbeat(claimId, agentId);

    if (!result.success) {
      res.status(409).json({ success: false, error: result.reason });
      return;
    }

    res.json({ success: true, data: { claim: result.claim } });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/extend-lease — Extend lease on a claim
// ---------------------------------------------------------------------------

/**
 * Extends the lease duration for an active claim.
 *
 * Request body:
 * ```json
 * { "claimId": "uuid", "agentId": "crewly-product-leo-member-n" }
 * ```
 *
 * @param req - Express request with claimId and agentId in body
 * @param res - Express response
 */
export async function extendLease(req: Request, res: Response): Promise<void> {
  try {
    const { claimId, agentId } = req.body as {
      claimId?: string;
      agentId?: string;
    };

    if (!claimId || !agentId) {
      res.status(400).json({
        success: false,
        error: 'claimId and agentId are required',
      });
      return;
    }

    const result = await getService().extendLease(claimId, agentId);

    if (!result.success) {
      res.status(409).json({ success: false, error: result.reason });
      return;
    }

    res.json({ success: true, data: { claim: result.claim } });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/task-pool/claims/expired — Scan for expired claims
// ---------------------------------------------------------------------------

/**
 * Scans for claims with expired leases. Returns two lists:
 * - expiring: lease expired, within grace period
 * - graceExceeded: past grace period, should be revoked
 *
 * Used by the Reconciler and for debugging.
 *
 * @param req - Express request
 * @param res - Express response
 */
export async function scanExpired(req: Request, res: Response): Promise<void> {
  try {
    const summary = await getService().scanExpiredClaims();
    res.json({
      success: true,
      data: {
        expiring: summary.expiring,
        graceExceeded: summary.graceExceeded,
        expiringCount: summary.expiring.length,
        graceExceededCount: summary.graceExceeded.length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/revoke/:claimId — Revoke a claim and release work item
// ---------------------------------------------------------------------------

/**
 * Revokes a claim and releases the work item back to the pool.
 * Typically called by the Reconciler when grace period is exceeded.
 *
 * Request body:
 * ```json
 * { "reason": "grace period exceeded" }
 * ```
 *
 * @param req - Express request with claimId param
 * @param res - Express response
 */
export async function revokeAndRelease(req: Request, res: Response): Promise<void> {
  try {
    const { claimId } = req.params;
    const { reason } = req.body as { reason?: string };

    if (!claimId) {
      res.status(400).json({ success: false, error: 'claimId param is required' });
      return;
    }

    const revokeReason = reason || 'revoked via API';
    await getService().revokeAndRelease(claimId, revokeReason);

    res.json({ success: true, message: `Claim ${claimId} revoked and work item released` });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valid WorkItemTypes accepted at the pool entry point. */
const VALID_POOL_TYPES = new Set(['delegate', 'check', 'notify', 'review', 'project_task', 'cron_run', 'confirm', 'reconcile']);

/** Max WorkItems allowed per Request in a single planning pass. */
const MAX_WORK_ITEMS_PER_REQUEST = 20;

/**
 * Validates a WorkItem before it enters the pool.
 * Returns a list of validation error strings (empty = valid).
 *
 * Checks:
 * 1. Schema: required fields present, type is valid
 * 2. Quantity: no more than MAX_WORK_ITEMS_PER_REQUEST per requestId
 * 3. Duplicate: workItemId must not already exist in pool
 *
 * @param workItem - The WorkItem to validate
 * @returns Array of error strings
 */
async function validateWorkItem(workItem: Record<string, unknown>): Promise<string[]> {
  const errors: string[] = [];

  // 1. Schema Check
  if (!workItem.id || typeof workItem.id !== 'string') {
    errors.push('WorkItem.id is required and must be a string');
  }
  if (!workItem.title || typeof workItem.title !== 'string') {
    errors.push('WorkItem.title is required');
  }
  if (!workItem.type || typeof workItem.type !== 'string') {
    errors.push('WorkItem.type is required');
  } else if (!VALID_POOL_TYPES.has(workItem.type)) {
    errors.push(`WorkItem.type "${workItem.type}" is invalid; must be one of: ${[...VALID_POOL_TYPES].join(', ')}`);
  }
  if (!workItem.owner || typeof workItem.owner !== 'string') {
    errors.push('WorkItem.owner is required');
  }

  if (errors.length > 0) return errors; // Bail out early on schema errors

  try {
    const svc = getService();
    const allItems = await svc.getAllItems();

    // 2. Duplicate detection
    const duplicate = allItems.find((wi) => wi.id === workItem.id);
    if (duplicate) {
      errors.push(`WorkItem.id "${workItem.id}" already exists in pool (status: ${duplicate.status})`);
    }

    // 3. Per-request quantity cap
    const requestId = workItem.requestId as string | undefined;
    if (requestId) {
      const requestItems = allItems.filter(
        (wi) => wi.requestId === requestId && wi.status !== 'done' && wi.status !== 'cancelled',
      );
      if (requestItems.length >= MAX_WORK_ITEMS_PER_REQUEST) {
        errors.push(
          `Request ${requestId} already has ${requestItems.length} active WorkItems (max ${MAX_WORK_ITEMS_PER_REQUEST}). Possible infinite decomposition loop.`,
        );
      }
    }
  } catch {
    // Non-critical: validation failures should not break pool insertion
  }

  return errors;
}

/**
 * Asynchronously rolls up token usage from a completed TaskRecord to its parent Request.
 * Non-blocking — errors are swallowed to avoid slowing down API responses.
 *
 * @param requestId - The parent Request ID
 * @param tokenUsage - Token usage to roll up
 * @param projection - TaskProjectionService instance
 */
function rollUpTokensToRequest(
  requestId: string,
  tokenUsage: TokenUsage,
  projection: TaskProjectionService,
): void {
  void projection; // used for type checking only
  setImmediate(async () => {
    try {
      const { RequestService } = await import('../../services/v3/request.service.js');
      const requestService = RequestService.getInstance();
      const request = await requestService.getById(requestId);
      if (!request) return;

      await requestService.update(requestId, {
        totalInputTokens: (request.totalInputTokens || 0) + (tokenUsage.promptTokens || 0),
        totalOutputTokens: (request.totalOutputTokens || 0) + (tokenUsage.completionTokens || 0),
        totalCost: (request.totalCost || 0) + (tokenUsage.estimatedCostUsd || 0),
      });

      // Cascade up to Mission if this Request belongs to one
      if (request.missionId && tokenUsage.estimatedCostUsd) {
        rollUpTokensToMission(request.missionId, tokenUsage);
      }
    } catch {
      // Non-critical — token roll-up failures should never break agent flow
    }
  });
}

/**
 * Asynchronously rolls up token usage from a Request to its parent Mission.
 * Errors are swallowed — this must never block agent-facing operations.
 *
 * @param missionId - The parent Mission ID
 * @param tokenUsage - Token counts to accumulate
 */
function rollUpTokensToMission(missionId: string, tokenUsage: TokenUsage): void {
  setImmediate(async () => {
    try {
      const { _loadMission, _saveMission } = await import('../mission/mission-policy.controller.js');
      const mission = await _loadMission(missionId);
      if (!mission) return;
      mission.totalInputTokens = (mission.totalInputTokens || 0) + (tokenUsage.promptTokens || 0);
      mission.totalOutputTokens = (mission.totalOutputTokens || 0) + (tokenUsage.completionTokens || 0);
      mission.totalCost = (mission.totalCost || 0) + (tokenUsage.estimatedCostUsd || 0);
      mission.updatedAt = new Date().toISOString();
      await _saveMission(mission);
    } catch {
      // Non-critical — mission roll-up must never interfere with agent flow
    }
  });
}

/**
 * Parses optional filter query parameters into a PoolFilters object.
 *
 * @param req - Express request
 * @returns Parsed filters, or undefined if none provided
 */
function parseQueryFilters(req: Request): PoolFilters | undefined {
  const { types, owner, target, missionId } = req.query;

  const hasAny = types || owner || target || missionId;
  if (!hasAny) return undefined;

  const filters: PoolFilters = {};

  if (typeof types === 'string' && types.trim()) {
    filters.types = types.split(',').map((t) => t.trim()) as PoolFilters['types'];
  }
  if (typeof owner === 'string' && owner.trim()) {
    filters.owner = owner.trim() as PoolFilters['owner'];
  }
  if (typeof target === 'string' && target.trim()) {
    filters.target = target.trim();
  }
  if (typeof missionId === 'string' && missionId.trim()) {
    filters.missionId = missionId.trim();
  }

  return filters;
}
