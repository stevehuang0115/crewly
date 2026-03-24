import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Tests for Cloud Controller
 *
 * @module controllers/cloud/cloud.controller.test
 */

import type { Request, Response, NextFunction } from 'express';
import { connectToCloud, disconnectFromCloud, getCloudStatus, getCloudTemplates, validateCloudToken, refreshCloudToken, getDeviceId } from './cloud.controller.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyJwt = vi.fn();
const mockSignJwt = vi.fn();

vi.mock('./cloud-google-auth.controller.js', () => ({
  verifyJwt: (...args: unknown[]) => mockVerifyJwt(...args),
  signJwt: (...args: unknown[]) => mockSignJwt(...args),
}));

vi.mock('../../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  },
}));

const mockConnect = vi.fn();
const mockConnectLocal = vi.fn();
const mockDisconnect = vi.fn();
const mockGetStatus = vi.fn();
const mockGetTemplates = vi.fn();
const mockIsConnected = vi.fn();

vi.mock('../../services/cloud/cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      connect: mockConnect,
      connectLocal: mockConnectLocal,
      disconnect: mockDisconnect,
      getStatus: mockGetStatus,
      getTemplates: mockGetTemplates,
      isConnected: mockIsConnected,
      getCloudUrl: vi.fn().mockReturnValue(null),
      getToken: vi.fn().mockReturnValue('test-token'),
      setRefreshToken: vi.fn(),
    }),
  },
}));

const mockSyncStart = vi.fn();
const mockSyncStop = vi.fn();

vi.mock('../../services/cloud/cloud-sync.service.js', () => ({
  CloudSyncService: {
    getInstance: () => ({
      start: mockSyncStart,
      stop: mockSyncStop,
    }),
  },
}));

const mockGetOrCreateIdentity = vi.fn().mockResolvedValue({
  deviceId: 'test-device-uuid',
  deviceName: 'test-hostname',
});

vi.mock('../../services/cloud/device-identity.service.js', () => ({
  DeviceIdentityService: {
    getInstance: () => ({
      getOrCreateIdentity: mockGetOrCreateIdentity,
    }),
  },
}));

