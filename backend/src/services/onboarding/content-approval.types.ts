/**
 * Type definitions for the Content Approval workflow.
 *
 * Used by marketing team agents to submit content for human review
 * via Slack. The approval flow is: draft → submitted → approved/rejected.
 *
 * @module content-approval-types
 */

// =============================================================================
// Approval Types
// =============================================================================

/** Approval status for a content item. */
export type ContentApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired';

/** A content item submitted for approval. */
export interface ContentApprovalRequest {
  /** Unique approval request ID */
  id: string;
  /** Team ID this approval belongs to */
  teamId: string;
  /** Agent session that submitted the content */
  submittedBy: string;
  /** Platform the content is for */
  platform: string;
  /** Content type (post, article, newsletter, etc.) */
  contentType: string;
  /** The actual content text */
  content: string;
  /** Suggested hashtags */
  hashtags?: string[];
  /** Suggested visual direction */
  visualDirection?: string;
  /** Suggested posting time */
  scheduledTime?: string;
  /** Current approval status */
  status: ContentApprovalStatus;
  /** Submission timestamp */
  submittedAt: string;
  /** Resolution timestamp */
  resolvedAt?: string;
  /** Who resolved (user ID or 'auto') */
  resolvedBy?: string;
  /** Rejection reason or edit notes */
  feedback?: string;
  /** Slack message timestamp for the approval message */
  slackMessageTs?: string;
  /** Slack channel ID where approval was posted */
  slackChannelId?: string;
}

/** Options for submitting content for approval. */
export interface SubmitForApprovalOptions {
  /** Team ID */
  teamId: string;
  /** Agent session name */
  submittedBy: string;
  /** Target platform */
  platform: string;
  /** Content type */
  contentType: string;
  /** Content text */
  content: string;
  /** Optional hashtags */
  hashtags?: string[];
  /** Optional visual direction */
  visualDirection?: string;
  /** Optional scheduled time */
  scheduledTime?: string;
}

/** Result of resolving an approval request. */
export interface ApprovalResolution {
  /** Approval ID that was resolved */
  approvalId: string;
  /** New status */
  status: 'approved' | 'rejected';
  /** Who resolved */
  resolvedBy: string;
  /** Optional feedback/notes */
  feedback?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** How long an approval request stays active before expiring (ms). */
export const CONTENT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Maximum pending approvals per team. */
export const MAX_PENDING_APPROVALS = 50;
