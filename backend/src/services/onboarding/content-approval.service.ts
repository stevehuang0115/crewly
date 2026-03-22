/**
 * Content Approval Service for Marketing Team templates.
 *
 * Manages the approval workflow where marketing agents submit content
 * for human review. Content can be approved/rejected via:
 *   - Slack text replies ("approve" / "reject")
 *   - REST API endpoints
 *
 * This service is designed for the marketing team use case and is
 * separate from the F27 ToolApprovalQueue (which handles tool execution).
 *
 * @module content-approval-service
 */

import { randomUUID } from 'crypto';
import {
  ApprovalResolution,
  ContentApprovalRequest,
  ContentApprovalStatus,
  CONTENT_APPROVAL_TTL_MS,
  MAX_PENDING_APPROVALS,
  SubmitForApprovalOptions,
} from './content-approval.types.js';

// =============================================================================
// Service
// =============================================================================

/**
 * Service managing content approval requests for marketing teams.
 *
 * Follows singleton pattern. Stores approvals in memory with optional
 * Slack message tracking for interactive approval via text replies.
 */
export class ContentApprovalService {
  private static instance: ContentApprovalService | null = null;
  private approvals: Map<string, ContentApprovalRequest> = new Map();

  /**
   * Get or create the singleton instance.
   *
   * @returns Singleton instance
   */
  static getInstance(): ContentApprovalService {
    if (!ContentApprovalService.instance) {
      ContentApprovalService.instance = new ContentApprovalService();
    }
    return ContentApprovalService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    ContentApprovalService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  /**
   * Submit content for approval.
   *
   * @param options - Content submission details
   * @returns Created approval request
   * @throws Error if team has too many pending approvals
   */
  submit(options: SubmitForApprovalOptions): ContentApprovalRequest {
    // Enforce max pending limit
    this.expireOldApprovals();
    const teamPending = this.getPendingByTeam(options.teamId);
    if (teamPending.length >= MAX_PENDING_APPROVALS) {
      throw new Error(
        `Team ${options.teamId} has ${teamPending.length} pending approvals (max: ${MAX_PENDING_APPROVALS}). Resolve some before submitting more.`
      );
    }

    const request: ContentApprovalRequest = {
      id: randomUUID(),
      teamId: options.teamId,
      submittedBy: options.submittedBy,
      platform: options.platform,
      contentType: options.contentType,
      content: options.content,
      hashtags: options.hashtags,
      visualDirection: options.visualDirection,
      scheduledTime: options.scheduledTime,
      status: 'pending',
      submittedAt: new Date().toISOString(),
    };

    this.approvals.set(request.id, request);
    return request;
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /**
   * Approve a content request.
   *
   * @param approvalId - ID of the approval request
   * @param resolvedBy - Who approved (user ID or identifier)
   * @param feedback - Optional feedback or notes
   * @returns Updated approval request or null if not found
   */
  approve(
    approvalId: string,
    resolvedBy: string,
    feedback?: string
  ): ContentApprovalRequest | null {
    return this.resolve({ approvalId, status: 'approved', resolvedBy, feedback });
  }

  /**
   * Reject a content request.
   *
   * @param approvalId - ID of the approval request
   * @param resolvedBy - Who rejected
   * @param feedback - Reason for rejection or edit instructions
   * @returns Updated approval request or null if not found
   */
  reject(
    approvalId: string,
    resolvedBy: string,
    feedback?: string
  ): ContentApprovalRequest | null {
    return this.resolve({ approvalId, status: 'rejected', resolvedBy, feedback });
  }

  /**
   * Resolve an approval request (approve or reject).
   *
   * @param resolution - Resolution details
   * @returns Updated request or null
   */
  resolve(resolution: ApprovalResolution): ContentApprovalRequest | null {
    const request = this.approvals.get(resolution.approvalId);
    if (!request) return null;
    if (request.status !== 'pending') return request; // Already resolved

    request.status = resolution.status;
    request.resolvedAt = new Date().toISOString();
    request.resolvedBy = resolution.resolvedBy;
    request.feedback = resolution.feedback;

    this.approvals.set(request.id, request);
    return request;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Get a specific approval request.
   *
   * @param approvalId - Approval ID
   * @returns The request or null
   */
  get(approvalId: string): ContentApprovalRequest | null {
    return this.approvals.get(approvalId) ?? null;
  }

  /**
   * Get all pending approvals for a team.
   *
   * @param teamId - Team ID
   * @returns Array of pending approval requests
   */
  getPendingByTeam(teamId: string): ContentApprovalRequest[] {
    this.expireOldApprovals();
    return Array.from(this.approvals.values()).filter(
      r => r.teamId === teamId && r.status === 'pending'
    );
  }

  /**
   * Get all approvals for a team (all statuses).
   *
   * @param teamId - Team ID
   * @returns Array of all approval requests
   */
  getAllByTeam(teamId: string): ContentApprovalRequest[] {
    return Array.from(this.approvals.values()).filter(
      r => r.teamId === teamId
    );
  }

  /**
   * Get approval by Slack message timestamp (for Slack reply-based approval).
   *
   * @param channelId - Slack channel ID
   * @param messageTs - Slack message timestamp
   * @returns Matching approval request or null
   */
  getBySlackMessage(channelId: string, messageTs: string): ContentApprovalRequest | null {
    for (const request of this.approvals.values()) {
      if (request.slackChannelId === channelId && request.slackMessageTs === messageTs) {
        return request;
      }
    }
    return null;
  }

  /**
   * Link a Slack message to an approval request (for tracking replies).
   *
   * @param approvalId - Approval ID
   * @param channelId - Slack channel where the approval message was posted
   * @param messageTs - Slack message timestamp
   * @returns Updated request or null
   */
  linkSlackMessage(
    approvalId: string,
    channelId: string,
    messageTs: string
  ): ContentApprovalRequest | null {
    const request = this.approvals.get(approvalId);
    if (!request) return null;

    request.slackChannelId = channelId;
    request.slackMessageTs = messageTs;
    this.approvals.set(request.id, request);
    return request;
  }

  /**
   * Get counts by status for a team.
   *
   * @param teamId - Team ID
   * @returns Object with status counts
   */
  getStats(teamId: string): Record<ContentApprovalStatus, number> {
    const all = this.getAllByTeam(teamId);
    const stats: Record<ContentApprovalStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
    };

    for (const r of all) {
      stats[r.status] = (stats[r.status] || 0) + 1;
    }
    return stats;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  /**
   * Format an approval request as a Slack message (plain text for MVP).
   *
   * @param request - The approval request to format
   * @returns Formatted message string ready for Slack
   */
  formatForSlack(request: ContentApprovalRequest): string {
    const lines = [
      `*Content Approval Request* (ID: \`${request.id.slice(0, 8)}\`)`,
      '',
      `*Platform:* ${request.platform}`,
      `*Type:* ${request.contentType}`,
      `*Submitted by:* ${request.submittedBy}`,
      '',
      '---',
      request.content,
      '---',
    ];

    if (request.hashtags?.length) {
      lines.push(`*Hashtags:* ${request.hashtags.join(' ')}`);
    }
    if (request.visualDirection) {
      lines.push(`*Visual Direction:* ${request.visualDirection}`);
    }
    if (request.scheduledTime) {
      lines.push(`*Scheduled:* ${request.scheduledTime}`);
    }

    lines.push('');
    lines.push('Reply with *approve* or *reject [reason]* to this message.');

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Expire old pending approvals past the TTL.
   */
  private expireOldApprovals(): void {
    const now = Date.now();
    for (const [id, request] of this.approvals.entries()) {
      if (
        request.status === 'pending' &&
        now - new Date(request.submittedAt).getTime() > CONTENT_APPROVAL_TTL_MS
      ) {
        request.status = 'expired';
        request.resolvedAt = new Date().toISOString();
        this.approvals.set(id, request);
      }
    }
  }
}
