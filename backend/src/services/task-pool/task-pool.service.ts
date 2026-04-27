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
import { formatError } from '../../utils/format-error.js';
import type {
  WorkItem,
  WorkItemStatus,
  WorkItemType,
  WorkItemOwner,
} from '../../types/v2/work-item.types.js';
import { isWorkItem, isValidWorkItemTransition, isTransitionPermitted } from '../../types/v2/work-item.types.js';
import {
  createTaskClaim,
  type TaskClaim,
  type CreateClaimInput,
} from '../../types/v2/claim.types.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';

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

  /**
   * Optional EventBus reference — wired via {@link setEventBusService} from
   * the boot path. When set, {@link addToPool} publishes a `workitem:queued`
   * event so subscribers (notably {@link RequestSlaSubscriber}) can react to
   * queue mutations. Optional because singleton callers (tests, CLI) bring
   * up the pool before the bus exists; missing bus is treated as a no-op
   * publish at warn level.
   */
  private eventBus: EventBusService | null = null;

  /**
   * Serializes claim operations to prevent the race where two concurrent
   * claimFromPool / claimSpecificItem calls both select the same queued
   * WorkItem between their read and write phases. In-process only — does
   * not protect against cross-process races, but the backend runs as a
   * single process today.
   */
  private claimMutex: Promise<void> = Promise.resolve();

  constructor(storage?: PoolStorage) {
    this.storage = storage ?? new PoolStorage();
    this.claimService = new ClaimService(this.storage);
    this.logger = LoggerService.getInstance().createComponentLogger('TaskPoolService');
  }

  /**
   * Wire the EventBus reference used by {@link addToPool} to publish
   * `workitem:queued` events (INBOUND-1.f1). Called from the backend boot
   * path after both services have been constructed. Idempotent and may be
   * called with `null` to disable publishing (testing).
   *
   * @param bus - The EventBus instance, or null to clear
   */
  setEventBusService(bus: EventBusService | null): void {
    this.eventBus = bus;
  }

  /**
   * Chains the given critical section after any in-flight claim operation.
   * Guarantees FIFO ordering even under concurrent invocation.
   */
  private withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.claimMutex;
    let release!: () => void;
    this.claimMutex = new Promise<void>((r) => {
      release = r;
    });
    return prev.then(fn).finally(() => release());
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
   * Accepted statuses:
   * - `queued`  — ready to run
   * - `blocked` — waiting on unresolved dependsOn; the resolver will promote
   *               it to `queued` when every upstream dep reaches terminal success.
   *
   * @param workItem - The work item to add
   * @throws Error if workItem is invalid or in an ineligible status
   */
  async addToPool(workItem: WorkItem): Promise<void> {
    if (!isWorkItem(workItem)) {
      throw new Error('Invalid WorkItem: does not conform to WorkItem interface');
    }
    if (workItem.status !== 'queued' && workItem.status !== 'blocked') {
      throw new Error(
        `Cannot add WorkItem to pool: status must be 'queued' or 'blocked', got '${workItem.status}'`,
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

    // INBOUND-1.f1: announce the queue mutation so subscribers (notably the
    // RequestSlaSubscriber) can react. We publish AFTER the storage flush
    // so any subscriber that re-reads via taskPool.findWorkItem sees the
    // committed item. Publish failures are logged-but-isolated — the pool
    // mutation is the source of truth, the event is informational.
    this.publishWorkItemQueued(workItem);
  }

  /**
   * INBOUND-1.f1 helper: publish a `workitem:queued` event with correlation
   * ids the SLA subscriber needs (`requestId`, `missionId`, plus the new
   * `workItemId`). Called by {@link addToPool} after the storage flush.
   *
   * Stays a separate method (vs inlining) so:
   *   1. The dependency on EventBus stays explicit and grep-able.
   *   2. A future caller adding an alternate enqueue path (e.g. a batch
   *      addAll) can route through the same publisher for consistent
   *      observability.
   *   3. Error handling stays in one place — a thrown publisher must NOT
   *      back out the pool mutation (the storage write already committed).
   */
  private publishWorkItemQueued(workItem: WorkItem): void {
    if (!this.eventBus) {
      this.logger.debug('No EventBus wired — skipping workitem:queued publish', {
        workItemId: workItem.id,
      });
      return;
    }
    try {
      this.eventBus.publish({
        // Deterministic event id keyed on the WI id so a redelivered storage
        // path (theoretical) collapses through the bus's per-(type,session)
        // debounce window without firing the SLA handler twice.
        id: `workitem:queued:${workItem.id}`,
        type: 'workitem:queued',
        timestamp: new Date().toISOString(),
        teamId: '',
        teamName: '',
        memberId: '',
        memberName: '',
        // sessionName is empty — `workitem:queued` is a system-level event
        // not attributable to a specific agent session. The bus's dedup key
        // is `${type}:${sessionName}` so a unique sessionName per WI would
        // defeat the dedup; an empty sessionName scoped per-id is fine since
        // the event id already encodes the WI uniquely.
        sessionName: '',
        previousValue: '',
        newValue: workItem.status,
        changedField: 'taskStatus',
        // INBOUND-1.f1 correlation fields. Mandatory: workItemId. Optional:
        // requestId, missionId — populated when the WI carries them. The SLA
        // subscriber no-ops when requestId is undefined (per spec), so we
        // don't need a fallback chain here.
        workItemId: workItem.id,
        requestId: workItem.requestId,
        missionId: workItem.missionId,
      });
    } catch (err) {
      this.logger.warn('workitem:queued publish threw', {
        workItemId: workItem.id,
        error: formatError(err),
      });
    }
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

    return this.withClaimLock(async () => {
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

      // TRANS-2: route the queued → running flip through the guarded
      // transitionStatus helper so internal callers are subject to the
      // same V3 actor-role + state-machine gates as external callers.
      // `startedAt` is set automatically by transitionStatus when
      // newStatus === 'running'; the mutator carries the agent target.
      const claimedItem = await this.transitionStatus(
        selected.id,
        'running',
        'system',
        (wi) => {
          wi.target = agentId;
        },
      );

      if (!claimedItem) {
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

      return {
        workItem: claimedItem,
        claim,
      };
    });
  }

  /**
   * Claims a specific WorkItem by ID for an agent.
   * Used by AgentAutoClaimService for score-based selection where the caller
   * already identified the best item (not FIFO).
   *
   * @param agentId - Agent session name claiming the item
   * @param workItemId - The specific WorkItem to claim
   * @returns The claimed work item and claim, or null if unavailable
   */
  async claimSpecificItem(agentId: string, workItemId: string): Promise<ClaimResult | null> {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a non-empty string');
    }

    return this.withClaimLock(async () => {
      const existingClaim = await this.storage.findActiveClaimByAgent(agentId);
      if (existingClaim) return null;

      const workItem = await this.storage.findWorkItem(workItemId);
      if (!workItem || workItem.status !== 'queued') return null;

      const claims = await this.storage.getClaims();
      if (claims.some((c) => c.workItemId === workItemId && c.status === 'active')) return null;

      // TRANS-2: route the queued → running flip through transitionStatus
      // (mirrors claimFromPool — same V3 + state-machine gates).
      const claimedItem = await this.transitionStatus(
        workItemId,
        'running',
        'system',
        (wi) => {
          wi.target = agentId;
        },
      );
      if (!claimedItem) return null;

      const claimInput: CreateClaimInput = { workItemId, agentId };
      const claim = createTaskClaim(claimInput);
      await this.storage.addClaim(claim);
      await this.storage.flush();

      this.logger.info('WorkItem claimed (specific)', { workItemId, agentId, claimId: claim.id });

      return { workItem: claimedItem, claim };
    });
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
    if (workItem.status !== 'running' && workItem.status !== 'blocked') {
      throw new Error(
        `Cannot release WorkItem: status must be 'running' or 'blocked', got '${workItem.status}'`,
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

    // TRANS-2: route the (running|blocked) → queued flip through the
    // guarded transitionStatus helper. The state-machine entry for
    // `running → queued` is a TRANS-2 addition, gated to system/TL/orc;
    // `blocked → queued` was already TL/orc/system-gated by TRANS-1.
    // Side-effect mutations (startedAt clear, target preservation when
    // unblocking, retryCount bump) move into the atomic mutator.
    const wasBlocked = workItem.status === 'blocked';
    await this.transitionStatus(workItemId, 'queued', 'system', (wi) => {
      wi.startedAt = undefined;
      if (!wasBlocked) {
        wi.target = undefined;
      }
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
   * Decide whether a WorkItem requires TL verification before reaching a
   * terminal-success status.
   *
   * Default policy (VERIF-1):
   *   - `delegate` items default to *requires verification* — a worker
   *     marking their own delegated work as "done" should produce
   *     `done_by_worker` and wake the TL for sign-off.
   *   - All other types (`cron_run`, `notify`, `reconcile`, `check`,
   *     `confirm`, `review`, ...) default to simple completion (`done`).
   *
   * The default is overridable via `wi.metadata.requiresVerification`:
   *   - `true`  — force verification path even for non-delegate types
   *   - `false` — skip verification even for delegate types (this is the
   *     F-H affordance REVIEW-1 needs: review WIs are themselves the
   *     verification step, so they must NOT loop back to TL self-verify)
   *
   * @param wi - The WorkItem under inspection
   * @returns true when the verification path should fire
   */
  private requiresVerification(wi: WorkItem): boolean {
    const metaFlag = (wi.metadata as { requiresVerification?: boolean } | undefined)?.requiresVerification;
    if (metaFlag === true) return true;
    if (metaFlag === false) return false;
    return wi.type === 'delegate';
  }

  /**
   * Internal: release the active claim on a WorkItem (if any). Shared by
   * `completeSimpleItem` and `submitForVerification` because both
   * represent the worker handing the item back to the system.
   *
   * @param workItemId - WorkItem whose claim should be released
   * @param endReason - Reason recorded on the claim (`completed` /
   *   `submitted_for_verification`) for auditability
   */
  private async releaseClaim(workItemId: string, endReason: string): Promise<void> {
    const claim = await this.storage.findActiveClaimByWorkItem(workItemId);
    if (!claim) return;
    await this.storage.updateClaim(claim.id, (c) => {
      c.status = 'released';
      c.endedAt = new Date().toISOString();
      c.endReason = endReason;
    });
  }

  /**
   * Worker reports a delegated WorkItem as done and submits it for TL
   * verification.
   *
   * Transitions `running → done_by_worker` via {@link transitionStatus},
   * which enforces the V3 actor-role gate (`'agent'` is allowed; any
   * other role throws). The active claim is released as
   * `submitted_for_verification` so the TL queue is the only thing
   * blocking forward progress.
   *
   * Used by the `completeItem` facade for `delegate`-type items and any
   * item whose `metadata.requiresVerification === true`.
   *
   * @param workItemId - WorkItem id
   * @param actorRole - Role of the caller (`'agent'` for normal worker
   *   submissions; passed through to `isTransitionPermitted`)
   * @param result - Optional result payload to attach to the WorkItem
   * @returns The updated WorkItem, or `null` if the WI was deleted
   *   between the find and the update (race window)
   * @throws When the WorkItem is missing, the transition is invalid, or
   *   the actor is not permitted to perform `running → done_by_worker`.
   */
  async submitForVerification(
    workItemId: string,
    actorRole: WorkItemOwner,
    result?: Record<string, unknown>,
  ): Promise<WorkItem | null> {
    await this.releaseClaim(workItemId, 'submitted_for_verification');
    const updated = await this.transitionStatus(
      workItemId,
      'done_by_worker',
      actorRole,
      (wi) => {
        if (result) wi.result = result;
      },
    );
    await this.storage.flush();
    this.logger.info('WorkItem submitted for verification', {
      workItemId,
      actorRole,
      // BRIDGE-1 will turn this into a real `task:done_by_worker` event
      // that wakes the TL session. For now the log line is the wake
      // signal — a TL-watching subscriber can grep on it.
      tlWakeRequested: true,
    });
    return updated;
  }

  /**
   * Worker (or system) marks a non-delegated WorkItem as fully done.
   *
   * Transitions `running → done` via {@link transitionStatus}. Used by
   * the `completeItem` facade for `cron_run`, `notify`, `reconcile`,
   * `check`, `confirm`, `review` types — anything whose lifecycle does
   * NOT include a TL verification step.
   *
   * The Reconciler service is the only system-actor caller and uses
   * `actorRole='system'`, which bypasses the actor check while still
   * respecting the state-machine legality check.
   *
   * @param workItemId - WorkItem id
   * @param actorRole - Role of the caller (`'agent'`, `'system'`, etc.)
   * @param result - Optional result payload to attach
   * @returns The updated WorkItem, or `null` if the WI was deleted
   *   between the find and the update (race window)
   * @throws When the WorkItem is missing, the transition is invalid, or
   *   the actor is not permitted to perform `running → done`.
   */
  async completeSimpleItem(
    workItemId: string,
    actorRole: WorkItemOwner,
    result?: Record<string, unknown>,
  ): Promise<WorkItem | null> {
    await this.releaseClaim(workItemId, 'completed');
    const updated = await this.transitionStatus(
      workItemId,
      'done',
      actorRole,
      (wi) => {
        if (result) wi.result = result;
      },
    );
    // Promote any blocked dependents whose deps are now all satisfied.
    await this.resolveBlockedDependents(workItemId);
    await this.storage.flush();
    this.logger.info('WorkItem completed', { workItemId, actorRole });
    return updated;
  }

  /**
   * TL records a verdict on a WorkItem in `done_by_worker` status.
   *
   * `verified` advances to terminal success and unblocks dependents;
   * `rejected` parks the item until the TL re-queues it (which TRANS-1
   * gates to TL/orchestrator/system actors). Worker-actor calls throw
   * automatically via {@link transitionStatus}'s permission gate — we
   * do NOT need to add an explicit role check here, the matrix in
   * `TRANSITION_PERMISSIONS` handles it.
   *
   * @param workItemId - WorkItem id (must currently be `done_by_worker`)
   * @param actorRole - Role of the caller (`'team_lead'` or `'orchestrator'`
   *   for verify/reject; worker calls throw)
   * @param verdict - `'verified'` or `'rejected'`
   * @param comment - Optional reviewer comment recorded in `wi.error`
   *   (the field is reused — the WorkItem schema does not yet have a
   *   dedicated `verifierComment` slot; keeping this on `error` lets
   *   downstream UIs render TL feedback alongside failure causes)
   * @returns The updated WorkItem, or `null` on race-window deletion
   * @throws When the WorkItem is missing, the verdict is invalid, the
   *   transition is illegal, or the actor is not permitted to verify.
   */
  async verifyItem(
    workItemId: string,
    actorRole: WorkItemOwner,
    verdict: 'verified' | 'rejected',
    comment?: string,
  ): Promise<WorkItem | null> {
    if (verdict !== 'verified' && verdict !== 'rejected') {
      throw new Error(
        `Invalid verdict: "${verdict}". Must be "verified" or "rejected".`,
      );
    }
    const updated = await this.transitionStatus(
      workItemId,
      verdict,
      actorRole,
      (wi) => {
        if (comment) wi.error = comment;
      },
    );
    if (verdict === 'verified') {
      await this.resolveBlockedDependents(workItemId);
    }
    await this.storage.flush();
    this.logger.info('WorkItem verdict recorded', { workItemId, verdict, actorRole });
    return updated;
  }

  /**
   * Legacy facade — picks the verification path for the caller.
   *
   * Existing call sites (REST controller, task-management controllers,
   * V3 data service) invoke `completeItem(id, result)` without an
   * explicit actor role. The facade reads the WorkItem, applies the
   * {@link requiresVerification} policy, and dispatches to either
   * {@link submitForVerification} (delegate items / explicit opt-in)
   * or {@link completeSimpleItem} (everything else).
   *
   * The legacy actor role for these implicit callers is `'agent'`.
   * Migrations to explicit-actor calls can land in follow-up tickets
   * without touching the five call sites in this PR.
   *
   * @param workItemId - WorkItem id
   * @param result - Optional result payload
   * @throws When the WorkItem is missing or the underlying transition
   *   is rejected (invalid state, forbidden actor).
   */
  async completeItem(
    workItemId: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    const workItem = await this.storage.findWorkItem(workItemId);
    if (!workItem) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }
    if (this.requiresVerification(workItem)) {
      await this.submitForVerification(workItemId, 'agent', result);
    } else {
      await this.completeSimpleItem(workItemId, 'agent', result);
    }
  }

  /**
   * Scans blocked WorkItems that list `completedId` in their `dependsOn` and
   * promotes each to `queued` if every one of their deps has reached terminal
   * success (`done` or `verified`). Idempotent and safe to call on any terminal
   * success transition.
   *
   * Serialized via the claim mutex — a concurrent claimFromPool call must not
   * observe a half-promoted item.
   */
  async resolveBlockedDependents(completedId: string): Promise<void> {
    await this.withClaimLock(async () => {
      const items = await this.storage.getWorkItems();
      const terminalSuccess = new Set<string>(
        items
          .filter((wi) => wi.status === 'done' || wi.status === 'verified')
          .map((wi) => wi.id),
      );

      const candidates = items.filter(
        (wi) =>
          wi.status === 'blocked' &&
          Array.isArray(wi.dependsOn) &&
          wi.dependsOn.includes(completedId),
      );

      for (const candidate of candidates) {
        const allSatisfied = (candidate.dependsOn ?? []).every((depId) =>
          terminalSuccess.has(depId),
        );
        if (!allSatisfied) continue;

        // TRANS-2: route the blocked → queued promotion through
        // transitionStatus. The 'system' actor matches both the V3
        // permission gate (blocked→queued requires TL/orc/system) and
        // the existing intent — dependency resolution is server-side
        // bookkeeping, not a user-initiated action.
        await this.transitionStatus(candidate.id, 'queued', 'system');
        this.logger.info('WorkItem unblocked — all deps satisfied', {
          workItemId: candidate.id,
          via: completedId,
        });
      }
    });
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

    // TRANS-2: route the running → failed flip through transitionStatus.
    // `completedAt` is set automatically when newStatus === 'failed'; the
    // mutator only needs to attach the error description.
    await this.transitionStatus(workItemId, 'failed', 'system', (wi) => {
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
   * Find a WorkItem by id without mutating it.
   *
   * Public read accessor used by callers that need to inspect a
   * specific item — for example REVIEW-1's reentrancy lock checks the
   * status of a Mission's `pendingReviewWorkItemId` to decide whether
   * to clear the lock. Returns `null` (not `undefined`) so callers can
   * use a uniform null-fallthrough idiom shared with
   * `getWorkItemSnapshot` and `transitionStatus`.
   *
   * @param workItemId - WorkItem id to look up
   * @returns The WorkItem, or `null` if no item has that id
   */
  async findWorkItem(workItemId: string): Promise<WorkItem | null> {
    return (await this.storage.findWorkItem(workItemId)) ?? null;
  }

  /**
   * Removes a WorkItem from the pool entirely.
   * Used for purging old completed/cancelled items.
   *
   * @param workItemId - ID of the item to remove
   */
  async removeItem(workItemId: string): Promise<void> {
    await this.storage.removeWorkItem(workItemId);
  }

  /**
   * Forces an immediate flush of pool data to disk.
   * Called during graceful shutdown to prevent data loss.
   */
  async flush(): Promise<void> {
    await this.storage.flush();
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
   * Reconciler invocations pass through `actorRole='system'` (default) which
   * bypasses the per-role gate at {@link isTransitionPermitted} but still
   * enforces the state-machine via {@link isValidWorkItemTransition}. Other
   * callers MUST supply the actor's role so TRANS-1 V3 enforcement applies.
   *
   * @param workItemId - The work item ID
   * @param newStatus - The target status
   * @param actorRole - Role of the caller (defaults to `'system'` for Reconciler)
   * @throws Error if work item not found
   * @throws Error if transition is invalid (state machine — see WORK_ITEM_TRANSITIONS)
   * @throws Error if actor is not permitted (role check — see TRANSITION_PERMISSIONS)
   */
  async updateItemStatus(
    workItemId: string,
    newStatus: WorkItemStatus,
    actorRole: WorkItemOwner = 'system',
  ): Promise<void> {
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

    // TRANS-1 V3: enforce per-role permissions. system role always passes.
    if (!isTransitionPermitted(item.status, newStatus, actorRole)) {
      throw new Error(
        `Forbidden transition for WorkItem ${workItemId}: actor='${actorRole}' ` +
          `not permitted to perform ${item.status} → ${newStatus}.`,
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
      actorRole,
    });
  }

  /**
   * Public guarded transition helper — TRANS-1's canonical entrypoint.
   *
   * Routes any externally-initiated WorkItem status change through the
   * combined state-machine + actor-role gates. Designed as the public API
   * VERIF-1 will call from `submitForVerification` / `verifyItem`, and as
   * the recommended path for any future caller that previously reached
   * for `storage.updateWorkItem` to flip status.
   *
   * Differences vs {@link updateItemStatus}:
   *   - Requires `actorRole` explicitly (no default) — forces the caller to
   *     decide the trust posture rather than silently inheriting `'system'`.
   *   - Accepts an optional `mutator` so callers can carry additional field
   *     updates (e.g. `result`, `error`, `completedAt`) atomically with the
   *     status flip — preventing races between status update and metadata
   *     attachment that direct `storage.updateWorkItem` callers risked.
   *
   * @param workItemId - The work item ID
   * @param newStatus - The target status
   * @param actorRole - Role of the caller (REQUIRED; pass `'system'` for trusted server-internal paths)
   * @param mutator - Optional additional WorkItem field updates applied atomically with the status change
   * @returns The updated WorkItem after the transition
   * @throws Error if work item not found
   * @throws Error if transition is invalid (state machine)
   * @throws Error if actor is not permitted (role check)
   *
   * @example
   * ```typescript
   * // VERIF-1 worker submitting for verification
   * await pool.transitionStatus(wiId, 'done_by_worker', 'agent', (wi) => {
   *   wi.result = output;
   * });
   *
   * // VERIF-1 TL verifying
   * await pool.transitionStatus(wiId, 'verified', 'team_lead');
   *
   * // VERIF-1 TL rejecting (allowed for TL only)
   * await pool.transitionStatus(wiId, 'rejected', 'team_lead', (wi) => {
   *   wi.error = 'Did not meet acceptance criteria';
   * });
   * ```
   */
  async transitionStatus(
    workItemId: string,
    newStatus: WorkItemStatus,
    actorRole: WorkItemOwner,
    mutator?: (wi: WorkItem) => void,
  ): Promise<WorkItem | null> {
    const item = await this.storage.findWorkItem(workItemId);
    if (!item) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }

    if (!isValidWorkItemTransition(item.status, newStatus)) {
      throw new Error(
        `Invalid status transition for WorkItem ${workItemId}: ${item.status} → ${newStatus}`,
      );
    }

    if (!isTransitionPermitted(item.status, newStatus, actorRole)) {
      throw new Error(
        `Forbidden transition for WorkItem ${workItemId}: actor='${actorRole}' ` +
          `not permitted to perform ${item.status} → ${newStatus}.`,
      );
    }

    const ok = await this.storage.updateWorkItem(workItemId, (wi) => {
      wi.status = newStatus;
      // Standard timestamp side-effects mirror updateItemStatus so callers
      // get consistent metadata regardless of which API they used.
      if (newStatus === 'running') {
        wi.startedAt = new Date().toISOString();
      } else if (
        newStatus === 'done' ||
        newStatus === 'failed' ||
        newStatus === 'verified' ||
        newStatus === 'done_by_worker' ||
        newStatus === 'rejected'
      ) {
        wi.completedAt = new Date().toISOString();
      }
      if (mutator) mutator(wi);
    });

    if (!ok) {
      // Race window: someone else removed the WorkItem between findWorkItem
      // and updateWorkItem. Surface as null so callers can distinguish from
      // a thrown invalid-transition / forbidden-transition error.
      return null;
    }

    this.logger.info('WorkItem transitioned', {
      workItemId,
      from: item.status,
      to: newStatus,
      actorRole,
    });

    // Return the post-update WorkItem snapshot so callers can chain on the
    // resolved value rather than re-fetching. Coerce `undefined` (item
    // removed during the race window) to `null` to match the declared
    // return type.
    return (await this.storage.findWorkItem(workItemId)) ?? null;
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
