/**
 * Approvals Controller
 *
 * HTTP request handlers for tool approval management endpoints.
 * Allows external callers to list pending approvals and approve/reject them.
 * Records audit trail entries for all approval resolutions.
 *
 * @module controllers/approvals/approvals.controller
 */

import type { Request, Response, NextFunction } from 'express';
import type { ApprovalQueueService, PendingApproval } from '../../services/agent/crewly-agent/approval-queue.service.js';

/** Module-level reference to the approval queue service */
let approvalQueue: ApprovalQueueService | null = null;

/** In-memory audit trail for approval resolutions */
const approvalAuditLog: ApprovalAuditEntry[] = [];

/** Maximum audit entries to retain */
const MAX_APPROVAL_AUDIT_ENTRIES = 500;

/**
 * Audit trail entry for an approval resolution (approve/reject).
 */
export interface ApprovalAuditEntry {
  /** ISO timestamp of the resolution */
  timestamp: string;
  /** Approval ID that was resolved */
  approvalId: string;
  /** Tool name from the approval */
  toolName: string;
  /** Agent session that requested the tool */
  sessionName: string;
  /** Resolution action: 'approved' or 'rejected' */
  action: 'approved' | 'rejected';
  /** Who performed the resolution */
  resolvedBy: string;
  /** Reason for rejection (if applicable) */
  reason?: string;
}

/**
 * Record an audit trail entry for an approval resolution.
 *
 * @param approval - The resolved approval
 * @param action - The resolution action
 * @param resolvedBy - Who resolved it
 * @param reason - Optional rejection reason
 */
function recordApprovalAudit(
  approval: PendingApproval,
  action: 'approved' | 'rejected',
  resolvedBy: string,
  reason?: string,
): void {
  const entry: ApprovalAuditEntry = {
    timestamp: new Date().toISOString(),
    approvalId: approval.id,
    toolName: approval.toolName,
    sessionName: approval.sessionName,
    action,
    resolvedBy,
    reason,
  };

  approvalAuditLog.push(entry);

  // Enforce max entries
  if (approvalAuditLog.length > MAX_APPROVAL_AUDIT_ENTRIES) {
    approvalAuditLog.splice(0, approvalAuditLog.length - MAX_APPROVAL_AUDIT_ENTRIES);
  }
}

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
 * Get the approval audit log (for testing and API access).
 *
 * @param limit - Maximum entries to return (default: 50)
 * @returns Most recent audit entries
 */
export function getApprovalAuditLog(limit: number = 50): ApprovalAuditEntry[] {
  return approvalAuditLog.slice(-limit);
}

/**
 * Clear the approval audit log (for testing only).
 */
export function clearApprovalAuditLog(): void {
  approvalAuditLog.length = 0;
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
 * Records an audit trail entry upon successful approval.
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

    // Record audit trail
    if (result.approval) {
      recordApprovalAudit(result.approval, 'approved', resolvedBy);
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
 * Records an audit trail entry upon successful rejection.
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

    // Record audit trail
    if (result.approval) {
      recordApprovalAudit(result.approval, 'rejected', resolvedBy, reason);
    }

    res.json({ success: true, data: result.approval });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/approvals/audit
 *
 * Retrieve the approval audit trail.
 * Optional ?limit query parameter (default: 50).
 *
 * @param req - Express request with optional ?limit query param
 * @param res - Express response with audit log entries
 * @param next - Express next function
 */
export async function getAuditTrail(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const entries = getApprovalAuditLog(limit);
    res.json({ success: true, data: entries });
  } catch (error) {
    next(error);
  }
}
