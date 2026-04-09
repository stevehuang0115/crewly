/**
 * Task Pool Service — Unified task entry and queue management
 *
 * The Task Pool holds execution-ready WorkItems. Agents claim items
 * from the pool, and the Reconciler returns unclaimed or failed items.
 *
 * CEO Decision: Pool only holds execution-ready WorkItems, not all ProjectTasks.
 *
 * @module services/task-pool/task-pool.service
 */

import { PoolStorage } from './pool-storage.js';
import { ClaimService, type HeartbeatResult, type ExtendLeaseResult, type ExpiredClaimsSummary } from './claim.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type {
  WorkItem,
  WorkItemStatus,
  WorkItemType,
  WorkItemOwner,
} from '../../types/v2/work-item.types.js';
import { isWorkItem, isValidWorkItemTransition } from '../../types/v2/work-item.types.js';
import {
  createTaskClaim,
  type TaskClaim,
  type CreateClaimInput,
} from '../../types/v2/claim.types.js';

// ---------------------------------------------------------------------------
// Filter / Snapshot Types
// ---------------------------------------------------------------------------

/**
 * Filters for claiming work items from the pool.
 */
export interface PoolFilters {
  /** Only match items of these types */
  types?: WorkItemType[];
  /** Only match items with this owner role */
  owner?: WorkItemOwner;
  /** Only match items targeting a specific agent/team */
  target?: string;
  /** Only match items belonging to this mission */
  missionId?: string;
}

/**
 * Statistics snapshot of the pool's current state.
 */
export interface PoolSnapshot {
  /** Total items in the pool (all statuses) */
  total: number;
  /** Items available for claiming (queued, no active claim) */
  available: number;
  /** Items currently claimed by an agent */
  claimed: number;
  /** Average wait time in ms for items that have been claimed */
  avgWaitTimeMs: number;
  /** Breakdown by WorkItem type */
  byType: Record<string, number>;
  /** Breakdown by status */
  byStatus: Record<string, number>;
  /** ISO8601 timestamp of this snapshot */
  timestamp: string;
}

/**
 * Result returned when claiming a work item.
 */
export interface ClaimResult {
  /** The claimed work item */
  workItem: WorkItem;
  /** The claim object tracking the lease */
  claim: TaskClaim;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * TaskPoolService manages the lifecycle of execution-ready WorkItems.
 *
 * Core operations:
 * - {@link addToPool} — enqueue an execution-ready WorkItem
 * - {@link claimFromPool} — agent claims the next available item
 * - {@link releaseBack} — release a claimed item back to the pool
 * - {@link getPoolStatus} — snapshot of pool statistics
 *
 * @example
 * ```typescript
 * const pool = TaskPoolService.getInstance();
 * pool.addToPool(workItem);
 * const result = pool.claimFromPool('agent-leo', { types: ['delegate'] });
 * if (result) {
 *   // agent works on result.workItem
 *   // when done:
 *   pool.completeItem(result.workItem.id);
 * }
 * ```
 */
export class TaskPoolService {
  private static instance: TaskPoolService | null = null;

  private readonly storage: PoolStorage;
  private readonly claimService: ClaimService;
  private readonly logger: ComponentLogger;

  constructor(storage?: PoolStorage) {
    this.storage = storage ?? new PoolStorage();
    this.claimService = new ClaimService(this.storage);
    this.logger = LoggerService.getInstance().createComponentLogger('TaskPoolService');
  }

  /**
   * Get singleton instance of TaskPoolService.
   *
   * @returns The singleton TaskPoolService
   */
  static getInstance(): TaskPoolService {
    if (!TaskPoolService.instance) {
      TaskPoolService.instance = new TaskPoolService();
    }
    return TaskPoolService.instance;
  }

  /**
   * Reset singleton (for testing).
   */
  static resetInstance(): void {
    TaskPoolService.instance = null;
  }

  // -----------------------------------------------------------------------
  // Core Pool Operations
  // -----------------------------------------------------------------------

  /**
   * Adds an execution-ready WorkItem to the pool.
   *
   * The item must have status 'queued' to be added. Items with other
   * statuses are rejected.
   *
   * @param workItem - The work item to add
   * @throws Error if workItem is not valid or not in 'queued' status
   */
  async addToPool(workItem: WorkItem): Promise<void> {
    if (!isWorkItem(workItem)) {
      throw new Error('Invalid WorkItem: does not conform to WorkItem interface');
    }
    if (workItem.status !== 'queued') {
      throw new Error(
        `Cannot add WorkItem to pool: status must be 'queued', got '${workItem.status}'`,
      );
    }

    // Check for duplicates
    const existing = await this.storage.findWorkItem(workItem.id);
    if (existing) {
      this.logger.warn('WorkItem already in pool, skipping', { workItemId: workItem.id });
      return;
    }

    await this.storage.addWorkItem(workItem);
    await this.storage.flush();
    this.logger.info('WorkItem added to pool', {
      workItemId: workItem.id,
      type: workItem.type,
      title: workItem.title,
    });
  }

