/**
 * Reconciler Controller Tests
 *
 * Tests for GET /api/reconciler/status, POST /api/reconciler/run,
 * and GET /api/reconciler/history endpoints.
 *
 * @module controllers/reconciler/reconciler.controller.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  getReconcilerStatus,
  runReconcile,
  getReconcilerHistory,
  setReconcilerService,
} from './reconciler.controller.js';
import type { ReconcilerService } from '../../services/reconciler/reconciler.service.js';
import type { ReconcileResult, ReconcilerStatus } from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock Express request with optional query params.
 *
 * @param query - Optional query parameters
 * @returns Mock Express request
 */
function createMockRequest(query: Record<string, string> = {}): Request {
  return { query, params: {}, body: {} } as unknown as Request;
}

/**
 * Creates a mock Express response with spied methods.
 *
 * @returns Mock Express response with status and json spies
 */
function createMockResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

/** No-op next function for tests */
const mockNext: NextFunction = vi.fn();

/**
 * Creates a mock ReconcileResult for testing.
 *
 * @param overrides - Optional field overrides
 * @returns A ReconcileResult
 */
function createMockReconcileResult(overrides?: Partial<ReconcileResult>): ReconcileResult {
  return {
    requestsUpdated: 0,
    workItemsTimedOut: 0,
    workItemsRequeued: 0,
    triggersRebuilt: 0,
    staleItemsCleaned: 0,
    reconciledAt: '2026-04-05T03:00:00.000Z',
    durationMs: 42,
    type: 'full',
    corrections: [],
    errors: [],
    ...overrides,
  };
}

/**
 * Creates a mock ReconcilerStatus for testing.
 *
 * @param overrides - Optional field overrides
 * @returns A ReconcilerStatus
 */
function createMockReconcilerStatus(overrides?: Partial<ReconcilerStatus>): ReconcilerStatus {
  return {
    isRunning: false,
    totalPasses: 5,
    totalCorrections: 12,
    config: {
      fastLoopIntervalMs: 10_000,
      fullLoopIntervalMs: 60_000,
      maxReconcileDurationMs: 3_000,
      workItemTimeoutMs: 600_000,
      maxHistorySize: 100,
      eventTriggeredEnabled: true,
    },
    lastResult: createMockReconcileResult(),
    nextFullReconcileAt: '2026-04-05T03:01:00.000Z',
    nextFastReconcileAt: '2026-04-05T03:00:10.000Z',
    ...overrides,
  };
}

/**
 * Creates a mock ReconcilerService.
 *
 * @returns Mock ReconcilerService with spied methods
 */
function createMockReconcilerService(): ReconcilerService {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    runFull: vi.fn().mockResolvedValue(createMockReconcileResult()),
    runFast: vi.fn().mockResolvedValue(createMockReconcileResult({ type: 'fast' })),
    reconcileRequest: vi.fn().mockResolvedValue(createMockReconcileResult({ type: 'targeted_request' })),
    getStatus: vi.fn().mockReturnValue(createMockReconcilerStatus()),
    getHistory: vi.fn().mockReturnValue([createMockReconcileResult()]),
    updateConfig: vi.fn(),
  } as unknown as ReconcilerService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReconcilerController', () => {
  let service: ReconcilerService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createMockReconcilerService();
    setReconcilerService(service);
  });

  // -----------------------------------------------------------------------
  // GET /api/reconciler/status
  // -----------------------------------------------------------------------
  describe('getReconcilerStatus', () => {
    it('returns 503 when service is not initialized', async () => {
      setReconcilerService(null as unknown as ReconcilerService);
      const req = createMockRequest();
      const res = createMockResponse();

      await getReconcilerStatus(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Reconciler service not initialized',
      });
    });

    it('returns current reconciler status', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await getReconcilerStatus(req, res, mockNext);

      expect(service.getStatus).toHaveBeenCalledOnce();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          isRunning: false,
          totalPasses: 5,
          totalCorrections: 12,
        }),
      });
    });

    it('forwards unexpected errors to next()', async () => {
      const error = new Error('unexpected');
      (service.getStatus as ReturnType<typeof vi.fn>).mockImplementation(() => { throw error; });
      const req = createMockRequest();
      const res = createMockResponse();

      await getReconcilerStatus(req, res, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/reconciler/run
  // -----------------------------------------------------------------------
  describe('runReconcile', () => {
    it('returns 503 when service is not initialized', async () => {
      setReconcilerService(null as unknown as ReconcilerService);
      const req = createMockRequest();
      const res = createMockResponse();

      await runReconcile(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('triggers a full reconciliation and returns the result', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await runReconcile(req, res, mockNext);

      expect(service.runFull).toHaveBeenCalledOnce();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          type: 'full',
          durationMs: 42,
        }),
      });
    });

    it('forwards errors to next()', async () => {
      const error = new Error('reconcile failed');
      (service.runFull as ReturnType<typeof vi.fn>).mockRejectedValue(error);
      const req = createMockRequest();
      const res = createMockResponse();

      await runReconcile(req, res, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/reconciler/history
  // -----------------------------------------------------------------------
  describe('getReconcilerHistory', () => {
    it('returns 503 when service is not initialized', async () => {
      setReconcilerService(null as unknown as ReconcilerService);
      const req = createMockRequest();
      const res = createMockResponse();

      await getReconcilerHistory(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('returns history with default limit when no query param', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await getReconcilerHistory(req, res, mockNext);

      expect(service.getHistory).toHaveBeenCalledWith(20);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.any(Array),
      });
    });

    it('respects a valid limit query parameter', async () => {
      const req = createMockRequest({ limit: '5' });
      const res = createMockResponse();

      await getReconcilerHistory(req, res, mockNext);

      expect(service.getHistory).toHaveBeenCalledWith(5);
    });

    it('caps limit at MAX_HISTORY_LIMIT (100)', async () => {
      const req = createMockRequest({ limit: '999' });
      const res = createMockResponse();

      await getReconcilerHistory(req, res, mockNext);

      expect(service.getHistory).toHaveBeenCalledWith(100);
    });

    it('returns 400 for non-numeric limit', async () => {
      const req = createMockRequest({ limit: 'abc' });
      const res = createMockResponse();

      await getReconcilerHistory(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid limit parameter — must be a positive integer',
      });
    });

    it('returns 400 for zero limit', async () => {
      const req = createMockRequest({ limit: '0' });
      const res = createMockResponse();

      await getReconcilerHistory(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for negative limit', async () => {
      const req = createMockRequest({ limit: '-5' });
      const res = createMockResponse();

      await getReconcilerHistory(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for float limit', async () => {
      const req = createMockRequest({ limit: '2.5' });
      const res = createMockResponse();

      await getReconcilerHistory(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('forwards unexpected errors to next()', async () => {
      const error = new Error('history failed');
      (service.getHistory as ReturnType<typeof vi.fn>).mockImplementation(() => { throw error; });
      const req = createMockRequest();
      const res = createMockResponse();

      await getReconcilerHistory(req, res, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
