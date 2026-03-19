/**
 * Tests for CloudAuthMiddleware
 *
 * @module services/cloud/cloud-auth.middleware.test
 */

import type { Request, Response, NextFunction } from 'express';
import { isCloudConnected, requireCloudConnection, requireTier, WARN_THROTTLE_MS, _warnTimestamps } from './cloud-auth.middleware.js';
import { CloudClientService } from './cloud-client.service.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoggerWarn = jest.fn();

jest.mock('../core/logger.service.js', () => {
  return {
    LoggerService: {
      getInstance: () => ({
        createComponentLogger: () => ({
          info: jest.fn(),
          warn: (...args: unknown[]) => mockLoggerWarn(...args),
          error: jest.fn(),
          debug: jest.fn(),
        }),
      }),
    },
  };
});

// We mock the CloudClientService module so we can control isConnected/getTier
const mockIsConnected = jest.fn<boolean, []>();
const mockGetTier = jest.fn<string, []>();

jest.mock('./cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      isConnected: mockIsConnected,
      getTier: mockGetTier,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Express Request. */
function mockReq(overrides: Partial<Request> = {}): Request {
  return { path: '/test', ...overrides } as unknown as Request;
}

/** Build a mock Express Response with chainable status/json. */
function mockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

const mockNext: NextFunction = jest.fn();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudAuthMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _warnTimestamps.clear();
  });

  // ----- isCloudConnected() -----------------------------------------------

  describe('isCloudConnected()', () => {
    it('should return true when client is connected', () => {
      mockIsConnected.mockReturnValue(true);
      expect(isCloudConnected()).toBe(true);
    });

    it('should return false when client is not connected', () => {
      mockIsConnected.mockReturnValue(false);
      expect(isCloudConnected()).toBe(false);
    });
  });

  // ----- requireCloudConnection -------------------------------------------

  describe('requireCloudConnection()', () => {
    it('should call next() when connected', () => {
      mockIsConnected.mockReturnValue(true);

      const req = mockReq();
      const res = mockRes();

      requireCloudConnection(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should respond 403 when not connected', () => {
      mockIsConnected.mockReturnValue(false);

      const req = mockReq();
      const res = mockRes();

      requireCloudConnection(req, res, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Cloud connection required'),
        }),
      );
    });
  });

  // ----- requireTier() ----------------------------------------------------

  describe('requireTier()', () => {
    it('should call next() when tier meets requirement', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetTier.mockReturnValue('enterprise');

      const middleware = requireTier('pro');
      const req = mockReq();
      const res = mockRes();

      middleware(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should call next() when tier exactly matches requirement', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetTier.mockReturnValue('pro');

      const middleware = requireTier('pro');
      const req = mockReq();
      const res = mockRes();

      middleware(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should respond 403 when tier is insufficient', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetTier.mockReturnValue('free');

      const middleware = requireTier('pro');
      const req = mockReq();
      const res = mockRes();

      middleware(req, res, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('requires a "pro" subscription'),
        }),
      );
    });

    it('should respond 403 when not connected', () => {
      mockIsConnected.mockReturnValue(false);

      const middleware = requireTier('pro');
      const req = mockReq();
      const res = mockRes();

      middleware(req, res, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Cloud connection required'),
        }),
      );
    });

    it('should respond 403 for enterprise requirement when tier is pro', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetTier.mockReturnValue('pro');

      const middleware = requireTier('enterprise');
      const req = mockReq();
      const res = mockRes();

      middleware(req, res, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('requires a "enterprise" subscription'),
        }),
      );
    });
  });

  // ----- Warning throttle (#212) -------------------------------------------

  describe('warning throttle (#212)', () => {
    it('should log warn on first not-connected request', () => {
      mockIsConnected.mockReturnValue(false);

      const middleware = requireTier('pro');
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);

      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Tier check failed: not connected',
        expect.objectContaining({ path: '/devices' }),
      );
    });

    it('should suppress repeated not-connected warnings for same path within throttle window', () => {
      mockIsConnected.mockReturnValue(false);

      const middleware = requireTier('pro');

      // First call — should warn
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);

      // Subsequent calls — should not warn (within 5 min)
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);

      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    });

    it('should still return 403 even when warning is throttled', () => {
      mockIsConnected.mockReturnValue(false);

      const middleware = requireTier('pro');

      // First call
      const res1 = mockRes();
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), res1, mockNext);
      expect(res1.status).toHaveBeenCalledWith(403);

      // Second call — warning throttled but 403 still returned
      const res2 = mockRes();
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), res2, mockNext);
      expect(res2.status).toHaveBeenCalledWith(403);
    });

    it('should warn again after throttle window expires', () => {
      mockIsConnected.mockReturnValue(false);

      const middleware = requireTier('pro');

      // First call
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);

      // Simulate time passing beyond throttle window
      const key = 'not-connected:/devices';
      _warnTimestamps.set(key, Date.now() - WARN_THROTTLE_MS - 1000);

      // Next call — should warn again
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    });

    it('should throttle insufficient-tier warnings independently', () => {
      mockIsConnected.mockReturnValue(true);
      mockGetTier.mockReturnValue('free');

      const middleware = requireTier('pro');

      // First call — should warn
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);

      // Repeated calls — suppressed
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);

      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    });

    it('should throttle different paths independently', () => {
      mockIsConnected.mockReturnValue(false);

      const middleware = requireTier('pro');

      // /devices path — first warn
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);

      // /other path — separate throttle, should also warn
      middleware(mockReq({ path: '/other' } as Partial<Request> as Request), mockRes(), mockNext);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(2);

      // /devices again — suppressed
      middleware(mockReq({ path: '/devices' } as Partial<Request> as Request), mockRes(), mockNext);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    });

    it('should export WARN_THROTTLE_MS as 5 minutes', () => {
      expect(WARN_THROTTLE_MS).toBe(5 * 60 * 1000);
    });
  });
});
