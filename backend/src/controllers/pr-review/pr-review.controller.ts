/**
 * PR Review Controller
 *
 * HTTP request handlers for GitHub PR webhook events and review status.
 * Receives webhook payloads, verifies signatures, and triggers automated
 * code reviews that post findings back as PR comments.
 *
 * @module controllers/pr-review/pr-review.controller
 */

import type { Request, Response, NextFunction } from 'express';
import {
  verifyWebhookSignature,
  executePrReview,
  getReviewStatus,
  PR_REVIEW_ACTIONS,
  type PullRequestPayload,
} from '../../services/pr-review/pr-review.service.js';
import { isValidRepo, isValidPrNumber } from '../../services/pr-review/pr-review.validation.js';

/** Environment variable name for the GitHub webhook secret */
const WEBHOOK_SECRET_ENV = 'GITHUB_WEBHOOK_SECRET';

/**
 * POST /api/pr-review/webhook
 *
 * Receive GitHub PR webhook events. Verifies the signature, checks the
 * event type and action, then triggers an asynchronous review.
 * Returns 200 immediately to acknowledge receipt — the review runs
 * in the background.
 *
 * Required headers:
 * - X-GitHub-Event: must be "pull_request"
 * - X-Hub-Signature-256: HMAC signature of the body
 *
 * Refused with 503 when GITHUB_WEBHOOK_SECRET is not set.
 *
 * @param req - Express request with webhook payload
 * @param res - Express response (200 on accept, 400/401/202 on reject)
 * @param next - Express next function for error propagation
 */
export async function handleWebhook(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const event = req.headers['x-github-event'] as string | undefined;

    // Only handle pull_request events
    if (event !== 'pull_request') {
      res.status(202).json({ success: true, message: 'Event ignored', event });
      return;
    }

    // Verify webhook signature
    // No secret means anyone could post a payload: refuse (CREW-967).
    const secret = process.env[WEBHOOK_SECRET_ENV];
    if (!secret) {
      res.status(503).json({ success: false, error: `Webhook is disabled: ${WEBHOOK_SECRET_ENV} is not set` });
      return;
    }
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    // GitHub signs the exact bytes it sent. Re-serialising the parsed body
    // gives different bytes (spacing, key order, escapes), so verify over the
    // raw text the app-wide JSON parser captured. Without it we cannot verify,
    // so refuse rather than fall back to the re-serialised body (CREW-972).
    const rawBody = (req as Request & { rawBody?: string }).rawBody;
    if (!signature || typeof rawBody !== 'string' || !verifyWebhookSignature(rawBody, signature, secret)) {
      res.status(401).json({ success: false, error: 'Invalid webhook signature' });
      return;
    }

    const payload = req.body as PullRequestPayload;

    // Validate required fields
    if (!payload.action || !payload.pull_request || !payload.repository) {
      res.status(400).json({ success: false, error: 'Invalid webhook payload' });
      return;
    }

    if (!isValidRepo(payload.repository.full_name) || !isValidPrNumber(payload.pull_request.number)) {
      res.status(400).json({ success: false, error: 'Invalid repository or pull request number' });
      return;
    }

    // Only review on supported actions
    if (!PR_REVIEW_ACTIONS.includes(payload.action as typeof PR_REVIEW_ACTIONS[number])) {
      res.status(202).json({
        success: true,
        message: 'Action ignored',
        action: payload.action,
      });
      return;
    }

    // Acknowledge receipt immediately, then review async
    res.status(200).json({
      success: true,
      message: 'Review triggered',
      prNumber: payload.pull_request.number,
      repository: payload.repository.full_name,
    });

    // Fire-and-forget: run review in background
    executePrReview(payload).catch((error) => {
      // Log but don't crash — webhook already acknowledged
      console.error(
        `[pr-review] Review failed for PR #${payload.pull_request.number}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/pr-review/review
 *
 * Manually trigger a PR review by providing the repository and PR number.
 * Useful for re-reviewing PRs or testing the review pipeline.
 *
 * @param req - Express request with { repo: string, prNumber: number }
 * @param res - Express response with review result
 * @param next - Express next function for error propagation
 */
export async function triggerManualReview(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { repo, prNumber } = req.body as { repo?: string; prNumber?: number };

    if (!repo || !prNumber) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: repo (string), prNumber (number)',
      });
      return;
    }
    if (!isValidRepo(repo) || !isValidPrNumber(prNumber)) {
      res.status(400).json({
        success: false,
        error: 'Invalid repo (owner/repo) or prNumber (positive integer)',
      });
      return;
    }

    // Build a minimal payload for the review service
    const payload: PullRequestPayload = {
      action: 'opened',
      pull_request: {
        number: prNumber,
        title: '',
        user: { login: 'manual' },
        head: { sha: '', ref: '' },
        base: { sha: '', ref: '' },
        diff_url: '',
        html_url: `https://github.com/${repo}/pull/${prNumber}`,
      },
      repository: { full_name: repo },
    };

    const result = await executePrReview(payload);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/pr-review/status
 *
 * Get the current PR review service status and statistics.
 *
 * @param _req - Express request (unused)
 * @param res - Express response with status data
 * @param next - Express next function for error propagation
 */
export async function getPrReviewStatus(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const status = getReviewStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
}
