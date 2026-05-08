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
  deleteItem,
  completeItem,
} from './task-pool.controller.js';
import { TaskPoolService, WorkItemClaimedError } from '../../services/task-pool/task-pool.service.js';
// Express types used for mock helpers below

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Auto-mock the service module BUT preserve the real WorkItemClaimedError
// class so `instanceof` checks across the test/import and controller/import
// boundary still match (auto-mocked classes are distinct constructors per
// import site).
jest.mock('../../services/task-pool/task-pool.service.js', () => {
  const actual = jest.requireActual('../../services/task-pool/task-pool.service.js');
  return {
    ...actual,
    TaskPoolService: { getInstance: jest.fn() },
  };
});

const mockService = {
  getAvailableItems: jest.fn(),
  claimFromPool: jest.fn(),
  releaseBack: jest.fn(),
  getPoolStatus: jest.fn(),
  heartbeat: jest.fn(),
  extendLease: jest.fn(),
  scanExpiredClaims: jest.fn(),
  revokeAndRelease: jest.fn(),
  removeFromPool: jest.fn(),
  completeItem: jest.fn(),
  findWorkItem: jest.fn(),
  setOutput: jest.fn(),
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

  // -------------------------------------------------------------------------
  // P1 1ffffb84(a) — DELETE /api/task-pool/:workItemId
  // -------------------------------------------------------------------------

  describe('deleteItem (P1 1ffffb84 component a)', () => {
    it('returns 200 + removed:true on a successful delete', async () => {
      mockService.removeFromPool.mockResolvedValue({
        removed: true,
        workItem: { id: 'wi-1', status: 'queued' },
        hadActiveClaim: false,
      });

      const req = mockReq({ params: { workItemId: 'wi-1' } });
      const res = mockRes();
      await deleteItem(req, res);

      expect(mockService.removeFromPool).toHaveBeenCalledWith('wi-1', { force: false });
      expect(res.status).not.toHaveBeenCalled(); // default 200 from res.json
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          removed: true,
          workItem: { id: 'wi-1', status: 'queued' },
          hadActiveClaim: false,
        }),
      );
    });

    it('returns 200 + removed:false + reason=not_found (idempotent on missing id)', async () => {
      mockService.removeFromPool.mockResolvedValue({
        removed: false,
        reason: 'not_found',
      });

      const req = mockReq({ params: { workItemId: 'ghost' } });
      const res = mockRes();
      await deleteItem(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          removed: false,
          reason: 'not_found',
        }),
      );
    });

    it('returns 409 with structured payload when WI is claimed (no force)', async () => {
      mockService.removeFromPool.mockRejectedValue(
        new WorkItemClaimedError({
          workItemId: 'wi-2',
          claimId: 'claim-99',
          claimedBy: 'agent-leo',
        }),
      );

      const req = mockReq({ params: { workItemId: 'wi-2' } });
      const res = mockRes();
      await deleteItem(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          code: 'work_item_claimed',
          workItemId: 'wi-2',
          claimId: 'claim-99',
          claimedBy: 'agent-leo',
        }),
      );
    });

    it('passes force=true through when ?force=1 query is supplied', async () => {
      mockService.removeFromPool.mockResolvedValue({
        removed: true,
        workItem: { id: 'wi-3' },
        hadActiveClaim: true,
      });

      const req = mockReq({
        params: { workItemId: 'wi-3' },
        query: { force: '1' },
      });
      const res = mockRes();
      await deleteItem(req, res);

      expect(mockService.removeFromPool).toHaveBeenCalledWith('wi-3', { force: true });
    });

    it('also accepts ?force=true (string-flag fallback)', async () => {
      mockService.removeFromPool.mockResolvedValue({
        removed: true,
        workItem: { id: 'wi-4' },
        hadActiveClaim: true,
      });

      const req = mockReq({
        params: { workItemId: 'wi-4' },
        query: { force: 'true' },
      });
      const res = mockRes();
      await deleteItem(req, res);

      expect(mockService.removeFromPool).toHaveBeenCalledWith('wi-4', { force: true });
    });

    it('returns 400 when workItemId param is missing', async () => {
      const req = mockReq({ params: {} });
      const res = mockRes();
      await deleteItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockService.removeFromPool).not.toHaveBeenCalled();
    });

    it('returns 500 on a generic service error', async () => {
      mockService.removeFromPool.mockRejectedValue(new Error('disk on fire'));

      const req = mockReq({ params: { workItemId: 'wi-5' } });
      const res = mockRes();
      await deleteItem(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ---------------------------------------------------------------------
  // completeItem (2026-05-08): require non-empty `summary` (Done Definition)
  // ---------------------------------------------------------------------
  describe('completeItem (require summary)', () => {
    beforeEach(() => {
      mockService.findWorkItem.mockResolvedValue({ id: 'wi-1', output: null });
      mockService.setOutput.mockResolvedValue(undefined);
      mockService.completeItem.mockResolvedValue(undefined);
    });

    it('returns 400 when result is missing entirely (fake-completion regression)', async () => {
      // 2026-05-08 dogfood: Sam and Leo both marked WIs done_by_worker
      // with `output=null, notes=null`. The Request Contract Done
      // Definition requires "what artifact/result must be produced". The
      // gate enforces it at the API boundary so workers can't claim
      // completion without producing artefacts.
      const req = mockReq({
        params: { workItemId: 'wi-1' },
        body: { agentId: 'agent-1' },
      });
      const res = mockRes();
      await completeItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          code: 'complete_requires_summary',
        }),
      );
      expect(mockService.completeItem).not.toHaveBeenCalled();
    });

    it('returns 400 when summary is an empty string', async () => {
      const req = mockReq({
        params: { workItemId: 'wi-2' },
        body: { agentId: 'agent-1', result: { summary: '' } },
      });
      const res = mockRes();
      await completeItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockService.completeItem).not.toHaveBeenCalled();
    });

    it('returns 400 when summary is only whitespace', async () => {
      const req = mockReq({
        params: { workItemId: 'wi-3' },
        body: { agentId: 'agent-1', result: { summary: '   \n\t  ' } },
      });
      const res = mockRes();
      await completeItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockService.completeItem).not.toHaveBeenCalled();
    });

    it('accepts a non-empty summary and persists it onto WorkItem.output', async () => {
      const req = mockReq({
        params: { workItemId: 'wi-4' },
        body: {
          agentId: 'leo',
          result: { summary: 'Designed schema for users table; 4 fields finalized.' },
        },
      });
      const res = mockRes();
      await completeItem(req, res);

      expect(mockService.completeItem).toHaveBeenCalledWith(
        'wi-4',
        expect.objectContaining({ summary: expect.stringContaining('Designed schema') }),
      );
      // Output is persisted with the summary.
      expect(mockService.setOutput).toHaveBeenCalledWith(
        'wi-4',
        expect.objectContaining({ summary: expect.stringContaining('Designed schema') }),
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });

    it('preserves caller-supplied non-summary result fields on output', async () => {
      const req = mockReq({
        params: { workItemId: 'wi-5' },
        body: {
          agentId: 'leo',
          result: { summary: 'Shipped PR #123', prNumber: 123, links: ['github.com/foo'] },
        },
      });
      const res = mockRes();
      await completeItem(req, res);

      expect(mockService.setOutput).toHaveBeenCalledWith(
        'wi-5',
        expect.objectContaining({
          summary: 'Shipped PR #123',
          prNumber: 123,
          links: ['github.com/foo'],
        }),
      );
    });
  });
});
