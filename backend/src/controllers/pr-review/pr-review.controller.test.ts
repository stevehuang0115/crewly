/**
 * PR Review Controller Tests
 *
 * Unit tests for the webhook handler, manual review trigger, and status endpoint.
 *
 * @module controllers/pr-review/pr-review.controller.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock the pr-review service
const mockExecutePrReview = jest.fn<any>();
const mockVerifyWebhookSignature = jest.fn<any>();
const mockGetReviewStatus = jest.fn<any>();

jest.mock('../../services/pr-review/pr-review.service.js', () => ({
  verifyWebhookSignature: (...args: unknown[]) => mockVerifyWebhookSignature(...args),
  executePrReview: (...args: unknown[]) => mockExecutePrReview(...args),
  getReviewStatus: (...args: unknown[]) => mockGetReviewStatus(...args),
  PR_REVIEW_ACTIONS: ['opened', 'synchronize', 'reopened'],
}));

import { handleWebhook, triggerManualReview, getPrReviewStatus } from './pr-review.controller';

describe('PR Review Controller', () => {
  let mockReq: Partial<Request>;
  let mockRes: { status: jest.Mock; json: jest.Mock };
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      headers: {},
      body: {},
    };
    mockRes = {
      status: jest.fn<any>().mockReturnThis(),
      json: jest.fn<any>(),
    };
    mockNext = jest.fn<any>();
  });

  describe('handleWebhook', () => {
    /**
     * Helper to build a valid PR webhook request.
     *
     * @param overrides - Partial overrides for the default payload
     * @returns A mock request configured as a PR webhook
     */
    function makePrWebhookReq(overrides: Record<string, unknown> = {}): Partial<Request> {
      return {
        headers: {
          'x-github-event': 'pull_request',
          ...(overrides.headers as Record<string, string> || {}),
        },
        body: {
          action: 'opened',
          pull_request: {
            number: 42,
            title: 'Test PR',
            user: { login: 'testuser' },
            head: { sha: 'abc123', ref: 'feature' },
            base: { sha: 'def456', ref: 'main' },
            diff_url: 'https://github.com/org/repo/pull/42.diff',
            html_url: 'https://github.com/org/repo/pull/42',
          },
          repository: { full_name: 'org/repo' },
          ...overrides.body as Record<string, unknown> || {},
        },
      };
    }

    it('should ignore non-pull_request events with 202', async () => {
      mockReq.headers = { 'x-github-event': 'push' };

      await handleWebhook(mockReq as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(202);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, message: 'Event ignored' }),
      );
      expect(mockExecutePrReview).not.toHaveBeenCalled();
    });

    it('should return 401 for invalid signature when secret is set', async () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(false);
      const req = makePrWebhookReq({
        headers: { 'x-hub-signature-256': 'sha256=bad' },
      });

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'Invalid webhook signature' }),
      );
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    it('should skip signature check when no secret is configured', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      mockExecutePrReview.mockResolvedValue({ verdict: 'approve' });
      const req = makePrWebhookReq();

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('should return 400 for missing payload fields', async () => {
      const req: Partial<Request> = {
        headers: { 'x-github-event': 'pull_request' },
        body: { action: 'opened' },
      };

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'Invalid webhook payload' }),
      );
    });

    it('should return 202 for unsupported PR actions', async () => {
      const req = makePrWebhookReq({
        body: { action: 'closed' },
      });

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(202);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, message: 'Action ignored' }),
      );
    });

    it('should return 200 and trigger review for opened PRs', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      mockExecutePrReview.mockResolvedValue({ verdict: 'approve' });
      const req = makePrWebhookReq();

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Review triggered',
          prNumber: 42,
          repository: 'org/repo',
        }),
      );
    });

    it('should trigger review for synchronize action', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      mockExecutePrReview.mockResolvedValue({ verdict: 'approve' });
      const req = makePrWebhookReq({
        body: { action: 'synchronize' },
      });

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('should trigger review for reopened action', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      mockExecutePrReview.mockResolvedValue({ verdict: 'approve' });
      const req = makePrWebhookReq({
        body: { action: 'reopened' },
      });

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('should call next on unexpected errors', async () => {
      const error = new Error('Unexpected');
      mockReq = {
        get headers(): any {
          throw error;
        },
        body: {},
      } as any;

      await handleWebhook(mockReq as Request, mockRes as any, mockNext as NextFunction);

      expect(mockNext).toHaveBeenCalledWith(error);
    });

    it('should not crash when executePrReview rejects (fire-and-forget)', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      mockExecutePrReview.mockRejectedValue(new Error('Review failed'));
      const req = makePrWebhookReq();

      // Should not throw
      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      // Give async fire-and-forget time to settle
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe('triggerManualReview', () => {
    it('should return 400 when repo is missing', async () => {
      mockReq.body = { prNumber: 1 };

      await triggerManualReview(mockReq as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('repo') }),
      );
    });

    it('should return 400 when prNumber is missing', async () => {
      mockReq.body = { repo: 'org/repo' };

      await triggerManualReview(mockReq as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should execute review and return result on success', async () => {
      const reviewResult = {
        prNumber: 5,
        repository: 'org/repo',
        verdict: 'approve',
        findings: [],
        summary: 'Clean',
        reviewedAt: '2026-03-15T00:00:00Z',
      };
      mockExecutePrReview.mockResolvedValue(reviewResult);
      mockReq.body = { repo: 'org/repo', prNumber: 5 };

      await triggerManualReview(mockReq as Request, mockRes as any, mockNext as NextFunction);

      expect(mockExecutePrReview).toHaveBeenCalledWith(
        expect.objectContaining({
          pull_request: expect.objectContaining({ number: 5 }),
          repository: { full_name: 'org/repo' },
        }),
      );
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: reviewResult });
    });

    it('should call next on error', async () => {
      const error = new Error('Review error');
      mockExecutePrReview.mockRejectedValue(error);
      mockReq.body = { repo: 'org/repo', prNumber: 5 };

      await triggerManualReview(mockReq as Request, mockRes as any, mockNext as NextFunction);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('getPrReviewStatus', () => {
    it('should return review status', async () => {
      const status = { isRunning: false, reviewCount: 3, lastReviewAt: '2026-03-15T00:00:00Z' };
      mockGetReviewStatus.mockReturnValue(status);

      await getPrReviewStatus(mockReq as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: status });
    });

    it('should call next on error', async () => {
      const error = new Error('Status failed');
      mockGetReviewStatus.mockImplementation(() => { throw error; });

      await getPrReviewStatus(mockReq as Request, mockRes as any, mockNext as NextFunction);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
