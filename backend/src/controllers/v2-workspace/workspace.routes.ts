/**
 * V2 Shared Workspace Routes
 *
 * Router for versioned JSON workspace CRUD with CAS.
 *
 * @module controllers/v2-workspace/workspace.routes
 */

import { Router } from 'express';
import {
  listWorkspaces,
  readWorkspace,
  createWorkspaceHandler,
  writeWorkspace,
  writeStructuredWorkspace,
  deleteWorkspace,
} from './workspace.controller.js';

/**
 * Create the V2 workspace router.
 *
 * @returns Express router for /api/v2/workspaces routes
 */
export function createV2WorkspaceRouter(): Router {
  const router = Router();

  // List all workspaces
  router.get('/', listWorkspaces);

  // Read a single workspace
  router.get('/:id', readWorkspace);

  // Create a new workspace
  router.post('/', createWorkspaceHandler);

  // Write data to workspace (CAS — 409 on conflict)
  router.put('/:id', writeWorkspace);

  // Structured write to specific path (CAS — 409 on conflict)
  router.put('/:id/structured', writeStructuredWorkspace);

  // Delete workspace
  router.delete('/:id', deleteWorkspace);

  return router;
}
