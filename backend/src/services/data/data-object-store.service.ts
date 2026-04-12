/**
 * DataObjectStore — file-based CRUD service for the Unified DataObject Model.
 *
 * Persists DataObjects as individual JSON files organised by namespace:
 * - scope=agent  → `{projectPath}/.crewly/agents/{owner_id}/data/{id}.json`
 * - scope=project → `{projectPath}/.crewly/data/{namespace}/{id}.json`
 * - scope=global  → `~/.crewly/data/{namespace}/{id}.json`
 *
 * @see specs/crewly-data-architecture-v2.md
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { atomicWriteFile, ensureDir } from '../../utils/file-io.utils.js';
import {
  DataObject,
  CreateDataObjectInput,
  DataObjectFilters,
  isDataObject,
} from './data-object.types.js';

/**
 * File-based CRUD store for DataObjects.
 *
 * Uses a singleton pattern consistent with other Crewly services.
 * Each DataObject is stored as a separate JSON file so that
 * concurrent agents can write without lock contention.
 */
export class DataObjectStore {
  private static instance: DataObjectStore | null = null;
  private static instanceProjectPath: string | null = null;

  private projectPath: string;
  private logger: ComponentLogger;

  /**
   * @param projectPath - Absolute path to the Crewly project root.
   *   Used to resolve scope-based storage directories.
   */
  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.logger = LoggerService.getInstance().createComponentLogger('DataObjectStore');
    this.logger.info('DataObjectStore initialised', { projectPath });
  }

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  /**
   * Returns the singleton DataObjectStore instance.
   *
   * If `projectPath` differs from the current instance, a new one is created.
   *
   * @param projectPath - Absolute path to the Crewly project root
   * @returns Singleton DataObjectStore
   */
  public static getInstance(projectPath: string): DataObjectStore {
    if (
      DataObjectStore.instance &&
      DataObjectStore.instanceProjectPath === projectPath
    ) {
      return DataObjectStore.instance;
    }
    DataObjectStore.instance = new DataObjectStore(projectPath);
    DataObjectStore.instanceProjectPath = projectPath;
    return DataObjectStore.instance;
  }

  /**
   * Clears the singleton (useful for tests).
   */
  public static clearInstance(): void {
    DataObjectStore.instance = null;
    DataObjectStore.instanceProjectPath = null;
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  /**
   * Creates a new DataObject, persists it to disk, and returns it.
   *
   * Generates a UUID, sets timestamps, and applies sensible defaults.
   *
   * @param input - Fields for the new DataObject
   * @returns The persisted DataObject
   */
  async create(input: CreateDataObjectInput): Promise<DataObject> {
    const now = new Date().toISOString();

    const obj: DataObject = {
      id: uuidv4(),
      type: input.type,
      scope: input.scope,
      schema_id: input.schema_id,
      status: input.status ?? 'new',
      owner_id: input.owner_id,
      namespace: input.namespace,
      payload: input.payload,
      metadata: {
        created_at: now,
        updated_at: now,
        source_thread_id: input.source_thread_id,
        confidence_score: input.confidence_score,
        tags: input.tags ?? [],
      },
      sync_state: input.sync_state ?? 'local',
    };

    await this.persist(obj);
    this.logger.info('DataObject created', { id: obj.id, type: obj.type, namespace: obj.namespace });
    return obj;
  }

  /**
   * Retrieves a DataObject by its ID.
   *
   * Scans all namespace directories because the caller may not know
   * the namespace. For hot-path lookups, prefer `listByNamespace`.
   *
   * @param id - UUID of the DataObject
   * @returns The DataObject, or null if not found
   */
  async getById(id: string): Promise<DataObject | null> {
    const bases = this.allBaseDirs();

    for (const base of bases) {
      const found = await this.findInBase(base, id);
      if (found) return found;
    }
    return null;
  }

  /**
   * Lists DataObjects matching the supplied filters.
   *
   * @param filters - Optional field constraints
   * @returns Array of matching DataObjects
   */
  async list(filters: DataObjectFilters = {}): Promise<DataObject[]> {
    const bases = this.baseDirsForFilters(filters);
    const results: DataObject[] = [];

    for (const base of bases) {
      const objects = await this.readAllFromBase(base);
      for (const obj of objects) {
        if (this.matchesFilters(obj, filters)) {
          results.push(obj);
        }
      }
    }

    return results;
  }

  /**
   * Applies a partial update to an existing DataObject.
   *
   * Only the fields present in `patch` are overwritten; the rest
   * are preserved. `metadata.updated_at` is always refreshed.
   *
   * @param id - UUID of the DataObject to update
   * @param patch - Fields to overwrite
   * @returns The updated DataObject
   * @throws Error if the DataObject does not exist
   */
  async update(id: string, patch: Partial<DataObject>): Promise<DataObject> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`DataObject not found: ${id}`);
    }

    const updated: DataObject = {
      ...existing,
      ...patch,
      id: existing.id, // id is immutable
      metadata: {
        ...existing.metadata,
        ...(patch.metadata ?? {}),
        updated_at: new Date().toISOString(),
      },
    };

    // If namespace or scope changed, remove old file first
    const oldPath = this.filePath(existing);
    const newPath = this.filePath(updated);
    if (oldPath !== newPath) {
      await this.safeDelete(oldPath);
    }

    await this.persist(updated);
    this.logger.info('DataObject updated', { id });
    return updated;
  }

  /**
   * Deletes a DataObject by ID.
   *
   * @param id - UUID of the DataObject to delete
   * @returns true if the object existed and was deleted, false otherwise
   */
  async delete(id: string): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.safeDelete(this.filePath(existing));
    this.logger.info('DataObject deleted', { id });
    return true;
  }

  // -----------------------------------------------------------------------
  // Namespace helpers
  // -----------------------------------------------------------------------

  /**
   * Lists all DataObjects within a given namespace.
   *
   * @param namespace - The namespace to scan, e.g. "marketing/steve-inputs"
   * @returns Array of DataObjects in that namespace
   */
  async listByNamespace(namespace: string): Promise<DataObject[]> {
    const results: DataObject[] = [];

    // Check all possible scope roots for this namespace
    const dirs = [
      path.join(this.projectPath, '.crewly', 'data', namespace),
      path.join(os.homedir(), '.crewly', 'data', namespace),
    ];

    // Also check agent-scoped dirs (agents/{owner}/data/)
    const agentsBase = path.join(this.projectPath, '.crewly', 'agents');
    if (await this.dirExists(agentsBase)) {
      const owners = await this.safeReaddir(agentsBase);
      for (const owner of owners) {
        dirs.push(path.join(agentsBase, owner, 'data'));
      }
    }

    for (const dir of dirs) {
      const objects = await this.readAllFromDir(dir);
      for (const obj of objects) {
        if (obj.namespace === namespace) {
          results.push(obj);
        }
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Storage path resolution
  // -----------------------------------------------------------------------

  /**
   * Resolves the absolute file path for a DataObject based on its scope.
   *
   * @param obj - The DataObject (or partial with scope, namespace, owner_id, id)
   * @returns Absolute path to the JSON file
   */
  private filePath(obj: Pick<DataObject, 'scope' | 'namespace' | 'owner_id' | 'id'>): string {
    switch (obj.scope) {
      case 'agent':
        return path.join(
          this.projectPath,
          '.crewly',
          'agents',
          obj.owner_id,
          'data',
          `${obj.id}.json`,
        );
      case 'project':
        return path.join(
          this.projectPath,
          '.crewly',
          'data',
          obj.namespace,
          `${obj.id}.json`,
        );
      case 'global':
        return path.join(
          os.homedir(),
          '.crewly',
          'data',
          obj.namespace,
          `${obj.id}.json`,
        );
      default:
        throw new Error(`Unknown scope: ${(obj as DataObject).scope}`);
    }
  }

  // -----------------------------------------------------------------------
  // Internal I/O helpers
  // -----------------------------------------------------------------------

  /**
   * Persists a DataObject to its resolved file path using atomic writes.
   */
  private async persist(obj: DataObject): Promise<void> {
    const fp = this.filePath(obj);
    await ensureDir(path.dirname(fp));
    await atomicWriteFile(fp, JSON.stringify(obj, null, 2));
  }

  /**
   * Safely deletes a file, ignoring ENOENT errors.
   */
  private async safeDelete(fp: string): Promise<void> {
    try {
      await fs.unlink(fp);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /**
   * Lists entries in a directory, returning empty array if it doesn't exist.
   */
  private async safeReaddir(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch {
      return [];
    }
  }

  /**
   * Checks if a directory exists.
   */
  private async dirExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Reads all DataObject JSON files from a single directory.
   */
  private async readAllFromDir(dirPath: string): Promise<DataObject[]> {
    const entries = await this.safeReaddir(dirPath);
    const results: DataObject[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dirPath, entry), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (isDataObject(parsed)) {
          results.push(parsed);
        }
      } catch (err) {
        this.logger.warn('Failed to read DataObject file', {
          file: entry,
          error: String(err),
        });
      }
    }

    return results;
  }

  /**
   * Recursively reads all DataObject JSON files from a directory tree
   * up to a configurable depth. Handles both shallow (data/{ns}/)
   * and deep (agents/{owner}/data/) hierarchies.
   *
   * @param dir - Root directory to scan
   * @param maxDepth - Maximum directory depth to descend (default 3)
   */
  private async readAllRecursive(dir: string, maxDepth: number = 3): Promise<DataObject[]> {
    if (maxDepth < 0) return [];
    const results: DataObject[] = [];

    // Read JSON files in this directory
    results.push(...await this.readAllFromDir(dir));

    // Recurse into subdirectories
    const entries = await this.safeReaddir(dir);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry);
      if (await this.dirExists(entryPath)) {
        results.push(...await this.readAllRecursive(entryPath, maxDepth - 1));
      }
    }

    return results;
  }

  /**
   * Reads all DataObjects from a base directory tree.
   */
  private async readAllFromBase(base: string): Promise<DataObject[]> {
    return this.readAllRecursive(base);
  }

  /**
   * Searches for a specific ID within a base directory tree (recursive).
   */
  private async findInBase(base: string, id: string): Promise<DataObject | null> {
    return this.findInDir(base, id, 3);
  }

  /**
   * Recursively searches for a DataObject by ID in a directory tree.
   */
  private async findInDir(dir: string, id: string, maxDepth: number): Promise<DataObject | null> {
    if (maxDepth < 0) return null;

    // Check direct file
    const file = path.join(dir, `${id}.json`);
    const found = await this.tryReadFile(file);
    if (found) return found;

    // Recurse into subdirectories
    const entries = await this.safeReaddir(dir);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry);
      if (await this.dirExists(entryPath)) {
        const result = await this.findInDir(entryPath, id, maxDepth - 1);
        if (result) return result;
      }
    }

    return null;
  }

  /**
   * Tries to read and parse a single DataObject JSON file.
   * Returns null on any failure.
   */
  private async tryReadFile(fp: string): Promise<DataObject | null> {
    try {
      const raw = await fs.readFile(fp, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return isDataObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Returns all possible base directories to scan.
   */
  private allBaseDirs(): string[] {
    return [
      path.join(this.projectPath, '.crewly', 'data'),
      path.join(this.projectPath, '.crewly', 'agents'),
      path.join(os.homedir(), '.crewly', 'data'),
    ];
  }

  /**
   * Narrows base directories based on scope filter, if provided.
   */
  private baseDirsForFilters(filters: DataObjectFilters): string[] {
    if (filters.scope === 'project') {
      return [path.join(this.projectPath, '.crewly', 'data')];
    }
    if (filters.scope === 'agent') {
      return [path.join(this.projectPath, '.crewly', 'agents')];
    }
    if (filters.scope === 'global') {
      return [path.join(os.homedir(), '.crewly', 'data')];
    }
    return this.allBaseDirs();
  }

  /**
   * Tests whether a DataObject matches all non-undefined filter fields.
   */
  private matchesFilters(obj: DataObject, filters: DataObjectFilters): boolean {
    if (filters.type !== undefined && obj.type !== filters.type) return false;
    if (filters.scope !== undefined && obj.scope !== filters.scope) return false;
    if (filters.status !== undefined && obj.status !== filters.status) return false;
    if (filters.owner_id !== undefined && obj.owner_id !== filters.owner_id) return false;
    if (filters.namespace !== undefined && obj.namespace !== filters.namespace) return false;
    if (filters.tags !== undefined && filters.tags.length > 0) {
      const hasAllTags = filters.tags.every((tag) => obj.metadata.tags.includes(tag));
      if (!hasAllTags) return false;
    }
    return true;
  }
}
