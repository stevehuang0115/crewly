/**
 * Reconcile Rules — Individual reconciliation checks
 *
 * Each rule inspects a specific aspect of system state and returns
 * corrections when discrepancies are found. Rules follow the CEO principle:
 * "All automation is explainable" — every correction records who, what, why.
 *
 * @module services/reconciler/reconcile-rules
 */

import type {
  WorkItem,
  WorkItemStatus,
  Request,
  RequestStatus,
  TaskClaim,
  ReconcileCorrection,
  WakeAction,
  WakeStrategy,
  AgentScoreBreakdown,
} from '../../types/v2/index.js';
import {
  isValidRequestTransition,
  isLeaseExpired,
  isGracePeriodExceeded,
  TERMINAL_WORK_ITEM_STATUSES,
  TERMINAL_REQUEST_STATUSES,
  createCorrection,
  DEFAULT_GRACE_PERIOD_MS,
} from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Agent Health Types (abstraction over existing services)
// ---------------------------------------------------------------------------

/**
 * Minimal agent info needed by reconcile rules.
 * Abstraction over AgentRegistrationService / StorageService.
 */
export interface AgentHealth {
  sessionName: string;
  status: 'active' | 'started' | 'inactive' | 'suspended' | 'unknown';
  lastSeenAt?: string;
  /** Agent role (developer, qa, team-lead, etc.) — used for skill matching */
  role?: string;
  /** Tags describing agent capabilities (e.g. ['backend', 'typescript', 'rust']) */
  tags?: string[];
  /** Number of WorkItems currently assigned to this agent */
  activeWorkItemCount?: number;
  /** Team ID the agent belongs to */
  teamId?: string;
  /** Member ID within the team */
  memberId?: string;
}

// ---------------------------------------------------------------------------
// Rule: Detect Stuck WorkItems
// ---------------------------------------------------------------------------

/**
 * Per-WorkItemType timeout overrides for the stuck detector.
 *
 * **Why per-type:** the original single-value timeout (10 min) treated every
 * WI the same — including `delegate`/`review` WIs that, by design, supervise
 * multi-actor work spanning hours. A 10-min ceiling on a TL umbrella will
 * always fire while the TL is still actively orchestrating, falsely marking
 * it `failed` and (via cascade rules) cancelling its children. Workshop
 * dogfood on 2026-05-06 lost 6 P0 child WIs to exactly this race.
 *
 * Defaults:
 *   - `delegate`, `review` — 4h (these supervise long-running coordination)
 *   - `confirm`            — Number.POSITIVE_INFINITY (waits for user; never timeout)
 *   - everything else      — falls back to the caller-provided default
 *
 * Callers may pass a partial override map to tighten or loosen any entry.
 */
export const DEFAULT_PER_TYPE_TIMEOUT_MS: Partial<Record<WorkItem['type'], number>> = {
  delegate: 4 * 60 * 60 * 1000,
  review: 4 * 60 * 60 * 1000,
  confirm: Number.POSITIVE_INFINITY,
};

/**
 * Resolves the timeout for a given WorkItem type.
 *
 * @param type        - WorkItem.type value
 * @param defaultMs   - Fallback when no per-type override exists
 * @param overrides   - Optional caller-supplied per-type overrides (merged on top of defaults)
 * @returns Timeout in ms, or Number.POSITIVE_INFINITY for "never timeout"
 */
function resolveTimeoutForType(
  type: WorkItem['type'],
  defaultMs: number,
  overrides?: Partial<Record<WorkItem['type'], number>>,
): number {
  if (overrides && type in overrides) {
    const v = overrides[type];
    if (typeof v === 'number') return v;
  }
  if (type in DEFAULT_PER_TYPE_TIMEOUT_MS) {
    const v = DEFAULT_PER_TYPE_TIMEOUT_MS[type];
    if (typeof v === 'number') return v;
  }
  return defaultMs;
}

/**
 * Detects WorkItems that are 'running' but whose assigned agent is not alive.
 * Returns corrections to transition them to 'blocked' or 'failed'.
 *
 * @param workItems - All running WorkItems
 * @param agentHealthMap - Map of agent session → health info
 * @param timeoutMs - Default running timeout (default: 10 min); per-type overrides
 *                   in {@link DEFAULT_PER_TYPE_TIMEOUT_MS} apply on top of this
 * @param timeoutOverrides - Optional caller-supplied per-type overrides
 * @returns Array of corrections and affected WorkItem IDs
 */
