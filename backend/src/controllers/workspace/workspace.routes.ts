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
import { ownerOnly } from '../../middleware/caller-identity.middleware.js';

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

  // GET /api/workspace/token?userId=xxx — Get a fresh Google access token.
  // Owner-only: a raw Google token bypasses per-person connector access
  // (specs/2026-10-04-agent-credential-isolation.md). Agents use the
  // connector skills (docs-read, drive-read, …), which never hand out tokens.
  router.get('/token', requireAuth, ownerOnly({
    success: false,
    error: 'owner_only',
    message: 'Raw Google tokens are not available to agents. Use the docs-read/drive-read/sheets-read skills instead.',
  }), getWorkspaceToken);

  // GET /api/workspace/scopes — List available Workspace scopes
  router.get('/scopes', requireAuth, listWorkspaceScopes);

  return router;
}
