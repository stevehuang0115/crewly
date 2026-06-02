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
  addItem,
  cancelQueuedItem,
} from './task-pool.controller.js';
import { TaskPoolService, WorkItemClaimedError } from '../../services/task-pool/task-pool.service.js';
import { StorageService } from '../../services/core/storage.service.js';
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

// #615: addItem now validates the target session via StorageService. Mock it
// so target resolution is controllable per-test.
jest.mock('../../services/core/storage.service.js', () => ({
  StorageService: { getInstance: jest.fn() },
}));

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
  addToPool: jest.fn(),
  getAllItems: jest.fn().mockResolvedValue([]),
  cancelQueued: jest.fn(),
};

(TaskPoolService.getInstance as any) = jest.fn().mockReturnValue(mockService);

// #615: StorageService.findMemberBySessionName backs addItem's target check.
const mockStorage = {
  findMemberBySessionName: jest.fn(),
};
(StorageService.getInstance as any) = jest.fn().mockReturnValue(mockStorage);

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

  // ---------------------------------------------------------------------
  // completeItem — Hygiene #4 (2026-05-09): strict-shape lock
  //
  // Quinn surfaced this on the #499 verify-WI dogfood. Five callsites
  // (3 skills + 2 TS in tool-registry.ts) were emitting top-level
  // `{summary}` instead of `{agentId, result:{summary}}`. Decision was
  // to keep the controller STRICT and fix all callers in the same PR
  // rather than ship a backward-compat resolver. These tests lock that
  // contract — broken-shape variants must 400, canonical shape must
  // succeed, and the broken-shape rejection messages must be specific
  // enough to point a human caller at the fix.
  // ---------------------------------------------------------------------
  describe('completeItem (Hygiene #4 strict-shape lock)', () => {
    beforeEach(() => {
      mockService.findWorkItem.mockResolvedValue({ id: 'wi-h4', output: null });
      mockService.setOutput.mockResolvedValue(undefined);
      mockService.completeItem.mockResolvedValue(undefined);
    });

    it('rejects legacy top-level `{summary}` shape with 400 (no agentId)', async () => {
      // The exact broken shape that 3 skills + 2 TS callsites used to
      // emit. The agentId-required check fires FIRST (before the
      // result.summary check), so the error here is `agentId is required`.
      const req = mockReq({
        params: { workItemId: 'wi-h4' },
        body: { summary: 'Top-level summary, no agentId, no result wrapper' },
      });
      const res = mockRes();
      await completeItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'agentId is required',
        }),
      );
      expect(mockService.completeItem).not.toHaveBeenCalled();
    });

    it('rejects `{agentId, summary}` (top-level summary missing result wrapper) with 400', async () => {
      // Caller has agentId but still puts summary at top level instead
      // of inside `result`. This is the second-most-likely "fixed it
      // halfway" mistake — passes the agentId gate, fails the
      // result.summary gate.
      const req = mockReq({
        params: { workItemId: 'wi-h4' },
        body: { agentId: 'agent-1', summary: 'Top-level summary, no result wrapper' },
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

    it('error message on missing summary points caller at body.result', async () => {
      // Discoverability check — the 400 message must contain the string
      // "body.result" so a human caller (or LLM agent) reading the
      // response can fix the shape without diving into source.
      const req = mockReq({
        params: { workItemId: 'wi-h4' },
        body: { agentId: 'agent-1', result: {} },
      });
      const res = mockRes();
      await completeItem(req, res);

      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.error).toEqual(expect.stringContaining('body.result'));
    });

    it('accepts the canonical shape `{agentId, result:{summary}}` and returns success', async () => {
      // The smoke-replay assertion. Mirror exactly what the 5 fixed
      // callsites emit post-Hygiene #4 — controller must accept it.
      const req = mockReq({
        params: { workItemId: 'wi-h4' },
        body: {
          agentId: 'crewly-product-quinn-47ce967d',
          result: { summary: 'Hygiene #4 strict-shape lock — 5 callsites fixed.' },
        },
      });
      const res = mockRes();
      await completeItem(req, res);

      expect(mockService.completeItem).toHaveBeenCalledWith(
        'wi-h4',
        expect.objectContaining({ summary: expect.stringContaining('Hygiene #4') }),
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });

    it('canonical shape with extra result fields preserves them onto output', async () => {
      // The complete-task skill's `output` parameter is now merged into
      // `result` alongside `summary` (per the fixed body in
      // config/skills/agent/core/complete-task/execute.sh). Verify the
      // controller accepts that merged shape and persists every field.
      const req = mockReq({
        params: { workItemId: 'wi-h4' },
        body: {
          agentId: 'crewly-product-quinn-47ce967d',
          result: {
            summary: 'Shipped Hygiene #4',
            prNumber: 999,
            callsiteCount: 5,
            decision: 'strict',
          },
        },
      });
      const res = mockRes();
      await completeItem(req, res);

      expect(mockService.setOutput).toHaveBeenCalledWith(
        'wi-h4',
        expect.objectContaining({
          summary: 'Shipped Hygiene #4',
          prNumber: 999,
          callsiteCount: 5,
          decision: 'strict',
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // POST /add — addItem
  //
  // 2026-05-12 dogfood: the orchestrator's delegate-task shell skill (and 3
  // sibling skills) all send a minimal `CreateWorkItemInput` shape — no id,
  // no status, no createdAt. The previous validator required all of those
  // and 400'd every shell-driven delegation. Fix: accept the minimal shape
  // and let the server build the full WI via `createWorkItem`. Preserve
  // legacy full-WI shape for callers that construct ids locally (e.g.
  // `break-down-request`).
  // -----------------------------------------------------------------------

  describe('addItem', () => {
    beforeEach(() => {
      mockService.addToPool.mockResolvedValue(undefined);
      mockService.getAllItems.mockResolvedValue([]);
      // Default: any targeted session resolves to a real member, so the
      // #615 target guard passes. Individual tests override to return null.
      mockStorage.findMemberBySessionName.mockResolvedValue({
        team: { id: 'team-1' },
        member: { id: 'm-1', sessionName: 'crewly-product-leo' },
      });
    });

    it('accepts a minimal CreateWorkItemInput body and generates id + status + createdAt', async () => {
      const req = mockReq({
        body: {
          type: 'delegate',
          owner: 'orchestrator',
          target: 'crewly-product-leo',
          title: 'Implement feature X',
          description: 'Short summary',
          briefMarkdown: 'Long-form brief...',
        },
      });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockService.addToPool).toHaveBeenCalledTimes(1);

      const addedWI = mockService.addToPool.mock.calls[0][0];
      expect(typeof addedWI.id).toBe('string');
      expect(addedWI.id.length).toBeGreaterThan(0);
      expect(addedWI.status).toBe('queued');
      expect(typeof addedWI.createdAt).toBe('string');
      expect(addedWI.retryCount).toBe(0);
      expect(addedWI.maxRetries).toBeGreaterThan(0);
      expect(addedWI.title).toBe('Implement feature X');
      expect(addedWI.type).toBe('delegate');
      expect(addedWI.owner).toBe('orchestrator');
      expect(addedWI.target).toBe('crewly-product-leo');
      expect(addedWI.briefMarkdown).toBe('Long-form brief...');

      // Response must echo the generated id so the skill can record it.
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.workItemId).toBe(addedWI.id);
      expect(body.data.id).toBe(addedWI.id);
      expect(body.data.status).toBe('queued');
    });

    it('rejects a minimal body missing required CreateWorkItemInput fields', async () => {
      // No type, no owner, no title — three errors expected.
      const req = mockReq({ body: { description: 'orphan' } });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(Array.isArray(body.errors)).toBe(true);
      expect(mockService.addToPool).not.toHaveBeenCalled();
    });

    it('accepts a legacy full-WorkItem body and preserves the client-supplied id', async () => {
      // break-down-request constructs WIs locally with deterministic ids it
      // then records in `Request.workItemIds[]`. This path must keep working.
      const req = mockReq({
        body: {
          id: 'wi_locally_minted_42',
          type: 'delegate',
          owner: 'orchestrator',
          target: 'crewly-product-leo',
          title: 'Pre-built WI',
          status: 'queued',
          createdAt: '2026-05-12T00:00:00.000Z',
          retryCount: 0,
          maxRetries: 3,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        },
      });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const addedWI = mockService.addToPool.mock.calls[0][0];
      expect(addedWI.id).toBe('wi_locally_minted_42');
      expect(addedWI.status).toBe('queued');
    });

    it('rejects a duplicate id against the existing pool (legacy path)', async () => {
      mockService.getAllItems.mockResolvedValue([
        { id: 'wi-dup', status: 'running', requestId: undefined },
      ]);

      const req = mockReq({
        body: {
          id: 'wi-dup',
          type: 'delegate',
          owner: 'orchestrator',
          title: 'Dup',
          status: 'queued',
          createdAt: '2026-05-12T00:00:00.000Z',
        },
      });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.errors.join(' ')).toMatch(/already exists/);
      expect(mockService.addToPool).not.toHaveBeenCalled();
    });

    it('rejects when the parent Request already holds MAX active WIs (per-request cap)', async () => {
      // 25 active WIs sharing a requestId is the documented cap. A 26th
      // should be refused as an "infinite decomposition" guardrail.
      const existing = Array.from({ length: 25 }, (_, i) => ({
        id: `wi-existing-${i}`,
        status: 'queued',
        requestId: 'req-runaway',
      }));
      mockService.getAllItems.mockResolvedValue(existing);

      const req = mockReq({
        body: {
          type: 'delegate',
          owner: 'orchestrator',
          title: 'one more',
          requestId: 'req-runaway',
        },
      });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.errors.join(' ')).toMatch(/active WorkItems/);
      expect(mockService.addToPool).not.toHaveBeenCalled();
    });

    it('returns 400 if body is not an object', async () => {
      const req = mockReq({ body: 'not-an-object' });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockService.addToPool).not.toHaveBeenCalled();
    });

    it('initial status for a minimal body with dependsOn is `blocked`, not `queued`', async () => {
      // createWorkItem promotes dependency-gated items to `blocked`. The
      // endpoint must propagate that — otherwise an item with unresolved
      // deps would be claimable immediately, defeating the gate.
      const req = mockReq({
        body: {
          type: 'delegate',
          owner: 'orchestrator',
          title: 'Has upstream deps',
          dependsOn: ['wi-upstream-1', 'wi-upstream-2'],
        },
      });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const addedWI = mockService.addToPool.mock.calls[0][0];
      expect(addedWI.status).toBe('blocked');
      expect(addedWI.dependsOn).toEqual(['wi-upstream-1', 'wi-upstream-2']);
    });

    // #615: an agent (Don) invented teammates "Leo"/"Noah" with plausible
    // session names and dispatched WorkItems that orphaned forever. The target
    // must resolve to a real member or known virtual agent, else reject.
    it('rejects a WorkItem whose target session does not resolve to any member (#615)', async () => {
      mockStorage.findMemberBySessionName.mockResolvedValue(null); // fabricated target

      const req = mockReq({
        body: {
          type: 'delegate',
          owner: 'orchestrator',
          target: 'stock-ops-team-noah-cbe74bbd', // looks real, does not exist
          title: 'Distribute report',
        },
      });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.code).toBe('unknown_target_session');
      expect(body.error).toMatch(/does not exist/);
      // Crucially, the orphan WI must NOT enter the pool.
      expect(mockService.addToPool).not.toHaveBeenCalled();
    });

    it('allows a known virtual agent target (orchestrator) even without a member record (#615)', async () => {
      // findMemberBySessionName returns null for virtual sessions, but the
      // orchestrator is an allowed dispatch target via the virtual allowlist.
      mockStorage.findMemberBySessionName.mockResolvedValue(null);

      const req = mockReq({
        body: {
          type: 'delegate',
          owner: 'orchestrator',
          target: 'crewly-orc',
          title: 'Escalate to orchestrator',
        },
      });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockService.addToPool).toHaveBeenCalledTimes(1);
    });

    it('allows an unassigned WorkItem (no target) — hybrid-wake picks it up (#615)', async () => {
      mockStorage.findMemberBySessionName.mockResolvedValue(null);

      const req = mockReq({
        body: {
          type: 'delegate',
          owner: 'orchestrator',
          title: 'Unassigned work',
          // no target
        },
      });
      const res = mockRes();

      await addItem(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockService.addToPool).toHaveBeenCalledTimes(1);
      // The target validator must not even consult storage for an absent target.
      expect(mockStorage.findMemberBySessionName).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/task-pool/items/:workItemId/cancel (#609 explicit cancel)
  // -------------------------------------------------------------------------

  describe('cancelQueuedItem (#609)', () => {
    beforeEach(() => {
      mockService.cancelQueued.mockReset();
      mockService.findWorkItem.mockReset();
    });

    it('returns 200 + cancelledFrom on a successful queued cancel', async () => {
      mockService.findWorkItem.mockResolvedValue({ id: 'wi-1', status: 'queued' });
      mockService.cancelQueued.mockResolvedValue(undefined);

      const req = mockReq({ params: { workItemId: 'wi-1' }, body: { reason: 'stuck fallback' } });
      const res = mockRes();
      await cancelQueuedItem(req, res);

      expect(mockService.cancelQueued).toHaveBeenCalledWith('wi-1', 'stuck fallback');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, workItemId: 'wi-1', cancelledFrom: 'queued', reason: 'stuck fallback' }),
      );
    });

    it('returns 400 when reason is missing or empty', async () => {
      const req = mockReq({ params: { workItemId: 'wi-1' }, body: {} });
      const res = mockRes();
      await cancelQueuedItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringMatching(/reason is required/) }),
      );
      expect(mockService.cancelQueued).not.toHaveBeenCalled();
    });

    it('returns 400 when reason is only whitespace', async () => {
      const req = mockReq({ params: { workItemId: 'wi-1' }, body: { reason: '   ' } });
      const res = mockRes();
      await cancelQueuedItem(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockService.cancelQueued).not.toHaveBeenCalled();
    });

    it('returns 404 when WI does not exist', async () => {
      mockService.findWorkItem.mockResolvedValue(null);
      const req = mockReq({ params: { workItemId: 'ghost' }, body: { reason: 'why' } });
      const res = mockRes();
      await cancelQueuedItem(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockService.cancelQueued).not.toHaveBeenCalled();
    });

    it('returns 400 with the service error message when WI is in a non-cancellable state', async () => {
      mockService.findWorkItem.mockResolvedValue({ id: 'wi-2', status: 'running' });
      mockService.cancelQueued.mockRejectedValue(
        new Error(
          "cancelQueued: WorkItem status must be 'queued', 'blocked', or 'scheduled' (got 'running'). Use a status-appropriate API for other states — e.g. failItem for running, or DELETE for terminal-state cleanup.",
        ),
      );

      const req = mockReq({ params: { workItemId: 'wi-2' }, body: { reason: 'oops' } });
      const res = mockRes();
      await cancelQueuedItem(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringMatching(/status must be 'queued'/) }),
      );
    });
  });
});
