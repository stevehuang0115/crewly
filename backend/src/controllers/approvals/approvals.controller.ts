/**
 * Approvals Controller
 *
 * HTTP request handlers for tool approval management endpoints.
 * Allows external callers to list pending approvals and approve/reject them.
 *
 * @module controllers/approvals/approvals.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { ApprovalQueueService } from '../../services/agent/crewly-agent/approval-queue.service.js';
import { isOwnerDashboardRequest, readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { hasValidApiToken } from '../../middleware/api-token.middleware.js';

/** 403 body for a non-owner approve/reject (#817 review). */
export const OWNER_ONLY_APPROVAL_ERROR = 'only the owner can decide approvals';

/**
 * Whether the caller may decide an approval (approve or reject).
 *
 * Approving lets a gated tool run, so an agent must never approve its own
 * pending call. Allowed only with NO `X-Agent-Session` and either:
 * - the dashboard marker (`X-Crewly-Caller: dashboard`, {@link isOwnerDashboardRequest},
 *   the same rule #813 uses), or
 * - the owner's API token. This is what crewly-mobile's relay path presents
 *   (`mobile-api-relay.service`), and agents cannot read it.
 *
 * Limitation: the session header and the dashboard marker are asserted by
 * the caller, the same as in #813. Per-session tokens will close that.
 *
 * @param req - Incoming request (headers only)
 * @returns True for the owner, false for an agent or an unidentified caller
 */
export function isApprovalOwner(req: Request): boolean {
  if (readAgentSessionHeader(req)) return false;
  return isOwnerDashboardRequest(req) || hasValidApiToken(req, false);
}

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
 * The queue the handlers use: the one set at startup, else the shared
 * singleton that agent runners enqueue into.
 *
 * #817: nothing in the server ever called {@link setApprovalQueueService}, so
 * every handler answered 503 "Approval queue not initialized" on a real
 * install. The queue is a process-wide singleton by design
 * ({@link ApprovalQueueService.getInstance}), so the handlers fall back to it
 * instead of depending on a startup call.
 *
 * @returns The approval queue
 */
function resolveQueue(): ApprovalQueueService {
  return approvalQueue ?? ApprovalQueueService.getInstance();
}

/**
 * GET /api/approvals/pending, and GET /api/approvals (alias, #817)
 *
 * List all pending tool approval requests. crewly-mobile polls the bare
 * `/approvals` path; the alias keeps installed app builds working.
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
    const sessionName = req.query.sessionName as string | undefined;
    const pending = resolveQueue().getPending(sessionName);
    res.json({ success: true, data: pending });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/approvals/:id/approve
 *
 * Approve a pending tool execution request. Owner only
 * ({@link isApprovalOwner}); anyone else gets 403.
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
    if (!isApprovalOwner(req)) {
      res.status(403).json({ success: false, error: OWNER_ONLY_APPROVAL_ERROR });
      return;
    }

    const { id } = req.params;
    const resolvedBy = (req.body?.resolvedBy as string) || 'api';
    const result = resolveQueue().approve(id, resolvedBy);

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
 * Reject a pending tool execution request. Owner only
 * ({@link isApprovalOwner}); anyone else gets 403.
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
    if (!isApprovalOwner(req)) {
      res.status(403).json({ success: false, error: OWNER_ONLY_APPROVAL_ERROR });
      return;
    }

    const { id } = req.params;
    const resolvedBy = (req.body?.resolvedBy as string) || 'api';
    const reason = req.body?.reason as string | undefined;
    const result = resolveQueue().reject(id, resolvedBy, reason);

    if (!result.success) {
      res.status(404).json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true, data: result.approval });
  } catch (error) {
    next(error);
  }
}
