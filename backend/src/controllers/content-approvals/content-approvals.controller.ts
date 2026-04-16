/**
 * Content Approvals Controller
 *
 * HTTP request handlers for marketing content approval endpoints.
 * Separates from the tool-execution approval queue — this handles
 * human review of agent-drafted content (posts, articles, etc.).
 *
 * @module controllers/content-approvals/content-approvals.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { ContentApprovalService } from '../../services/onboarding/content-approval.service.js';
import { getSlackOrchestratorBridge } from '../../services/slack/slack-orchestrator-bridge.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('ContentApprovalsController');

/**
 * POST /api/content-approvals
 *
 * Submit content for human approval. Returns the created approval request
 * with an ID that can be used to approve/reject via REST or Slack buttons.
 *
 * @param req - Express request with submission body
 * @param res - Express response with created approval
 * @param next - Express next function
 */
export async function submitContentApproval(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { teamId, submittedBy, platform, contentType, content, hashtags, visualDirection, scheduledTime } = req.body;

    if (!teamId || !submittedBy || !platform || !contentType || !content) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: teamId, submittedBy, platform, contentType, content',
      });
      return;
    }

    const service = ContentApprovalService.getInstance();
    const approval = service.submit({
      teamId,
      submittedBy,
      platform,
      contentType,
      content,
      hashtags,
      visualDirection,
      scheduledTime,
    });

    // Auto-post to Slack with Block Kit approve/reject buttons (fire-and-forget)
    const slackChannelId = req.body.slackChannelId as string | undefined;
    const slackThreadTs = req.body.slackThreadTs as string | undefined;
    try {
      const bridge = getSlackOrchestratorBridge();
      const messageTs = await bridge.sendContentApproval(approval.id, slackChannelId, slackThreadTs);
      if (messageTs) {
        logger.info('Content approval posted to Slack', { approvalId: approval.id.slice(0, 8), messageTs });
      }
    } catch (err) {
      // Slack posting is best-effort — don't fail the API call
      logger.warn('Failed to post content approval to Slack', {
        approvalId: approval.id.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Re-fetch to include any Slack link updates
    const updated = service.get(approval.id) || approval;
    res.status(201).json({ success: true, data: updated });
  } catch (error) {
    if (error instanceof Error && error.message.includes('pending approvals')) {
      res.status(429).json({ success: false, error: error.message });
      return;
    }
    next(error);
  }
}

/**
 * GET /api/content-approvals/pending
 *
 * List pending content approvals, optionally filtered by teamId.
 *
 * @param req - Express request with optional ?teamId query param
 * @param res - Express response with pending approvals
 * @param next - Express next function
 */
export async function getPendingContentApprovals(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const teamId = req.query.teamId as string | undefined;
    const service = ContentApprovalService.getInstance();

    if (teamId) {
      const pending = service.getPendingByTeam(teamId);
      res.json({ success: true, data: pending });
    } else {
      // Return all pending (no team filter) — iterate all
      const all = (service as any).approvals as Map<string, any>;
      const pending = Array.from(all.values()).filter((r: any) => r.status === 'pending');
      res.json({ success: true, data: pending });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/content-approvals/:id
 *
 * Get a specific content approval by ID.
 *
 * @param req - Express request with approval ID in params
 * @param res - Express response with approval data
 * @param next - Express next function
 */
export async function getContentApproval(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const service = ContentApprovalService.getInstance();
    const approval = service.get(id);

    if (!approval) {
      res.status(404).json({ success: false, error: 'Approval not found' });
      return;
    }

    res.json({ success: true, data: approval });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/content-approvals/:id/approve
 *
 * Approve a pending content item.
 *
 * @param req - Express request with approval ID and optional feedback
 * @param res - Express response with updated approval
 * @param next - Express next function
 */
export async function approveContentApproval(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const resolvedBy = (req.body?.resolvedBy as string) || 'api';
    const feedback = req.body?.feedback as string | undefined;

    const service = ContentApprovalService.getInstance();
    const result = service.approve(id, resolvedBy, feedback);

    if (!result) {
      res.status(404).json({ success: false, error: 'Approval not found' });
      return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/content-approvals/:id/reject
 *
 * Reject a pending content item with optional feedback.
 *
 * @param req - Express request with approval ID and optional feedback
 * @param res - Express response with updated approval
 * @param next - Express next function
 */
export async function rejectContentApproval(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const resolvedBy = (req.body?.resolvedBy as string) || 'api';
    const feedback = req.body?.feedback as string | undefined;

    const service = ContentApprovalService.getInstance();
    const result = service.reject(id, resolvedBy, feedback);

    if (!result) {
      res.status(404).json({ success: false, error: 'Approval not found' });
      return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/content-approvals/stats
 *
 * Get approval statistics for a team.
 *
 * @param req - Express request with required ?teamId query param
 * @param res - Express response with stats
 * @param next - Express next function
 */
export async function getContentApprovalStats(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const teamId = req.query.teamId as string;
    if (!teamId) {
      res.status(400).json({ success: false, error: 'teamId query param is required' });
      return;
    }

    const service = ContentApprovalService.getInstance();
    const stats = service.getStats(teamId);
    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
}