export function detectStuckWorkItems(
  workItems: WorkItem[],
  agentHealthMap: Map<string, AgentHealth>,
  timeoutMs: number = 600_000,
  timeoutOverrides?: Partial<Record<WorkItem['type'], number>>,
): { corrections: ReconcileCorrection[]; stuckIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const stuckIds: string[] = [];
  const now = Date.now();

  for (const wi of workItems) {
    if (wi.status !== 'running') continue;
    if (!wi.target) continue;

    const agent = agentHealthMap.get(wi.target);
    const isAgentDead = !agent || agent.status === 'inactive' || agent.status === 'unknown';
    const startedAt = wi.startedAt ? new Date(wi.startedAt).getTime() : new Date(wi.createdAt).getTime();
    const effectiveTimeoutMs = resolveTimeoutForType(wi.type, timeoutMs, timeoutOverrides);
    const isTimedOut = Number.isFinite(effectiveTimeoutMs) && (now - startedAt) > effectiveTimeoutMs;

    if (isAgentDead) {
      const newStatus: WorkItemStatus = wi.retryCount < wi.maxRetries ? 'blocked' : 'failed';
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: 'running',
        newState: newStatus,
        reason: `Agent ${wi.target} is ${agent?.status ?? 'not found'}`,
        evidence: `Agent health check: status=${agent?.status ?? 'missing'}, lastSeen=${agent?.lastSeenAt ?? 'never'}`,
      }));
      stuckIds.push(wi.id);
    } else if (isTimedOut) {
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: 'running',
        newState: 'failed',
        reason: `WorkItem (type=${wi.type}) exceeded timeout of ${effectiveTimeoutMs}ms`,
        evidence: `Started at ${wi.startedAt ?? wi.createdAt}, running for ${now - startedAt}ms (limit ${effectiveTimeoutMs}ms)`,
      }));
      stuckIds.push(wi.id);
    }
  }

  return { corrections, stuckIds };
}

// ---------------------------------------------------------------------------
// Rule: Detect Expired Claims
// ---------------------------------------------------------------------------

/**
 * Detects TaskClaims whose lease has expired and should be released or revoked.
 *
 * @param claims - All active claims
 * @param gracePeriodMs - Grace period duration in ms
 * @returns Claims to mark as expiring and claims to revoke
 */
export function detectExpiredClaims(
  claims: TaskClaim[],
  gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
): {
  corrections: ReconcileCorrection[];
  expiringIds: string[];
  revokedIds: string[];
} {
  const corrections: ReconcileCorrection[] = [];
  const expiringIds: string[] = [];
  const revokedIds: string[] = [];
  const now = Date.now();

  for (const claim of claims) {
    if (claim.status !== 'active' && claim.status !== 'expiring') continue;

    if (claim.status === 'active' && isLeaseExpired(claim, now)) {
      corrections.push(createCorrection({
        entityType: 'claim',
        entityId: claim.id,
        previousState: 'active',
        newState: 'expiring',
        reason: `Lease expired for claim ${claim.id} on WorkItem ${claim.workItemId}`,
        evidence: `leaseExpiresAt=${claim.leaseExpiresAt}, agentId=${claim.agentId}, now=${new Date(now).toISOString()}`,
      }));
      expiringIds.push(claim.id);
    }

    if (claim.status === 'expiring' && isGracePeriodExceeded(claim, gracePeriodMs, now)) {
      corrections.push(createCorrection({
        entityType: 'claim',
        entityId: claim.id,
        previousState: 'expiring',
        newState: 'revoked',
        reason: `Grace period exceeded for claim ${claim.id} on WorkItem ${claim.workItemId}`,
        evidence: `leaseExpiresAt=${claim.leaseExpiresAt}, gracePeriod=${gracePeriodMs}ms, agentId=${claim.agentId}, now=${new Date(now).toISOString()}`,
      }));
      revokedIds.push(claim.id);
    }
  }

  return { corrections, expiringIds, revokedIds };
}

// ---------------------------------------------------------------------------
// Rule: Reconcile Request Status
// ---------------------------------------------------------------------------

/**
 * Recomputes the correct status for a Request based on its WorkItems' statuses.
 * This is the core "truth recomputation" — events are hints, this is truth.
 *
 * @param request - The Request to reconcile
 * @param workItems - All WorkItems belonging to this Request
 * @returns Correction if status needs updating, null otherwise
 */
