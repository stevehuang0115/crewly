/**
 * ReconcilerService — The "CPU" of Crewly V3
 *
 * The Reconciler periodically and on-demand recomputes system truth from
 * durable state. It does NOT trust event delivery — it reads state and
 * determines what should be true.
 *
 * Two-level loop:
 * - Fast loop (10s): Lease expiry + agent health only
 * - Full loop (60s): Complete scan of all Requests, WorkItems, Claims
 *
 * Performance budget: single reconcile < 3s (CEO requirement).
 *
 * @module services/reconciler/reconciler.service
 */

import type {
  ReconcileResult,
  ReconcileType,
  ReconcileCorrection,
  ReconcilerConfig,
  ReconcilerStatus,
  WakeAction,
  WorkItem,
  Request,
  TaskClaim,
} from '../../types/v2/index.js';
import {
  createEmptyReconcileResult,
  DEFAULT_RECONCILER_CONFIG,
} from '../../types/v2/index.js';
import {
  detectStuckWorkItems,
  detectExpiredClaims,
  reconcileRequestStatus,
  detectRecoverableWorkItems,
  detectUnclaimedTasks,
  runPruningPass,
} from './reconcile-rules.js';
import type { AgentHealth } from './reconcile-rules.js';

// ---------------------------------------------------------------------------
// Data Provider Interface (dependency injection)
// ---------------------------------------------------------------------------

/**
 * Interface for providing data to the Reconciler.
 * Abstracts over the actual storage/service layer so the Reconciler
 * can be tested independently.
 */
export interface ReconcilerDataProvider {
  /** Get all non-terminal WorkItems */
  getActiveWorkItems(): Promise<WorkItem[]>;
  /** Get all WorkItems for a specific Request */
  getWorkItemsForRequest(requestId: string): Promise<WorkItem[]>;
  /** Get all non-terminal Requests */
  getActiveRequests(): Promise<Request[]>;
  /** Get all active TaskClaims */
  getActiveClaims(): Promise<TaskClaim[]>;
  /** Get health info for all known agents */
  getAgentHealthMap(): Promise<Map<string, AgentHealth>>;
  /** Apply a correction — update an entity's status */
  applyCorrection(correction: ReconcileCorrection): Promise<void>;
  /** Release a WorkItem back to the task pool */
  releaseToPool(workItemId: string, reason: string): Promise<void>;
  /** Re-queue a WorkItem (increment retryCount, set status to queued) */
  requeueWorkItem(workItemId: string): Promise<void>;
  /** Mark a claim as 'expiring' (lease expired, within grace period) */
  markClaimExpiring(claimId: string): Promise<void>;
  /** Revoke a claim and release its work item back to the pool */
  revokeClaimAndRelease(claimId: string, reason: string): Promise<void>;
  /** Get all available (queued, unclaimed) WorkItems from the task pool */
  getAvailablePoolItems?(): Promise<WorkItem[]>;
  /** Execute a wake action — rehydrate a suspended agent or start an inactive one */
  executeWakeAction?(action: WakeAction): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// ReconcilerService
// ---------------------------------------------------------------------------

export class ReconcilerService {
  private config: ReconcilerConfig;
  private dataProvider: ReconcilerDataProvider;
  private fastLoopTimer: ReturnType<typeof setInterval> | null = null;
  private fullLoopTimer: ReturnType<typeof setInterval> | null = null;
  private history: ReconcileResult[] = [];
  private isRunning = false;
  private totalPasses = 0;
  private totalCorrections = 0;

