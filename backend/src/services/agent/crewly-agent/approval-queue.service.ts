/**
 * Approval Queue Service
 *
 * Manages pending tool approval requests for the Crewly Agent runtime.
 * When a tool requires approval (based on SecurityPolicy.requireApproval),
 * execution is blocked and a PendingApproval entry is created. External
 * callers (API, auditor) can then approve or reject the request.
 *
 * @module services/agent/crewly-agent/approval-queue.service
 */

import type { ToolSensitivity } from './types.js';

/** Maximum number of pending approvals before oldest are auto-rejected */
const MAX_PENDING_APPROVALS = 100;

/** Default TTL for pending approvals in milliseconds (10 minutes) */
const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

/**
 * Status of an approval request.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * A single pending approval entry.
 */
export interface PendingApproval {
  /** Unique approval ID */
  id: string;
  /** Agent session that requested the tool call */
  sessionName: string;
  /** Name of the tool awaiting approval */
  toolName: string;
  /** Sensitivity classification of the tool */
  sensitivity: ToolSensitivity;
  /** Sanitized arguments passed to the tool */
  args: Record<string, unknown>;
  /** Current status */
  status: ApprovalStatus;
  /** ISO timestamp when the approval was requested */
  requestedAt: string;
  /** ISO timestamp when the approval was resolved (approved/rejected/expired) */
  resolvedAt?: string;
  /** Who resolved the approval (e.g. 'api', 'auditor', 'auto-expire') */
  resolvedBy?: string;
  /** Reason for rejection (if rejected) */
  reason?: string;
}

/**
 * Result of resolving (approve/reject) an approval request.
 */
export interface ApprovalResolution {
  /** Whether the resolution was successful */
  success: boolean;
  /** The resolved approval entry */
  approval?: PendingApproval;
  /** Error message if resolution failed */
  error?: string;
}

/**
 * In-memory approval queue for tool execution requests.
 *
 * Stores pending approvals and provides approve/reject operations.
 * Approvals that exceed the TTL are automatically marked as expired
 * when queried.
 *
 * @example
 * ```typescript
 * const queue = new ApprovalQueueService();
 * const approval = queue.enqueue('session-1', 'edit_file', 'destructive', { path: '/foo' });
 * // Later, approve it:
 * const result = queue.approve(approval.id, 'api');
 * ```
 */
export class ApprovalQueueService {
  private approvals: Map<string, PendingApproval> = new Map();
  private idCounter = 0;
  private ttlMs: number;

