/**
 * Reconciler Controller
 *
 * HTTP request handlers for Reconciler status, history, and manual trigger.
 * Provides monitoring and debugging endpoints for the Reconciler service.
 *
 * @module controllers/reconciler/reconciler.controller
 */

import type { Request, Response, NextFunction } from 'express';
import type { ReconcilerService } from '../../services/reconciler/reconciler.service.js';

/** Maximum number of history entries a client can request in one call */
const MAX_HISTORY_LIMIT = 100;

/** Default number of history entries returned when limit is not specified */
const DEFAULT_HISTORY_LIMIT = 20;

/** Module-level reference to the reconciler service */
let reconcilerService: ReconcilerService | null = null;

/**
 * Set the ReconcilerService instance.
 * Called during server initialization.
 *
 * @param service - The ReconcilerService instance
 */
export function setReconcilerService(service: ReconcilerService): void {
  reconcilerService = service;
}

/**
 * GET /api/reconciler/status
 *
 * Returns the current Reconciler status including last result,
 * next scheduled execution times, total passes, and configuration.
 *
 * @param _req - Express request (unused)
 * @param res - Express response with ReconcilerStatus
 * @param next - Express next function for error forwarding
 */
export async function getReconcilerStatus(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!reconcilerService) {
      res.status(503).json({ success: false, error: 'Reconciler service not initialized' });
      return;
    }

    const status = reconcilerService.getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/reconciler/run
 *
 * Manually triggers a full reconciliation pass.
 * Returns the result of the reconciliation.
 *
 * @param _req - Express request (unused)
 * @param res - Express response with ReconcileResult
 * @param next - Express next function for error forwarding
 */
export async function runReconcile(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!reconcilerService) {
      res.status(503).json({ success: false, error: 'Reconciler service not initialized' });
      return;
    }

    const result = await reconcilerService.runFull();
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/reconciler/history
 *
 * Returns the most recent reconciliation results.
 * Supports optional `limit` query parameter (default: 20, max: 100).
 *
 * @param req - Express request with optional `limit` query param
 * @param res - Express response with array of ReconcileResult
 * @param next - Express next function for error forwarding
 */
export async function getReconcilerHistory(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!reconcilerService) {
      res.status(503).json({ success: false, error: 'Reconciler service not initialized' });
      return;
    }

    const rawLimit = req.query.limit;
    let limit = DEFAULT_HISTORY_LIMIT;

    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({
          success: false,
          error: 'Invalid limit parameter — must be a positive integer',
        });
        return;
      }
      limit = Math.min(parsed, MAX_HISTORY_LIMIT);
    }

    const history = reconcilerService.getHistory(limit);
    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
}
