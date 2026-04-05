/**
 * WorkspaceService — Shared versioned JSON document store with CAS
 *
 * Provides read/write/update operations on Workspaces using optimistic
 * locking (Compare-And-Swap). Each write must provide the expectedVersion
 * matching the current version; mismatches result in a conflict error.
 *
 * Storage: JSON files + atomic write (reuses atomicWriteJson from file-io.utils).
 *
 * Usage discipline (CEO requirement):
 * - Owner-only writes by default, configurable via allowedWriters
 * - Access mode controls overwrite vs append vs structured
 * - All writes are audited (lastWrittenBy, updatedAt)
 *
 * @module services/workspace/workspace.service
 */

import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import type {
  Workspace,
  CreateWorkspaceInput,
  WriteWorkspaceInput,
  StructuredWriteInput,
} from '../../types/v2/index.js';
import {
  createWorkspace,
  WorkspaceConflictError,
  WorkspaceAccessError,
} from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Storage Interface (for testing / swappability)
// ---------------------------------------------------------------------------

/**
 * Abstraction over file I/O for workspace persistence.
 */
export interface WorkspaceStorage {
  /** Read a workspace from disk. Returns null if not found. */
  read(workspaceId: string): Promise<Workspace | null>;
  /** Write a workspace to disk (atomic). */
  write(workspace: Workspace): Promise<void>;
  /** Delete a workspace from disk. */
  delete(workspaceId: string): Promise<boolean>;
  /** List all workspace IDs. */
  listIds(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// File-based Storage Implementation
// ---------------------------------------------------------------------------

/**
 * File-based WorkspaceStorage using JSON files + atomic write.
 */
export class FileWorkspaceStorage implements WorkspaceStorage {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  }

  private filePath(id: string): string {
    return path.join(this.baseDir, `${id}.json`);
  }

  async read(workspaceId: string): Promise<Workspace | null> {
    const filePath = this.filePath(workspaceId);
    if (!existsSync(filePath)) return null;
    const { readFile } = await import('fs/promises');
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as Workspace;
  }

  async write(workspace: Workspace): Promise<void> {
    // Dynamic import to avoid circular deps in tests
    const { atomicWriteJson } = await import('../../utils/file-io.utils.js');
    await atomicWriteJson(this.filePath(workspace.id), workspace);
  }

  async delete(workspaceId: string): Promise<boolean> {
    const filePath = this.filePath(workspaceId);
    if (!existsSync(filePath)) return false;
    const { unlink } = await import('fs/promises');
    await unlink(filePath);
    return true;
  }

  async listIds(): Promise<string[]> {
    if (!existsSync(this.baseDir)) return [];
    const { readdir } = await import('fs/promises');
    const files = await readdir(this.baseDir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  }
}

// ---------------------------------------------------------------------------
// WorkspaceService
// ---------------------------------------------------------------------------

export class WorkspaceService {
  private storage: WorkspaceStorage;

  /**
   * Creates a new WorkspaceService.
   *
   * @param storage - Storage backend (FileWorkspaceStorage or mock for tests)
   */
  constructor(storage: WorkspaceStorage) {
    this.storage = storage;
  }

  // -------------------------------------------------------------------------
  // CRUD Operations
  // -------------------------------------------------------------------------

  /**
   * Creates a new workspace.
   *
   * @param input - Workspace creation parameters
   * @returns The created Workspace at version 1
   */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const workspace = createWorkspace(input);
    await this.storage.write(workspace);
    return workspace;
  }

  /**
   * Reads a workspace by ID.
   *
   * @param workspaceId - The workspace ID
   * @returns The workspace, or null if not found
   */
  async read(workspaceId: string): Promise<Workspace | null> {
    return this.storage.read(workspaceId);
  }

  /**
   * Writes data to a workspace with CAS validation.
   *
   * The write semantics depend on the workspace's accessMode:
   * - overwrite: data replaces the entire workspace data
   * - append: data is shallow-merged with existing data
   * - structured: use writeStructured() instead
   *
   * @param workspaceId - The workspace to write to
   * @param input - Write input with expectedVersion and data
   * @returns The updated Workspace
   * @throws WorkspaceConflictError if version mismatch
   * @throws WorkspaceAccessError if writer not authorized
   * @throws Error if workspace not found
   */
  async write(workspaceId: string, input: WriteWorkspaceInput): Promise<Workspace> {
    const workspace = await this.storage.read(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }

    // CAS check
    if (input.expectedVersion !== workspace.version) {
      throw new WorkspaceConflictError(workspaceId, input.expectedVersion, workspace.version);
    }

    // Access check
    this.checkWriteAccess(workspace, input.writerId);

    // Apply write based on access mode
    const now = new Date().toISOString();
    let newData: Record<string, unknown>;

    switch (workspace.accessMode) {
      case 'append':
        newData = { ...workspace.data, ...input.data };
        break;
      case 'overwrite':
      default:
        newData = { ...input.data };
        break;
    }

    const updated: Workspace = {
      ...workspace,
      data: newData,
      version: workspace.version + 1,
      updatedAt: now,
      lastWrittenBy: input.writerId,
    };

    await this.storage.write(updated);
    return updated;
  }

  /**
   * Writes to a specific path within a structured workspace.
   *
   * @param workspaceId - The workspace to write to
   * @param input - Structured write input with path and value
   * @returns The updated Workspace
   * @throws WorkspaceConflictError if version mismatch
   * @throws WorkspaceAccessError if writer not authorized
   * @throws Error if workspace not found or not in structured mode
   */
  async writeStructured(
    workspaceId: string,
    input: StructuredWriteInput,
  ): Promise<Workspace> {
    const workspace = await this.storage.read(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }

    if (workspace.accessMode !== 'structured') {
      throw new Error(`Workspace '${workspaceId}' is not in structured mode`);
    }

    // CAS check
    if (input.expectedVersion !== workspace.version) {
      throw new WorkspaceConflictError(workspaceId, input.expectedVersion, workspace.version);
    }

    // Access check
    this.checkWriteAccess(workspace, input.writerId);

    // Set value at path
    const newData = { ...workspace.data };
    setNestedValue(newData, input.path, input.value);

    const now = new Date().toISOString();
    const updated: Workspace = {
      ...workspace,
      data: newData,
      version: workspace.version + 1,
      updatedAt: now,
      lastWrittenBy: input.writerId,
    };

    await this.storage.write(updated);
    return updated;
  }

  /**
   * Deletes a workspace.
   *
   * @param workspaceId - The workspace to delete
   * @returns True if deleted, false if not found
   */
  async delete(workspaceId: string): Promise<boolean> {
    return this.storage.delete(workspaceId);
  }

  /**
   * Lists all workspaces (IDs only, for discovery).
   *
   * @returns Array of workspace IDs
   */
  async listIds(): Promise<string[]> {
    return this.storage.listIds();
  }

  /**
   * Lists all workspaces with full data.
   *
   * @returns Array of all Workspace objects
   */
  async listAll(): Promise<Workspace[]> {
    const ids = await this.storage.listIds();
    const workspaces: Workspace[] = [];
    for (const id of ids) {
      const ws = await this.storage.read(id);
      if (ws) workspaces.push(ws);
    }
    return workspaces;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Checks whether a writer is authorized to write to a workspace.
   *
   * @param workspace - The workspace to check
   * @param writerId - The writer's identifier
   * @throws WorkspaceAccessError if not authorized
   */
  private checkWriteAccess(workspace: Workspace, writerId: string): void {
    // Owner always has access
    if (writerId === workspace.ownerId) return;

    // Check allowed writers list
    if (workspace.allowedWriters.length > 0 && workspace.allowedWriters.includes(writerId)) {
      return;
    }

    // If allowedWriters is empty, only owner can write
    if (workspace.allowedWriters.length === 0) {
      throw new WorkspaceAccessError(workspace.id, writerId);
    }

    // Writer not in allowed list
    throw new WorkspaceAccessError(workspace.id, writerId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sets a value at a dot-notation path in a nested object.
 * Creates intermediate objects as needed.
 *
 * @param obj - The object to modify (mutated in place)
 * @param dotPath - Dot-notation path (e.g., "results.phase1.score")
 * @param value - The value to set
 */
function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}
