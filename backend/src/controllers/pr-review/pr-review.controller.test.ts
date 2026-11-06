/**
 * PR Review Controller Tests
 *
 * Unit tests for the webhook handler, manual review trigger, and status endpoint.
 *
 * @module controllers/pr-review/pr-review.controller.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import request from 'supertest';
import * as nodeCrypto from 'crypto';

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

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

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
      const req = {
        headers: {
          'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=test',
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
      // The app-wide JSON parser keeps the exact bytes GitHub sent as `rawBody`.
      return { ...req, rawBody: JSON.stringify(req.body) } as Partial<Request>;
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

    it('verifies the signature over the raw body, not over JSON.stringify(req.body) (CREW-972)', async () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(true);
      const req = makePrWebhookReq();
      // Bytes GitHub sent: pretty-printed, so they differ from a re-serialised body.
      const raw = JSON.stringify(req.body, null, 2);
      (req as { rawBody?: string }).rawBody = raw;
      expect(raw).not.toBe(JSON.stringify(req.body));

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockVerifyWebhookSignature).toHaveBeenCalledTimes(1);
      expect(mockVerifyWebhookSignature.mock.calls[0][0]).toBe(raw);
      expect(mockVerifyWebhookSignature.mock.calls[0][2]).toBe('test-secret');
    });

    it('refuses with 401 when the raw body was not captured, without falling back to the parsed body (CREW-972)', async () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(true);
      const req = makePrWebhookReq();
      delete (req as { rawBody?: string }).rawBody;

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
      expect(mockExecutePrReview).not.toHaveBeenCalled();
    });

    it('refuses the webhook with 503 when no secret is configured (CREW-967)', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const req = makePrWebhookReq();

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockExecutePrReview).not.toHaveBeenCalled();
      expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
    });

    it.each(['$(touch x)/r', 'o/r`id`', 'o/r;id', 'o/r"x', "o/r' x"])('refuses a webhook whose repository is %j (CREW-967)', async (full_name) => {
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(true);
      const req = makePrWebhookReq({ body: { repository: { full_name } } });

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockExecutePrReview).not.toHaveBeenCalled();
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    it('should return 400 for missing payload fields', async () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(true);
      const req: Partial<Request> = {
        headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=test' },
        body: { action: 'opened' },
        rawBody: JSON.stringify({ action: 'opened' }),
      } as Partial<Request>;

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'Invalid webhook payload' }),
      );
    });

    it('should return 202 for unsupported PR actions', async () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(true);
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
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(true);
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
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(true);
      mockExecutePrReview.mockResolvedValue({ verdict: 'approve' });
      const req = makePrWebhookReq({
        body: { action: 'synchronize' },
      });

      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('should trigger review for reopened action', async () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(true);
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
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerifyWebhookSignature.mockReturnValue(true);
      mockExecutePrReview.mockRejectedValue(new Error('Review failed'));
      const req = makePrWebhookReq();

      // Should not throw
      await handleWebhook(req as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      // Give async fire-and-forget time to settle
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe('webhook over real HTTP with the real HMAC (CREW-972)', () => {
    const SECRET = 'hook-secret';

    /** The app-wide JSON parser setup from index.ts: keeps the exact bytes as rawBody. */
    function makeApp() {
      const app = express();
      app.use(
        express.json({
          verify: (req, _res, buf) => {
            (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
          },
        }),
      );
      app.post('/hook', (req, res, next) => void handleWebhook(req, res, next));
      return app;
    }

    /** Sign exact bytes the way GitHub does. */
    const sign = (bytes: string) => `sha256=${nodeCrypto.createHmac('sha256', SECRET).update(bytes).digest('hex')}`;

    /** A pretty-printed body with a non-ASCII escape: JSON.stringify(parsed) is different bytes. */
    const RAW = `{
  "action": "opened",
  "pull_request": { "number": 7, "title": "caf\\u00e9" },
  "repository": { "full_name": "org/repo" }
}`;

    beforeEach(() => {
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      mockVerifyWebhookSignature.mockImplementation((...args: unknown[]) =>
        (jest.requireActual('../../services/pr-review/pr-review.service.js') as { verifyWebhookSignature: (...a: unknown[]) => boolean })
          .verifyWebhookSignature(...args),
      );
      mockExecutePrReview.mockResolvedValue(undefined);
    });

    it('accepts a body whose signature is over the exact bytes GitHub sent', async () => {
      expect(JSON.stringify(JSON.parse(RAW))).not.toBe(RAW);

      const res = await request(makeApp())
        .post('/hook')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sign(RAW))
        .send(RAW);

      expect(res.status).toBe(200);
      expect(mockExecutePrReview).toHaveBeenCalledTimes(1);
    });

    it('rejects a signature computed over the re-serialised body', async () => {
      const res = await request(makeApp())
        .post('/hook')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sign(JSON.stringify(JSON.parse(RAW))))
        .send(RAW);

      expect(res.status).toBe(401);
      expect(mockExecutePrReview).not.toHaveBeenCalled();
    });

    it('rejects the same JSON with different whitespace than what was signed', async () => {
      const res = await request(makeApp())
        .post('/hook')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sign(RAW))
        .send(RAW.replace('"action": "opened"', '"action":  "opened"'));

      expect(res.status).toBe(401);
      expect(mockExecutePrReview).not.toHaveBeenCalled();
    });

    it('rejects the same JSON with its keys in a different order than what was signed', async () => {
      const reordered = `{
  "repository": { "full_name": "org/repo" },
  "action": "opened",
  "pull_request": { "number": 7, "title": "caf\\u00e9" }
}`;
      expect(JSON.parse(reordered)).toEqual(JSON.parse(RAW));

      const res = await request(makeApp())
        .post('/hook')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sign(RAW))
        .send(reordered);

      expect(res.status).toBe(401);
      expect(mockExecutePrReview).not.toHaveBeenCalled();
    });

    it('rejects a request with no signature header', async () => {
      const res = await request(makeApp())
        .post('/hook')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .send(RAW);

      expect(res.status).toBe(401);
      expect(mockExecutePrReview).not.toHaveBeenCalled();
    });

    it.each(['sha256=deadbeef', 'sha256=', 'not-a-signature'])('rejects the malformed signature %j without throwing', async (bad) => {
      const res = await request(makeApp())
        .post('/hook')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', bad)
        .send(RAW);

      expect(res.status).toBe(401);
      expect(mockExecutePrReview).not.toHaveBeenCalled();
    });

    it('rejects a body changed after signing', async () => {
      const res = await request(makeApp())
        .post('/hook')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sign(RAW))
        .send(RAW.replace('"number": 7', '"number": 8'));

      expect(res.status).toBe(401);
      expect(mockExecutePrReview).not.toHaveBeenCalled();
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

    it.each([
      ['$(touch x)/r', 5],
      ['o/r`id`', 5],
      ['o/r;id', 5],
      ['org/repo', '5; touch x'],
      ['org/repo', '$(touch x)'],
      ['org/repo', -1],
      ['org/repo', 1.5],
    ])('refuses repo=%j prNumber=%j with 400 and runs nothing (CREW-967)', async (repo, prNumber) => {
      mockReq.body = { repo, prNumber };

      await triggerManualReview(mockReq as Request, mockRes as any, mockNext as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockExecutePrReview).not.toHaveBeenCalled();
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