export function reconcileRequestStatus(
  request: Request,
  workItems: WorkItem[],
): ReconcileCorrection | null {
  if (TERMINAL_REQUEST_STATUSES.has(request.status)) return null;
  if (workItems.length === 0 && request.status === 'open') return null;

  // Dangling request: non-open status but no WorkItems left — close it.
  // Try 'done' first (valid from running, waiting_confirmation).
  // Fall back to 'cancelled' (valid from ready, blocked, running).
  if (workItems.length === 0 && request.status !== 'open') {
    let newState: RequestStatus = 'done';
    if (!isValidRequestTransition(request.status, newState)) {
      newState = 'cancelled';
    }
    if (!isValidRequestTransition(request.status, newState)) return null;
    return createCorrection({
      entityType: 'request',
      entityId: request.id,
      previousState: request.status,
      newState,
      reason: 'Dangling request: non-open status with 0 WorkItems',
      evidence: `Request status was "${request.status}" but has no associated WorkItems`,
    });
  }

  const statuses = workItems.map(wi => wi.status);
  const allDone = statuses.length > 0 && statuses.every(s => s === 'done' || s === 'verified' || s === 'cancelled');
  const anyRunning = statuses.some(s => s === 'running');
  const allBlockedOrFailed = statuses.length > 0 && statuses.every(
    s => s === 'blocked' || s === 'failed' || s === 'cancelled'
  );
  const hasQueued = statuses.some(s => s === 'queued' || s === 'scheduled');

  let expectedStatus: RequestStatus = request.status;

  if (allDone) {
    expectedStatus = request.requiresConfirmation ? 'waiting_confirmation' : 'done';
  } else if (anyRunning) {
    expectedStatus = 'running'; // At least one task is actively running
  } else if (hasQueued) {
    expectedStatus = 'ready'; // Plan exists, tasks queued, none running yet
  } else if (allBlockedOrFailed) {
    expectedStatus = 'blocked';
  }

  if (expectedStatus === request.status) return null;
  if (!isValidRequestTransition(request.status, expectedStatus)) return null;

  return createCorrection({
    entityType: 'request',
    entityId: request.id,
    previousState: request.status,
    newState: expectedStatus,
    reason: `Recomputed from WorkItem statuses: ${JSON.stringify(countByStatus(statuses))}`,
    evidence: `${workItems.length} WorkItems: ${statuses.join(', ')}`,
  });
}

// ---------------------------------------------------------------------------
// Rule: Detect Orphan WorkItems
// ---------------------------------------------------------------------------

/**
 * A parent WorkItem is treated as **permanently** terminal — and therefore
 * eligible to cascade-cancel its children — only when:
 *
 *   - status === 'cancelled' (terminal by definition), OR
 *   - status === 'failed' AND retryCount >= maxRetries (no more retries)
 *
 * A `failed` parent that still has retries left is **not** terminal: the
 * Reconciler's auto-retry rule ({@link detectRetryableFailedWorkItems}) will
 * re-queue it on the same pass. If we cascade-cancel the children at that
 * moment, the parent gets revived but its children are already in the
 * irreversible `cancelled` state — which is exactly the data-loss bug
 * observed in the 2026-05-06 dogfood (umbrella WI 5bccc08d timed out, all 6
 * P0 child WIs were cancelled, parent then auto-retried but was childless).
 *
 * @param parent - Parent WorkItem
 * @returns True if cascade should fire on this parent
 */
function isParentPermanentlyTerminal(parent: WorkItem): boolean {
  if (parent.status === 'cancelled') return true;
  if (parent.status === 'failed' && parent.retryCount >= parent.maxRetries) return true;
  return false;
}

/**
 * Detects WorkItems whose parent has been permanently cancelled/failed but
 * are still active. These should be cascade-cancelled.
 *
 * Children of `failed`-but-retryable parents are intentionally **skipped** —
 * see {@link isParentPermanentlyTerminal} for the rationale.
 *
 * @param workItems - All WorkItems to check
 * @param workItemMap - Map of WorkItem ID → WorkItem for parent lookup
 * @returns Corrections for orphan WorkItems
 */
export function detectOrphanWorkItems(
  workItems: WorkItem[],
  workItemMap: Map<string, WorkItem>,
): { corrections: ReconcileCorrection[]; orphanIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const orphanIds: string[] = [];

  for (const wi of workItems) {
    if (TERMINAL_WORK_ITEM_STATUSES.has(wi.status)) continue;
    if (!wi.parentWorkItemId) continue;

    const parent = workItemMap.get(wi.parentWorkItemId);
    if (!parent) continue;

    if (isParentPermanentlyTerminal(parent)) {
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: wi.status,
        newState: 'cancelled',
        reason: `Parent WorkItem ${parent.id} is ${parent.status} (permanent: retries ${parent.retryCount}/${parent.maxRetries})`,
        evidence: `Cascade cancel: parent.status=${parent.status}, parent.retryCount=${parent.retryCount}/${parent.maxRetries}, child.status=${wi.status}`,
      }));
      orphanIds.push(wi.id);
    }
  }

  return { corrections, orphanIds };
}