  /**
   * Creates a new ReconcilerService.
   *
   * @param dataProvider - Provides data access and mutation capabilities
   * @param config - Optional configuration override
   */
  constructor(
    dataProvider: ReconcilerDataProvider,
    config?: Partial<ReconcilerConfig>,
  ) {
    this.dataProvider = dataProvider;
    this.config = { ...DEFAULT_RECONCILER_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start the reconciliation loops (fast + full).
   * Called during backend startup.
   */
  start(): void {
    if (this.fastLoopTimer || this.fullLoopTimer) {
      this.stop();
    }

    this.fastLoopTimer = setInterval(
      () => void this.runFast(),
      this.config.fastLoopIntervalMs,
    );

    this.fullLoopTimer = setInterval(
      () => void this.runFull(),
      this.config.fullLoopIntervalMs,
    );
  }

  /**
   * Stop the reconciliation loops. Called during graceful shutdown.
   */
  stop(): void {
    if (this.fastLoopTimer) {
      clearInterval(this.fastLoopTimer);
      this.fastLoopTimer = null;
    }
    if (this.fullLoopTimer) {
      clearInterval(this.fullLoopTimer);
      this.fullLoopTimer = null;
    }
  }

  /**
   * Full reconciliation pass — scans all entities.
   * Called on startup, periodically (60s), and manually via API.
   *
   * @returns The reconciliation result
   */
  async runFull(): Promise<ReconcileResult> {
    return this.executeReconcile('full', async (result) => {
      const [workItems, requests, claims, agentHealthMap] = await Promise.all([
        this.dataProvider.getActiveWorkItems(),
        this.dataProvider.getActiveRequests(),
        this.dataProvider.getActiveClaims(),
        this.dataProvider.getAgentHealthMap(),
      ]);

      // 1. Detect stuck WorkItems (agent dead or timed out)
      const stuck = detectStuckWorkItems(
        workItems,
        agentHealthMap,
        this.config.workItemTimeoutMs,
      );
      result.corrections.push(...stuck.corrections);
      result.workItemsTimedOut += stuck.stuckIds.length;

      // 2. Detect expired claims
      const expired = detectExpiredClaims(claims);
      result.corrections.push(...expired.corrections);

      // 3. Detect recoverable blocked WorkItems
      const recoverable = detectRecoverableWorkItems(workItems, agentHealthMap);
      result.corrections.push(...recoverable.corrections);
      result.workItemsRequeued += recoverable.recoverableIds.length;

      // 4. Pruning pass (F4): TTL expiry + orphan cascade + deep cascade + stale queue detection
      const pruning = runPruningPass(workItems);
      result.corrections.push(...pruning.totalCorrections);
      result.staleItemsCleaned += pruning.ttlExpiredCount + pruning.orphanCancelledCount + pruning.cascadeCancelledCount;

      // 5. Reconcile Request statuses
      for (const request of requests) {
        const requestWorkItems = await this.dataProvider.getWorkItemsForRequest(request.id);
        const correction = reconcileRequestStatus(request, requestWorkItems);
        if (correction) {
          result.corrections.push(correction);
          result.requestsUpdated++;
        }
      }

      // 6. Apply all corrections
      await this.applyCorrections(result.corrections, result);
    });
  }

  /**
   * Fast reconciliation pass — checks leases, agent health, and Hybrid Wake.
   * Called frequently (every 10s) with minimal overhead.
   *
   * @returns The reconciliation result
   */
  async runFast(): Promise<ReconcileResult> {
    return this.executeReconcile('fast', async (result) => {
      const [claims, agentHealthMap, workItems] = await Promise.all([
        this.dataProvider.getActiveClaims(),
        this.dataProvider.getAgentHealthMap(),
        this.dataProvider.getActiveWorkItems(),
      ]);

      // 1. Check lease expiry
      const expired = detectExpiredClaims(claims);
      result.corrections.push(...expired.corrections);

      // 2. Quick stuck check on running items
      const runningItems = workItems.filter(wi => wi.status === 'running');
      const stuck = detectStuckWorkItems(
        runningItems,
        agentHealthMap,
        this.config.workItemTimeoutMs,
      );
      result.corrections.push(...stuck.corrections);
      result.workItemsTimedOut += stuck.stuckIds.length;

      // 3. Apply corrections
      await this.applyCorrections(result.corrections, result);

      // 4. Hybrid Wake: detect unclaimed tasks and wake dormant agents
      await this.runHybridWake(workItems, agentHealthMap, result);
    });
  }

  /**
   * Targeted reconciliation for a single Request.
   * Called when a specific Request's state may have changed.
   *
   * @param requestId - The Request ID to reconcile
   */
  async reconcileRequest(requestId: string): Promise<ReconcileResult> {
    return this.executeReconcile('targeted_request', async (result) => {
      const requests = await this.dataProvider.getActiveRequests();
      const request = requests.find(r => r.id === requestId);
      if (!request) return;

      const workItems = await this.dataProvider.getWorkItemsForRequest(requestId);
      const correction = reconcileRequestStatus(request, workItems);
      if (correction) {
        result.corrections.push(correction);
        result.requestsUpdated++;
        await this.applyCorrections(result.corrections, result);
      }
    });
  }

  /**
   * Returns current Reconciler status for API exposure.
   *
   * @returns Current status including last result, config, and counters
   */
  getStatus(): ReconcilerStatus {
    const now = new Date();
    return {
      isRunning: this.isRunning,
      lastResult: this.history[0],
      nextFullReconcileAt: this.fullLoopTimer
        ? new Date(now.getTime() + this.config.fullLoopIntervalMs).toISOString()
        : undefined,
      nextFastReconcileAt: this.fastLoopTimer
        ? new Date(now.getTime() + this.config.fastLoopIntervalMs).toISOString()
        : undefined,
      totalPasses: this.totalPasses,
      totalCorrections: this.totalCorrections,
      config: { ...this.config },
    };
  }

  /**
   * Returns recent reconciliation history.
   *
   * @param limit - Maximum number of results to return
   * @returns Array of recent ReconcileResults (newest first)
   */
  getHistory(limit: number = 20): ReconcileResult[] {
    return this.history.slice(0, Math.min(limit, this.config.maxHistorySize));
  }

  /**
   * Updates the Reconciler configuration at runtime.
   *
   * @param updates - Partial configuration to merge
   */
  updateConfig(updates: Partial<ReconcilerConfig>): void {
    this.config = { ...this.config, ...updates };

    // Restart loops if timing changed
    if (updates.fastLoopIntervalMs || updates.fullLoopIntervalMs) {
      const wasRunning = !!(this.fastLoopTimer || this.fullLoopTimer);
      if (wasRunning) {
        this.stop();
        this.start();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Executes a reconciliation pass with timing, error handling, and history tracking.
   *
   * @param type - The type of reconciliation
   * @param logic - The reconciliation logic to execute
   * @returns The completed ReconcileResult
   */
  private async executeReconcile(
    type: ReconcileType,
    logic: (result: ReconcileResult) => Promise<void>,
  ): Promise<ReconcileResult> {
    if (this.isRunning) {
      return createEmptyReconcileResult(type);
    }

    this.isRunning = true;
    const result = createEmptyReconcileResult(type);
    const startTime = Date.now();

    try {
      await logic(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Reconcile error: ${message}`);
    } finally {
      result.durationMs = Date.now() - startTime;
      result.reconciledAt = new Date().toISOString();
      this.isRunning = false;
      this.totalPasses++;
      this.totalCorrections += result.corrections.length;

      // Add to history (newest first)
      this.history.unshift(result);
      if (this.history.length > this.config.maxHistorySize) {
        this.history = this.history.slice(0, this.config.maxHistorySize);
      }
    }

    return result;
  }

  /**
   * Applies corrections by calling the data provider.
   * Handles errors gracefully — a failed correction doesn't stop the pass.
   *
   * @param corrections - Corrections to apply
   * @param result - The ReconcileResult to accumulate errors into
   */
  private async applyCorrections(
    corrections: ReconcileCorrection[],
    result: ReconcileResult,
  ): Promise<void> {
    for (const correction of corrections) {
      try {
        // Handle claim-specific corrections via ClaimService
        if (correction.entityType === 'claim') {
          if (correction.newState === 'expiring') {
            await this.dataProvider.markClaimExpiring(correction.entityId);
          } else if (correction.newState === 'revoked') {
            await this.dataProvider.revokeClaimAndRelease(
              correction.entityId,
              correction.reason,
            );
            result.claimsRevoked++;
          }
          continue;
        }

        await this.dataProvider.applyCorrection(correction);

        // If a WorkItem was revoked (from claim expiry), release it back to pool
        if (
          correction.entityType === 'work_item' &&
          correction.newState === 'revoked'
        ) {
          await this.dataProvider.releaseToPool(correction.entityId, correction.reason);
        }

        // If a WorkItem should be re-queued (recovery)
        if (
          correction.entityType === 'work_item' &&
          correction.newState === 'queued' &&
          correction.previousState === 'blocked'
        ) {
          await this.dataProvider.requeueWorkItem(correction.entityId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to apply correction for ${correction.entityType}:${correction.entityId}: ${message}`);
      }
    }
  }

  /**
   * Runs Hybrid Wake logic: detects unclaimed tasks in the pool and
   * wakes dormant agents (suspended → rehydrate, inactive → start).
   *
   * Only runs if the data provider supports pool item retrieval and wake execution.
   *
   * @param workItems - All active WorkItems (used as fallback if no pool provider)
   * @param agentHealthMap - Map of agent session → health info
   * @param result - The ReconcileResult to accumulate wake actions into
   */
  private async runHybridWake(
    workItems: WorkItem[],
    agentHealthMap: Map<string, AgentHealth>,
    result: ReconcileResult,
  ): Promise<void> {
    // Only run if the provider supports wake actions
    if (!this.dataProvider.executeWakeAction) return;

    // Use pool items if available, otherwise fall back to active work items
    const poolItems = this.dataProvider.getAvailablePoolItems
      ? await this.dataProvider.getAvailablePoolItems()
      : workItems.filter(wi => wi.status === 'queued');

    const { wakeActions } = detectUnclaimedTasks(poolItems, agentHealthMap);

    // Execute each wake action
    for (const action of wakeActions) {
      try {
        const success = await this.dataProvider.executeWakeAction(action);
        if (success) {
          result.wakeActions.push(action);
          result.agentsWoken++;
        } else {
          result.errors.push(
            `Wake action failed for agent ${action.agentSessionName} (strategy: ${action.strategy})`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(
          `Wake action error for agent ${action.agentSessionName}: ${message}`,
        );
      }
    }
  }
}
