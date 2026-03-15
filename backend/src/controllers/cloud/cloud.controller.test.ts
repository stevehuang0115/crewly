/**
 * Tests for Cloud Controller
 *
 * @module controllers/cloud/cloud.controller.test
 */

import type { Request, Response, NextFunction } from 'express';
import { connectToCloud, disconnectFromCloud, getCloudStatus, getCloudTemplates, validateCloudToken, refreshCloudToken } from './cloud.controller.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyJwt = jest.fn();
const mockSignJwt = jest.fn();

jest.mock('./cloud-google-auth.controller.js', () => ({
  verifyJwt: (...args: unknown[]) => mockVerifyJwt(...args),
  signJwt: (...args: unknown[]) => mockSignJwt(...args),
}));

jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

const mockConnect = jest.fn();
const mockConnectLocal = jest.fn();
const mockDisconnect = jest.fn();
const mockGetStatus = jest.fn();
const mockGetTemplates = jest.fn();
const mockIsConnected = jest.fn();

jest.mock('../../services/cloud/cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      connect: mockConnect,
      connectLocal: mockConnectLocal,
      disconnect: mockDisconnect,
      getStatus: mockGetStatus,
      getTemplates: mockGetTemplates,
      isConnected: mockIsConnected,
      getCloudUrl: jest.fn().mockReturnValue(null),
    }),
  },
}));

const mockRelayConnect = jest.fn();
const mockRelayDisconnect = jest.fn();
const mockRelayGetState = jest.fn().mockReturnValue('disconnected');

jest.mock('../../services/cloud/relay-client.service.js', () => ({
  RelayClientService: {
    getInstance: () => ({
      connect: mockRelayConnect,
      disconnect: mockRelayDisconnect,
      getState: mockRelayGetState,
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
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

const mockNext: NextFunction = jest.fn();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cloud Controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
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
      expect(mockConnectLocal).toHaveBeenCalledWith('https://cloud.test.com', 'test-token', 'pro');
      expect(mockConnect).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { tier: 'pro' },
      });
    });

    it('should fall back to remote connect when local JWT verification fails', async () => {
      mockVerifyJwt.mockReturnValue(null);
      mockConnect.mockResolvedValue({ success: true, tier: 'pro' });
      mockVerifyJwt.mockReturnValue({ sub: 'user-1' });

      const req = mockReq({ body: { token: 'test-token', cloudUrl: 'https://cloud.test.com' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      expect(mockConnect).toHaveBeenCalledWith('https://cloud.test.com', 'test-token');
      expect(mockConnectLocal).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { tier: 'pro' },
      });
    });

    it('should auto-connect relay after successful cloud connect', async () => {
      mockConnect.mockResolvedValue({ success: true, tier: 'pro' });
      mockVerifyJwt.mockReturnValue({ sub: 'user-1', email: 'test@test.com' });
      mockRelayGetState.mockReturnValue('disconnected');

      const req = mockReq({ body: { token: 'test-token', cloudUrl: 'https://cloud.test.com' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      expect(mockRelayConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          wsUrl: expect.stringContaining('relay'),
          pairingCode: expect.any(String),
          role: 'orchestrator',
          token: 'test-token',
          sharedSecret: expect.any(String),
        }),
      );
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
      mockRelayGetState.mockReturnValue('disconnected');

      const req = mockReq({ body: { token: 'test-token', cloudUrl: 'https://cloud.test.com' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      // Allow the async handshake to fire
      await new Promise((r) => setTimeout(r, 50));

      // Handshake should be called via fetch
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
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('handshake'),
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
      mockRelayGetState.mockReturnValue('disconnected');
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      const req = mockReq({ body: { token: 'test-token' } });
      const res = mockRes();

      await connectToCloud(req, res, mockNext);

      // Cloud connect still returns success despite handshake failure
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
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(cloudResponse),
      });

      const req = mockReq({ headers: { authorization: 'Bearer test-token' } as any });
      const res = mockRes();

      await validateCloudToken(req, res, mockNext);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.crewlyai.com/api/cloud/validate',
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
});
