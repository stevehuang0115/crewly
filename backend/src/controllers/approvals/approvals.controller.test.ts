/**
 * Tests for Approvals Controller
 *
 * @module controllers/approvals/approvals.controller.test
 */

import type { Request, Response, NextFunction } from 'express';
import {
  getPendingApprovals,
  approveRequest,
  rejectRequest,
  setApprovalQueueService,
  getApprovalQueueService,
} from './approvals.controller.js';
import { ApprovalQueueService } from '../../services/agent/crewly-agent/approval-queue.service.js';

describe('Approvals Controller', () => {
  let queue: ApprovalQueueService;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonSpy: jest.Mock;
  let statusSpy: jest.Mock;

  beforeEach(() => {
    queue = new ApprovalQueueService();
    setApprovalQueueService(queue);

    jsonSpy = jest.fn();
    statusSpy = jest.fn().mockReturnValue({ json: jsonSpy });
    mockRes = {
      json: jsonSpy,
      status: statusSpy,
    };
    mockNext = jest.fn();
    mockReq = { query: {}, params: {}, body: {} };
  });

  afterEach(() => {
    setApprovalQueueService(null as any);
  });

  describe('setApprovalQueueService / getApprovalQueueService', () => {
    it('should set and get the service', () => {
      const q = new ApprovalQueueService();
      setApprovalQueueService(q);
      expect(getApprovalQueueService()).toBe(q);
    });
  });

  describe('getPendingApprovals', () => {
    it('should return 503 when queue not initialized', async () => {
      setApprovalQueueService(null as any);
      await getPendingApprovals(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(503);
    });

    it('should return all pending approvals', async () => {
      queue.enqueue('s1', 'edit_file', 'destructive', { path: '/foo' });
      queue.enqueue('s2', 'write_file', 'destructive', { path: '/bar' });

      await getPendingApprovals(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        data: expect.arrayContaining([
          expect.objectContaining({ toolName: 'edit_file' }),
          expect.objectContaining({ toolName: 'write_file' }),
        ]),
      });
    });

    it('should filter by sessionName query param', async () => {
      queue.enqueue('s1', 'tool1', 'sensitive', {});
      queue.enqueue('s2', 'tool2', 'sensitive', {});

      mockReq.query = { sessionName: 's1' };
      await getPendingApprovals(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        data: expect.arrayContaining([
          expect.objectContaining({ sessionName: 's1' }),
        ]),
      });
      expect(jsonSpy.mock.calls[0][0].data).toHaveLength(1);
    });

    it('should call next on error', async () => {
      const badQueue = { getPending: () => { throw new Error('boom'); } } as any;
      setApprovalQueueService(badQueue);

      await getPendingApprovals(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('approveRequest', () => {
    it('should return 503 when queue not initialized', async () => {
      setApprovalQueueService(null as any);
      mockReq.params = { id: 'test' };
      await approveRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(503);
    });

    it('should approve a pending approval', async () => {
      const approval = queue.enqueue('s1', 'edit_file', 'destructive', {});
      mockReq.params = { id: approval.id };
      mockReq.body = {};

      await approveRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          status: 'approved',
          resolvedBy: 'api',
        }),
      });
    });

    it('should use custom resolvedBy from body', async () => {
      const approval = queue.enqueue('s1', 'edit_file', 'destructive', {});
      mockReq.params = { id: approval.id };
      mockReq.body = { resolvedBy: 'auditor' };

      await approveRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({ resolvedBy: 'auditor' }),
      });
    });

    it('should return 404 for non-existent approval', async () => {
      mockReq.params = { id: 'non-existent' };

      await approveRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(404);
    });
  });

  describe('rejectRequest', () => {
    it('should return 503 when queue not initialized', async () => {
      setApprovalQueueService(null as any);
      mockReq.params = { id: 'test' };
      await rejectRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(503);
    });

    it('should reject a pending approval with reason', async () => {
      const approval = queue.enqueue('s1', 'edit_file', 'destructive', {});
      mockReq.params = { id: approval.id };
      mockReq.body = { reason: 'Too risky' };

      await rejectRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          status: 'rejected',
          reason: 'Too risky',
        }),
      });
    });

    it('should return 404 for non-existent approval', async () => {
      mockReq.params = { id: 'non-existent' };

      await rejectRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(404);
    });

    it('should call next on error', async () => {
      const badQueue = { reject: () => { throw new Error('boom'); } } as any;
      setApprovalQueueService(badQueue);
      mockReq.params = { id: 'test' };

      await rejectRequest(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
