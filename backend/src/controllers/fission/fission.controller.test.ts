/**
 * Fission Controller Tests
 *
 * Tests for GET/PUT /api/fission/config, GET /api/fission/stats,
 * GET /api/fission/violations, and POST /api/fission/check.
 *
 * @module controllers/fission/fission.controller.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  getFissionConfig,
  updateFissionConfig,
  getFissionStats,
  getFissionViolations,
  checkFission,
  setFissionGuardService,
} from './fission.controller.js';
import type { FissionGuardService } from '../../services/fission/fission-guard.service.js';
import { DEFAULT_FISSION_CONFIG, type FissionViolation, type GuardResult } from '../../services/fission/fission-guard.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock Express request.
 *
 * @param opts - Optional query, params, and body
 * @returns Mock Express request
 */
function createMockRequest(opts?: {
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}): Request {
  return {
    query: opts?.query ?? {},
    params: {},
    body: opts?.body ?? {},
  } as unknown as Request;
}

/**
 * Creates a mock Express response with spied methods.
 *
 * @returns Mock Express response
 */
function createMockResponse(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

const mockNext: NextFunction = vi.fn();

/**
 * Creates a mock FissionViolation.
 *
 * @param overrides - Field overrides
 * @returns A FissionViolation
 */
function createMockViolation(overrides?: Partial<FissionViolation>): FissionViolation {
  return {
    id: 'v-001',
    violationType: 'max_depth',
    agentId: 'agent-1',
    parentWorkItemId: 'wi-1',
    reason: 'Depth exceeded',
    currentValue: 4,
    configuredLimit: 3,
    violatedAt: '2026-04-05T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Creates a mock FissionGuardService.
 *
 * @returns Mock FissionGuardService with spied methods
 */
function createMockService(): FissionGuardService {
  return {
    getConfig: vi.fn().mockReturnValue({ ...DEFAULT_FISSION_CONFIG }),
    updateConfig: vi.fn(),
    getViolations: vi.fn().mockReturnValue([createMockViolation()]),
    getViolationsByType: vi.fn().mockReturnValue([createMockViolation()]),
    canCreateSubTask: vi.fn().mockResolvedValue({ allowed: true } as GuardResult),
  } as unknown as FissionGuardService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FissionController', () => {
  let service: FissionGuardService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createMockService();
    setFissionGuardService(service);
  });

  // -----------------------------------------------------------------------
  // GET /api/fission/config
  // -----------------------------------------------------------------------
  describe('getFissionConfig', () => {
    it('returns 503 when service not initialized', async () => {
      setFissionGuardService(null as unknown as FissionGuardService);
      const res = createMockResponse();
      await getFissionConfig(createMockRequest(), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('returns current config', async () => {
      const res = createMockResponse();
      await getFissionConfig(createMockRequest(), res, mockNext);
      expect(service.getConfig).toHaveBeenCalledOnce();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({ maxDepth: 3 }),
      });
    });

    it('forwards errors to next()', async () => {
      const err = new Error('fail');
      (service.getConfig as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });
      const res = createMockResponse();
      await getFissionConfig(createMockRequest(), res, mockNext);
      expect(mockNext).toHaveBeenCalledWith(err);
    });
  });

  // -----------------------------------------------------------------------
  // PUT /api/fission/config
  // -----------------------------------------------------------------------
  describe('updateFissionConfig', () => {
    it('returns 503 when service not initialized', async () => {
      setFissionGuardService(null as unknown as FissionGuardService);
      const res = createMockResponse();
      await updateFissionConfig(createMockRequest({ body: { maxDepth: 5 } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('updates config with valid partial body', async () => {
      const res = createMockResponse();
      await updateFissionConfig(
        createMockRequest({ body: { maxDepth: 5, maxBranchingFactor: 10 } }),
        res, mockNext,
      );
      expect(service.updateConfig).toHaveBeenCalledWith({ maxDepth: 5, maxBranchingFactor: 10 });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({ maxDepth: 3 }), // returns getConfig()
      });
    });

    it('rejects non-object body', async () => {
      const res = createMockResponse();
      const req = { query: {}, params: {}, body: 'not-an-object' } as unknown as Request;
      await updateFissionConfig(req, res, mockNext);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects array body', async () => {
      const res = createMockResponse();
      await updateFissionConfig(createMockRequest({ body: [] as any }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects negative maxDepth', async () => {
      const res = createMockResponse();
      await updateFissionConfig(createMockRequest({ body: { maxDepth: -1 } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('maxDepth'),
      }));
    });

    it('rejects zero rateLimitMaxCreations', async () => {
      const res = createMockResponse();
      await updateFissionConfig(createMockRequest({ body: { rateLimitMaxCreations: 0 } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects NaN budgetThresholdUsd', async () => {
      const res = createMockResponse();
      await updateFissionConfig(createMockRequest({ body: { budgetThresholdUsd: NaN } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects non-boolean budgetGateEnabled', async () => {
      const res = createMockResponse();
      await updateFissionConfig(createMockRequest({ body: { budgetGateEnabled: 1 } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('allows budgetThresholdUsd of 0', async () => {
      const res = createMockResponse();
      await updateFissionConfig(createMockRequest({ body: { budgetThresholdUsd: 0 } }), res, mockNext);
      expect(service.updateConfig).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/fission/stats
  // -----------------------------------------------------------------------
  describe('getFissionStats', () => {
    it('returns 503 when service not initialized', async () => {
      setFissionGuardService(null as unknown as FissionGuardService);
      const res = createMockResponse();
      await getFissionStats(createMockRequest(), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('returns stats with violation counts by type', async () => {
      const res = createMockResponse();
      await getFissionStats(createMockRequest(), res, mockNext);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          totalViolations: 1,
          byType: expect.objectContaining({ max_depth: 1, rate_limit: 0 }),
          config: expect.objectContaining({ maxDepth: 3 }),
        }),
      });
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/fission/violations
  // -----------------------------------------------------------------------
  describe('getFissionViolations', () => {
    it('returns 503 when service not initialized', async () => {
      setFissionGuardService(null as unknown as FissionGuardService);
      const res = createMockResponse();
      await getFissionViolations(createMockRequest(), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('returns violations with default limit', async () => {
      const res = createMockResponse();
      await getFissionViolations(createMockRequest(), res, mockNext);
      expect(service.getViolations).toHaveBeenCalledWith(50);
    });

    it('respects custom limit', async () => {
      const res = createMockResponse();
      await getFissionViolations(createMockRequest({ query: { limit: '10' } }), res, mockNext);
      expect(service.getViolations).toHaveBeenCalledWith(10);
    });

    it('caps limit at 200', async () => {
      const res = createMockResponse();
      await getFissionViolations(createMockRequest({ query: { limit: '999' } }), res, mockNext);
      expect(service.getViolations).toHaveBeenCalledWith(200);
    });

    it('rejects non-numeric limit', async () => {
      const res = createMockResponse();
      await getFissionViolations(createMockRequest({ query: { limit: 'abc' } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects zero limit', async () => {
      const res = createMockResponse();
      await getFissionViolations(createMockRequest({ query: { limit: '0' } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('filters by type when provided', async () => {
      const res = createMockResponse();
      await getFissionViolations(createMockRequest({ query: { type: 'max_depth' } }), res, mockNext);
      expect(service.getViolationsByType).toHaveBeenCalledWith('max_depth');
    });

    it('rejects invalid type filter', async () => {
      const res = createMockResponse();
      await getFissionViolations(createMockRequest({ query: { type: 'invalid' } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('must be one of'),
      }));
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/fission/check
  // -----------------------------------------------------------------------
  describe('checkFission', () => {
    it('returns 503 when service not initialized', async () => {
      setFissionGuardService(null as unknown as FissionGuardService);
      const res = createMockResponse();
      await checkFission(createMockRequest({ body: { parentWorkItemId: 'wi-1', agentId: 'a-1' } }), res, mockNext);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('returns guard result for valid check', async () => {
      const res = createMockResponse();
      await checkFission(
        createMockRequest({ body: { parentWorkItemId: 'wi-1', agentId: 'agent-1' } }),
        res, mockNext,
      );
      expect(service.canCreateSubTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wi-1' }),
        'agent-1',
        undefined,
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { allowed: true },
      });
    });

    it('passes missionId when provided', async () => {
      const res = createMockResponse();
      await checkFission(
        createMockRequest({ body: { parentWorkItemId: 'wi-1', agentId: 'a-1', missionId: 'm-1' } }),
        res, mockNext,
      );
      expect(service.canCreateSubTask).toHaveBeenCalledWith(
        expect.anything(),
        'a-1',
        'm-1',
      );
    });

    it('returns blocked result from service', async () => {
      (service.canCreateSubTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        allowed: false,
        reason: 'Too deep',
        violationType: 'max_depth',
      });
      const res = createMockResponse();
      await checkFission(
        createMockRequest({ body: { parentWorkItemId: 'wi-1', agentId: 'a-1' } }),
        res, mockNext,
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { allowed: false, reason: 'Too deep', violationType: 'max_depth' },
      });
    });

    it('rejects missing parentWorkItemId', async () => {
      const res = createMockResponse();
      await checkFission(
        createMockRequest({ body: { agentId: 'a-1' } }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects missing agentId', async () => {
      const res = createMockResponse();
      await checkFission(
        createMockRequest({ body: { parentWorkItemId: 'wi-1' } }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects non-string parentWorkItemId', async () => {
      const res = createMockResponse();
      await checkFission(
        createMockRequest({ body: { parentWorkItemId: 123, agentId: 'a-1' } }),
        res, mockNext,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('forwards errors to next()', async () => {
      const err = new Error('service error');
      (service.canCreateSubTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);
      const res = createMockResponse();
      await checkFission(
        createMockRequest({ body: { parentWorkItemId: 'wi-1', agentId: 'a-1' } }),
        res, mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(err);
    });
  });
});
