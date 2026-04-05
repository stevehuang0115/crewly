/**
 * V2 Shared Workspace Type Definitions
 *
 * A Workspace is a structured, versioned JSON document that agents can
 * read and write. Optimistic locking (CAS — Compare-And-Swap) ensures
 * consistency: writes must include the expectedVersion, and fail with
 * a conflict if another writer has updated the document since the read.
 *
 * Usage discipline (CEO requirement):
 * - Each workspace has an owner (agent/team/system)
 * - Schema defines allowed structure
 * - Access mode controls append vs overwrite
 * - Ownership prevents unauthorized writes
 *
 * @module types/v2/workspace.types
 */

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Enums & Literals
// ---------------------------------------------------------------------------

/**
 * Access mode for workspace writes.
 * - overwrite: Replace entire data on write
 * - append: Merge/append new data to existing
 * - structured: Write to specific paths within the document
 */
export type WorkspaceAccessMode = 'overwrite' | 'append' | 'structured';

/** All valid access modes. */
export const WORKSPACE_ACCESS_MODES: readonly WorkspaceAccessMode[] = [
  'overwrite',
  'append',
  'structured',
] as const;

/**
 * Who owns the workspace.
 */
export type WorkspaceOwnerType = 'agent' | 'team' | 'mission' | 'system';

/** All valid owner types. */
export const WORKSPACE_OWNER_TYPES: readonly WorkspaceOwnerType[] = [
  'agent',
  'team',
  'mission',
  'system',
] as const;

// ---------------------------------------------------------------------------
// Core Interface
// ---------------------------------------------------------------------------

/**
 * A versioned, structured JSON workspace.
 *
 * Each write increments the version counter. Reads return the current
 * version, which must be passed back on writes for CAS validation.
 */
export interface Workspace {
  /** UUID v4 */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Who owns this workspace */
  ownerType: WorkspaceOwnerType;
  /** Owner identifier (agent session, team ID, mission ID, or 'system') */
  ownerId: string;
  /** Access mode — how data can be modified */
  accessMode: WorkspaceAccessMode;
  /** The actual workspace data (arbitrary JSON-serializable object) */
  data: Record<string, unknown>;
  /** Monotonically increasing version number (starts at 1) */
  version: number;
  /** Which sessions are allowed to write (empty = owner only) */
  allowedWriters: string[];
  /** ISO8601 timestamps */
  createdAt: string;
  updatedAt: string;
  /** Who last wrote to this workspace */
  lastWrittenBy?: string;
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

/**
 * Input for creating a new Workspace.
 */
export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  ownerType: WorkspaceOwnerType;
  ownerId: string;
  accessMode?: WorkspaceAccessMode;
  data?: Record<string, unknown>;
  allowedWriters?: string[];
}

/**
 * Input for writing to a workspace.
 * Requires expectedVersion for CAS validation.
 */
export interface WriteWorkspaceInput {
  /** The version the client believes is current — CAS check */
  expectedVersion: number;
  /** New data to write (interpretation depends on accessMode) */
  data: Record<string, unknown>;
  /** Who is performing the write */
  writerId: string;
}

/**
 * Input for a structured write to a specific path.
 */
export interface StructuredWriteInput {
  /** The version the client believes is current */
  expectedVersion: number;
  /** Dot-notation path to write to (e.g., "results.phase1") */
  path: string;
  /** Value to set at the path */
  value: unknown;
  /** Who is performing the write */
  writerId: string;
}

// ---------------------------------------------------------------------------
// CAS Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a CAS conflict occurs.
 * The client's expectedVersion doesn't match the current version.
 */
export class WorkspaceConflictError extends Error {
  readonly workspaceId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(workspaceId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Workspace conflict: expected version ${expectedVersion} but current is ${actualVersion}`
    );
    this.name = 'WorkspaceConflictError';
    this.workspaceId = workspaceId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * Error thrown when a writer is not authorized.
 */
export class WorkspaceAccessError extends Error {
  readonly workspaceId: string;
  readonly writerId: string;

  constructor(workspaceId: string, writerId: string) {
    super(`Access denied: '${writerId}' is not authorized to write to workspace '${workspaceId}'`);
    this.name = 'WorkspaceAccessError';
    this.workspaceId = workspaceId;
    this.writerId = writerId;
  }
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Checks whether a string is a valid WorkspaceAccessMode.
 */
export function isValidWorkspaceAccessMode(value: string): value is WorkspaceAccessMode {
  return (WORKSPACE_ACCESS_MODES as readonly string[]).includes(value);
}

/**
 * Checks whether a string is a valid WorkspaceOwnerType.
 */
export function isValidWorkspaceOwnerType(value: string): value is WorkspaceOwnerType {
  return (WORKSPACE_OWNER_TYPES as readonly string[]).includes(value);
}

/**
 * Validates that an unknown value is structurally a valid Workspace.
 */
export function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.ownerType === 'string' &&
    isValidWorkspaceOwnerType(obj.ownerType) &&
    typeof obj.ownerId === 'string' &&
    typeof obj.accessMode === 'string' &&
    isValidWorkspaceAccessMode(obj.accessMode) &&
    typeof obj.data === 'object' && obj.data !== null &&
    typeof obj.version === 'number' && obj.version >= 1 &&
    Array.isArray(obj.allowedWriters) &&
    typeof obj.createdAt === 'string' &&
    typeof obj.updatedAt === 'string'
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates CreateWorkspaceInput.
 *
 * @param input - The creation input to validate
 * @returns Array of validation error strings (empty = valid)
 */
export function validateCreateWorkspaceInput(input: CreateWorkspaceInput): string[] {
  const errors: string[] = [];
  if (!input.name || typeof input.name !== 'string') {
    errors.push('name is required and must be a non-empty string');
  }
  if (!input.ownerType || !isValidWorkspaceOwnerType(input.ownerType)) {
    errors.push(`ownerType must be one of: ${WORKSPACE_OWNER_TYPES.join(', ')}`);
  }
  if (!input.ownerId || typeof input.ownerId !== 'string') {
    errors.push('ownerId is required and must be a non-empty string');
  }
  if (input.accessMode && !isValidWorkspaceAccessMode(input.accessMode)) {
    errors.push(`accessMode must be one of: ${WORKSPACE_ACCESS_MODES.join(', ')}`);
  }
  return errors;
}

/**
 * Validates WriteWorkspaceInput.
 */
export function validateWriteWorkspaceInput(input: WriteWorkspaceInput): string[] {
  const errors: string[] = [];
  if (typeof input.expectedVersion !== 'number' || input.expectedVersion < 1) {
    errors.push('expectedVersion must be a positive integer');
  }
  if (typeof input.data !== 'object' || input.data === null) {
    errors.push('data must be a non-null object');
  }
  if (!input.writerId || typeof input.writerId !== 'string') {
    errors.push('writerId is required and must be a non-empty string');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new Workspace with sensible defaults.
 *
 * @param input - Required and optional creation fields
 * @returns A fully populated Workspace at version 1
 *
 * @example
 * ```typescript
 * const ws = createWorkspace({
 *   name: 'Sprint 1 Results',
 *   ownerType: 'team',
 *   ownerId: 'team-product',
 * });
 * ```
 */
export function createWorkspace(input: CreateWorkspaceInput): Workspace {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    name: input.name,
    description: input.description,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    accessMode: input.accessMode ?? 'overwrite',
    data: input.data ?? {},
    version: 1,
    allowedWriters: input.allowedWriters ?? [],
    createdAt: now,
    updatedAt: now,
  };
}