  /**
   * Claims the next available WorkItem from the pool for an agent.
   *
   * Selection strategy: FIFO among matching unclaimed 'queued' items.
   * If a target filter is provided, only items targeting that agent are considered.
   *
   * @param agentId - Agent session name claiming the item
   * @param filters - Optional filters to narrow which items to consider
   * @returns The claimed work item and claim object, or null if nothing available
   */
  async claimFromPool(
    agentId: string,
    filters?: PoolFilters,
  ): Promise<ClaimResult | null> {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a non-empty string');
    }

    // Check if agent already has an active claim
    const existingClaim = await this.storage.findActiveClaimByAgent(agentId);
    if (existingClaim) {
      this.logger.warn('Agent already has an active claim', {
        agentId,
        existingClaimId: existingClaim.id,
        existingWorkItemId: existingClaim.workItemId,
      });
      return null;
    }

    const workItems = await this.storage.getWorkItems();
    const claims = await this.storage.getClaims();

    // Set of work item IDs that have active claims
    const claimedIds = new Set(
      claims
        .filter((c) => c.status === 'active')
        .map((c) => c.workItemId),
    );

    // Find first matching unclaimed queued item (FIFO by createdAt)
    const candidates = workItems
      .filter((wi) => wi.status === 'queued' && !claimedIds.has(wi.id))
      .filter((wi) => matchesFilters(wi, filters))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    if (candidates.length === 0) {
      return null;
    }

    const selected = candidates[0];

    // Transition item to 'running'
    const updated = await this.storage.updateWorkItem(selected.id, (wi) => {
      wi.status = 'running';
      wi.startedAt = new Date().toISOString();
      wi.target = agentId;
    });

    if (!updated) {
      this.logger.warn('Failed to update WorkItem during claim', { workItemId: selected.id });
      return null;
    }

    // Create the claim
    const claimInput: CreateClaimInput = {
      workItemId: selected.id,
      agentId,
    };
    const claim = createTaskClaim(claimInput);
    await this.storage.addClaim(claim);
    await this.storage.flush();

    this.logger.info('WorkItem claimed', {
      workItemId: selected.id,
      agentId,
      claimId: claim.id,
      title: selected.title,
    });

    // Return the updated item
    const claimedItem = await this.storage.findWorkItem(selected.id);
    return {
      workItem: claimedItem!,
      claim,
    };
  }

  /**
   * Releases a claimed WorkItem back to the pool.
   *
   * The item's status reverts to 'queued' and the claim is marked 'released'.
   *
   * @param workItemId - ID of the work item to release
   * @param reason - Why the item is being released
   * @throws Error if work item not found or not currently claimed
   */
  async releaseBack(workItemId: string, reason: string): Promise<void> {
    const workItem = await this.storage.findWorkItem(workItemId);
    if (!workItem) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }
    if (workItem.status !== 'running') {
      throw new Error(
        `Cannot release WorkItem: status must be 'running', got '${workItem.status}'`,
      );
    }

    // Find and release the active claim
    const claim = await this.storage.findActiveClaimByWorkItem(workItemId);
    if (claim) {
      await this.storage.updateClaim(claim.id, (c) => {
        c.status = 'released';
        c.endedAt = new Date().toISOString();
        c.endReason = reason;
      });
    }

    // Revert item to queued
    await this.storage.updateWorkItem(workItemId, (wi) => {
      wi.status = 'queued';
      wi.startedAt = undefined;
      wi.target = undefined;
      wi.retryCount += 1;
    });

