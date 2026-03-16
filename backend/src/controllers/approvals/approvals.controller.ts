/**
 * Approvals Controller
 *
 * HTTP request handlers for tool approval management endpoints.
 * Allows external callers to list pending approvals and approve/reject them.
 *
 * @module controllers/approvals/approvals.controller
 */

import type { Request, Response, NextFunction } from 'express';
import type { ApprovalQueueService } from '../../services/agent/crewly-agent/approval-queue.service.js';

/** Module-level reference to the approval queue service */
let approvalQueue: ApprovalQueueService | null = null;

/**
 * Set the ApprovalQueueService instance.
 * Called during server initialization.
 *
 * @param service - The ApprovalQueueService instance
 */
export function setApprovalQueueService(service: ApprovalQueueService): void {
  approvalQueue = service;
}

/**
 * Get the current ApprovalQueueService instance (for testing).
 *
 * @returns The current service or null
 */
export function getApprovalQueueService(): ApprovalQueueService | null {
  return approvalQueue;
}

/**
 * GET /api/approvals/pending
 *
 * List all pending tool approval requests.
 * Optionally filter by sessionName query parameter.
 *
 * @param req - Express request with optional ?sessionName query param
 * @param res - Express response with pending approvals array
 * @param next - Express next function
 */
export async function getPendingApprovals(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!approvalQueue) {
      res.status(503).json({ success: false, error: 'Approval queue not initialized' });
      return;
    }

    const sessionName = req.query.sessionName as string | undefined;
    const pending = approvalQueue.getPending(sessionName);
    res.json({ success: true, data: pending });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/approvals/:id/approve
 *
 * Approve a pending tool execution request.
 *
 * @param req - Express request with approval ID in params
 * @param res - Express response with resolution result
 * @param next - Express next function
 */
export async function approveRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!approvalQueue) {
      res.status(503).json({ success: false, error: 'Approval queue not initialized' });
      return;
    }

    const { id } = req.params;
    const resolvedBy = (req.body?.resolvedBy as string) || 'api';
    const result = approvalQueue.approve(id, resolvedBy);

    if (!result.success) {
      res.status(404).json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true, data: result.approval });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/approvals/:id/reject
 *
 * Reject a pending tool execution request.
 *
 * @param req - Express request with approval ID in params and optional reason in body
 * @param res - Express response with resolution result
 * @param next - Express next function
 */
export async function rejectRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!approvalQueue) {
      res.status(503).json({ success: false, error: 'Approval queue not initialized' });
      return;
    }

    const { id } = req.params;
    const resolvedBy = (req.body?.resolvedBy as string) || 'api';
    const reason = req.body?.reason as string | undefined;
    const result = approvalQueue.reject(id, resolvedBy, reason);

    if (!result.success) {
      res.status(404).json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true, data: result.approval });
  } catch (error) {
    next(error);
  }
}
