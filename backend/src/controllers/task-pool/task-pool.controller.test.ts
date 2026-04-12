/**
 * Task Pool Controller Tests — HTTP handlers for Task Pool API
 *
 * @module controllers/task-pool/task-pool.controller.test
 */

import {
  listAvailable,
  claimItem,
  releaseItem,
  getStats,
  heartbeat,
  extendLease,
  scanExpired,
  revokeAndRelease,
} from './task-pool.controller.js';
import { TaskPoolService } from '../../services/task-pool/task-pool.service.js';
// Express types used for mock helpers below

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/task-pool/task-pool.service.js');

const mockService = {
  getAvailableItems: jest.fn(),
  claimFromPool: jest.fn(),
  releaseBack: jest.fn(),
  getPoolStatus: jest.fn(),
  heartbeat: jest.fn(),
  extendLease: jest.fn(),
  scanExpiredClaims: jest.fn(),
  revokeAndRelease: jest.fn(),
};

(TaskPoolService.getInstance as any) = jest.fn().mockReturnValue(mockService);

function mockReq(overrides: Record<string, any> = {}): any {
  return {
    query: {},
    params: {},
    body: {},
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.json = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskPoolController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // GET / — listAvailable
  // -----------------------------------------------------------------------

  describe('listAvailable', () => {
    it('returns available items', async () => {
      const items = [{ id: 'wi-1', title: 'Test', status: 'queued' }];
      mockService.getAvailableItems.mockResolvedValue(items);

      const req = mockReq();
      const res = mockRes();
      await listAvailable(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: items,
        count: 1,
      });
    });

    it('passes query filters to service', async () => {
      mockService.getAvailableItems.mockResolvedValue([]);

      const req = mockReq({
        query: { types: 'delegate,check', owner: 'agent', missionId: 'm-1' } as Record<string, string>,
      });
      const res = mockRes();
      await listAvailable(req, res);

      expect(mockService.getAvailableItems).toHaveBeenCalledWith({
        types: ['delegate', 'check'],
        owner: 'agent',
        missionId: 'm-1',
      });
    });

    it('returns 500 on error', async () => {
      mockService.getAvailableItems.mockRejectedValue(new Error('disk fail'));

      const req = mockReq();
      const res = mockRes();
      await listAvailable(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'disk fail',
      });
    });
  });

  // -----------------------------------------------------------------------
  // POST /claim — claimItem
  // -----------------------------------------------------------------------

  describe('claimItem', () => {
    it('returns claimed item on success', async () => {
      const claimResult = {
        workItem: { id: 'wi-1', status: 'running' },
        claim: { id: 'cl-1', agentId: 'agent-leo' },
      };
      mockService.claimFromPool.mockResolvedValue(claimResult);

      const req = mockReq({ body: { agentId: 'agent-leo' } });
      const res = mockRes();
      await claimItem(req, res);

      expect(mockService.claimFromPool).toHaveBeenCalledWith('agent-leo', undefined);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: claimResult,
      });
    });

    it('returns 400 when agentId missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      await claimItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for empty agentId', async () => {
      const req = mockReq({ body: { agentId: '  ' } });
      const res = mockRes();
      await claimItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 404 when no items available', async () => {
      mockService.claimFromPool.mockResolvedValue(null);

      const req = mockReq({ body: { agentId: 'agent-leo' } });
      const res = mockRes();
      await claimItem(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('passes filters from body', async () => {
      mockService.claimFromPool.mockResolvedValue(null);

      const filters = { types: ['delegate'] };
      const req = mockReq({ body: { agentId: 'agent-leo', filters } });
      const res = mockRes();
      await claimItem(req, res);

      expect(mockService.claimFromPool).toHaveBeenCalledWith('agent-leo', filters);
    });
  });

  // -----------------------------------------------------------------------
  // POST /release/:workItemId — releaseItem
  // -----------------------------------------------------------------------

  describe('releaseItem', () => {
    it('releases item successfully', async () => {
      mockService.releaseBack.mockResolvedValue(undefined);

      const req = mockReq({
        params: { workItemId: 'wi-1' } as Record<string, string>,
        body: { reason: 'agent busy' },
      });
      const res = mockRes();
      await releaseItem(req, res);

      expect(mockService.releaseBack).toHaveBeenCalledWith('wi-1', 'agent busy');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'WorkItem wi-1 released back to pool',
      });
    });

    it('uses default reason when none provided', async () => {
      mockService.releaseBack.mockResolvedValue(undefined);

      const req = mockReq({
        params: { workItemId: 'wi-1' } as Record<string, string>,
        body: {},
      });
      const res = mockRes();
      await releaseItem(req, res);

      expect(mockService.releaseBack).toHaveBeenCalledWith('wi-1', 'released via API');
    });

    it('returns 404 when item not found', async () => {
      mockService.releaseBack.mockRejectedValue(new Error('WorkItem not found: ghost'));

      const req = mockReq({
        params: { workItemId: 'ghost' } as Record<string, string>,
        body: {},
      });
      const res = mockRes();
      await releaseItem(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 409 when item in wrong status', async () => {
      mockService.releaseBack.mockRejectedValue(
        new Error("Cannot release WorkItem: status must be 'running', got 'queued'"),
      );

      const req = mockReq({
        params: { workItemId: 'wi-1' } as Record<string, string>,
        body: {},
      });
      const res = mockRes();
      await releaseItem(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
    });
  });

  // -----------------------------------------------------------------------
  // GET /stats — getStats
  // -----------------------------------------------------------------------

  describe('getStats', () => {
    it('returns pool statistics', async () => {
      const snapshot = {
        total: 5,
        available: 3,
        claimed: 2,
        avgWaitTimeMs: 1500,
        byType: { delegate: 3, check: 2 },
        byStatus: { queued: 3, running: 2 },
        timestamp: '2026-04-05T00:00:00Z',
      };
      mockService.getPoolStatus.mockResolvedValue(snapshot);

      const req = mockReq();
      const res = mockRes();
      await getStats(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: snapshot,
      });
    });

    it('returns 500 on error', async () => {
      mockService.getPoolStatus.mockRejectedValue(new Error('oops'));

      const req = mockReq();
      const res = mockRes();
      await getStats(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // -----------------------------------------------------------------------
  // POST /heartbeat — heartbeat
  // -----------------------------------------------------------------------

  describe('heartbeat', () => {
    it('returns updated claim on success', async () => {
      const claim = { id: 'cl-1', agentId: 'agent-leo', status: 'active' };
      mockService.heartbeat.mockResolvedValue({ success: true, claim });

      const req = mockReq({ body: { claimId: 'cl-1', agentId: 'agent-leo' } });
      const res = mockRes();
      await heartbeat(req, res);

      expect(mockService.heartbeat).toHaveBeenCalledWith('cl-1', 'agent-leo');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { claim },
      });
    });

    it('returns 400 when claimId missing', async () => {
      const req = mockReq({ body: { agentId: 'agent-leo' } });
      const res = mockRes();
      await heartbeat(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when agentId missing', async () => {
      const req = mockReq({ body: { claimId: 'cl-1' } });
      const res = mockRes();
      await heartbeat(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 409 on heartbeat failure', async () => {
      mockService.heartbeat.mockResolvedValue({
        success: false,
        reason: 'Agent does not own claim',
      });

      const req = mockReq({ body: { claimId: 'cl-1', agentId: 'agent-max' } });
      const res = mockRes();
      await heartbeat(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
    });
  });

  // -----------------------------------------------------------------------
  // POST /extend-lease — extendLease
  // -----------------------------------------------------------------------

  describe('extendLease', () => {
    it('returns extended claim on success', async () => {
      const claim = { id: 'cl-1', extensionCount: 1 };
      mockService.extendLease.mockResolvedValue({ success: true, claim });

      const req = mockReq({ body: { claimId: 'cl-1', agentId: 'agent-leo' } });
      const res = mockRes();
      await extendLease(req, res);

      expect(mockService.extendLease).toHaveBeenCalledWith('cl-1', 'agent-leo');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { claim },
      });
    });

    it('returns 400 when required params missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      await extendLease(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 409 when extension rejected', async () => {
      mockService.extendLease.mockResolvedValue({
        success: false,
        reason: 'Max extensions reached',
      });

      const req = mockReq({ body: { claimId: 'cl-1', agentId: 'agent-leo' } });
      const res = mockRes();
      await extendLease(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
    });
  });

  // -----------------------------------------------------------------------
  // GET /claims/expired — scanExpired
  // -----------------------------------------------------------------------

  describe('scanExpired', () => {
    it('returns expired claims summary', async () => {
      const summary = {
        expiring: [{ id: 'cl-1' }],
        graceExceeded: [{ id: 'cl-2' }],
      };
      mockService.scanExpiredClaims.mockResolvedValue(summary);

      const req = mockReq();
      const res = mockRes();
      await scanExpired(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          expiring: summary.expiring,
          graceExceeded: summary.graceExceeded,
          expiringCount: 1,
          graceExceededCount: 1,
        },
      });
    });

    it('returns 500 on error', async () => {
      mockService.scanExpiredClaims.mockRejectedValue(new Error('scan failed'));

      const req = mockReq();
      const res = mockRes();
      await scanExpired(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // -----------------------------------------------------------------------
  // POST /revoke/:claimId — revokeAndRelease
  // -----------------------------------------------------------------------

  describe('revokeAndRelease', () => {
    it('revokes claim successfully', async () => {
      mockService.revokeAndRelease.mockResolvedValue(undefined);

      const req = mockReq({
        params: { claimId: 'cl-1' } as Record<string, string>,
        body: { reason: 'grace exceeded' },
      });
      const res = mockRes();
      await revokeAndRelease(req, res);

      expect(mockService.revokeAndRelease).toHaveBeenCalledWith('cl-1', 'grace exceeded');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Claim cl-1 revoked and work item released',
      });
    });

    it('uses default reason when none provided', async () => {
      mockService.revokeAndRelease.mockResolvedValue(undefined);

      const req = mockReq({
        params: { claimId: 'cl-1' } as Record<string, string>,
        body: {},
      });
      const res = mockRes();
      await revokeAndRelease(req, res);

      expect(mockService.revokeAndRelease).toHaveBeenCalledWith('cl-1', 'revoked via API');
    });

    it('returns 404 when claim not found', async () => {
      mockService.revokeAndRelease.mockRejectedValue(new Error('Claim not found: ghost'));

      const req = mockReq({
        params: { claimId: 'ghost' } as Record<string, string>,
        body: {},
      });
      const res = mockRes();
      await revokeAndRelease(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