  /**
   * Create a new ApprovalQueueService.
   *
   * @param ttlMs - Time-to-live for pending approvals in milliseconds
   */
  constructor(ttlMs: number = DEFAULT_APPROVAL_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Add a new approval request to the queue.
   *
   * @param sessionName - Agent session requesting approval
   * @param toolName - Name of the tool
   * @param sensitivity - Sensitivity classification
   * @param args - Sanitized tool arguments
   * @returns The created PendingApproval entry
   */
  enqueue(
    sessionName: string,
    toolName: string,
    sensitivity: ToolSensitivity,
    args: Record<string, unknown>,
  ): PendingApproval {
    this.expireStale();

    // Enforce max pending limit — reject oldest if full
    if (this.getPendingCount() >= MAX_PENDING_APPROVALS) {
      const oldest = this.getOldestPending();
      if (oldest) {
        oldest.status = 'rejected';
        oldest.resolvedAt = new Date().toISOString();
        oldest.resolvedBy = 'auto-overflow';
        oldest.reason = 'Approval queue overflow — auto-rejected oldest entry';
      }
    }

    this.idCounter++;
    const id = `approval-${this.idCounter}-${Date.now()}`;

    const approval: PendingApproval = {
      id,
      sessionName,
      toolName,
      sensitivity,
      args,
      status: 'pending',
      requestedAt: new Date().toISOString(),
    };

    this.approvals.set(id, approval);
    return approval;
  }

  /**
   * Approve a pending approval request.
   *
   * @param id - Approval ID to approve
   * @param resolvedBy - Who is approving (e.g. 'api', 'auditor')
   * @returns Resolution result
   */
  approve(id: string, resolvedBy: string = 'api'): ApprovalResolution {
    return this.resolve(id, 'approved', resolvedBy);
  }

  /**
   * Reject a pending approval request.
   *
   * @param id - Approval ID to reject
   * @param resolvedBy - Who is rejecting
   * @param reason - Reason for rejection
   * @returns Resolution result
   */
  reject(id: string, resolvedBy: string = 'api', reason?: string): ApprovalResolution {
    return this.resolve(id, 'rejected', resolvedBy, reason);
  }

  /**
   * Get all pending approval requests.
   *
   * @param sessionName - Optional filter by session name
   * @returns Array of pending approvals
   */
  getPending(sessionName?: string): PendingApproval[] {
    this.expireStale();
    const pending: PendingApproval[] = [];
    for (const approval of this.approvals.values()) {
      if (approval.status !== 'pending') continue;
      if (sessionName && approval.sessionName !== sessionName) continue;
      pending.push({ ...approval });
    }
    return pending;
  }

  /**
   * Get a specific approval by ID.
   *
   * @param id - Approval ID
   * @returns The approval entry or undefined
   */
  getById(id: string): PendingApproval | undefined {
    const approval = this.approvals.get(id);
    if (!approval) return undefined;
    return { ...approval };
  }

  /**
   * Get the count of currently pending approvals.
   *
   * @returns Number of pending approvals
   */
  getPendingCount(): number {
    let count = 0;
    for (const approval of this.approvals.values()) {
      if (approval.status === 'pending') count++;
    }
    return count;
  }

  /**
   * Clear all approvals (for testing or reset).
   */
  clear(): void {
    this.approvals.clear();
    this.idCounter = 0;
  }

  /**
   * Resolve a pending approval with the given status.
   *
   * @param id - Approval ID
   * @param status - New status
   * @param resolvedBy - Who resolved it
   * @param reason - Optional reason (for rejections)
   * @returns Resolution result
   */
  private resolve(
    id: string,
    status: 'approved' | 'rejected',
    resolvedBy: string,
    reason?: string,
  ): ApprovalResolution {
    const approval = this.approvals.get(id);
    if (!approval) {
      return { success: false, error: `Approval '${id}' not found` };
    }
    if (approval.status !== 'pending') {
      return {
        success: false,
        error: `Approval '${id}' is already ${approval.status}`,
        approval: { ...approval },
      };
    }

    approval.status = status;
    approval.resolvedAt = new Date().toISOString();
    approval.resolvedBy = resolvedBy;
    if (reason) approval.reason = reason;

    return { success: true, approval: { ...approval } };
  }

  /**
   * Expire stale pending approvals that have exceeded the TTL.
   */
  private expireStale(): void {
    const now = Date.now();
    const resolvedRetentionMs = this.ttlMs * 3; // Keep resolved entries 3x TTL then prune

    for (const [id, approval] of this.approvals.entries()) {
      if (approval.status === 'pending') {
        const requestedAt = new Date(approval.requestedAt).getTime();
        if (now - requestedAt > this.ttlMs) {
          approval.status = 'expired';
          approval.resolvedAt = new Date().toISOString();
          approval.resolvedBy = 'auto-expire';
          approval.reason = 'Approval request expired';
        }
      } else if (approval.resolvedAt) {
        // Prune resolved entries that are older than retention window
        const resolvedAt = new Date(approval.resolvedAt).getTime();
        if (now - resolvedAt > resolvedRetentionMs) {
          this.approvals.delete(id);
        }
      }
    }
  }

  /**
   * Get the oldest pending approval.
   *
   * @returns Oldest pending approval or undefined
   */
  private getOldestPending(): PendingApproval | undefined {
    let oldest: PendingApproval | undefined;
    for (const approval of this.approvals.values()) {
      if (approval.status !== 'pending') continue;
      if (!oldest || approval.requestedAt < oldest.requestedAt) {
        oldest = approval;
      }
    }
    return oldest;
  }
}
