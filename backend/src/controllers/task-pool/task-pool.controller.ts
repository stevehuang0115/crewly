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

/**
 * Get the TaskPoolService singleton.
 *
 * @returns TaskPoolService instance
 */
function getService(): TaskPoolService {
  return TaskPoolService.getInstance();
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

    await getService().addToPool(workItem);

    res.status(201).json({
      success: true,
      message: `WorkItem ${workItem.id} added to pool`,
      data: { workItemId: workItem.id },
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('Invalid WorkItem') || message.includes('status must be')) {
      res.status(400).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
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
    const message = (error as Error).message;
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else if (message.includes('status must be')) {
      res.status(409).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
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
