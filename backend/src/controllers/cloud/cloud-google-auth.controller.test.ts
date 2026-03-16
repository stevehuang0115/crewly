/**
 * Tests for Cloud Google Auth Controller
 *
 * Tests the Google OAuth login flow for CrewlyAI Cloud Portal.
 *
 * @module controllers/cloud/cloud-google-auth.controller.test
 */

import type { Request, Response, NextFunction } from 'express';
import { cloudGoogleStart, cloudGoogleCallback } from './cloud-google-auth.controller.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

const mockCreateOrUpdateUser = jest.fn();
const mockConnectService = jest.fn();

jest.mock('../../services/user/user-identity.service.js', () => ({
  UserIdentityService: {
    getInstance: () => ({
      createOrUpdateUser: mockCreateOrUpdateUser,
      connectService: mockConnectService,
    }),
  },
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    protocol: 'https',
    get: jest.fn().mockReturnValue('api.crewlyai.com'),
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { _redirectUrl?: string } {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockImplementation(function (this: { _redirectUrl?: string }, url: string) {
      this._redirectUrl = url;
    }),
    _redirectUrl: undefined,
  };
  return res as unknown as Response & { _redirectUrl?: string };
}

const mockNext: NextFunction = jest.fn();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cloud Google Auth Controller', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env['GOOGLE_CLIENT_ID'] = 'test-client-id';
    process.env['GOOGLE_CLIENT_SECRET'] = 'test-client-secret';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ----- cloudGoogleStart -------------------------------------------------

  describe('cloudGoogleStart()', () => {
    it('should redirect to Google OAuth consent screen', async () => {
      const req = mockReq();
      const res = mockRes();

      await cloudGoogleStart(req, res, mockNext);

      expect(res.redirect).toHaveBeenCalledTimes(1);
      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('accounts.google.com');
      expect(redirectUrl).toContain('client_id=test-client-id');
      expect(redirectUrl).toContain('redirect_uri=');
      expect(redirectUrl).toContain('response_type=code');
    });

    it('should return 500 if GOOGLE_CLIENT_ID is not set', async () => {
      delete process.env['GOOGLE_CLIENT_ID'];

      const req = mockReq();
      const res = mockRes();

      await cloudGoogleStart(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('GOOGLE_CLIENT_ID'),
        }),
      );
    });

    it('should include state parameter with redirect info', async () => {
      const req = mockReq({ query: { redirect: '/dashboard' } });
      const res = mockRes();

      await cloudGoogleStart(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('state=');
    });
  });

  // ----- cloudGoogleCallback ----------------------------------------------

  describe('cloudGoogleCallback()', () => {
    it('should redirect to frontend with error if Google returns error param', async () => {
      const req = mockReq({ query: { error: 'access_denied' } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('/login?error=access_denied');
    });

    it('should redirect to frontend with error if code is missing', async () => {
      const req = mockReq({ query: {} });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('/login?error=missing_code');
    });

    it('should redirect with error if credentials not configured', async () => {
      delete process.env['GOOGLE_CLIENT_SECRET'];

      const req = mockReq({ query: { code: 'auth-code-123' } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('/login?error=');
    });

    it('should redirect with error if token exchange fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('invalid_grant'),
      });

      const req = mockReq({ query: { code: 'bad-code' } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('/login?error=token_exchange_failed');
    });

    it('should redirect with error if profile fetch fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'at-123', refresh_token: 'rt-456' }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: () => Promise.resolve('unauthorized'),
        });

      const req = mockReq({ query: { code: 'valid-code' } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('/login?error=profile_fetch_failed');
    });

    it('should redirect with error if profile has no email', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'at-123' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ name: 'No Email User' }),
        });

      const req = mockReq({ query: { code: 'valid-code' } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('/login?error=no_email');
    });

    it('should create user, issue JWT, and redirect with token on success', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ access_token: 'at-123', refresh_token: 'rt-456' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ email: 'user@example.com', name: 'Test User' }),
        });

      mockCreateOrUpdateUser.mockResolvedValue({
        id: 'user-001',
        email: 'user@example.com',
      });
      mockConnectService.mockResolvedValue(undefined);

      const req = mockReq({ query: { code: 'valid-code' } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      // Verify user was created
      expect(mockCreateOrUpdateUser).toHaveBeenCalledWith({ email: 'user@example.com' });

      // Verify Google tokens were stored
      expect(mockConnectService).toHaveBeenCalledWith('user-001', 'google', {
        refreshToken: 'rt-456',
        accessToken: 'at-123',
        scopes: ['openid', 'email', 'profile'],
      });

      // Verify redirect with JWT token
      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('token=');
      // JWT should have 3 parts separated by dots
      const tokenMatch = redirectUrl.match(/token=([^&]+)/);
      expect(tokenMatch).toBeTruthy();
      const token = tokenMatch![1];
      const parts = token.split('.');
      expect(parts).toHaveLength(3);

      // Verify JWT payload
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      expect(payload.sub).toBe('user-001');
      expect(payload.email).toBe('user@example.com');
      expect(payload.iss).toBe('crewly-cloud');
      expect(payload.type).toBe('access');
    });

    it('should use access_token as fallback when refresh_token is absent', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'at-only' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ email: 'user@example.com', name: 'Test' }),
        });

      mockCreateOrUpdateUser.mockResolvedValue({ id: 'user-002', email: 'user@example.com' });
      mockConnectService.mockResolvedValue(undefined);

      const req = mockReq({ query: { code: 'valid-code' } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      expect(mockConnectService).toHaveBeenCalledWith('user-002', 'google', {
        refreshToken: 'at-only',
        accessToken: 'at-only',
        scopes: ['openid', 'email', 'profile'],
      });
    });

    it('should respect state redirectTo parameter', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'at-123' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ email: 'user@example.com' }),
        });

      mockCreateOrUpdateUser.mockResolvedValue({ id: 'user-003', email: 'user@example.com' });
      mockConnectService.mockResolvedValue(undefined);

      const statePayload = { redirectTo: 'https://crewlyai.com/dashboard', t: Date.now(), nonce: '123' };
      const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

      const req = mockReq({ query: { code: 'valid-code', state } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl.startsWith('https://crewlyai.com/dashboard')).toBe(true);
    });

    it('should support legacy redirect field in state for backwards compatibility', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'at-123' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ email: 'user@example.com' }),
        });

      mockCreateOrUpdateUser.mockResolvedValue({ id: 'user-004', email: 'user@example.com' });
      mockConnectService.mockResolvedValue(undefined);

      const statePayload = { redirect: 'https://crewlyai.com/legacy', t: Date.now(), nonce: '456' };
      const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

      const req = mockReq({ query: { code: 'valid-code', state } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl.startsWith('https://crewlyai.com/legacy')).toBe(true);
    });

    it('should redirect with error when exchange fails with network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      const req = mockReq({ query: { code: 'valid-code' } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('/login?error=');
    });

    it('should use CLOUD_PORTAL_URL env var for redirects', async () => {
      process.env['CLOUD_PORTAL_URL'] = 'https://portal.example.com';

      const req = mockReq({ query: { error: 'access_denied' } });
      const res = mockRes();

      await cloudGoogleCallback(req, res, mockNext);

      const redirectUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
      expect(redirectUrl).toContain('portal.example.com');
    });
  });
});
