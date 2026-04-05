/**
 * V2 Shared Workspace Controller
 *
 * CRUD + CAS endpoints for versioned JSON workspaces.
 *
 * Endpoints:
 * - GET    /api/v2/workspaces          — list all workspaces
 * - GET    /api/v2/workspaces/:id      — read workspace (data + version)
 * - POST   /api/v2/workspaces          — create workspace
 * - PUT    /api/v2/workspaces/:id      — write data (CAS, 409 on conflict)
 * - PUT    /api/v2/workspaces/:id/structured — structured write (path + value)
 * - DELETE /api/v2/workspaces/:id      — delete workspace
 *
 * @module controllers/v2-workspace/workspace.controller
 */

import type { Request, Response, NextFunction } from 'express';
import type { WorkspaceService } from '../../services/workspace/workspace.service.js';
import {
  WorkspaceConflictError,
  WorkspaceAccessError,
  validateCreateWorkspaceInput,
  validateWriteWorkspaceInput,
} from '../../types/v2/workspace.types.js';
import type {
  CreateWorkspaceInput,
  WriteWorkspaceInput,
  StructuredWriteInput,
} from '../../types/v2/workspace.types.js';

/** Module-level reference to the workspace service */
let workspaceService: WorkspaceService | null = null;

/**
 * Set the WorkspaceService instance.
 * Called during server initialization.
 *
 * @param service - The WorkspaceService instance
 */
export function setWorkspaceService(service: WorkspaceService): void {
  workspaceService = service;
}

// ---------------------------------------------------------------------------
// Error Mapping Helper
// ---------------------------------------------------------------------------

/**
 * Maps domain errors to HTTP responses.
 * Returns true if the error was handled, false otherwise.
 *
 * @param error - The caught error
 * @param res - Express response
 * @returns True if the error was mapped to a response
 */
function handleDomainError(error: unknown, res: Response): boolean {
  if (error instanceof WorkspaceConflictError) {
    res.status(409).json({
      success: false,
      error: error.message,
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    });
    return true;
  }

  if (error instanceof WorkspaceAccessError) {
    res.status(403).json({
      success: false,
      error: error.message,
    });
    return true;
  }

  if (error instanceof Error && error.message.includes('not found')) {
    res.status(404).json({
      success: false,
      error: error.message,
    });
    return true;
  }

  if (error instanceof Error && error.message.includes('not in structured mode')) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/v2/workspaces
 *
 * Lists all workspaces with full data.
 */
export async function listWorkspaces(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!workspaceService) {
      res.status(503).json({ success: false, error: 'Workspace service not initialized' });
      return;
    }

    const workspaces = await workspaceService.listAll();
    res.json({ success: true, data: workspaces });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v2/workspaces/:id
 *
 * Reads a single workspace. Returns the full workspace including data and version.
 */
export async function readWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!workspaceService) {
      res.status(503).json({ success: false, error: 'Workspace service not initialized' });
      return;
    }

    const { id } = req.params;
    const workspace = await workspaceService.read(id);

    if (!workspace) {
      res.status(404).json({ success: false, error: `Workspace '${id}' not found` });
      return;
    }

    res.json({ success: true, data: workspace });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v2/workspaces
 *
 * Creates a new workspace.
 * Body: CreateWorkspaceInput (name, ownerType, ownerId required)
 */
export async function createWorkspaceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!workspaceService) {
      res.status(503).json({ success: false, error: 'Workspace service not initialized' });
      return;
    }

    const input = req.body as CreateWorkspaceInput;
    const validationErrors = validateCreateWorkspaceInput(input);
    if (validationErrors.length > 0) {
      res.status(400).json({ success: false, errors: validationErrors });
      return;
    }

    const workspace = await workspaceService.create(input);
    res.status(201).json({ success: true, data: workspace });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/v2/workspaces/:id
 *
 * Writes data to a workspace with CAS validation.
 * Body: { expectedVersion: number, data: {}, writerId: string }
 *
 * Returns 409 Conflict if expectedVersion doesn't match current version.
 * Returns 403 Forbidden if writerId is not authorized.
 */
export async function writeWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!workspaceService) {
      res.status(503).json({ success: false, error: 'Workspace service not initialized' });
      return;
    }

    const { id } = req.params;
    const input = req.body as WriteWorkspaceInput;

    const validationErrors = validateWriteWorkspaceInput(input);
    if (validationErrors.length > 0) {
      res.status(400).json({ success: false, errors: validationErrors });
      return;
    }

    const updated = await workspaceService.write(id, input);
    res.json({ success: true, data: updated });
  } catch (error) {
    if (handleDomainError(error, res)) return;
    next(error);
  }
}

/**
 * PUT /api/v2/workspaces/:id/structured
 *
 * Structured write — sets a value at a specific dot-notation path.
 * Body: { expectedVersion: number, path: string, value: any, writerId: string }
 *
 * Workspace must be in 'structured' access mode.
 * Returns 409 Conflict if expectedVersion doesn't match.
 * Returns 403 Forbidden if writerId is not authorized.
 * Returns 400 if workspace is not in structured mode.
 */
export async function writeStructuredWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!workspaceService) {
      res.status(503).json({ success: false, error: 'Workspace service not initialized' });
      return;
    }

    const { id } = req.params;
    const input = req.body as StructuredWriteInput;

    // Validate structured write input
    if (typeof input.expectedVersion !== 'number' || input.expectedVersion < 1) {
      res.status(400).json({ success: false, error: 'expectedVersion must be a positive integer' });
      return;
    }
    if (!input.path || typeof input.path !== 'string') {
      res.status(400).json({ success: false, error: 'path is required and must be a non-empty string' });
      return;
    }
    if (!input.writerId || typeof input.writerId !== 'string') {
      res.status(400).json({ success: false, error: 'writerId is required and must be a non-empty string' });
      return;
    }

    const updated = await workspaceService.writeStructured(id, input);
    res.json({ success: true, data: updated });
  } catch (error) {
    if (handleDomainError(error, res)) return;
    next(error);
  }
}

/**
 * DELETE /api/v2/workspaces/:id
 *
 * Deletes a workspace.
 */
export async function deleteWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!workspaceService) {
      res.status(503).json({ success: false, error: 'Workspace service not initialized' });
      return;
    }

    const { id } = req.params;
    const deleted = await workspaceService.delete(id);

    if (!deleted) {
      res.status(404).json({ success: false, error: `Workspace '${id}' not found` });
      return;
    }

    res.json({ success: true, message: `Workspace '${id}' deleted` });
  } catch (error) {
    next(error);
  }
}
