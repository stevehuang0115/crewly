/**
 * Authentication Middleware
 *
 * Verifies JWT tokens from the Authorization header and attaches
 * decoded user info to the request. Supports both Supabase JWTs
 * (via JWKS) and locally-signed JWTs (via CREWLY_JWT_SECRET).
 *
 * In development mode (NODE_ENV !== 'production' and no JWT secret),
 * falls through with a placeholder user to allow local testing.
 *
 * @module middleware/require-auth
 */

import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { LoggerService } from '../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('AuthMiddleware');

/** Shape of the decoded JWT payload we expect */
export interface JwtPayload {
  /** Subject — the user's unique ID */
  sub: string;
  /** User email address */
  email?: string;
  /** Subscription plan tier */
  plan?: string;
  /** Token issued-at timestamp (seconds) */
  iat?: number;
  /** Token expiration timestamp (seconds) */
  exp?: number;
}

/** User object attached to authenticated requests */
export interface AuthUser {
  userId: string;
  email: string;
  plan?: string;
}

/** Extended Request type with user attached */
export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

/**
 * Base64url decode a string segment.
 *
 * @param input - Base64url encoded string
 * @returns Decoded UTF-8 string
 */
function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

/**
 * Verify and decode an HS256 JWT token.
 *
 * @param token - The raw JWT string
 * @param secret - HMAC secret for signature verification
 * @returns Decoded payload or null if verification fails
 */
export function verifyHs256Token(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify header is HS256
  try {
    const header = JSON.parse(base64UrlDecode(headerB64));
    if (header.alg !== 'HS256') {
      return null;
    }
  } catch {
    return null;
  }

  // Verify signature
  const signatureInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac('sha256', secret)
    .update(signatureInput)
    .digest('base64url');

  // Timing-safe comparison
  const sigBuf = Buffer.from(signatureB64);
  const expectedBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  // Decode payload
  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as JwtPayload;

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Express middleware that enforces JWT authentication.
 *
 * Reads the token from the Authorization header (Bearer scheme).
 * On success, attaches `user` to the request. On failure, responds
 * with 401.
 *
 * In development (no JWT_SECRET and NODE_ENV !== 'production'),
 * falls through with a dev placeholder user.
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Express next function
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const jwtSecret = process.env['CREWLY_JWT_SECRET'];
  const isProduction = process.env['NODE_ENV'] === 'production';

  // Extract Bearer token
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // If JWT secret is configured, enforce real auth
  if (jwtSecret) {
    if (!token) {
      res.status(401).json({ success: false, error: 'Authorization header required' });
      return;
    }

    const payload = verifyHs256Token(token, jwtSecret);
    if (!payload || !payload.sub) {
      res.status(401).json({ success: false, error: 'Invalid or expired token' });
      return;
    }

    (req as AuthenticatedRequest).user = {
      userId: payload.sub,
      email: payload.email ?? '',
      plan: payload.plan,
    };

    next();
    return;
  }

  // No JWT secret configured
  if (isProduction) {
    logger.error('CREWLY_JWT_SECRET not set in production — blocking request');
    res.status(500).json({ success: false, error: 'Server authentication not configured' });
    return;
  }

  // Development fallback: allow requests with a dev placeholder
  logger.warn('Auth middleware in dev mode — using placeholder user');
  (req as AuthenticatedRequest).user = {
    userId: 'dev-user-001',
    email: 'dev@crewly.local',
    plan: 'max',
  };
  next();
};
