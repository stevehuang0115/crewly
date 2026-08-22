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
import {
  isWorkItem,
  isValidWorkItemTransition,
  isTransitionPermitted,
  LAST_REQUEUED_AT_METADATA_KEY,
  DISPOSITION_METADATA_KEY,
  DISPOSITION_REQUIRED_STATUSES,
  getWorkItemDisposition,
} from '../../types/v2/work-item.types.js';
import type { WorkItemDisposition } from '../../types/v2/work-item.types.js';
import {
  createTaskClaim,
  type TaskClaim,
  type CreateClaimInput,
} from '../../types/v2/claim.types.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';

/**
 * Narrow Request-link contract consumed by {@link TaskPoolService.addToPool}.
 *
 * Defined as a duck-typed interface (rather than importing the full
 * `RequestService` class) so tests can supply fakes without depending on
 * the RequestService transitive imports, and to keep the dependency
 * direction one-way: TaskPool → Request, never the reverse.
 *
 * P1 Bug B (Pool umbrella WI 72ca743a-3a66-4d0e-a6cf-1a861f849dbd):
 * the production `linkWorkItem` is idempotent — it short-circuits when
 * `workItemId` is already in `request.workItemIds[]` — so the
 * intrinsic-link path here is safe to coexist with downstream
 * subscriber-driven linking (request-sla.subscriber, V3DataService).
 */
