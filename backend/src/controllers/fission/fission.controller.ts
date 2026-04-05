/**
 * Fission Controller
 *
 * HTTP request handlers for Fission Guardrail configuration, stats,
 * violations audit, and pre-creation checks.
 *
 * Endpoints:
 * - GET  /api/fission/config     — current guardrail configuration
 * - PUT  /api/fission/config     — update configuration
 * - GET  /api/fission/stats      — fission statistics (violation counts by type)
 * - GET  /api/fission/violations — recent violations (audit log)
 * - POST /api/fission/check      — pre-check whether a sub-task creation is allowed
 *
 * @module controllers/fission/fission.controller
 */

import type { Request, Response, NextFunction } from 'express';
import type { FissionGuardService } from '../../services/fission/fission-guard.service.js';
import { isValidFissionGuardConfig, type FissionViolationType, FISSION_VIOLATION_TYPES } from '../../services/fission/fission-guard.types.js';

/** Maximum violations returned in a single request */
const MAX_VIOLATIONS_LIMIT = 200;

/** Default violations returned when limit is not specified */
const DEFAULT_VIOLATIONS_LIMIT = 50;

/** Module-level reference to the fission guard service */
let fissionGuardService: FissionGuardService | null = null;

/**
 * Set the FissionGuardService instance.
 * Called during server initialization.
 *
 * @param service - The FissionGuardService instance
 */
export function setFissionGuardService(service: FissionGuardService): void {
  fissionGuardService = service;
}

/**
 * GET /api/fission/config
 *
 * Returns the current fission guardrail configuration.
 *
 * @param _req - Express request (unused)
 * @param res - Express response with FissionGuardConfig
 * @param next - Express next function for error forwarding
 */
export async function getFissionConfig(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!fissionGuardService) {
      res.status(503).json({ success: false, error: 'Fission guard service not initialized' });
      return;
    }

    const config = fissionGuardService.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/fission/config
 *
 * Updates the fission guardrail configuration.
 * Accepts a partial FissionGuardConfig — only provided fields are updated.
 *
 * @param req - Express request with partial FissionGuardConfig body
 * @param res - Express response with updated config
 * @param next - Express next function for error forwarding
 */
export async function updateFissionConfig(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!fissionGuardService) {
      res.status(503).json({ success: false, error: 'Fission guard service not initialized' });
      return;
    }

    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
      return;
    }

    // Validate that provided numeric fields are positive
    const numericFields = [
      'maxDepth', 'maxTasksPerMission', 'hardMaxTasksPerMission',
      'rateLimitWindowMs', 'rateLimitMaxCreations', 'maxBranchingFactor',
      'defaultTtlMs', 'maxTtlMs', 'maxViolationHistory',
    ] as const;

    for (const field of numericFields) {
      if (field in updates) {
        const val = updates[field];
        if (typeof val !== 'number' || val <= 0 || !Number.isFinite(val)) {
          res.status(400).json({
            success: false,
            error: `${field} must be a positive finite number`,
          });
          return;
        }
      }
    }

    if ('budgetThresholdUsd' in updates) {
      const val = updates.budgetThresholdUsd;
      if (typeof val !== 'number' || val < 0 || !Number.isFinite(val)) {
        res.status(400).json({
          success: false,
          error: 'budgetThresholdUsd must be a non-negative finite number',
        });
        return;
      }
    }

    if ('budgetGateEnabled' in updates && typeof updates.budgetGateEnabled !== 'boolean') {
      res.status(400).json({
        success: false,
        error: 'budgetGateEnabled must be a boolean',
      });
      return;
    }

    fissionGuardService.updateConfig(updates);
    const config = fissionGuardService.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/fission/stats
 *
 * Returns fission statistics: violation counts grouped by type.
 *
 * @param _req - Express request (unused)
 * @param res - Express response with stats object
 * @param next - Express next function for error forwarding
 */
