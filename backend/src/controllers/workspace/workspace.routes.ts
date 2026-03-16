/**
 * Google Workspace API Routes
 *
 * Mounts workspace-related endpoints under /api/workspace/.
 *
 * @module controllers/workspace/workspace.routes
 */

import { Router } from 'express';
import { getWorkspaceToken, listWorkspaceScopes } from './workspace.controller.js';
import { requireAuth } from '../../middleware/require-auth.middleware.js';

/**
 * Create the Workspace API router.
 *
 * All endpoints are protected by requireAuth middleware to ensure
 * only authenticated users/agents can access Workspace tokens.
 *
 * @returns Express Router with workspace endpoints
 */
export function createWorkspaceRouter(): Router {
  const router = Router();

  // GET /api/workspace/token?userId=xxx — Get a fresh Google access token
  router.get('/token', requireAuth, getWorkspaceToken);

  // GET /api/workspace/scopes — List available Workspace scopes
  router.get('/scopes', requireAuth, listWorkspaceScopes);

  return router;
}
