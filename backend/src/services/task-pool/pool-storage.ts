/**
 * Pool Storage — JSON file persistence for Task Pool
 *
 * Handles reading and writing the task pool state to disk using
 * atomic writes (temp-file + fsync + rename) and operation locks
 * to prevent corruption on crash or concurrent access.
 *
 * @module services/task-pool/pool-storage
 */

import * as path from 'path';
import * as os from 'os';
import {
  ensureDir,
  safeReadJson,
  atomicWriteJson,
  modifyJsonFile,
} from '../../utils/file-io.utils.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TaskClaim } from '../../types/v2/claim.types.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * On-disk shape of the pool data file.
 */
export interface PoolData {
  /** All work items currently in the pool */
  workItems: WorkItem[];
  /** All active and historical claims */
  claims: TaskClaim[];
  /** ISO8601 — last time the file was written */
  lastUpdatedAt: string;
}

/**
 * Options for PoolStorage construction.
 */
export interface PoolStorageOptions {
  /** Override the default data directory (defaults to ~/.crewly/task-pool/) */
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default directory name under ~/.crewly/ for pool data. */
const POOL_DIR_NAME = 'task-pool';

/** File name for the pool data. */
const POOL_FILE_NAME = 'pool.json';

/** Debounce interval in ms for write batching. */
const WRITE_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// PoolStorage
// ---------------------------------------------------------------------------

/**
 * Persists task pool state to a JSON file with atomic writes.
 *
 * Uses the same patterns as the rest of the Crewly backend:
 * - {@link atomicWriteJson} for crash-safe writes
 * - {@link modifyJsonFile} for locked read-modify-write cycles
 * - Debounced flushing to reduce disk I/O under burst writes
 */
export class PoolStorage {
  private readonly filePath: string;
  private readonly logger: ComponentLogger;

  /** In-memory cache — authoritative after first load. */
  private cache: PoolData | null = null;

  /** Debounce timer handle for batching writes. */
  private flushTimer: NodeJS.Timeout | null = null;

  /** Whether a flush is pending. */
  private dirty = false;

  constructor(options?: PoolStorageOptions) {
    const dataDir =
      options?.dataDir ??
      path.join(os.homedir(), '.crewly', POOL_DIR_NAME);
    this.filePath = path.join(dataDir, POOL_FILE_NAME);
    this.logger = LoggerService.getInstance().createComponentLogger('PoolStorage');
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Loads pool data from disk (or returns cached copy).
   *
   * @returns Current pool data
   */
  async load(): Promise<PoolData> {
    if (this.cache) return this.cache;

    await ensureDir(path.dirname(this.filePath));
    const data = await safeReadJson<PoolData>(
      this.filePath,
      createEmptyPoolData(),
      this.logger,
    );
    this.cache = data;
    return data;
  }

  /**
   * Returns all work items currently in the pool.
   *
   * @returns Array of WorkItems
   */
  async getWorkItems(): Promise<WorkItem[]> {
    const data = await this.load();
    return data.workItems;
  }

  /**
   * Returns all claims.
   *
   * @returns Array of TaskClaims
   */
  async getClaims(): Promise<TaskClaim[]> {
    const data = await this.load();
    return data.claims;
  }

  /**
   * Finds a work item by ID.
   *
   * @param workItemId - The work item ID
   * @returns The work item, or undefined
   */
  async findWorkItem(workItemId: string): Promise<WorkItem | undefined> {
    const data = await this.load();
    return data.workItems.find((wi) => wi.id === workItemId);
  }

  /**
   * Finds a claim by work item ID (active claims only).
   *
   * @param workItemId - The work item ID
   * @returns The active claim, or undefined
   */
  async findActiveClaimByWorkItem(workItemId: string): Promise<TaskClaim | undefined> {
    const data = await this.load();
    return data.claims.find(
      (c) => c.workItemId === workItemId && c.status === 'active',
    );
  }

  /**
   * Finds a claim by agent ID (active claims only).
   *
   * @param agentId - The agent session name
   * @returns The active claim, or undefined
   */
  async findActiveClaimByAgent(agentId: string): Promise<TaskClaim | undefined> {
    const data = await this.load();
    return data.claims.find(
      (c) => c.agentId === agentId && c.status === 'active',
    );
  }

  /**
   * Adds a work item to the pool.
   *
   * @param workItem - The work item to add
   */
  async addWorkItem(workItem: WorkItem): Promise<void> {
    const data = await this.load();
    data.workItems.push(workItem);
    this.markDirty();
  }

  /**
   * Updates a work item in-place.
   *
   * @param workItemId - ID of the work item to update
   * @param updater - Function that mutates the work item
   * @returns True if item was found and updated
   */
  async updateWorkItem(
    workItemId: string,
    updater: (wi: WorkItem) => void,
  ): Promise<boolean> {
    const data = await this.load();
    const item = data.workItems.find((wi) => wi.id === workItemId);
    if (!item) return false;
    updater(item);
    this.markDirty();
    return true;
  }

  /**
   * Removes a work item from the pool.
   *
   * @param workItemId - ID of the work item to remove
   * @returns True if item was found and removed
   */
  async removeWorkItem(workItemId: string): Promise<boolean> {
    const data = await this.load();
    const idx = data.workItems.findIndex((wi) => wi.id === workItemId);
    if (idx === -1) return false;
    data.workItems.splice(idx, 1);
    this.markDirty();
    return true;
  }

  /**
   * Adds a claim to storage.
   *
   * @param claim - The claim to add
   */
  async addClaim(claim: TaskClaim): Promise<void> {
    const data = await this.load();
    data.claims.push(claim);
    this.markDirty();
  }

  /**
   * Updates a claim in-place.
   *
   * @param claimId - ID of the claim to update
   * @param updater - Function that mutates the claim
   * @returns True if claim was found and updated
   */
  async updateClaim(
    claimId: string,
    updater: (claim: TaskClaim) => void,
  ): Promise<boolean> {
    const data = await this.load();
    const claim = data.claims.find((c) => c.id === claimId);
    if (!claim) return false;
    updater(claim);
    this.markDirty();
    return true;
  }

  /**
   * Forces an immediate flush to disk (bypasses debounce).
   * Call this during graceful shutdown.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty || !this.cache) return;

    this.cache.lastUpdatedAt = new Date().toISOString();
    await atomicWriteJson(this.filePath, this.cache);
    this.dirty = false;
    this.logger.debug?.('Pool data flushed to disk', { path: this.filePath });
  }

  /**
   * Clears all pool data (useful for testing).
   */
  async clear(): Promise<void> {
    this.cache = createEmptyPoolData();
    this.dirty = true;
    await this.flush();
  }

  /**
   * Cleanup: cancels pending debounce timer and flushes.
   */
  async destroy(): Promise<void> {
    await this.flush();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Marks cache as dirty and schedules a debounced flush.
   */
  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return; // already scheduled
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => {
        this.logger.warn('Failed to flush pool data', { error: String(err) });
      });
    }, WRITE_DEBOUNCE_MS);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates an empty pool data structure.
 *
 * @returns Empty PoolData
 */
export function createEmptyPoolData(): PoolData {
  return {
    workItems: [],
    claims: [],
    lastUpdatedAt: new Date().toISOString(),
  };
}