// ---------------------------------------------------------------------------
// Rule: Detect TTL-Expired WorkItems
// ---------------------------------------------------------------------------

/**
 * Detects WorkItems that have exceeded their time-to-live.
 * Default TTL is 24 hours.
 *
 * @param workItems - All non-terminal WorkItems to check
 * @param ttlMs - Maximum age before auto-cancel (default: 24h)
 * @returns Corrections for expired WorkItems
 */
export function detectTTLExpiredWorkItems(
  workItems: WorkItem[],
  ttlMs: number = 24 * 60 * 60 * 1000,
): { corrections: ReconcileCorrection[]; expiredIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const expiredIds: string[] = [];
  const now = Date.now();

  for (const wi of workItems) {
    if (TERMINAL_WORK_ITEM_STATUSES.has(wi.status)) continue;

    const createdAt = new Date(wi.createdAt).getTime();
    const age = now - createdAt;

    if (age > ttlMs) {
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: wi.status,
        newState: 'cancelled',
        reason: `WorkItem exceeded TTL of ${Math.round(ttlMs / 3600000)}h`,
        evidence: `Created at ${wi.createdAt}, age=${Math.round(age / 3600000)}h`,
      }));
      expiredIds.push(wi.id);
    }
  }

  return { corrections, expiredIds };
}

// ---------------------------------------------------------------------------
// Rule: Recover Blocked WorkItems
// ---------------------------------------------------------------------------

/**
 * Detects blocked WorkItems whose assigned agent is now alive,
 * suggesting they can be re-queued for retry.
 *
 * @param workItems - All blocked WorkItems
 * @param agentHealthMap - Map of agent session → health info
 * @returns Corrections to re-queue recoverable WorkItems
 */
export function detectRecoverableWorkItems(
  workItems: WorkItem[],
  agentHealthMap: Map<string, AgentHealth>,
): { corrections: ReconcileCorrection[]; recoverableIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const recoverableIds: string[] = [];

  for (const wi of workItems) {
    if (wi.status !== 'blocked') continue;
    if (wi.retryCount >= wi.maxRetries) continue;

    // If the agent is back online, re-queue
    if (wi.target) {
      const agent = agentHealthMap.get(wi.target);
      if (agent && agent.status === 'active') {
        corrections.push(createCorrection({
          entityType: 'work_item',
          entityId: wi.id,
          previousState: 'blocked',
          newState: 'queued',
          reason: `Agent ${wi.target} is back online, retry ${wi.retryCount + 1}/${wi.maxRetries}`,
          evidence: `Agent status: active, lastSeen=${agent.lastSeenAt ?? 'now'}`,
        }));
        recoverableIds.push(wi.id);
      }
    }
  }

  return { corrections, recoverableIds };
}

// ---------------------------------------------------------------------------
// Rule: Cascade Cancel Children (F4 enhancement)
// ---------------------------------------------------------------------------

/**
 * Performs deep cascade cancellation: when a WorkItem is cancelled/failed,
 * all descendants (children, grandchildren, etc.) should be cancelled too.
 * This is a recursive version of detectOrphanWorkItems.
 *
 * @param cancelledIds - Set of WorkItem IDs that have been cancelled/failed
 * @param allWorkItems - All WorkItems in the system
 * @returns Corrections for cascaded cancellations
 */
export function cascadeCancelChildren(
  cancelledIds: Set<string>,
  allWorkItems: WorkItem[],
): { corrections: ReconcileCorrection[]; cascadedIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const cascadedIds: string[] = [];
  let changed = true;

  // Iterative approach: keep propagating until no new cancellations
  while (changed) {
    changed = false;
    for (const wi of allWorkItems) {
      if (TERMINAL_WORK_ITEM_STATUSES.has(wi.status)) continue;
      if (cascadedIds.includes(wi.id)) continue;
      if (!wi.parentWorkItemId) continue;

      if (cancelledIds.has(wi.parentWorkItemId) || cascadedIds.includes(wi.parentWorkItemId)) {
        corrections.push(createCorrection({
          entityType: 'work_item',
          entityId: wi.id,
          previousState: wi.status,
          newState: 'cancelled',
          reason: `Cascade cancel: ancestor WorkItem was cancelled/failed`,
          evidence: `parentWorkItemId=${wi.parentWorkItemId} is in cancelled set`,
        }));
        cascadedIds.push(wi.id);
        changed = true;
      }
    }
  }

  return { corrections, cascadedIds };
}