export async function getFissionStats(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!fissionGuardService) {
      res.status(503).json({ success: false, error: 'Fission guard service not initialized' });
      return;
    }

    const allViolations = fissionGuardService.getViolations(MAX_VIOLATIONS_LIMIT);
    const byType: Record<string, number> = {};
    for (const type of FISSION_VIOLATION_TYPES) {
      byType[type] = 0;
    }
    for (const v of allViolations) {
      byType[v.violationType] = (byType[v.violationType] || 0) + 1;
    }

    const config = fissionGuardService.getConfig();

    res.json({
      success: true,
      data: {
        totalViolations: allViolations.length,
        byType,
        config: {
          maxDepth: config.maxDepth,
          maxTasksPerMission: config.maxTasksPerMission,
          maxBranchingFactor: config.maxBranchingFactor,
          rateLimitMaxCreations: config.rateLimitMaxCreations,
          rateLimitWindowMs: config.rateLimitWindowMs,
          budgetGateEnabled: config.budgetGateEnabled,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/fission/violations
 *
 * Returns recent fission guard violations for auditing.
 * Supports optional `limit` and `type` query parameters.
 *
 * @param req - Express request with optional query params
 * @param res - Express response with violation array
 * @param next - Express next function for error forwarding
 */
export async function getFissionViolations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!fissionGuardService) {
      res.status(503).json({ success: false, error: 'Fission guard service not initialized' });
      return;
    }

    // Parse limit
    let limit = DEFAULT_VIOLATIONS_LIMIT;
    if (req.query.limit !== undefined) {
      const parsed = Number(req.query.limit);
      if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({
          success: false,
          error: 'Invalid limit parameter — must be a positive integer',
        });
        return;
      }
      limit = Math.min(parsed, MAX_VIOLATIONS_LIMIT);
    }

    // Parse optional type filter
    const typeFilter = req.query.type as string | undefined;
    if (typeFilter !== undefined) {
      if (!FISSION_VIOLATION_TYPES.includes(typeFilter as FissionViolationType)) {
        res.status(400).json({
          success: false,
          error: `Invalid type filter — must be one of: ${FISSION_VIOLATION_TYPES.join(', ')}`,
        });
        return;
      }
      const filtered = fissionGuardService.getViolationsByType(typeFilter as FissionViolationType);
      res.json({ success: true, data: filtered.slice(0, limit) });
      return;
    }

    const violations = fissionGuardService.getViolations(limit);
    res.json({ success: true, data: violations });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/fission/check
 *
 * Pre-check whether a sub-task creation would be allowed.
 * Used by bash skills and external callers before attempting creation.
 *
 * Body: { parentWorkItemId: string, agentId: string, missionId?: string }
 *
 * @param req - Express request with check parameters
 * @param res - Express response with GuardResult
 * @param next - Express next function for error forwarding
 */
export async function checkFission(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!fissionGuardService) {
      res.status(503).json({ success: false, error: 'Fission guard service not initialized' });
      return;
    }

    const { parentWorkItemId, agentId, missionId } = req.body;

    if (!parentWorkItemId || typeof parentWorkItemId !== 'string') {
      res.status(400).json({ success: false, error: 'parentWorkItemId is required (string)' });
      return;
    }
    if (!agentId || typeof agentId !== 'string') {
      res.status(400).json({ success: false, error: 'agentId is required (string)' });
      return;
    }

    // We need the actual WorkItem — the service's data provider resolves it.
    // For the API check, we construct a minimal stub since the full WorkItem
    // resolution happens inside canCreateSubTask via the data provider.
    // The controller passes a stub parent; the service walks the chain from parentWorkItemId.
    const stubParent = {
      id: parentWorkItemId,
      parentWorkItemId: undefined as string | undefined,
      type: 'delegate' as const,
      owner: 'agent' as const,
      title: 'API check stub',
      status: 'running' as const,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    const result = await fissionGuardService.canCreateSubTask(
      stubParent,
      agentId,
      missionId,
    );

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
