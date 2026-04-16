/**
 * Content Approvals Controller Tests
 *
 * @module controllers/content-approvals/content-approvals.controller.test
 */

import type { Request, Response, NextFunction } from 'express';
import {
  submitContentApproval,
  getPendingContentApprovals,
  getContentApproval,
  approveContentApproval,
  rejectContentApproval,
  getContentApprovalStats,
} from './content-approvals.controller.js';
import { ContentApprovalService } from '../../services/onboarding/content-approval.service.js';

// Mock the Slack bridge — sendContentApproval is best-effort, should not break the API
const mockSendContentApproval = jest.fn().mockResolvedValue('mock-ts-123');
jest.mock('../../services/slack/slack-orchestrator-bridge.js', () => ({
  getSlackOrchestratorBridge: () => ({
    sendContentApproval: mockSendContentApproval,
  }),
}));

// =============================================================================
// Helpers
// =============================================================================

function createMockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    body: {},
    params: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): { res: Response; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { json, status } as unknown as Response;
  return { res, json, status };
}

const next: NextFunction = jest.fn();

// =============================================================================
// Tests
// =============================================================================

describe('Content Approvals Controller', () => {
  beforeEach(() => {
    ContentApprovalService.resetInstance();
    (next as jest.Mock).mockClear();
    mockSendContentApproval.mockClear();
  });

  // ---------------------------------------------------------------------------
  // POST /api/content-approvals
  // ---------------------------------------------------------------------------
  describe('submitContentApproval', () => {
    it('creates an approval and returns 201', async () => {
      const req = createMockReq({
        body: {
          teamId: 'team-1',
          submittedBy: 'agent-luna',
          platform: 'twitter',
          contentType: 'post',
          content: 'Hello world! #crewly',
        },
      });
      const { res, status, json } = createMockRes();

      await submitContentApproval(req, res, next);

      expect(status).toHaveBeenCalledWith(201);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            id: expect.any(String),
            teamId: 'team-1',
            status: 'pending',
          }),
        }),
      );
    });

    it('returns 400 when required fields are missing', async () => {
      const req = createMockReq({ body: { teamId: 'team-1' } });
      const { res, status } = createMockRes();

      await submitContentApproval(req, res, next);

      expect(status).toHaveBeenCalledWith(400);
    });

    it('auto-posts to Slack with Block Kit buttons after creation', async () => {
      const req = createMockReq({
        body: {
          teamId: 'team-1',
          submittedBy: 'agent-luna',
          platform: 'twitter',
          contentType: 'post',
          content: 'Auto-post test #crewly',
        },
      });
      const { res, status } = createMockRes();

      await submitContentApproval(req, res, next);

      expect(status).toHaveBeenCalledWith(201);
      expect(mockSendContentApproval).toHaveBeenCalledTimes(1);
      expect(mockSendContentApproval).toHaveBeenCalledWith(
        expect.any(String), // approvalId
        undefined,          // no explicit slackChannelId
        undefined,          // no explicit slackThreadTs
      );
    });

    it('forwards optional slackChannelId and slackThreadTs', async () => {
      const req = createMockReq({
        body: {
          teamId: 'team-1',
          submittedBy: 'agent-luna',
          platform: 'instagram',
          contentType: 'post',
          content: 'Channel routing test',
          slackChannelId: 'C12345',
          slackThreadTs: '1234567890.123',
        },
      });
      const { res, status } = createMockRes();

      await submitContentApproval(req, res, next);

      expect(status).toHaveBeenCalledWith(201);
      expect(mockSendContentApproval).toHaveBeenCalledWith(
        expect.any(String),
        'C12345',
        '1234567890.123',
      );
    });

    it('still returns 201 when Slack posting fails', async () => {
      mockSendContentApproval.mockRejectedValueOnce(new Error('Slack down'));

      const req = createMockReq({
        body: {
          teamId: 'team-1',
          submittedBy: 'agent-luna',
          platform: 'twitter',
          contentType: 'post',
          content: 'Slack failure test',
        },
      });
      const { res, status, json } = createMockRes();

      await submitContentApproval(req, res, next);

      // API should still succeed even if Slack fails
      expect(status).toHaveBeenCalledWith(201);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/content-approvals/pending
  // ---------------------------------------------------------------------------
  describe('getPendingContentApprovals', () => {
    it('returns pending approvals filtered by teamId', async () => {
      const service = ContentApprovalService.getInstance();
      service.submit({
        teamId: 'team-1',
        submittedBy: 'agent',
        platform: 'twitter',
        contentType: 'post',
        content: 'Test',
      });

      const req = createMockReq({ query: { teamId: 'team-1' } });
      const { res, json } = createMockRes();

      await getPendingContentApprovals(req, res, next);

      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-1', status: 'pending' }),
          ]),
        }),
      );
    });

    it('returns all pending when no teamId provided', async () => {
      const service = ContentApprovalService.getInstance();
      service.submit({
        teamId: 'team-1',
        submittedBy: 'agent',
        platform: 'twitter',
        contentType: 'post',
        content: 'Test',
      });

      const req = createMockReq({ query: {} });
      const { res, json } = createMockRes();

      await getPendingContentApprovals(req, res, next);

      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: expect.any(Array) }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/content-approvals/:id
  // ---------------------------------------------------------------------------
  describe('getContentApproval', () => {
    it('returns a specific approval', async () => {
      const service = ContentApprovalService.getInstance();
      const approval = service.submit({
        teamId: 'team-1',
        submittedBy: 'agent',
        platform: 'twitter',
        contentType: 'post',
        content: 'Test',
      });

      const req = createMockReq({ params: { id: approval.id } });
      const { res, json } = createMockRes();

      await getContentApproval(req, res, next);

      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ id: approval.id }),
        }),
      );
    });

    it('returns 404 for non-existent ID', async () => {
      const req = createMockReq({ params: { id: 'non-existent' } });
      const { res, status } = createMockRes();

      await getContentApproval(req, res, next);

      expect(status).toHaveBeenCalledWith(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/content-approvals/:id/approve
  // ---------------------------------------------------------------------------
  describe('approveContentApproval', () => {
    it('approves a pending approval', async () => {
      const service = ContentApprovalService.getInstance();
      const approval = service.submit({
        teamId: 'team-1',
        submittedBy: 'agent',
        platform: 'twitter',
        contentType: 'post',
        content: 'Test',
      });

      const req = createMockReq({
        params: { id: approval.id },
        body: { resolvedBy: 'steve', feedback: 'Looks good!' },
      });
      const { res, json } = createMockRes();

      await approveContentApproval(req, res, next);

      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            id: approval.id,
            status: 'approved',
            resolvedBy: 'steve',
          }),
        }),
      );
    });

    it('returns 404 for non-existent approval', async () => {
      const req = createMockReq({ params: { id: 'bad-id' } });
      const { res, status } = createMockRes();

      await approveContentApproval(req, res, next);

      expect(status).toHaveBeenCalledWith(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/content-approvals/:id/reject
  // ---------------------------------------------------------------------------
  describe('rejectContentApproval', () => {
    it('rejects a pending approval with feedback', async () => {
      const service = ContentApprovalService.getInstance();
      const approval = service.submit({
        teamId: 'team-1',
        submittedBy: 'agent',
        platform: 'twitter',
        contentType: 'post',
        content: 'Test',
      });

      const req = createMockReq({
        params: { id: approval.id },
        body: { resolvedBy: 'steve', feedback: 'Needs more detail' },
      });
      const { res, json } = createMockRes();

      await rejectContentApproval(req, res, next);

      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            id: approval.id,
            status: 'rejected',
            feedback: 'Needs more detail',
          }),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/content-approvals/stats
  // ---------------------------------------------------------------------------
  describe('getContentApprovalStats', () => {
    it('returns stats for a team', async () => {
      const service = ContentApprovalService.getInstance();
      service.submit({
        teamId: 'team-1',
        submittedBy: 'agent',
        platform: 'twitter',
        contentType: 'post',
        content: 'Test',
      });

      const req = createMockReq({ query: { teamId: 'team-1' } });
      const { res, json } = createMockRes();

      await getContentApprovalStats(req, res, next);

      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ pending: 1, approved: 0, rejected: 0, expired: 0 }),
        }),
      );
    });

    it('returns 400 when teamId is missing', async () => {
      const req = createMockReq({ query: {} });
      const { res, status } = createMockRes();

      await getContentApprovalStats(req, res, next);

      expect(status).toHaveBeenCalledWith(400);
    });
  });
});