// ---------------------------------------------------------------------------
// Rule: Detect Stale Queued WorkItems (F4 enhancement)
// ---------------------------------------------------------------------------

/**
 * Detects WorkItems that have been in 'queued' status for too long
 * without being picked up. These may indicate assignment problems.
 *
 * **F-CYCLE7-3 fix (2026-05-07):** Previously emitted `queued → queued`
 * which is *not* a valid transition per the canonical
 * {@link WORK_ITEM_TRANSITIONS} table — every emitted correction was
 * rejected by `StorageService` with `Invalid status transition: queued →
 * queued`, generating reconciler-error noise that hid real signal. The
 * comment "Don't change status, just flag for audit" assumed an
 * audit-only path that doesn't exist: `applyCorrection()` always calls
 * `pool.updateItemStatus()` which validates against the transition
 * table.
 *
 * **Canonical state machine** (`backend/src/types/v2/work-item.types.ts`):
 *   `queued` → one of `{ running, proposed, scheduled, cancelled }`.
 *
 * `'expired'` is *not* a valid `WorkItemStatus` (see `WORK_ITEM_STATUSES`),
 * despite earlier reconciler briefs occasionally suggesting it. Of the
 * canonical options, `cancelled` is the only terminal status reachable
 * from `queued`, and is the correct semantic for "queued > threshold,
 * never picked up — work was abandoned."
 *
 * @param workItems - All WorkItems to check
 * @param staleThresholdMs - How long in queued before considered stale (default: 1h)
 * @returns Corrections for stale queued WorkItems (transition: queued → cancelled)
 */
export function detectStaleQueuedWorkItems(
  workItems: WorkItem[],
  staleThresholdMs: number = 60 * 60 * 1000,
): { corrections: ReconcileCorrection[]; staleIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const staleIds: string[] = [];
  const now = Date.now();

  for (const wi of workItems) {
    if (wi.status !== 'queued') continue;

    const createdAt = new Date(wi.createdAt).getTime();
    const waitTime = now - createdAt;

    if (waitTime > staleThresholdMs) {
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: 'queued',
        // queued → cancelled is the canonical valid transition for an
        // abandoned-in-queue WorkItem. See WORK_ITEM_TRANSITIONS.
        newState: 'cancelled',
        reason: `WorkItem has been queued for ${Math.round(waitTime / 60000)} minutes without pickup`,
        evidence: `Created at ${wi.createdAt}, waiting for ${Math.round(waitTime / 60000)}m (threshold: ${Math.round(staleThresholdMs / 60000)}m)`,
      }));
      staleIds.push(wi.id);
    }
  }

  return { corrections, staleIds };
}

// ---------------------------------------------------------------------------
// Pruning Summary
// ---------------------------------------------------------------------------

/**
 * Result of a pruning pass, aggregating all pruning-related corrections.
 */
export interface PruningResult {
  /** WorkItems cancelled due to TTL expiry */
  ttlExpiredCount: number;
  /** WorkItems cancelled due to orphan cascade */
  orphanCancelledCount: number;
  /** WorkItems cancelled due to deep cascade */
  cascadeCancelledCount: number;
  /** WorkItems flagged as stale in queue */
  staleQueuedCount: number;
  /** Total corrections from pruning */
  totalCorrections: ReconcileCorrection[];
}

/**
 * Runs a complete pruning pass — combines TTL, orphan, cascade, and stale detection.
 * Called as part of the Reconciler's full loop every 5 minutes.
 *
 * @param allWorkItems - All WorkItems in the system
 * @param ttlMs - TTL threshold (default: 24h)
 * @param staleThresholdMs - Stale queue threshold (default: 1h)
 * @returns Aggregated pruning result
 */