    await this.storage.flush();
    this.logger.info('WorkItem released back to pool', {
      workItemId,
      reason,
      claimId: claim?.id,
    });
  }

  /**
   * Marks a work item as completed ('done').
   *
   * @param workItemId - ID of the work item
   * @param result - Optional result data
   * @throws Error if work item not found or not in 'running' status
   */
  async completeItem(
    workItemId: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    const workItem = await this.storage.findWorkItem(workItemId);
    if (!workItem) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }
    if (workItem.status !== 'running') {
      throw new Error(
        `Cannot complete WorkItem: status must be 'running', got '${workItem.status}'`,
      );
    }

    // Release the claim
    const claim = await this.storage.findActiveClaimByWorkItem(workItemId);
    if (claim) {
      await this.storage.updateClaim(claim.id, (c) => {
        c.status = 'released';
        c.endedAt = new Date().toISOString();
        c.endReason = 'completed';
      });
    }

    // Mark item done
    await this.storage.updateWorkItem(workItemId, (wi) => {
      wi.status = 'done';
      wi.completedAt = new Date().toISOString();
      if (result) wi.result = result;
    });

    await this.storage.flush();
    this.logger.info('WorkItem completed', { workItemId });
  }

  /**
   * Marks a work item as failed.
   *
   * @param workItemId - ID of the work item
   * @param error - Error description
   * @throws Error if work item not found or not in 'running' status
   */
  async failItem(workItemId: string, error: string): Promise<void> {
    const workItem = await this.storage.findWorkItem(workItemId);
    if (!workItem) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }
    if (workItem.status !== 'running') {
      throw new Error(
        `Cannot fail WorkItem: status must be 'running', got '${workItem.status}'`,
      );
    }

    // Release the claim
    const claim = await this.storage.findActiveClaimByWorkItem(workItemId);
    if (claim) {
      await this.storage.updateClaim(claim.id, (c) => {
        c.status = 'released';
        c.endedAt = new Date().toISOString();
        c.endReason = `failed: ${error}`;
      });
    }

    // Mark item failed
    await this.storage.updateWorkItem(workItemId, (wi) => {
      wi.status = 'failed';
      wi.completedAt = new Date().toISOString();
      wi.error = error;
    });

    await this.storage.flush();
    this.logger.info('WorkItem failed', { workItemId, error });
  }

  // -----------------------------------------------------------------------
  // Claim Lifecycle (delegated to ClaimService)
  // -----------------------------------------------------------------------

  /**
   * Processes a heartbeat from an agent for their active claim.
   *
   * @param claimId - The claim ID
   * @param agentId - The agent sending the heartbeat
   * @returns HeartbeatResult
   */
  async heartbeat(claimId: string, agentId: string): Promise<HeartbeatResult> {
    const result = await this.claimService.heartbeat(claimId, agentId);
    if (result.success) {
      await this.storage.flush();
    }
    return result;
  }

  /**
   * Extends the lease on a claim.
   *
   * @param claimId - The claim ID
   * @param agentId - The agent requesting extension
   * @returns ExtendLeaseResult
   */
  async extendLease(claimId: string, agentId: string): Promise<ExtendLeaseResult> {
    const result = await this.claimService.extendLease(claimId, agentId);
    if (result.success) {
      await this.storage.flush();
    }
    return result;
  }

  /**
   * Scans for expired claims (for Reconciler use).
   *
   * @param now - Current timestamp in ms
   * @returns Summary of expiring and grace-exceeded claims
   */
  async scanExpiredClaims(now?: number): Promise<ExpiredClaimsSummary> {
    return this.claimService.scanExpiredClaims(now);
  }

  /**
   * Revokes a claim and releases the work item back to the pool.
   * Used by the Reconciler when a claim's grace period is exceeded.
   *
   * @param claimId - The claim to revoke
   * @param reason - Reason for revocation
   */
  async revokeAndRelease(claimId: string, reason: string): Promise<void> {
    const claim = await this.claimService.getClaimById(claimId);
    if (!claim) {
      throw new Error(`Claim not found: ${claimId}`);
    }

    await this.claimService.revoke(claimId, reason);

    // Release work item back to pool if it's still running
    const workItem = await this.storage.findWorkItem(claim.workItemId);
    if (workItem && workItem.status === 'running') {
      await this.releaseBack(claim.workItemId, `claim revoked: ${reason}`);
    }

    this.logger.info('Claim revoked and work item released', {
      claimId,
      workItemId: claim.workItemId,
      reason,
    });
  }

  /**
   * Exposes the underlying ClaimService for advanced operations.
   *
   * @returns The ClaimService instance
   */
  getClaimService(): ClaimService {
    return this.claimService;
  }

  // -----------------------------------------------------------------------
  // Pool Status & Queries
  // -----------------------------------------------------------------------

  /**
   * Returns a snapshot of pool statistics.
   *
   * @returns Pool statistics including counts and avg wait time
   */
  async getPoolStatus(): Promise<PoolSnapshot> {
    const workItems = await this.storage.getWorkItems();
    const claims = await this.storage.getClaims();

    const activeClaimIds = new Set(
      claims.filter((c) => c.status === 'active').map((c) => c.workItemId),
    );

    const available = workItems.filter(
      (wi) => wi.status === 'queued' && !activeClaimIds.has(wi.id),
    ).length;

    const claimed = activeClaimIds.size;

    // Average wait time: for items that have been claimed (have startedAt),
    // compute time from createdAt to startedAt
    const waitTimes: number[] = [];
    for (const wi of workItems) {
      if (wi.startedAt) {
        const wait =
          new Date(wi.startedAt).getTime() - new Date(wi.createdAt).getTime();
        if (wait >= 0) waitTimes.push(wait);
      }
    }
    const avgWaitTimeMs =
      waitTimes.length > 0
        ? Math.round(waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length)
        : 0;

    // Breakdowns
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const wi of workItems) {
      byType[wi.type] = (byType[wi.type] ?? 0) + 1;
      byStatus[wi.status] = (byStatus[wi.status] ?? 0) + 1;
    }

    return {
      total: workItems.length,
      available,
      claimed,
      avgWaitTimeMs,
      byType,
      byStatus,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Returns all available (unclaimed, queued) work items.
   *
   * @param filters - Optional filters
   * @returns Array of available WorkItems
   */
  async getAvailableItems(filters?: PoolFilters): Promise<WorkItem[]> {
    const workItems = await this.storage.getWorkItems();
    const claims = await this.storage.getClaims();

    const activeClaimIds = new Set(
      claims.filter((c) => c.status === 'active').map((c) => c.workItemId),
    );

    return workItems
      .filter((wi) => wi.status === 'queued' && !activeClaimIds.has(wi.id))
      .filter((wi) => matchesFilters(wi, filters))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  /**
   * Returns all work items in the pool (all statuses).
   *
   * @returns Array of all WorkItems
   */
  async getAllItems(): Promise<WorkItem[]> {
    return this.storage.getWorkItems();
  }

  /**
   * Returns all active/expiring claims.
   * Used by the Reconciler to check lease health.
   *
   * @returns Array of active/expiring TaskClaims
   */
  async getActiveClaims(): Promise<TaskClaim[]> {
    return this.claimService.getActiveClaims();
  }

  /**
   * Updates a work item's status directly.
   * Used by the Reconciler for corrections (e.g., stuck → blocked).
   *
   * @param workItemId - The work item ID
   * @param newStatus - The target status
   * @throws Error if work item not found or transition is invalid
   */
  async updateItemStatus(workItemId: string, newStatus: WorkItemStatus): Promise<void> {
    const items = await this.storage.getWorkItems();
    const item = items.find((wi) => wi.id === workItemId);

    if (!item) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }

    if (!isValidWorkItemTransition(item.status, newStatus)) {
      throw new Error(
        `Invalid status transition for WorkItem ${workItemId}: ${item.status} → ${newStatus}`,
      );
    }

    await this.storage.updateWorkItem(workItemId, (wi) => {
      wi.status = newStatus;
      // Use startedAt for running, completedAt for done/failed
      if (newStatus === 'running') {
        wi.startedAt = new Date().toISOString();
      } else if (newStatus === 'done' || newStatus === 'failed') {
        wi.completedAt = new Date().toISOString();
      }
    });

    this.logger.info('Work item status updated', {
      workItemId,
      from: item.status,
      to: newStatus,
    });
  }

  /**
   * Update token usage and cost on a WorkItem.
   * Called after task completion when token data is available from TokenUsageService.
   *
   * @param workItemId - The work item ID
   * @param inputTokens - Number of input tokens consumed
   * @param outputTokens - Number of output tokens generated
   * @param cost - Total cost in USD
   * @returns True if the update was applied, false if WorkItem not found
   */
  async updateTokenUsage(
    workItemId: string,
    inputTokens: number,
    outputTokens: number,
    cost: number,
  ): Promise<boolean> {
    const workItem = await this.storage.findWorkItem(workItemId);
    if (!workItem) return false;

    await this.storage.updateWorkItem(workItemId, (wi) => {
      wi.inputTokens = inputTokens;
      wi.outputTokens = outputTokens;
      wi.cost = cost;
    });

    await this.storage.flush();
    this.logger.debug('WorkItem token usage updated', {
      workItemId,
      inputTokens,
      outputTokens,
      cost,
    });
    return true;
  }

  /**
   * Marks a claim as 'expiring' (lease expired, within grace period).
   * Used by the Reconciler fast loop.
   *
   * @param claimId - The claim ID to mark
   */
  async markClaimExpiring(claimId: string): Promise<void> {
    await this.claimService.markExpiring([claimId]);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Graceful shutdown — flush pending writes.
   */
  async destroy(): Promise<void> {
    await this.storage.destroy();
  }

  /**
   * Exposes underlying storage for advanced operations (e.g., Reconciler).
   *
   * @returns The PoolStorage instance
   */
  getStorage(): PoolStorage {
    return this.storage;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether a work item matches the given filters.
 *
 * @param wi - WorkItem to check
 * @param filters - Optional filters
 * @returns True if item passes all filter criteria
 */
function matchesFilters(wi: WorkItem, filters?: PoolFilters): boolean {
  if (!filters) return true;
  if (filters.types && !filters.types.includes(wi.type)) return false;
  if (filters.owner && wi.owner !== filters.owner) return false;
  if (filters.target && wi.target !== filters.target) return false;
  if (filters.missionId && wi.missionId !== filters.missionId) return false;
  return true;
}
