/**
 * Tests for Data Controller — V2 Data Architecture
 *
 * Unit tests for REST API handlers. Uses mocked DataObjectStore,
 * SchemaRegistry, and SinkRegistry services.
 */

import type { Request, Response } from 'express';
import { getSyncStatus } from './data.controller.js';

/** Create a mock Express response. */
function mockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

/** Create a mock Express request. */
function mockReq(overrides?: Partial<Request>): Request {
  return {
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

describe('Data Controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getSyncStatus', () => {
    it('returns Phase 1 placeholder sync status', async () => {
      const req = mockReq();
      const res = mockRes();

      await getSyncStatus(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          syncEnabled: false,
          localObjects: 0,
          syncedObjects: 0,
          conflictObjects: 0,
          lastSyncAt: null,
          message: 'Sync not yet enabled (Phase 3)',
        },
      });
    });
  });
});