export function runPruningPass(
  allWorkItems: WorkItem[],
  ttlMs: number = 24 * 60 * 60 * 1000,
  staleThresholdMs: number = 60 * 60 * 1000,
): PruningResult {
  const workItemMap = new Map(allWorkItems.map(wi => [wi.id, wi]));

  // 1. TTL expiry
  const ttl = detectTTLExpiredWorkItems(allWorkItems, ttlMs);

  // 2. Orphan detection
  const orphans = detectOrphanWorkItems(allWorkItems, workItemMap);

  // 3. Build cancelled set for cascade — only include parents that are
  //    *permanently* terminal. A `failed` parent with retries remaining is
  //    excluded so its children are not cancelled mid-retry-window.
  const cancelledIds = new Set<string>();
  for (const wi of allWorkItems) {
    if (isParentPermanentlyTerminal(wi)) {
      cancelledIds.add(wi.id);
    }
  }
  // Include newly detected TTL + orphan IDs
  for (const id of ttl.expiredIds) cancelledIds.add(id);
  for (const id of orphans.orphanIds) cancelledIds.add(id);

  // 4. Deep cascade cancel
  const cascade = cascadeCancelChildren(cancelledIds, allWorkItems);

  // 5. Stale queue detection
  const stale = detectStaleQueuedWorkItems(allWorkItems, staleThresholdMs);

  return {
    ttlExpiredCount: ttl.expiredIds.length,
    orphanCancelledCount: orphans.orphanIds.length,
    cascadeCancelledCount: cascade.cascadedIds.length,
    staleQueuedCount: stale.staleIds.length,
    totalCorrections: [
      ...ttl.corrections,
      ...orphans.corrections,
      ...cascade.corrections,
      ...stale.corrections,
    ],
  };
}

// ---------------------------------------------------------------------------
// Rule: Detect Unclaimed Tasks (Hybrid Wake) — H3
// ---------------------------------------------------------------------------

/** Default threshold for unclaimed task detection (2 minutes). */
export const UNCLAIMED_THRESHOLD_MS = 2 * 60 * 1000;

/** Maximum number of wake actions per reconcile pass (rate limit). */
export const MAX_WAKE_ACTIONS_PER_PASS = 3;

/**
 * Result from the detectUnclaimedTasks rule.
 */
export interface UnclaimedTasksResult {
  /** Wake actions to execute */
  wakeActions: WakeAction[];
  /** WorkItem IDs that triggered wake actions */
  unclaimedWorkItemIds: string[];
}

/**
 * Detects WorkItems in 'queued' status that have gone unclaimed for longer
 * than the threshold, and selects the best dormant agent to wake.
 *
 * Selection algorithm scores agents by:
 *   skill_match (0–40) + urgency (0–30) + context_familiarity (0–20) - load_penalty (0–20)
 *
 * Wake strategy depends on agent status:
 *   - suspended → rehydrate (AgentSuspendService.rehydrateAgent())
 *   - inactive → start (start-agent API)
 *
 * @param workItems - All queued WorkItems in the pool
 * @param agentHealthMap - Map of agent session → health info
 * @param unclaimedThresholdMs - How long unclaimed before triggering wake (default: 2 min)
 * @returns Wake actions and affected WorkItem IDs
 */
