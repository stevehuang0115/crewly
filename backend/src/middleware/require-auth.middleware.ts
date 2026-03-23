/**
 * Authentication Middleware
 *
 * Guards protected API routes by requiring one of:
 * 1. A valid `X-Agent-Session` header (local agent identity)
 * 2. A valid `Authorization: Bearer <token>` header (cloud/external auth)
 * 3. `CREWLY_AUTH_DISABLED=true` env var (development/local-only bypass)
 *
 * When CREWLY_AUTH_DISABLED is set (the default for local installs), all
 * requests are allowed through to maintain backward compatibility.
 *
 * @module middleware/require-auth
 */

import type { Request, Response, NextFunction } from 'express';
import { LoggerService } from '../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('RequireAuth');

/**
 * Environment variable to set a static API key for auth.
 * When set, `Authorization: Bearer <key>` must match this value.
 */
const CREWLY_API_KEY = process.env['CREWLY_API_KEY'];

/**
 * Environment variable to explicitly disable auth (default: true for local).
 * Set to 'false' to enforce authentication.
 */
const AUTH_DISABLED = process.env['CREWLY_AUTH_DISABLED']?.toLowerCase() !== 'false';

/**
 * Express middleware that enforces authentication on protected routes.
 *
 * Authentication passes if any of these conditions are met:
 * - `CREWLY_AUTH_DISABLED` is not explicitly set to 'false' (default: auth off)
 * - Request has a non-empty `X-Agent-Session` header (local agent)
 * - Request has a valid `Authorization: Bearer <token>` matching CREWLY_API_KEY
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Express next function
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  // Development/local bypass: auth disabled by default
  if (AUTH_DISABLED) {
    next();
    return;
  }

  // Local agent identity: X-Agent-Session header
  const agentSession = req.headers['x-agent-session'];
  if (agentSession && typeof agentSession === 'string' && agentSession.length > 0) {
    next();
    return;
  }

  // Bearer token: validate against CREWLY_API_KEY
  const authHeader = req.headers['authorization'];
  if (authHeader && typeof authHeader === 'string') {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token.length > 0 && CREWLY_API_KEY && token === CREWLY_API_KEY) {
      next();
      return;
    }
  }

  // No valid credentials
  logger.warn('Unauthorized request to protected route', {
    path: req.path,
    method: req.method,
    hasAuthHeader: !!authHeader,
    hasAgentSession: !!agentSession,
  });

  res.status(401).json({
    success: false,
    error: 'Authentication required. Provide X-Agent-Session header or Authorization: Bearer <token>.',
  });
};
