/**
 * Tests for require-auth middleware
 *
 * Covers JWT verification, dev fallback, and production guard.
 *
 * @module middleware/require-auth.test
 */

import { requireAuth, verifyHs256Token, type AuthenticatedRequest } from './require-auth.middleware.js';
import { createHmac } from 'crypto';
import type { Request, Response } from 'express';

// Mock LoggerService
jest.mock('../services/core/logger.service.js', () => ({
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

/** Helper to create a valid HS256 JWT */
function createTestJwt(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('require-auth middleware', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('verifyHs256Token', () => {
    const secret = 'test-secret-key';

    it('should return payload for a valid token', () => {
      const token = createTestJwt({ sub: 'user-1', email: 'test@example.com' }, secret);
      const result = verifyHs256Token(token, secret);
      expect(result).toMatchObject({ sub: 'user-1', email: 'test@example.com' });
    });

    it('should return null for an expired token', () => {
      const token = createTestJwt({ sub: 'user-1', exp: 1000 }, secret);
      const result = verifyHs256Token(token, secret);
      expect(result).toBeNull();
    });

    it('should return null for a wrong secret', () => {
      const token = createTestJwt({ sub: 'user-1' }, secret);
      const result = verifyHs256Token(token, 'wrong-secret');
      expect(result).toBeNull();
    });

    it('should return null for malformed token', () => {
      expect(verifyHs256Token('not.a.jwt', secret)).toBeNull();
      expect(verifyHs256Token('onlyone', secret)).toBeNull();
      expect(verifyHs256Token('', secret)).toBeNull();
    });

    it('should return null for non-HS256 algorithm', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
      const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
      expect(verifyHs256Token(`${header}.${body}.${sig}`, secret)).toBeNull();
    });

    it('should accept a token without exp field', () => {
      const token = createTestJwt({ sub: 'user-1' }, secret);
      const result = verifyHs256Token(token, secret);
      expect(result).toMatchObject({ sub: 'user-1' });
    });
  });

  describe('requireAuth middleware', () => {
    const mockNext = jest.fn();
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let statusFn: jest.Mock;
    let jsonFn: jest.Mock;

    beforeEach(() => {
      mockNext.mockClear();
      jsonFn = jest.fn();
      statusFn = jest.fn().mockReturnValue({ json: jsonFn });
      mockReq = { headers: {} };
      mockRes = { status: statusFn, json: jsonFn } as any;
    });

    it('should pass through in dev mode when no JWT_SECRET is set', () => {
      delete process.env['CREWLY_JWT_SECRET'];
      process.env['NODE_ENV'] = 'development';

      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect((mockReq as AuthenticatedRequest).user).toEqual({
        userId: 'dev-user-001',
        email: 'dev@crewly.local',
        plan: 'max',
      });
    });

    it('should block requests in production without JWT_SECRET', () => {
      delete process.env['CREWLY_JWT_SECRET'];
      process.env['NODE_ENV'] = 'production';

      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusFn).toHaveBeenCalledWith(500);
    });

    it('should reject requests without Authorization header when JWT_SECRET is set', () => {
      process.env['CREWLY_JWT_SECRET'] = 'my-secret';
      mockReq.headers = {};

      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusFn).toHaveBeenCalledWith(401);
    });

    it('should reject requests with invalid token', () => {
      process.env['CREWLY_JWT_SECRET'] = 'my-secret';
      mockReq.headers = { authorization: 'Bearer invalid.token.here' };

      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusFn).toHaveBeenCalledWith(401);
    });

    it('should authenticate and attach user for valid token', () => {
      const secret = 'my-test-secret';
      process.env['CREWLY_JWT_SECRET'] = secret;
      const token = createTestJwt(
        { sub: 'user-42', email: 'user@test.com', plan: 'pro' },
        secret,
      );
      mockReq.headers = { authorization: `Bearer ${token}` };

      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect((mockReq as AuthenticatedRequest).user).toEqual({
        userId: 'user-42',
        email: 'user@test.com',
        plan: 'pro',
      });
    });

    it('should reject token without sub claim', () => {
      const secret = 'my-test-secret';
      process.env['CREWLY_JWT_SECRET'] = secret;
      const token = createTestJwt({ email: 'no-sub@test.com' }, secret);
      mockReq.headers = { authorization: `Bearer ${token}` };

      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusFn).toHaveBeenCalledWith(401);
    });
  });
});