export function detectUnclaimedTasks(
  workItems: WorkItem[],
  agentHealthMap: Map<string, AgentHealth>,
  unclaimedThresholdMs: number = UNCLAIMED_THRESHOLD_MS,
): UnclaimedTasksResult {
  const wakeActions: WakeAction[] = [];
  const unclaimedWorkItemIds: string[] = [];
  const now = Date.now();

  // Find agents that can be woken (suspended or inactive)
  const wakableAgents: AgentHealth[] = [];
  for (const agent of agentHealthMap.values()) {
    if (agent.status === 'suspended' || agent.status === 'inactive') {
      wakableAgents.push(agent);
    }
  }

  if (wakableAgents.length === 0) {
    return { wakeActions, unclaimedWorkItemIds };
  }

  // Check if there are ANY active agents — if yes, skip (they should claim work)
  let hasActiveAgent = false;
  for (const agent of agentHealthMap.values()) {
    if (agent.status === 'active') {
      hasActiveAgent = true;
      break;
    }
  }

  // Find unclaimed queued WorkItems past the threshold
  const unclaimedItems = workItems
    .filter(wi => {
      if (wi.status !== 'queued') return false;
      const createdAt = new Date(wi.createdAt).getTime();
      return (now - createdAt) > unclaimedThresholdMs;
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (unclaimedItems.length === 0) {
    return { wakeActions, unclaimedWorkItemIds };
  }

  // If active agents exist but items are unclaimed, only wake if items have
  // been waiting significantly longer (5min) — active agents may be overloaded
  const effectiveThreshold = hasActiveAgent
    ? Math.max(unclaimedThresholdMs, 5 * 60 * 1000)
    : unclaimedThresholdMs;

  // Track which agents we've already decided to wake (avoid waking same agent twice)
  const agentsToWake = new Set<string>();

  for (const wi of unclaimedItems) {
    if (wakeActions.length >= MAX_WAKE_ACTIONS_PER_PASS) break;

    const createdAt = new Date(wi.createdAt).getTime();
    const waitTime = now - createdAt;

    if (hasActiveAgent && waitTime < effectiveThreshold) continue;

    // Score each wakable agent for this WorkItem
    const bestAgent = selectBestAgent(wi, wakableAgents, waitTime, agentsToWake);
    if (!bestAgent) continue;

    const strategy: WakeStrategy = bestAgent.agent.status === 'suspended'
      ? 'rehydrate'
      : 'start';

    wakeActions.push({
      workItemId: wi.id,
      agentSessionName: bestAgent.agent.sessionName,
      strategy,
      score: bestAgent.score,
      scoreBreakdown: bestAgent.breakdown,
      triggeredAt: new Date().toISOString(),
      // Propagate team identifiers so the wake-action HTTP call can hit
      // `/api/teams/:teamId/members/:memberId/start` (the only registered
      // route). Without these, the data-provider falls back to
      // `/api/teams/members/start` which has no router match — the server
      // matches the catch-all `/:teamId/members/:memberId/start` with
      // teamId="members", memberId="start", and returns 404 "Team not
      // found". This silent breakage made hybrid-wake a no-op for
      // inactive team members across the entire fleet.
      teamId: bestAgent.agent.teamId,
      memberId: bestAgent.agent.memberId,
    });

    unclaimedWorkItemIds.push(wi.id);
    agentsToWake.add(bestAgent.agent.sessionName);
  }

  return { wakeActions, unclaimedWorkItemIds };
}

/**
 * Scores and selects the best agent to handle a WorkItem.
 *
 * Score = skill_match (0–40) + urgency (0–30) + context_familiarity (0–20) - load_penalty (0–20)
 *
 * @param workItem - The WorkItem needing an agent
 * @param agents - Candidate agents (suspended or inactive)
 * @param waitTimeMs - How long the WorkItem has been waiting
 * @param excludeAgents - Agents already scheduled for wake in this pass
 * @returns Best agent with score, or null if no suitable agent
 */
export function selectBestAgent(
  workItem: WorkItem,
  agents: AgentHealth[],
  waitTimeMs: number,
  excludeAgents: Set<string> = new Set(),
): { agent: AgentHealth; score: number; breakdown: AgentScoreBreakdown } | null {
  let bestResult: { agent: AgentHealth; score: number; breakdown: AgentScoreBreakdown } | null = null;

  for (const agent of agents) {
    if (excludeAgents.has(agent.sessionName)) continue;

    const breakdown = computeAgentScore(workItem, agent, waitTimeMs);
    const score = breakdown.skillMatch + breakdown.urgency + breakdown.contextFamiliarity - breakdown.loadPenalty;

    if (score <= 0) continue;

    if (!bestResult || score > bestResult.score) {
      bestResult = { agent, score, breakdown };
    }
  }

  return bestResult;
}

/**
 * Computes the score breakdown for a single agent–WorkItem pair.
 *
 * @param workItem - The WorkItem being matched
 * @param agent - The candidate agent
 * @param waitTimeMs - How long the WorkItem has been waiting
 * @returns Score breakdown
 */
export function computeAgentScore(
  workItem: WorkItem,
  agent: AgentHealth,
  waitTimeMs: number,
): AgentScoreBreakdown {
  // --- Skill Match (0–40) ---
  let skillMatch = 10; // Base score: any agent gets 10

  // If WorkItem has a specific target that matches this agent
  if (workItem.target && workItem.target === agent.sessionName) {
    skillMatch = 40; // Perfect match
  } else if (agent.tags && agent.tags.length > 0) {
    // Check tag overlap with WorkItem type and title
    const wiKeywords = extractKeywords(workItem);
    const matchCount = agent.tags.filter(tag =>
      wiKeywords.some(kw => kw.toLowerCase().includes(tag.toLowerCase()) || tag.toLowerCase().includes(kw.toLowerCase()))
    ).length;
    skillMatch = Math.min(40, 10 + matchCount * 10);
  } else if (agent.role === 'developer') {
    // Developers are generic workers — moderate match for delegate/project_task
    if (workItem.type === 'delegate' || workItem.type === 'project_task') {
      skillMatch = 25;
    }
  }

  // --- Urgency (0–30) ---
  // Scale linearly: 2min wait = 0, 10min+ = 30
  const urgencyMinutes = waitTimeMs / 60_000;
  const urgency = Math.min(30, Math.max(0, Math.round((urgencyMinutes - 2) * 3.75)));

  // --- Context Familiarity (0–20) ---
  let contextFamiliarity = 0;

  // If agent previously had this WorkItem assigned (target match = familiarity)
  if (workItem.target && workItem.target === agent.sessionName) {
    contextFamiliarity = 20;
  }
  // Same team = some familiarity
  else if (agent.teamId && workItem.owner === 'agent') {
    contextFamiliarity = 5;
  }

  // --- Load Penalty (0–20) ---
  const activeCount = agent.activeWorkItemCount ?? 0;
  const loadPenalty = Math.min(20, activeCount * 5);

  return { skillMatch, urgency, contextFamiliarity, loadPenalty };
}

/**
 * Extracts searchable keywords from a WorkItem for tag matching.
 *
 * @param workItem - WorkItem to extract keywords from
 * @returns Array of lowercase keywords
 */
function extractKeywords(workItem: WorkItem): string[] {
  const words: string[] = [workItem.type];
  if (workItem.title) {
    words.push(...workItem.title.toLowerCase().split(/[\s\-_/]+/).filter(w => w.length > 2));
  }
  if (workItem.owner) {
    words.push(workItem.owner);
  }
  return words;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Counts WorkItem statuses into a summary object.
 *
 * @param statuses - Array of status strings
 * @returns Object with status counts
 */
function countByStatus(statuses: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statuses) {
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Rule: Auto-Retry Failed WorkItems
// ---------------------------------------------------------------------------

/**
 * Detects WorkItems in 'failed' status that still have remaining retries
 * and can be automatically re-queued for another attempt.
 *
 * @param workItems - Active WorkItems to inspect
 * @returns Corrections for retryable items and their IDs
 */
export function detectRetryableFailedWorkItems(
  workItems: WorkItem[],
): { corrections: ReconcileCorrection[]; retriedIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const retriedIds: string[] = [];

  for (const wi of workItems) {
    if (wi.status !== 'failed') continue;
    if (wi.retryCount >= wi.maxRetries) continue;

    corrections.push(createCorrection({
      entityType: 'work_item',
      entityId: wi.id,
      previousState: 'failed',
      newState: 'queued',
      reason: `Auto-retry failed WorkItem (attempt ${wi.retryCount + 1}/${wi.maxRetries})`,
      evidence: `status=failed, retryCount=${wi.retryCount}, maxRetries=${wi.maxRetries}`,
    }));
    retriedIds.push(wi.id);
  }

  return { corrections, retriedIds };
}

// ---------------------------------------------------------------------------
// Rule: Unblock Dependency-Resolved WorkItems
// ---------------------------------------------------------------------------

/**
 * Detects WorkItems in 'blocked' status whose blocking dependencies
 * (tracked via dependsOn array) have all reached terminal status.
 * These items can be unblocked and re-queued.
 *
 * @param workItems - Active WorkItems to inspect
 * @param workItemMap - Map of all WorkItems by ID for dependency lookup
 * @returns Corrections for unblocked items and their IDs
 */
export function detectDependencyResolvedWorkItems(
  workItems: WorkItem[],
  workItemMap: Map<string, WorkItem>,
): { corrections: ReconcileCorrection[]; unblockedIds: string[] } {
  const corrections: ReconcileCorrection[] = [];
  const unblockedIds: string[] = [];

  for (const wi of workItems) {
    if (wi.status !== 'blocked') continue;

    // Check if this WorkItem has dependency tracking
    const dependsOn = (wi as any).dependsOn as string[] | undefined;
    if (!dependsOn || dependsOn.length === 0) continue;

    // All dependencies must be in a terminal state
    const allResolved = dependsOn.every(depId => {
      const dep = workItemMap.get(depId);
      if (!dep) return true; // Missing dependency treated as resolved
      return TERMINAL_WORK_ITEM_STATUSES.has(dep.status);
    });

    if (allResolved) {
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: 'blocked',
        newState: 'queued',
        reason: `All dependencies resolved, unblocking WorkItem`,
        evidence: `dependsOn=[${dependsOn.join(', ')}], all terminal`,
      }));
      unblockedIds.push(wi.id);
    }
  }

  return { corrections, unblockedIds };
}