export interface IRequestWorkItemLinker {
  /**
   * Idempotently link a WorkItem id to a Request's workItemIds[].
   *
   * @param requestId - The parent Request id (already on the WI).
   * @param workItemId - The WorkItem id to link.
   * @returns The updated Request, or null if the Request was not found.
   *   `addToPool` ignores the return value — link failure is best-effort.
   */
  linkWorkItem(requestId: string, workItemId: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Bulk-DELETE types (P1 1ffffb84 component a)
// ---------------------------------------------------------------------------

/** Result of {@link TaskPoolService.removeFromPool}. */
export interface RemoveFromPoolResult {
  /** `true` when the WorkItem existed and was removed. */
  removed: boolean;
  /** The deleted WorkItem (only when removed === true). */
  workItem?: WorkItem;
  /** `true` when an active claim was found at delete time. */
  hadActiveClaim?: boolean;
  /** Cause when removed === false. */
  reason?: 'not_found';
}

/**
 * Structured error thrown by {@link TaskPoolService.removeFromPool}
 * when an active claim exists and `force: true` was not passed.
 */
export class WorkItemClaimedError extends Error {
  public readonly workItemId: string;
  public readonly claimId: string;
  public readonly claimedBy: string;

  constructor(args: { workItemId: string; claimId: string; claimedBy: string }) {
    super(
      `WorkItem '${args.workItemId}' has an active claim ` +
      `(claimId='${args.claimId}', claimedBy='${args.claimedBy}'). ` +
      `Pass { force: true } to delete anyway (will revoke the claim).`,
    );
    this.name = 'WorkItemClaimedError';
    this.workItemId = args.workItemId;
    this.claimId = args.claimId;
    this.claimedBy = args.claimedBy;
    Object.setPrototypeOf(this, WorkItemClaimedError.prototype);
  }
}

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
 *
 * `alreadyHeld` (Steve 2026-05-15, issue #513): true when the caller
 * already had an active claim — we return that claim + its WorkItem
 * instead of returning null. Callers (skill scripts, controller) can
 * distinguish "fresh claim" from "you already own this" and route
 * accordingly. Default `false` for new claims so existing callers
 * stay source-compat.
 */
export interface ClaimResult {
  /** The claimed work item */
  workItem: WorkItem;
  /** The claim object tracking the lease */
  claim: TaskClaim;
  /** Set when the caller already held an active claim before this call */
  alreadyHeld?: boolean;
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

/**
 * Options for {@link TaskPoolService.releaseBack}.
 */
export interface ReleaseBackOptions {
  /**
   * When true, clear the item's `target` as well, returning it to the
   * unassigned pool.
   *
   * Defaults to false: a release ends an attempt, it does not revoke an
   * assignment. This must be requested BY NAME so that un-assignment is
   * always a deliberate act by a caller who means it, never a silent
   * side effect of a lease expiring.
   */
  unassign?: boolean;
}

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
   * Optional Request-linker reference — wired via {@link setRequestService}
   * from the boot path. When set, {@link addToPool} pushes the new WI's id
   * into the parent `Request.workItemIds[]` immediately after the storage
   * flush, independent of any downstream subscriber.
   *
   * P1 Bug B (Pool umbrella WI 72ca743a) intrinsic-link contract:
   *  - The pre-fix path relied on `workitem:queued` / `task:delegated`
   *    subscribers (request-sla.subscriber, V3DataService) to backfill
   *    `Request.workItemIds[]`. Manual / programmatic / cron callers that
   *    bypass the standard event chain left Requests with
   *    `workItemIds=[]` even though their WIs were in the pool.
   *  - The intrinsic path here is the source-of-truth link and runs on
   *    every `addToPool`. Subscriber-driven linking remains as
   *    belt-and-suspenders (idempotent — see request.service.ts:328
   *    short-circuit on duplicate id).
   *  - Optional because singleton callers (tests, CLI) bring up the pool
   *    before RequestService exists; missing linker is a no-op debug log.
   */
  private requestService: IRequestWorkItemLinker | null = null;

  /**
   * Optional agent-liveness probe — wired via {@link setIsAgentActive} from
   * the boot path. When set, {@link claimFromPool} and {@link claimSpecificItem}
   * refuse to issue a claim if the requesting agent's PTY session is not alive.
   *
   * Why: the invariant is that a WI in `running` status is being executed by
   * a live agent. The orchestrator's `delegate-task` skill pre-claims a fresh
   * WI for its target before the target session is actually spawned (see
   * `config/skills/orchestrator/delegate-task/execute.sh` "self-heal fix #1"
   * 2026-04). That pushes the WI from `queued` to `running` while the target
   * is still inactive. 5 s later the reconciler's `detectStuckWorkItems`
   * rule sees `running` + dead agent and marks the WI `blocked` — and the
   * reconciler's `detectUnclaimedTasks` wake-rule only handles `queued`
   * items, so the agent never gets spawned and the WI is stuck forever.
   *
   * Rejecting the claim at the source keeps the WI in `queued`, letting the
   * wake-rule do its job (start the agent → agent auto-claims when it boots).
   * delegate-task's existing fallback path (line 277 of execute.sh — "if
   * claim fails (race, target locked, etc.) the work proceeds via the
   * async path") already handles a rejected pre-claim gracefully.
   *
   * Optional because singleton callers (tests, CLI) bring up the pool
   * before any agent-registration plumbing exists; missing probe = "trust
   * the caller" (current behavior preserved for those code paths).
   */
  private isAgentActive: ((agentId: string) => Promise<boolean>) | null = null;

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
   * Wire the Request-linker reference used by {@link addToPool} to
   * intrinsically link the new WI into its parent `Request.workItemIds[]`
   * (P1 Bug B — Pool umbrella WI 72ca743a).
   *
   * Called from the backend boot path after both services exist.
   * Idempotent and may be called with `null` to disable intrinsic
   * linking (testing). Mirrors the {@link setEventBusService} setter
   * pattern so the dependency wiring stays uniform and grep-able.
   *
   * @param svc - The RequestService instance (or any object satisfying
   *   {@link IRequestWorkItemLinker}), or null to clear.
   */
  setRequestService(svc: IRequestWorkItemLinker | null): void {
    this.requestService = svc;
  }

  /**
   * Wire the agent-liveness probe used by {@link claimFromPool} and
   * {@link claimSpecificItem} to refuse claims for dead/missing target
   * sessions. Called from the backend boot path after the agent runtime
   * exists. Idempotent and may be called with `null` to disable the gate
   * (testing or single-process CLI).
   *
   * @param probe - Async function returning whether the named session is
   *   currently alive (PTY exists + child runtime running), or null to clear
   */
  setIsAgentActive(probe: ((agentId: string) => Promise<boolean>) | null): void {
    this.isAgentActive = probe;
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

    // P1 Bug B (Pool umbrella WI 72ca743a): intrinsically link the new
    // WI into its parent `Request.workItemIds[]` if a linker is wired
    // and the WI carries a requestId. This is the SOURCE-OF-TRUTH link
    // and runs unconditionally on every successful addToPool, fixing
    // the bug where manual / programmatic / cron / orchestrator-script
    // callers that bypass the standard event chain left Requests with
    // empty `workItemIds[]`.
    //
    // Subscriber-driven linking (request-sla.subscriber.ts on
    // workitem:queued, V3DataService.onTaskDelegated on task:delegated)
    // continues to run as belt-and-suspenders — `linkWorkItem` is
    // idempotent (request.service.ts:328 short-circuits on duplicate id),
    // so double-link is safe.
    //
    // Failure isolation: pool mutation is the source of truth. Link
    // failures are warn-logged and swallowed; subscriber path remains
    // as a backup, and a future addToPool of the same WI is a no-op
    // (storage dedup) so retry comes via natural traffic.
    await this.linkWorkItemToRequest(workItem);

    // INBOUND-1.f1: announce the queue mutation so subscribers (notably the
    // RequestSlaSubscriber) can react. We publish AFTER the storage flush
    // so any subscriber that re-reads via taskPool.findWorkItem sees the
    // committed item. Publish failures are logged-but-isolated — the pool
    // mutation is the source of truth, the event is informational.
    this.publishWorkItemQueued(workItem);
  }

  /**
   * P1 Bug B helper: intrinsically link a freshly-added WI into its
   * parent `Request.workItemIds[]`.
   *
   * Stays a separate method (vs inlining) so:
   *   1. The dependency on RequestService stays explicit and grep-able,
   *      mirroring {@link publishWorkItemQueued}.
   *   2. Future enqueue paths (e.g. a batch addAll) can route through
   *      the same linker for consistent behaviour.
   *   3. Error handling stays in one place — a thrown linker must NOT
   *      back out the pool mutation (the storage write already committed).
   *
   * @param workItem - The WI just persisted into the pool.
   */
  private async linkWorkItemToRequest(workItem: WorkItem): Promise<void> {
    if (!workItem.requestId) {
      // No parent Request — nothing to link.
      return;
    }
    if (!this.requestService) {
      this.logger.debug(
        'No RequestService wired — skipping intrinsic Request link',
        { workItemId: workItem.id, requestId: workItem.requestId },
      );
      return;
    }
    try {
      await this.requestService.linkWorkItem(workItem.requestId, workItem.id);
    } catch (linkError) {
      this.logger.warn(
        'Bug B intrinsic link failed (subscriber path remains as fallback)',
        {
          requestId: workItem.requestId,
          workItemId: workItem.id,
          error: formatError(linkError),
        },
      );
    }
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
   * F1-BRIDGE-1 helper: publish `task:done_by_worker` after a successful
   * `submitForVerification` transition. The {@link EventToWorkItemBridge}
   * subscribes to this event and creates a verification WorkItem for the
   * resolved team-lead session.
   *
   * Stays a separate method (mirrors {@link publishWorkItemQueued}) so:
   *   1. The dependency on EventBus stays explicit and grep-able — Arch's
   *      grep guard checks both the type declaration AND a publish call
   *      site for `task:done_by_worker`.
   *   2. Error handling is uniform with the other publishers — a thrown
   *      bus must NOT back out the verified state transition; the storage
   *      flush has already committed.
   *   3. A future caller adding an alternate verification-submission path
   *      (e.g. an admin endpoint or a CLI) routes through the same publisher.
   *
   * The deterministic event id (`task:done_by_worker:${workItemId}`) keys
   * dedup so a redelivered submitForVerification (theoretical) collapses
   * through the bus without firing the bridge handler twice.
   */
  private publishTaskDoneByWorker(workItem: WorkItem): void {
    if (!this.eventBus) {
      this.logger.debug('No EventBus wired — skipping task:done_by_worker publish', {
        workItemId: workItem.id,
      });
      return;
    }
    try {
      this.eventBus.publish({
        id: `task:done_by_worker:${workItem.id}`,
        type: 'task:done_by_worker',
        timestamp: new Date().toISOString(),
        teamId: '',
        teamName: '',
        memberId: '',
        memberName: '',
        // sessionName is empty — `task:done_by_worker` is published from the
        // pool layer which doesn't carry the worker's PTY session. The bridge
        // uses `workItemId` (and falls back to `taskId`) to resolve the
        // source WI; sessionName is informational. Empty matches the
        // workitem:queued publish convention.
        sessionName: '',
        // The state machine just landed at done_by_worker. Carry both ends
        // so any subscriber filtering on (previousValue, newValue) sees
        // the canonical transition.
        previousValue: 'running',
        newValue: 'done_by_worker',
        changedField: 'taskStatus',
        // BRIDGE-1.1 hybrid extension. `workItemId` is mandatory for the
        // bridge handler; the `taskId` fallback path is unused here because
        // WorkItem itself does not carry a taskId (the bridge resolves the
        // source WI by id alone via taskPool.findWorkItem).
        workItemId: workItem.id,
        missionId: workItem.missionId,
        requestId: workItem.requestId,
      });
    } catch (err) {
      this.logger.warn('task:done_by_worker publish threw', {
        workItemId: workItem.id,
        error: formatError(err),
      });
    }
  }

  /**
   * F1-BRIDGE-1 helper: publish `task:rejected` after a successful
   * `verifyItem` transition with verdict='rejected'. The
   * {@link EventToWorkItemBridge} subscribes and either creates a retry
   * WI (`retryCount < maxRetries`) or escalates to a TL review WI with
   * `reviewReason='max_retries_exceeded'` at the cap.
   *
   * Mirrors {@link publishTaskDoneByWorker} for symmetry. Only the
   * verdict='rejected' branch reaches this publisher — `verdict='verified'`
   * does NOT publish (terminal-success path goes through
   * {@link resolveBlockedDependents}, which is not a bridge trigger).
   */
  private publishTaskRejected(workItem: WorkItem): void {
    if (!this.eventBus) {
      this.logger.debug('No EventBus wired — skipping task:rejected publish', {
        workItemId: workItem.id,
      });
      return;
    }
    try {
      this.eventBus.publish({
        id: `task:rejected:${workItem.id}`,
        type: 'task:rejected',
        timestamp: new Date().toISOString(),
        teamId: '',
        teamName: '',
        memberId: '',
        memberName: '',
        sessionName: '',
        previousValue: 'done_by_worker',
        newValue: 'rejected',
        changedField: 'taskStatus',
        workItemId: workItem.id,
        missionId: workItem.missionId,
        requestId: workItem.requestId,
      });
    } catch (err) {
      this.logger.warn('task:rejected publish threw', {
        workItemId: workItem.id,
        error: formatError(err),
      });
    }
  }

  /**
   * Publish `task:cancelled` whenever a WorkItem transitions to the
   * cancelled status via {@link updateItemStatus} or {@link transitionStatus}.
   *
   * **Why this exists.** 2026-05-09 dogfood: 4 child WIs of a Slack-
   * originated Request all landed in `cancelled` (orc-not-in-health-map
   * loop, fixed in #531) but the Request stayed in `ready` for hours.
   * `cascadeRequestStatus` only fires from V3DataService's task
   * handlers, which are wired to the retired `v3:task_*` events
   * (`mission-executor.service.ts:152` v1-cleanup comment) — so out-of-
   * band cancellations never reached cascade. The heartbeat sweep
   * eventually caught it (#533), but with up-to-30-min latency that
   * showed up as a misleading "0/4 in every bucket" ping in the user's
   * Slack thread.
   *
   * Publishing `task:cancelled` lets `RequestCascadeSubscriber` close
   * the Request within seconds of the last child cancelling, instead
   * of waiting for the heartbeat catch.
   *
   * Mirrors {@link publishTaskDoneByWorker} / {@link publishTaskRejected}
   * so the EventBus surface stays uniform.
   *
   * @param workItem - The WI snapshot AFTER the cancelled transition committed
   * @param previousStatus - The status it transitioned from (for the event payload)
   */
  private publishTaskCancelled(
    workItem: WorkItem,
    previousStatus: WorkItemStatus,
  ): void {
    if (!this.eventBus) {
      this.logger.debug('No EventBus wired — skipping task:cancelled publish', {
        workItemId: workItem.id,
      });
      return;
    }
    try {
      this.eventBus.publish({
        id: `task:cancelled:${workItem.id}`,
        type: 'task:cancelled',
        timestamp: new Date().toISOString(),
        teamId: '',
        teamName: '',
        memberId: '',
        memberName: '',
        sessionName: '',
        previousValue: previousStatus,
        newValue: 'cancelled',
        changedField: 'taskStatus',
        workItemId: workItem.id,
        missionId: workItem.missionId,
        requestId: workItem.requestId,
      });
    } catch (err) {
      this.logger.warn('task:cancelled publish threw', {
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
      // Agent-liveness gate — see {@link isAgentActive} field doc for full
      // rationale. Reject before doing any pool work if the requesting
      // agent's session isn't alive; the reconciler's wake-rule will
      // spawn it and the agent will re-attempt the claim once registered.
      if (this.isAgentActive) {
        const alive = await this.isAgentActive(agentId).catch(() => false);
        if (!alive) {
          this.logger.info('claimFromPool refused — agent session not active', { agentId });
          return null;
        }
      }

      // Check if agent already has an active claim
      const existingClaim = await this.storage.findActiveClaimByAgent(agentId);
      if (existingClaim) {
        // Issue #513 — Steve 2026-05-15. Previously this returned
        // null, which the controller mapped to 404 "No available
        // WorkItem matching filters". That was misleading: the caller
        // DOES have a WorkItem (the one they already claimed), they
        // just couldn't see it without grepping pool.json. Return the
        // held claim + its WorkItem with `alreadyHeld: true` so the
        // skill / agent can recognize the situation.
        this.logger.info('Agent already has an active claim — returning existing', {
          agentId,
          existingClaimId: existingClaim.id,
          existingWorkItemId: existingClaim.workItemId,
        });
        const heldWorkItem = await this.storage.findWorkItem(existingClaim.workItemId);
        if (!heldWorkItem) {
          // Held claim exists but WI is missing — orphan state. Best we
          // can do is fall through to the empty-pool null so the agent
          // doesn't think they own a phantom item. Log so we notice.
          this.logger.warn('Orphan claim — claim exists but WorkItem missing', {
            agentId,
            existingClaimId: existingClaim.id,
            existingWorkItemId: existingClaim.workItemId,
          });
          return null;
        }
        return { workItem: heldWorkItem, claim: existingClaim, alreadyHeld: true };
      }

      const workItems = await this.storage.getWorkItems();
      const claims = await this.storage.getClaims();

      // Set of work item IDs that have active claims
      const claimedIds = new Set(
        claims
          .filter((c) => c.status === 'active')
          .map((c) => c.workItemId),
      );

      // Hygiene #3 — target-respect gate. Before this filter, claimFromPool
      // would FIFO-pick the oldest queued+unclaimed item regardless of
      // its existing `target` field, then unconditionally rewrite
      // `wi.target = agentId` in the transitionStatus mutator. That
      // produced the target-rotation bug observed in the 5/9 wave (WIs
      // rotating through Quinn → Sam, Leo → Quinn, etc.).
      //
      // After this filter:
      //   - WIs with an explicit target are claimable ONLY by that target.
      //   - WIs with no target (broadcast pool) remain claimable by any agent.
      // The defensive identity check in the transitionStatus mutator
      // below ensures we never accidentally overwrite an existing target
      // even if a future code path bypasses this filter.
      const targetRespectingCandidates = workItems
        .filter((wi) => wi.status === 'queued' && !claimedIds.has(wi.id))
        .filter((wi) => !wi.target || wi.target === agentId);

      // Find first matching unclaimed queued item (FIFO by createdAt)
      const candidates = targetRespectingCandidates
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
      //
      // Hygiene #3 — target-respect (defensive). The candidate filter
      // above already excludes WIs whose target ≠ agentId, so the only
      // remaining cases here are (a) wi.target === agentId (no-op assign)
      // and (b) wi.target === undefined (broadcast claim). Either way we
      // refuse to overwrite a non-matching existing target.
      const claimedItem = await this.transitionStatus(
        selected.id,
        'running',
        'system',
        (wi) => {
          if (!wi.target) {
            // Broadcast claim: record that this target is an incidental
            // claim stamp, not a deliberate assignment, so releaseBack
            // returns the item to the broadcast pool instead of binding
            // it to this agent forever.
            wi.target = agentId;
            wi.targetSource = 'claim';
          }
          // else: target already === agentId per the filter; leave as-is.
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
      // Agent-liveness gate — same rationale as claimFromPool.
      if (this.isAgentActive) {
        const alive = await this.isAgentActive(agentId).catch(() => false);
        if (!alive) {
          this.logger.info('claimSpecificItem refused — agent session not active', {
            agentId,
            workItemId,
          });
          return null;
        }
      }

      const existingClaim = await this.storage.findActiveClaimByAgent(agentId);
      if (existingClaim) return null;

      const workItem = await this.storage.findWorkItem(workItemId);
      if (!workItem || workItem.status !== 'queued') return null;

      // Hygiene #3 — target-respect gate. Refuse to claim a WI whose
      // existing target is set to a different agent. This prevents the
      // claimSpecificItem path (used by AgentAutoClaimService for
      // score-based selection) from rotating target onto an idle agent
      // when another agent is the actual target. Same rule as
      // claimFromPool: target=undefined (broadcast) is claimable by any
      // agent; target=agentId is claimable only by that agent.
      if (workItem.target && workItem.target !== agentId) {
        this.logger.debug('claimSpecificItem refused — target mismatch', {
          workItemId,
          existingTarget: workItem.target,
          requestingAgent: agentId,
        });
        return null;
      }

      const claims = await this.storage.getClaims();
      if (claims.some((c) => c.workItemId === workItemId && c.status === 'active')) return null;

      // TRANS-2: route the queued → running flip through transitionStatus
      // (mirrors claimFromPool — same V3 + state-machine gates).
      // Hygiene #3 defensive: only assign target when it's currently
      // undefined; never overwrite an existing target.
      const claimedItem = await this.transitionStatus(
        workItemId,
        'running',
        'system',
        (wi) => {
          if (!wi.target) {
            // Broadcast claim — see claimFromPool: this is a claim stamp,
            // not an assignment.
            wi.target = agentId;
            wi.targetSource = 'claim';
          }
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
   * A release is an ADMINISTRATIVE event, not a failure. Two invariants
   * follow, and both were violated before 2026-08-21:
   *
   * 1. **`target` is preserved.** A release says "this attempt ended", not
   *    "this work no longer belongs to that agent". Clearing it silently
   *    destroyed a deliberate assignment — and because the wake gate admits
   *    a worker only when a queued/blocked WI carries `target === their
   *    session`, it also made the assigned worker unwakeable for their own
   *    work (`wake_gate_no_pool_work`). The sibling failure path,
   *    {@link requeueAfterFailure}, already keeps `target` on the far
   *    stronger grounds of an actual failure; there is no coherent reading
   *    in which a lease lapse un-assigns work that a failure would not.
   *    Genuine un-assignment is still possible, but it must be asked for by
   *    name via `options.unassign` — never inferred from a lease expiring.
   *
   *    One carve-out, and it is not an exception to the rule so much as a
   *    sharpening of it: `claimFromPool` stamps `target` on a *broadcast*
   *    item to record who picked it up. That stamp is not an assignment,
   *    and it is dropped on release (`targetSource === 'claim'`) so the
   *    item returns to the broadcast pool. Preserving it would let one
   *    claim permanently bind unassigned work to a single agent — and if
   *    that agent died, only a dead session could ever re-claim it.
   *
   * 2. **`retryCount` is untouched.** That counter means failures only (see
   *    {@link WorkItem.retryCount}); consumers branch on
   *    `retryCount < maxRetries` to decide retry-in-place vs terminal-and-
   *    escalate. Charging a retry for lease churn drove live work to 3/3
   *    with zero failures. Release churn is counted separately in
   *    {@link WorkItem.releaseCount}, which nothing branches on.
   *
   * @param workItemId - ID of the work item to release
   * @param reason - Why the item is being released
   * @param options - Release options
   * @param options.unassign - When true, ALSO clear `target`, returning the
   *   item to the unassigned pool. Opt-in only, for the case where a caller
   *   genuinely means "someone else should take this". Defaults to false.
   * @throws Error if work item not found, or its status is not
   *   'running' or 'blocked'
   *
   * @example
   * ```typescript
   * // Lease lapsed / claim revoked — the owner keeps the work.
   * await pool.releaseBack(id, 'claim revoked: grace exceeded');
   *
   * // Deliberate hand-back — anyone may pick this up.
   * await pool.releaseBack(id, 'agent declined', { unassign: true });
   * ```
   */
  async releaseBack(
    workItemId: string,
    reason: string,
    options: ReleaseBackOptions = {},
  ): Promise<void> {
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
    // Side-effect mutations (startedAt clear, opt-in target clear,
    // releaseCount bump) move into the atomic mutator.
    //
    // `target` survives every release; only an explicit `unassign` clears
    // it. `retryCount` is NOT touched here — a release is not a failure —
    // and release churn is recorded in `releaseCount` instead.
    const unassign = options.unassign === true;
    await this.transitionStatus(workItemId, 'queued', 'system', (wi) => {
      wi.startedAt = undefined;
      // Drop the target only when the caller explicitly asked, or when the
      // target was never an assignment in the first place — a broadcast
      // item stamped by whoever happened to claim it belongs back in the
      // broadcast pool, not bound to that agent.
      if (unassign || wi.targetSource === 'claim') {
        wi.target = undefined;
        wi.targetSource = undefined;
      }
      wi.releaseCount = (wi.releaseCount ?? 0) + 1;
    });

    await this.storage.flush();
    this.logger.info('WorkItem released back to pool', {
      workItemId,
      reason,
      claimId: claim?.id,
      unassigned: unassign,
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
   * Release the active claim on a WorkItem, if it has one.
   *
   * Shared by `completeSimpleItem` and `submitForVerification` because both
   * represent the worker handing the item back to the system.
   *
   * Also public for callers that must drive a terminal transition
   * themselves rather than through {@link failItem}. The SLA orphan-close
   * path is the live example: it targets `cancelled`, `failed` OR
   * `rejected` depending on the origin status, so `failItem` — which always
   * transitions to `failed` — cannot serve it. Such callers MUST call this,
   * otherwise the claim stays `active` against a terminal WorkItem and
   * quietly wedges the claiming agent. The mechanism is not an error, which
   * is what makes it hard to spot: {@link claimFromPool} checks
   * `findActiveClaimByAgent` BEFORE it scans the pool, and short-circuits by
   * returning the held claim with `alreadyHeld: true` (issue #513). So the
   * agent is handed the same terminal item on every poll and never sees the
   * queued work waiting for them, until the lease/grace ladder revokes it.
   *
   * Idempotent: a no-op when no active claim exists.
   *
   * @param workItemId - WorkItem whose claim should be released
   * @param endReason - Reason recorded on the claim (`completed`,
   *   `submitted_for_verification`, `sla escalation timeout ...`) for
   *   auditability
   */
  async releaseClaim(workItemId: string, endReason: string): Promise<void> {
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
      // BRIDGE-1 turns this into a real `task:done_by_worker` event below
      // (F1-BRIDGE-1). The log line is preserved as a wake signal for any
      // tail-based TL-watching subscriber that still greps it.
      tlWakeRequested: true,
    });
    // F1-BRIDGE-1: publish AFTER the storage flush so any subscriber that
    // re-reads via taskPool.findWorkItem sees the committed `done_by_worker`
    // status. `updated` is null only on race-window deletion — skip the
    // publish in that case (no source WI for the bridge to resolve).
    if (updated) {
      this.publishTaskDoneByWorker(updated);
    }
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

    // Steve 2026-05-15 dogfood: TL Verify WIs were completing (status=done)
    // but the SOURCE work item they were verifying stayed stuck in
    // `done_by_worker` forever. `resolveBlockedDependents` only treats
    // `done|verified` as terminal-success, so blocked dependents of the
    // SOURCE (e.g. an Execute waiting on a Plan in a Plan/Execute/Review
    // chain) were never unblocked.
    //
    // Concrete repro: WI 12d7e988 (Plan) — done_by_worker; verify WI
    // 12d7e988:verify:12d7e988 — done; Execute 722da42f — blocked for 41+
    // min waiting on the Plan that was already verified.
    //
    // When a verify WI completes (metadata.verifyOf points at its source),
    // propagate the verdict to the source via verifyItem so the source
    // moves done_by_worker → verified AND its own dependents unblock. Use
    // the 'system' actor — this is automatic propagation, not a fresh
    // TL action (the TL action was completing this verify WI).
    const verifyOf =
      updated?.metadata && typeof updated.metadata.verifyOf === 'string'
        ? updated.metadata.verifyOf
        : undefined;
    if (verifyOf) {
      try {
        const source = await this.storage.findWorkItem(verifyOf);
        if (source && source.status === 'done_by_worker') {
          await this.verifyItem(verifyOf, 'system', 'verified');
          this.logger.info('Verify WI complete → propagated to source', {
            verifyWorkItemId: workItemId,
            sourceWorkItemId: verifyOf,
            verdict: 'verified',
          });
        }
      } catch (err) {
        // Propagation is best-effort — a failed propagate must NOT roll
        // back the verify WI's own completion.
        this.logger.warn('Verify-to-source propagation failed (non-fatal)', {
          verifyWorkItemId: workItemId,
          sourceWorkItemId: verifyOf,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
    // F1-BRIDGE-1: only the `rejected` branch publishes. The bridge's
    // task:rejected handler creates the retry-or-escalate WI; the `verified`
    // branch is terminal-success and unblocks dependents above without any
    // bridge involvement. Skip the publish on race-window deletion.
    if (verdict === 'rejected' && updated) {
      this.publishTaskRejected(updated);
    }
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

  /**
   * Cancel a WorkItem that is currently `queued` or `blocked` (i.e. has
   * NOT been claimed yet).
   *
   * Closes the 2026-05-25 #609 incident: a fallback delegate WI targeted
   * at `crewly-orc` got stuck `queued` and kept re-dispatching every
   * minute. The available APIs were either inappropriate (`fail` requires
   * `running`, `complete` requires `running`) or destructive (`DELETE
   * /api/task-pool/:id?force=1` is a hard delete with no audit trail).
   * This method provides the clean `queued → cancelled` transition with
   * a reason captured in `cancelReason` for the activity timeline.
   *
   * @param workItemId - Target WI id
   * @param reason     - Human-readable explanation; persisted on
   *                     `cancelReason` and surfaces in the UI badge.
   * @throws if the WI doesn't exist, has an active claim, or is in a
   *         non-cancellable terminal state.
   */
  async cancelQueued(workItemId: string, reason: string): Promise<void> {
    const workItem = await this.storage.findWorkItem(workItemId);
    if (!workItem) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }
    if (workItem.status !== 'queued' && workItem.status !== 'blocked' && workItem.status !== 'scheduled') {
      throw new Error(
        `cancelQueued: WorkItem status must be 'queued', 'blocked', or 'scheduled' (got '${workItem.status}'). Use a status-appropriate API for other states — e.g. failItem for running, or DELETE for terminal-state cleanup.`,
      );
    }
    const activeClaim = await this.storage.findActiveClaimByWorkItem(workItemId);
    if (activeClaim) {
      // Defensive: queued items shouldn't have active claims, but if
      // some race produced one (e.g. claim got revoked but not cleaned
      // up), release it cleanly before flipping to cancelled.
      await this.storage.updateClaim(activeClaim.id, (c) => {
        c.status = 'released';
        c.endedAt = new Date().toISOString();
        c.endReason = `cancelQueued: ${reason}`;
      });
    }
    await this.transitionStatus(workItemId, 'cancelled', 'system', undefined, reason);
    await this.storage.flush();
    this.logger.info('WorkItem cancelled (queued → cancelled)', {
      workItemId,
      reason,
      previousStatus: workItem.status,
    });
  }

  /**
   * Requeue a failed WorkItem back to `queued` for another attempt.
   *
   * Path: `failed → queued` (legal in WORK_ITEM_TRANSITIONS but previously
   * unused — the system never auto-retried, every failure was terminal).
   * Increments `retryCount`, clears `startedAt`, preserves `target` so
   * the same agent gets a second shot, and records the previous error
   * on the WI's metadata for postmortem visibility.
   *
   * Caller must have ALREADY confirmed `retryCount < maxRetries` — this
   * method does NOT enforce the cap, on the assumption that the caller
   * (v3-data.onTaskFailed) handles the exhausted-retries branch with
   * escalation to ORC.
   *
   * @param workItemId - The failed WI to retry
   * @param reason     - Why the previous attempt failed (recorded on
   *   metadata.lastFailureReason; surfaces in the activity timeline)
   * @throws if the WI doesn't exist or isn't in `failed` status
   */
  async requeueAfterFailure(workItemId: string, reason: string): Promise<void> {
    const workItem = await this.storage.findWorkItem(workItemId);
    if (!workItem) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }
    if (workItem.status !== 'failed') {
      throw new Error(
        `Cannot requeue WorkItem after failure: status must be 'failed', got '${workItem.status}'`,
      );
    }

    await this.transitionStatus(workItemId, 'queued', 'system', (wi) => {
      wi.retryCount += 1;
      wi.startedAt = undefined;
      wi.completedAt = undefined;
      // Keep `target` — the original agent should get the retry.
      // APPEND to failureHistory so postmortems see all attempts, not
      // just the most recent. `lastFailureReason` / `lastFailureAt`
      // are retained for back-compat with dashboards that already
      // read those scalar fields. Cap history at 10 entries so a
      // pathological retry loop can't bloat the metadata indefinitely.
      const now = new Date().toISOString();
      const priorHistory = (wi.metadata?.failureHistory as Array<Record<string, unknown>>) ?? [];
      wi.metadata = {
        ...(wi.metadata ?? {}),
        failureHistory: [
          ...priorHistory,
          { at: now, reason, retryAttempt: wi.retryCount },
        ].slice(-10),
        lastFailureReason: reason,
        lastFailureAt: now,
        retryAttempt: wi.retryCount,
        // TTL anchor (see getTtlAnchorAt). The age-based expiry rules must
        // measure this retry's window from HERE, not from the original
        // `createdAt` — otherwise a WorkItem that failed after the 24h TTL is
        // TTL-cancelled on the next reconciler pass, silently destroying the
        // retry we just granted. `createdAt` is deliberately left untouched so
        // it keeps meaning "when this work was first asked for".
        [LAST_REQUEUED_AT_METADATA_KEY]: now,
      };
      // A disposition describes how a PAST failure was dealt with. This item
      // is back in play, so any existing stamp is history and must not be
      // allowed to outlive the failure it described — otherwise the
      // safety-net rule would read a stale stamp and skip the item the next
      // time it strands. See DISPOSITION_METADATA_KEY.
      delete wi.metadata[DISPOSITION_METADATA_KEY];
      // Clear the error field so a successful retry doesn't surface a
      // stale error message; the metadata above keeps the history.
      wi.error = undefined;
    });

    await this.storage.flush();
    this.logger.info('WorkItem requeued after failure', {
      workItemId,
      retryCount: workItem.retryCount + 1,
      maxRetries: workItem.maxRetries,
      reason,
    });
  }

  /**
   * Decide and record how a stranded WorkItem is dealt with — the single
   * funnel every `rejected`/`failed` writer must route through.
   *
   * `rejected` and `failed` are the only two statuses that are neither
   * terminal nor able to reach a terminal state: their sole outbound edge is
   * `→ queued`. An item parked in either is finished as far as every consumer
   * is concerned (see `SLA_TERMINAL_WORK_ITEM_STATUSES`) and unfinished as far
   * as the state machine is concerned, and until this funnel existed nothing
   * owned closing that gap. Items written there by a path that did not itself
   * arrange a successor simply stopped, permanently and — since PR #733
   * correctly stopped the pruning rules emitting illegal corrections for them
   * — silently.
   *
   * Exactly one of three things happens, and the choice is recorded rather
   * than left to be re-derived later by scanning other WorkItems:
   *
   * 1. **retried in place** — `failed` with retry budget left. The item goes
   *    back on the queue via {@link requeueAfterFailure}, which bumps
   *    `retryCount`. Deliberately NOT stamped: the item has left the stranding
   *    statuses under its own power, and a stamp would be a claim about a
   *    failure that is no longer the current one.
   * 2. **succeeded by another item** — the caller already created a successor
   *    (the `EventToWorkItemBridge` retry/escalation WorkItem). Stamped with
   *    its id.
   * 3. **terminal** — budget spent, or a status with no retry path. Stamped,
   *    and escalated so a human or the orchestrator renders the verdict. This
   *    is the "deliberate terminal state with an audit record" case: the item
   *    stays in `rejected`/`failed` by design, because the alternative —
   *    adding `→ cancelled` edges — would re-open the illegal-correction
   *    surface #733 closed and turn a deliberate decision into a 24h default.
   *
   * Idempotent and re-entrant: an already-disposed item is returned unchanged,
   * so concurrent reconciler passes converge and the safety-net rule cannot
   * fire twice on the same strand. Terminating: the only branch that repeats
   * is (1), and it bumps `retryCount`, so it can run at most `maxRetries`
   * times before (3) becomes the only reachable outcome.
   *
   * @param workItemId - The stranded WorkItem.
   * @param options    - `reason` is carried into the audit record and the
   *                     escalation. `actor` defaults to `'system'`.
   *                     `successorWorkItemId` selects outcome (2) when the
   *                     caller owns a real successor.
   * @returns The recorded disposition, or `null` when there was nothing to do
   *          (item missing, or not in a stranding status).
   *
   * @example
   * ```typescript
   * await pool.disposeFailedWorkItem(wi.id, { reason: 'SLA escalation timeout' });
   * ```
   */
  async disposeFailedWorkItem(
    workItemId: string,
    options: {
      reason: string;
      actor?: WorkItemOwner;
      successorWorkItemId?: string;
    },
  ): Promise<WorkItemDisposition | null> {
    const { reason, actor = 'system', successorWorkItemId } = options;
    const workItem = await this.storage.findWorkItem(workItemId);
    if (!workItem) return null;

    // Only the stranding statuses need a disposition. Anything else is either
    // still in play or already strictly terminal.
    if (!DISPOSITION_REQUIRED_STATUSES.has(workItem.status)) return null;

    // Idempotency: the stamp IS the key. Two passes converge here.
    const existing = getWorkItemDisposition(workItem);
    if (existing) return existing;

    const now = new Date().toISOString();

    // (2) The caller owns a real successor — record it and stop.
    if (successorWorkItemId) {
      return this.stampDisposition(workItemId, {
        kind: 'succeeded_by',
        at: now,
        by: actor,
        reason,
        successorWorkItemId,
      });
    }

    // (1) Retry in place. Only `failed` has a retry path — `rejected` reaches
    // `queued` too, but re-running work a reviewer rejected without a fresh
    // verdict would re-execute exactly what was turned down.
    // `retryCount` is FAILURES ONLY — this branch is load-bearing on that
    // semantic, not incidentally coupled to it. Reading a churn-inflated count
    // here would send work that never failed straight to `terminal`.
    //
    // That is an invariant rather than an assumption as of #739: `releaseBack`
    // used to bump `retryCount` on every lease lapse, so a worker who simply
    // stopped heartbeating was charged a failure. Release churn now goes to
    // {@link WorkItem.releaseCount}, which nothing branches on. Keep it that
    // way — if a future change makes anything other than a failure move
    // `retryCount`, this branch silently starts terminating live work, and a
    // second counter here would hide that rather than surface it.
    if (workItem.status === 'failed' && workItem.retryCount < workItem.maxRetries) {
      await this.requeueAfterFailure(workItemId, reason);
      this.logger.info('Stranded WorkItem retried in place', {
        workItemId,
        retryCount: workItem.retryCount + 1,
        maxRetries: workItem.maxRetries,
        reason,
      });
      // Not stamped — see the doc comment. The item is queued again, and the
      // requeue itself is the audit record (metadata.failureHistory).
      return {
        kind: 'retried_in_place',
        at: now,
        by: actor,
        reason,
      };
    }

    // (3) Terminal. Escalate for the verdict, then stamp — in that order, so a
    // failed escalation cannot leave a stamp claiming an escalation happened.
    let escalationId: string | undefined;
    try {
      const { EscalationRouterService } = await import(
        '../v3/escalation-router.service.js'
      );
      escalationId =
        (await EscalationRouterService.getInstance().escalateFailedWorkItem(
          workItem,
          reason,
        )) ?? undefined;
    } catch (err) {
      // Best-effort, matching every other escalation call site: a messaging
      // blip must not leave the item stranded a second time. The stamp is
      // still written, without an escalationId, so the gap is visible in the
      // audit record rather than hidden by a retry loop.
      this.logger.warn('escalateFailedWorkItem threw during disposition (non-fatal)', {
        workItemId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return this.stampDisposition(workItemId, {
      kind: 'terminal',
      at: now,
      by: actor,
      reason,
      escalationId,
    });
  }

  /**
   * Persist a disposition record onto a WorkItem's metadata.
   *
   * Writes metadata only — no status transition — so it is safe to call on an
   * item whose status has no legal outbound edge, which is precisely the
   * situation a `terminal` disposition describes.
   *
   * @param workItemId  - WorkItem to stamp.
   * @param disposition - The record to write.
   * @returns The disposition as written.
   */
  private async stampDisposition(
    workItemId: string,
    disposition: WorkItemDisposition,
  ): Promise<WorkItemDisposition> {
    const workItem = await this.storage.findWorkItem(workItemId);
    if (workItem) {
      workItem.metadata = {
        ...(workItem.metadata ?? {}),
        [DISPOSITION_METADATA_KEY]: disposition,
      };
      await this.storage.flush();
    }
    this.logger.info('WorkItem disposition recorded', {
      workItemId,
      kind: disposition.kind,
      successorWorkItemId: disposition.successorWorkItemId,
      escalationId: disposition.escalationId,
      reason: disposition.reason,
    });
    return disposition;
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
   * Agents that look HUNG — they keep claiming work but never heartbeat, so
   * their claims are repeatedly grace-revoked. Powers the `/health`
   * orchestrator-liveness signal ("up but stalled") and hung-session recovery.
   *
   * @param threshold - Minimum consecutive grace-revokes to count as hung.
   * @returns Agent ids that currently look hung.
   */
  getHungAgents(threshold?: number): string[] {
    return this.claimService.getHungAgents(threshold);
  }

  /**
   * Clear an agent's hung state after a recovery (session restart), so the
   * restarted session is not immediately re-flagged before it can heartbeat.
   *
   * @param agentId - The agent/session id to clear.
   */
  clearHungState(agentId: string): void {
    this.claimService.clearGraceRevokes(agentId);
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
   * Stores worker-supplied structured output on a WorkItem.
   *
   * Replaces the v1 `<taskId>.output.json` filesystem store with an
   * in-pool field (see {@link WorkItem.output}). Used by the worker
   * `complete-task` flow and read back by the TL `verify-output` skill.
   *
   * @param workItemId - WorkItem id to attach output to
   * @param output - Arbitrary task-specific output object
   * @returns The updated WorkItem, or null if not found
   */
  async setOutput(
    workItemId: string,
    output: Record<string, unknown>,
  ): Promise<WorkItem | null> {
    const ok = await this.storage.updateWorkItem(workItemId, (wi) => {
      wi.output = output;
    });
    if (!ok) return null;
    return (await this.storage.findWorkItem(workItemId)) ?? null;
  }

  /**
   * Reassigns a WorkItem to a different target agent.
   *
   * Replaces the v1 `/task-management/handoff` filesystem reassign with a
   * direct `target` field update on the WorkItem.
   *
   * Allowed transitions:
   *   - `target` must be a non-empty string
   *   - WI must not be in a terminal state (done/cancelled/failed-final)
   *
   * @param workItemId - WorkItem to reassign
   * @param newTarget  - Session name of the new target agent
   * @param fromAgent  - Session name of the agent handing off (for audit)
   * @param reason     - Human-readable reason recorded as a working-note
   * @returns The updated WorkItem, or null if not found
   */
  async handoff(
    workItemId: string,
    newTarget: string,
    fromAgent: string,
    reason: string,
  ): Promise<WorkItem | null> {
    if (!newTarget || newTarget.trim() === '') {
      throw new Error('handoff: newTarget is required');
    }
    const wi = await this.storage.findWorkItem(workItemId);
    if (!wi) return null;
    if (wi.status === 'done' || wi.status === 'cancelled') {
      throw new Error(`handoff refused: WorkItem ${workItemId} is in terminal state '${wi.status}'`);
    }

    const handoffNote = `[HANDOFF] ${fromAgent} → ${newTarget}: ${reason || '(no reason)'}`;
    await this.storage.updateWorkItem(workItemId, (item) => {
      item.target = newTarget;
      // An explicit handoff is a deliberate assignment: it must survive a
      // later release.
      item.targetSource = 'assigned';
      const existing = (item.metadata && typeof item.metadata === 'object' ? item.metadata : {}) as Record<
        string,
        unknown
      >;
      const notes = Array.isArray(existing.notes) ? (existing.notes as string[]) : [];
      notes.push(`${new Date().toISOString()} ${handoffNote}`);
      item.metadata = { ...existing, notes };
    });
    this.logger.info('WorkItem handoff', { workItemId, fromAgent, newTarget });
    return (await this.storage.findWorkItem(workItemId)) ?? null;
  }

  /**
   * Appends a working-state note to a WorkItem's metadata.notes array.
   *
   * Replaces v1 `/task-management/sync` and `/task-management/save-working-notes`,
   * both of which appended progress notes to the `.md` task body. With v1
   * retired, notes live on the WorkItem itself under `metadata.notes[]`.
   *
   * @param workItemId - WorkItem id
   * @param author - Session name of note author
   * @param note - Note content (free-form)
   * @returns The updated WorkItem, or null if not found
   */
  async appendNote(
    workItemId: string,
    author: string,
    note: string,
  ): Promise<WorkItem | null> {
    if (!note || note.trim() === '') {
      throw new Error('appendNote: note is required');
    }
    const ok = await this.storage.updateWorkItem(workItemId, (wi) => {
      const existing = (wi.metadata && typeof wi.metadata === 'object' ? wi.metadata : {}) as Record<
        string,
        unknown
      >;
      const notes = Array.isArray(existing.notes) ? (existing.notes as string[]) : [];
      notes.push(`${new Date().toISOString()} [${author}] ${note}`);
      wi.metadata = { ...existing, notes };
    });
    if (!ok) return null;
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

  // -------------------------------------------------------------------------
  // P1 1ffffb84(a) — Bulk-DELETE stale WorkItems
  // -------------------------------------------------------------------------

  /**
   * Public delete API used by the bulk-cleanup script and the new
   * `DELETE /api/task-pool/:id` HTTP endpoint (P1 umbrella WI 1ffffb84
   * component a, Steve directive 2026-05-06: just-DELETE-not-backfill).
   *
   * Three guarantees over {@link removeItem}:
   *   1. Idempotent — `not_found` is a no-op return, not a throw.
   *   2. Claim-safety — refuses claimed delete unless `opts.force`.
   *   3. Audit log — single info-level log per removal.
   *
   * Force path also revokes the orphaned claim (status='revoked',
   * endedAt, endReason).
   */
  async removeFromPool(
    workItemId: string,
    opts: { force?: boolean } = {},
  ): Promise<RemoveFromPoolResult> {
    const wi = await this.storage.findWorkItem(workItemId);
    if (!wi) {
      this.logger.debug('removeFromPool: item not found (idempotent)', { workItemId });
      return { removed: false, reason: 'not_found' };
    }

    const activeClaim = await this.storage.findActiveClaimByWorkItem(workItemId);
    const hadActiveClaim = !!activeClaim;

    if (hadActiveClaim && activeClaim && !opts.force) {
      this.logger.warn('removeFromPool refused: active claim exists', {
        workItemId,
        claimId: activeClaim.id,
        claimedBy: activeClaim.agentId,
      });
      throw new WorkItemClaimedError({
        workItemId,
        claimId: activeClaim.id,
        claimedBy: activeClaim.agentId,
      });
    }

    const removed = await this.storage.removeWorkItem(workItemId);

    if (hadActiveClaim && activeClaim) {
      await this.storage.updateClaim(activeClaim.id, (c) => {
        c.status = 'revoked';
        c.endedAt = new Date().toISOString();
        c.endReason = `WorkItem deleted via removeFromPool (force=${opts.force === true})`;
      });
    }

    this.logger.info('removeFromPool: WorkItem removed', {
      workItemId,
      status: wi.status,
      target: wi.target,
      force: opts.force === true,
      hadActiveClaim,
    });

    return {
      removed: removed === true,
      workItem: wi,
      hadActiveClaim,
    };
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
    /**
     * Optional human-readable reason. Persisted on:
     *   - `WorkItem.cancelReason` when `newStatus === 'cancelled'`
     *   - `WorkItem.blockedReason` when `newStatus === 'blocked'` (Steve
     *     2026-05-15 dogfood — UI showed Blocked badge with no
     *     explanation)
     *   - Ignored for other status transitions.
     */
    reason?: string,
  ): Promise<void> {
    const items = await this.storage.getWorkItems();
    const item = items.find((wi) => wi.id === workItemId);

    if (!item) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }

    // Idempotent same-state no-op: the reconciler's stale-pickup rule
    // and the SLA close path can both race to apply the same terminal
    // status. Silently no-op here instead of throwing or logging a
    // misleading "transitioned cancelled → cancelled" entry. (Steve
    // 2026-05-15 dogfood — see the duplicate "Work item status
    // updated from cancelled to cancelled" rows in
    // crewly-2026-05-15.log around 15:48:56 / 16:05:55.)
    if (item.status === newStatus) {
      this.logger.debug('Skipped idempotent same-state status update', {
        workItemId,
        status: newStatus,
        actorRole,
      });
      return;
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

    // Capture pre-write status. See transitionStatus's identical block
    // for the writeup — storage.updateWorkItem mutates in place, so
    // reading item.status after the write yields newStatus and the
    // "Work item status updated" log reads like "X → X" for every
    // valid transition.
    const fromStatus = item.status;

    await this.storage.updateWorkItem(workItemId, (wi) => {
      wi.status = newStatus;
      // P1 1ffffb84 component (b): mirror the transitionStatus
      // atomic-timestamp contract so the older updateItemStatus path
      // never produces a status↔completedAt mismatch either. See
      // transitionStatus below for the full root-cause writeup
      // (b7840fe8 partial-write bug).
      if (newStatus === 'running') {
        wi.startedAt = new Date().toISOString();
        wi.completedAt = undefined;
      } else if (newStatus === 'done' || newStatus === 'failed') {
        wi.completedAt = new Date().toISOString();
      } else {
        wi.completedAt = undefined;
      }
      // Persist the cancellation reason atomically with the status
      // flip so the activity timeline always has the explanation
      // alongside the terminal state. Only set on transitions INTO
      // cancelled — leaving the field untouched on non-cancel paths
      // preserves any earlier value (e.g. requeued after a manual
      // cancel-then-revive flow).
      if (newStatus === 'cancelled' && typeof reason === 'string' && reason.length > 0) {
        wi.cancelReason = reason;
      }
      // Mirror for blocked transitions (Steve 2026-05-15 dogfood): the
      // UI showed `Blocked` badge with an empty activity timeline.
      // Sources include reconciler agent-inactive correction, mission
      // executor dependency-blocked creation (not via this path),
      // explicit blockItem.
      if (newStatus === 'blocked' && typeof reason === 'string' && reason.length > 0) {
        wi.blockedReason = reason;
      }
    });

    this.logger.info('Work item status updated', {
      workItemId,
      from: fromStatus,
      to: newStatus,
      actorRole,
      ...(newStatus === 'cancelled' && reason ? { reason } : {}),
      ...(newStatus === 'blocked' && reason ? { reason } : {}),
    });

    // Cascade signal — let RequestCascadeSubscriber close the parent
    // Request without waiting for the heartbeat catch. See
    // {@link publishTaskCancelled} for the full bug writeup.
    if (newStatus === 'cancelled') {
      const post = await this.storage.findWorkItem(workItemId);
      if (post) this.publishTaskCancelled(post, fromStatus);
    }
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
    /**
     * Optional human-readable reason. Routed by target status:
     *   - `cancelled` → persisted on `WorkItem.cancelReason`
     *   - `blocked`   → persisted on `WorkItem.blockedReason`
     *     (Steve 2026-05-15 dogfood)
     *   - other       → ignored
     * Applied BEFORE the caller's mutator runs so the mutator may
     * override if needed. Surfaces in the activity timeline so the
     * Blocked/Cancelled badges aren't opaque ("WorkItem was X.").
     * Parameter name retained as `cancelReason` for source compat;
     * effectively a generic transition reason.
     */
    cancelReason?: string,
  ): Promise<WorkItem | null> {
    const item = await this.storage.findWorkItem(workItemId);
    if (!item) {
      throw new Error(`WorkItem not found: ${workItemId}`);
    }

    // Idempotent same-state no-op (matches updateItemStatus behavior).
    // Return the current item so callers chaining on the result don't
    // see a spurious null. Steve 2026-05-15.
    if (item.status === newStatus) {
      this.logger.debug('Skipped idempotent same-state transition', {
        workItemId,
        status: newStatus,
        actorRole,
      });
      return item;
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

    // Capture the pre-write status into a local. `storage.updateWorkItem`
    // mutates the same in-memory object that `findWorkItem` returned, so
    // reading `item.status` AFTER the write yields the new value — which
    // makes the "transitioned X → Y" log read like "Y → Y" and hides the
    // real `previousValue` on the task:cancelled EventBus payload.
    // (Steve 2026-05-15 dogfood: `from:cancelled, to:cancelled` showing
    // for transitions that were actually `queued → cancelled`.)
    const fromStatus = item.status;

    const ok = await this.storage.updateWorkItem(workItemId, (wi) => {
      wi.status = newStatus;
      // Atomic timestamp side-effects enforce the invariant
      // `completedAt is set IFF status ∈ {done, failed, verified,
      // done_by_worker, rejected}`.
      //
      // P1 1ffffb84 component (b): the prior code only SET completedAt
      // on terminal transitions; non-terminal landings (queued, running,
      // blocked, scheduled, proposed, accepted, escalated, cancelled)
      // inherited a stale completedAt from a prior terminal trip via
      //   - `rejected → queued` (TL re-queue)
      //   - `failed → queued`  (BRIDGE-1 retry)
      //   - `running → queued` (releaseBack abandon path)
      // WorkItem b7840fe8 reproduced the bug — status=queued AND
      // completedAt=2026-05-06T00:47:59Z AND retryCount=1 AND no
      // startedAt/target, which is the exact fingerprint of a
      // `failed → queued` retry leaving stale completedAt. The else
      // branch below closes the gap atomically with the status flip.
      if (newStatus === 'running') {
        wi.startedAt = new Date().toISOString();
        // Resuming work — clear stale completedAt from a prior failed/
        // rejected attempt so a re-claim never carries forward a
        // completion timestamp from an earlier terminal trip.
        wi.completedAt = undefined;
      } else if (
        newStatus === 'done' ||
        newStatus === 'failed' ||
        newStatus === 'verified' ||
        newStatus === 'done_by_worker' ||
        newStatus === 'rejected'
      ) {
        wi.completedAt = new Date().toISOString();
      } else {
        // Non-terminal-with-result landings: clear completedAt so the
        // invariant holds. (`cancelled` is technically terminal but
        // historically never carried completedAt — preserving that
        // shape here to keep the change minimal; the `cancelled`
        // semantics are out of scope.)
        wi.completedAt = undefined;
      }
      // Apply cancelReason BEFORE the user-supplied mutator so the
      // mutator wins if the caller wants to override (rare). The
      // parameter is named `cancelReason` for source-compat but is
      // routed to cancelReason OR blockedReason based on newStatus
      // (Steve 2026-05-15).
      if (newStatus === 'cancelled' && typeof cancelReason === 'string' && cancelReason.length > 0) {
        wi.cancelReason = cancelReason;
      }
      if (newStatus === 'blocked' && typeof cancelReason === 'string' && cancelReason.length > 0) {
        wi.blockedReason = cancelReason;
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
      from: fromStatus,
      to: newStatus,
      actorRole,
    });

    // Return the post-update WorkItem snapshot so callers can chain on the
    // resolved value rather than re-fetching. Coerce `undefined` (item
    // removed during the race window) to `null` to match the declared
    // return type.
    const post = (await this.storage.findWorkItem(workItemId)) ?? null;

    // Cascade signal — let RequestCascadeSubscriber close the parent
    // Request without waiting for the heartbeat catch. See
    // {@link publishTaskCancelled} for the full bug writeup.
    if (newStatus === 'cancelled' && post) {
      this.publishTaskCancelled(post, fromStatus);
    }

    return post;
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