vi.mock('../../services/core/storage.service.js', () => ({
  StorageService: {
    getInstance: () => ({
      getTeams: vi.fn().mockResolvedValue([
        { id: 'team-1', name: 'Product', members: [{ agentStatus: 'active' }, { agentStatus: 'inactive' }] },
        { id: 'team-2', name: 'Marketing', members: [{ agentStatus: 'active' }] },
      ]),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Express Request. */
function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

/** Build a mock Express Response with chainable status/json. */
function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

const mockNext: NextFunction = vi.fn();

const originalFetch = global.fetch;
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ success: true }),
}) as vi.Mock;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cloud Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  // ----- connectToCloud ---------------------------------------------------

  describe('connectToCloud()', () => {
    it('should connect locally when JWT verifies locally', async () => {
      mockVerifyJwt.mockReturnValue({ sub: 'user-1', plan: 'pro' });

      const req = mockReq({ body: { token: 'test-token', cloudUrl: 'https://cloud.test.com' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      // Local verification → connectLocal instead of connect
      // 4th arg is refreshToken (undefined when not provided)
      expect(mockConnectLocal).toHaveBeenCalledWith('https://cloud.test.com', 'test-token', 'pro', undefined);
      expect(mockConnect).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { tier: 'pro' },
      });
    });

    it('should fall back to remote connect when local JWT verification fails', async () => {
      // First call (verifyJwt in connectToCloud) → null → remote path
      // Second call (verifyJwt in autoConnectRelay) → still null → relay skipped
      mockVerifyJwt.mockReturnValue(null);
      mockConnect.mockResolvedValue({ success: true, tier: 'pro' });

      const req = mockReq({ body: { token: 'test-token', cloudUrl: 'https://cloud.test.com' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      // refreshToken is undefined when not provided in body
      expect(mockConnect).toHaveBeenCalledWith('https://cloud.test.com', 'test-token', undefined);
      expect(mockConnectLocal).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { tier: 'pro' },
      });
    });

    it('should use default cloud URL when not provided', async () => {
      mockVerifyJwt.mockReturnValue(null);
      mockConnect.mockResolvedValue({ success: true, tier: 'free' });

      const req = mockReq({ body: { token: 'test-token' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      expect(mockConnect).toHaveBeenCalledWith(
        expect.stringContaining('crewly'),
        'test-token',
        undefined,
      );
    });

    it('should return 400 when token is missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('token'),
        }),
      );
    });

    it('should return 401 on authentication failure', async () => {
      mockVerifyJwt.mockReturnValue(null);
      mockConnect.mockRejectedValue(new Error('Cloud authentication failed: 401 Unauthorized'));

      const req = mockReq({ body: { token: 'bad-token' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should call next on unexpected error', async () => {
      mockVerifyJwt.mockReturnValue(null);
      const error = new Error('Network error');
      mockConnect.mockRejectedValue(error);

      const req = mockReq({ body: { token: 'test-token' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });

    it('should send cloud handshake with device metadata after connect', async () => {
      mockVerifyJwt.mockReturnValue({ sub: 'user-1', plan: 'pro' });


      const req = mockReq({ body: { token: 'test-token', cloudUrl: 'https://cloud.test.com' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      // Allow the async handshake to fire
      await new Promise((r) => setTimeout(r, 50));

      // Handshake should be called via fetch (now uses /api/v1/relay/handshake)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/relay/handshake'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );

      // Verify the payload structure
      const callArgs = mockFetch.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/relay/handshake'),
      );
      expect(callArgs).toBeDefined();
      const body = JSON.parse(callArgs![1].body);
      expect(body.deviceId).toBe('test-device-uuid');
      expect(body.deviceName).toBe('test-hostname');
      expect(body.teams).toHaveLength(2);
      expect(body.teams[0].name).toBe('Product');
      expect(body.teams[0].memberCount).toBe(2);
      expect(body.teams[0].activeAgents).toBe(1);
      expect(body.timestamp).toBeDefined();
    });

    it('should not fail cloud connect if handshake fails', async () => {
      mockVerifyJwt.mockReturnValue({ sub: 'user-1', plan: 'pro' });

      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      const req = mockReq({ body: { token: 'test-token' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      // Cloud connect still returns success despite handshake failure
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should start CloudSyncService after successful cloud connect', async () => {
      mockVerifyJwt.mockReturnValue({ sub: 'user-1', plan: 'pro' });


      const req = mockReq({ body: { token: 'test-token', cloudUrl: 'https://cloud.test.com' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      expect(mockSyncStart).toHaveBeenCalledWith({
        cloudUrl: 'https://cloud.test.com',
        token: 'test-token',
        deviceId: 'test-device-uuid',
        deviceName: 'test-hostname',
      });
    });

    it('should not fail cloud connect if CloudSyncService.start throws', async () => {
      mockVerifyJwt.mockReturnValue({ sub: 'user-1', plan: 'pro' });

      mockSyncStart.mockImplementation(() => { throw new Error('Sync failed'); });

      const req = mockReq({ body: { token: 'test-token' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  // ----- disconnectFromCloud ----------------------------------------------

  describe('disconnectFromCloud()', () => {
    it('should disconnect and return success', async () => {
      const req = mockReq();
      const res = mockRes();

      await disconnectFromCloud(req, res, mockNext);

      expect(mockDisconnect).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('should stop CloudSyncService on disconnect', async () => {
      const req = mockReq();
      const res = mockRes();

      await disconnectFromCloud(req, res, mockNext);

      expect(mockSyncStop).toHaveBeenCalled();
    });
  });

  // ----- getCloudStatus ---------------------------------------------------

  describe('getCloudStatus()', () => {
    it('should return current status', async () => {
      const status = {
        connectionStatus: 'connected',
        cloudUrl: 'https://cloud.test.com',
        tier: 'pro',
        lastSyncAt: '2026-03-07T00:00:00.000Z',
      };
      mockGetStatus.mockReturnValue(status);

      const req = mockReq();
      const res = mockRes();

      await getCloudStatus(req, res, mockNext);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: status,
      });
    });
  });

  // ----- getCloudTemplates ------------------------------------------------

  describe('getCloudTemplates()', () => {
    it('should return templates when connected', async () => {
      mockIsConnected.mockReturnValue(true);
      const templates = [{ id: '1', name: 'Template 1' }];
      mockGetTemplates.mockResolvedValue(templates);

      const req = mockReq();
      const res = mockRes();

      await getCloudTemplates(req, res, mockNext);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: templates,
      });
    });

    it('should return 403 when not connected', async () => {
      mockIsConnected.mockReturnValue(false);

      const req = mockReq();
      const res = mockRes();

      await getCloudTemplates(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Not connected'),
        }),
      );
    });

    it('should call next on fetch error', async () => {
      mockIsConnected.mockReturnValue(true);
      const error = new Error('Fetch failed');
      mockGetTemplates.mockRejectedValue(error);

      const req = mockReq();
      const res = mockRes();

      await getCloudTemplates(req, res, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  // ----- validateCloudToken ------------------------------------------------

  describe('validateCloudToken()', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const req = mockReq({ headers: {} as any });
      const res = mockRes();

      await validateCloudToken(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Authorization') }),
      );
    });

    it('should validate JWT locally and return user profile', async () => {
      mockVerifyJwt.mockReturnValue({
        sub: 'u1',
        email: 'test@test.com',
        name: 'Test User',
        plan: 'pro',
      });

      const req = mockReq({ headers: { authorization: 'Bearer valid-jwt' } as any });
      const res = mockRes();

      await validateCloudToken(req, res, mockNext);

      expect(mockVerifyJwt).toHaveBeenCalledWith('valid-jwt');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          id: 'u1',
          email: 'test@test.com',
          displayName: 'Test User',
          plan: 'pro',
        },
      });
    });

    it('should return 401 when JWT is invalid and no proxy configured', async () => {
      mockVerifyJwt.mockReturnValue(null);
      delete process.env['CREWLY_CLOUD_API_BASE'];

      const req = mockReq({ headers: { authorization: 'Bearer invalid-jwt' } as any });
      const res = mockRes();

      await validateCloudToken(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Invalid or expired') }),
      );
    });

    it('should proxy to cloud API when local verification fails and CREWLY_CLOUD_API_BASE is set', async () => {
      mockVerifyJwt.mockReturnValue(null);
      process.env['CREWLY_CLOUD_API_BASE'] = 'https://api.crewlyai.com/api';

      const cloudResponse = { success: true, data: { id: 'u1', email: 'test@test.com', plan: 'pro' } };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(cloudResponse),
      });

      const req = mockReq({ headers: { authorization: 'Bearer test-token' } as any });
      const res = mockRes();

      await validateCloudToken(req, res, mockNext);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/cloud/validate'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(cloudResponse);

      delete process.env['CREWLY_CLOUD_API_BASE'];
    });
  });

  // ----- refreshCloudToken ------------------------------------------------

  describe('refreshCloudToken()', () => {
    it('should return 400 when refreshToken is missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();

      await refreshCloudToken(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 401 when refresh token is invalid', async () => {
      mockVerifyJwt.mockReturnValue(null);

      const req = mockReq({ body: { refreshToken: 'bad-token' } });
      const res = mockRes();

      await refreshCloudToken(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should return 401 when token type is not refresh', async () => {
      mockVerifyJwt.mockReturnValue({ sub: 'u1', type: 'access' });

      const req = mockReq({ body: { refreshToken: 'access-token' } });
      const res = mockRes();

      await refreshCloudToken(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should issue new access token on valid refresh token', async () => {
      mockVerifyJwt.mockReturnValue({ sub: 'u1', email: 'test@test.com', name: 'Test', plan: 'pro', type: 'refresh' });
      mockSignJwt.mockReturnValue('new-access-token');

      const req = mockReq({ body: { refreshToken: 'valid-refresh' } });
      const res = mockRes();

      await refreshCloudToken(req, res, mockNext);

      expect(mockSignJwt).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'u1',
          type: 'access',
        }),
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          accessToken: 'new-access-token',
          expiresIn: expect.any(Number),
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // getDeviceId
  // -------------------------------------------------------------------------

  describe('getDeviceId', () => {
    it('should return deviceId and deviceName from DeviceIdentityService', async () => {
      const req = mockReq();
      const res = mockRes();

      await getDeviceId(req, res, mockNext);

      expect(mockGetOrCreateIdentity).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          deviceId: 'test-device-uuid',
          deviceName: 'test-hostname',
        },
      });
    });

    it('should call next on error', async () => {
      mockGetOrCreateIdentity.mockRejectedValueOnce(new Error('disk error'));
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      await getDeviceId(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
