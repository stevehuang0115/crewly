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
  WORK_ITEM_TRANSITIONS,
  createCorrection,
  DEFAULT_GRACE_PERIOD_MS,
  getTtlAnchorAt,
} from '../../types/v2/index.js';
import {
  DISPOSITION_REQUIRED_STATUSES,
  isWorkItemDisposed,
} from '../../types/v2/work-item.types.js';

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
// Cascade Target Picker (shared by the orphan + deep-cascade rules)
// ---------------------------------------------------------------------------

/**
 * Preference order used when choosing a CASCADE target.
 *
 * Deliberately cancel-only. See {@link pickCascadeTarget} for why this list
 * must never grow an "accomplishment" outcome such as `verified` or `done`.
 */
const CASCADE_TARGET_PREFERENCE: readonly WorkItemStatus[] = ['cancelled'] as const;

/**
 * Pick a state-machine-legal target for a WorkItem being cascade-cancelled
 * because an ancestor died, or `null` when no legal target exists.
 *
 * Table-driven off {@link WORK_ITEM_TRANSITIONS} for the same reason the TTL
 * picker is ({@link pickTTLExpiryTarget}): hardcoding `→ cancelled` per rule
 * has already caused the same forever-throwing production loop twice, because
 * a fix applied at one call site was never applied to its siblings. Adding a
 * new {@link WorkItemStatus} can therefore only ever make cascade *skip* an
 * item — inert — never emit an edge the state machine rejects on every pass.
 *
 * **Why this is NOT `pickTTLExpiryTarget`.** Commit 469a3a21 routed both
 * cascade rules through the TTL picker to close the illegal-edge bug. That
 * fixed the crash but imported a semantic that does not belong here. The TTL
 * picker falls back to `verified` for `done_by_worker` on purpose: a TTL
 * expiry means "24h elapsed with nobody objecting", and treating silence as
 * implicit acceptance is a defensible reading of a 24h-old review request.
 *
 * Cascade has no time dimension whatsoever. It fires the instant a dead
 * ancestor is reconciled. Borrowing the TTL fallback meant a child that
 * entered `done_by_worker` one second ago was stamped `verified` — TL-
 * unreviewed work auto-accepted with no age gate, no verdict, and no TL —
 * precisely the invariant `ReconcilerService.runFull` orders
 * {@link detectUnverifiedWorkItems} ahead of the pruning pass to protect.
 * An unrelated ancestor failing is not evidence that a child's output is good.
 *
 * So cascade declines instead. `done_by_worker`, `rejected` and `failed` all
 * return `null` and are left untouched, which is consistent with what the TTL
 * rule already does for `rejected` / `failed`: no legal *cancel* edge means no
 * correction, not a different correction. Those statuses own their own
 * lifecycles (TL verdict, retry, escalation); a cascade sweep is not entitled
 * to resolve them.
 *
 * @param current - Current WorkItem status
 * @returns `'cancelled'` when that edge is legal from `current`, else `null`
 *   (the caller must skip the item and emit no correction)
 *
 * @example
 * ```typescript
 * pickCascadeTarget('running');        // 'cancelled'
 * pickCascadeTarget('done_by_worker'); // null → skip; never auto-accept
 * pickCascadeTarget('rejected');       // null → skip
 * ```
 */
export function pickCascadeTarget(current: WorkItemStatus): WorkItemStatus | null {
  const legalTargets = WORK_ITEM_TRANSITIONS[current];
  if (!legalTargets) return null;

  for (const candidate of CASCADE_TARGET_PREFERENCE) {
    if (TERMINAL_WORK_ITEM_STATUSES.has(candidate) && legalTargets.has(candidate)) {
      return candidate;
    }
  }
  return null;
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
      // `→ cancelled` is NOT legal from every non-terminal status
      // (`rejected` / `failed` only permit `→ queued`; `done_by_worker`
      // only `→ verified` / `→ rejected`). Hardcoding `cancelled` here
      // reproduced Request 13548bd5's forever-throwing loop for orphaned
      // children. Route through the CANCEL-ONLY picker — NOT the TTL one,
      // which would auto-`verified` a `done_by_worker` child on the strength
      // of an unrelated ancestor dying. See {@link pickCascadeTarget}.
      const orphanTarget = pickCascadeTarget(wi.status);
      if (orphanTarget === null) continue;
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: wi.status,
        newState: orphanTarget,
        reason: `Parent WorkItem ${parent.id} is ${parent.status} (permanent: retries ${parent.retryCount}/${parent.maxRetries})`,
        evidence: `Orphan ${orphanTarget}: parent.status=${parent.status}, parent.retryCount=${parent.retryCount}/${parent.maxRetries}, child.status=${wi.status}`,
      }));
      // Only genuinely cancelled ids may enter `orphanIds`. The list seeds
      // the deep-cascade set in `runPruningPass`, so pushing a
      // non-`cancelled` outcome here would cascade-cancel the descendants of
      // a parent that was never cancelled.
      orphanIds.push(wi.id);
    }
  }

  return { corrections, orphanIds };
}

// ---------------------------------------------------------------------------
// Rule: Detect TTL-Expired WorkItems
// ---------------------------------------------------------------------------

/**
 * Preference order used when choosing a TTL-expiry target.
 *
 * The picker walks this list and returns the first entry that is BOTH
 * strictly terminal (per {@link TERMINAL_WORK_ITEM_STATUSES}) and a legal
 * outbound edge from the WorkItem's current status (per
 * {@link WORK_ITEM_TRANSITIONS}).
 *
 * `cancelled` is first because a TTL expiry is an abandonment, not an
 * accomplishment. `verified` follows so `done_by_worker` — which has no
 * `→ cancelled` edge — auto-approves rather than stranding: 24h of
 * nobody objecting is treated as implicit acceptance. `done` is last and
 * in practice unreachable (every status that permits `→ done` also
 * permits `→ cancelled`), but is listed so the table stays total if a
 * future status permits `→ done` alone.
 */
const TTL_EXPIRY_TARGET_PREFERENCE: readonly WorkItemStatus[] = [
  'cancelled',
  'verified',
  'done',
] as const;

/**
 * Pick a state-machine-legal terminal status for a TTL-expired WorkItem,
 * or `null` when no legal terminal target exists.
 *
 * **Scope: the TTL rule only.** The `verified` fallback below encodes a TIME
 * semantic — "24h elapsed with nobody objecting, treat silence as implicit
 * acceptance" — which is only defensible because a TTL expiry *is* the passage
 * of time. Rules with no time dimension must NOT borrow this picker; commit
 * 469a3a21 briefly shared it with the orphan + deep-cascade rules and that
 * silently auto-`verified` seconds-old `done_by_worker` children whenever an
 * unrelated ancestor failed. Those rules use {@link pickCascadeTarget}, which
 * is cancel-only. Read that JSDoc before wiring a third caller into this one.
 *
 * This picker is TABLE-DRIVEN off {@link WORK_ITEM_TRANSITIONS} rather
 * than hardcoded per-status branches. That is deliberate: the hardcoded
 * form has now caused the same production incident twice, because a fix
 * applied to one status was never applied to its siblings.
 *
 * History — read this before "simplifying" it back:
 *
 * 1. Original form issued an unconditional `→ cancelled` correction.
 *    That is legal from `queued` / `scheduled` / `accepted` / `running` /
 *    `blocked` / `escalated`, but NOT from `done_by_worker`, which only
 *    permits `→ verified` / `→ rejected`.
 * 2. Dogfood symptom 2026-05-12: 10 stale `done_by_worker` WIs sat in the
 *    pool for 86+ hours. The TTL rule fired every minute, every attempt
 *    threw `Invalid status transition for WorkItem ...: done_by_worker →
 *    cancelled`, the log filled with ERROR noise, and the WIs were never
 *    cleaned up. Fixed by special-casing `done_by_worker → verified`.
 * 3. That fix was NOT applied to the siblings. `rejected` and `failed`
 *    are also non-terminal, are also absent from
 *    {@link TERMINAL_WORK_ITEM_STATUSES}, and also have no `→ cancelled`
 *    edge — `failed → queued` is their only outbound edge. So the exact
 *    same forever-throwing loop recurred for them (Request 13548bd5,
 *    surfaced by the 2026-08-20 Orca audit).
 *
 * The table-driven form closes this bug class **for the TTL rule**: a status
 * can only receive a target the transition matrix actually permits, and a
 * status with no legal terminal target is skipped rather than corrected into
 * an exception. Adding a new {@link WorkItemStatus} can no longer silently
 * reintroduce this — worst case the new status is skipped by TTL, which
 * is inert, instead of throwing on every reconciler pass forever.
 *
 * `null` results (currently `rejected` and `failed`) are intentional — the
 * alternative is an illegal edge, not a cleanup. Both statuses have their own
 * lifecycle, though NEITHER is fully covered today; see the caveats, which are
 * tracked as follow-ups rather than silently assumed away:
 *
 * - `failed`: {@link detectRetryableFailedWorkItems} re-queues it while
 *   retries remain, and `V3DataService.onTaskFailed` escalates it to the
 *   orchestrator once the budget is spent. CAVEAT: that escalation only fires
 *   for failures arriving via the `v3:task_failed` event. A WI that reaches
 *   `failed` another way (direct `failItem`, the SLA `pickFailTarget`
 *   `running → failed` path, reconciler-driven failures) with
 *   `retryCount >= maxRetries` currently has no lifecycle at all.
 * - `rejected`: `EventToWorkItemBridge`'s `task:rejected` handler spawns a
 *   retry or TL-escalation WorkItem, and the source stays `rejected` as an
 *   audit record. CAVEAT: `verifyItem` is the only publisher of
 *   `task:rejected`, so rejections arriving via
 *   `RequestSlaSubscriber.failOrphanRespondWi` produce no successor and
 *   currently strand.
 *
 * Skipping them here is still correct: the TTL sweeper cannot legally act on
 * either, so these gaps belong to the owning lifecycles, not to this rule.
 *
 * @param current - Current (non-terminal) WorkItem status
 * @returns A legal terminal status for TTL expiry, or `null` when the
 *   status has no legal terminal target and must be skipped
 *
 * @example
 * ```typescript
 * pickTTLExpiryTarget('running');        // 'cancelled'
 * pickTTLExpiryTarget('done_by_worker'); // 'verified'
 * pickTTLExpiryTarget('rejected');       // null  → skip, do not correct
 * ```
 */
export function pickTTLExpiryTarget(current: WorkItemStatus): WorkItemStatus | null {
  const legalTargets = WORK_ITEM_TRANSITIONS[current];
  if (!legalTargets) return null;

  for (const candidate of TTL_EXPIRY_TARGET_PREFERENCE) {
    if (TERMINAL_WORK_ITEM_STATUSES.has(candidate) && legalTargets.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Detects WorkItems that have exceeded their time-to-live.
 * Default TTL is 24 hours.
 *
 * Picks a state-machine-legal terminal target for each expired WI via
 * {@link pickTTLExpiryTarget}, so the correction never fails with
 * `Invalid status transition`.
 *
 * Two categories are skipped without a correction:
 * 1. Strictly terminal WIs ({@link TERMINAL_WORK_ITEM_STATUSES}) — already done.
 * 2. WIs whose status has NO legal terminal target (picker returns `null`).
 *    Emitting a correction for these is what produced the forever-throwing
 *    reconciler loop in Request 13548bd5 — the correction was illegal, the
 *    transition threw on every pass, and the item was never cleaned up.
 *    Skipping is inert and correct: those statuses (`rejected`, `failed`)
 *    own their own retry/escalation lifecycles. See {@link pickTTLExpiryTarget}.
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

    // Age is measured from the TTL anchor, not `createdAt`. For an item that
    // has never been requeued these are the same value; for one that HAS been
    // requeued after a failure, the retry gets a fresh TTL window instead of
    // inheriting the original request's age. See {@link getTtlAnchorAt}.
    const anchorAt = new Date(getTtlAnchorAt(wi)).getTime();
    const age = now - anchorAt;

    if (age > ttlMs) {
      const target = pickTTLExpiryTarget(wi.status);
      // No legal terminal edge from this status — skip rather than emit a
      // correction the state machine will reject on every single pass.
      if (target === null) continue;
      corrections.push(createCorrection({
        entityType: 'work_item',
        entityId: wi.id,
        previousState: wi.status,
        newState: target,
        reason: `WorkItem exceeded TTL of ${Math.round(ttlMs / 3600000)}h`,
        evidence:
          `Created at ${wi.createdAt}, TTL measured from ${getTtlAnchorAt(wi)}, ` +
          `age=${Math.round(age / 3600000)}h`,
      }));
      expiredIds.push(wi.id);
    }
  }

  return { corrections, expiredIds };
}

// ---------------------------------------------------------------------------
// Rule: Detect Unverified WorkItems (verification enforcement — P1)
// ---------------------------------------------------------------------------

/**
 * How long a `done_by_worker` WorkItem may await TL verification before the
 * reconciler escalates it to the orchestrator for a verdict. Deliberately far
 * shorter than the 24h TTL fallback (which silently auto-`verified`s as a last
 * resort) so unverified work gets a REAL verdict opportunity long before it
 * could be implicitly accepted. Default 2 hours.
 */
export const DEFAULT_VERIFY_ESCALATE_MS = 2 * 60 * 60 * 1000;

/**
 * Metadata flag the reconciler stamps once it has escalated a WorkItem for
 * overdue verification, so the rule fires exactly once per item (no per-tick
 * re-nudge spam). Exported so the reconciler service and tests share the key.
 */
export const VERIFY_ESCALATED_AT_KEY = 'verifyEscalatedAt';

/**
 * Detect WorkItems the worker reported done but the Team Leader has NOT
 * verified within the deadline — the verification-enforcement gap.
 *
 * Background: a `done_by_worker` item sits awaiting a TL verdict
 * (`done_by_worker → verified | rejected`). If the TL never acts, the only
 * thing that eventually moves it is the 24h TTL rule, which treats
 * "no-objection" as IMPLICIT ACCEPTANCE (auto-`verified`) — i.e. unverified
 * work silently passes. That breaks the "verify → reject → iterate" loop the
 * autonomous harness depends on.
 *
 * This rule surfaces such items so the reconciler can ESCALATE them to the
 * orchestrator for an explicit verdict (which then either accepts, or rejects
 * → the existing `rejected → queued` rework loop). It does NOT change status
 * itself (the only legal edges are verified/rejected, and the verdict is the
 * orc's to make) and it skips items already escalated (via
 * {@link VERIFY_ESCALATED_AT_KEY}) so it fires once per item.
 *
 * Pure + deterministic for unit testing.
 *
 * @param workItems - All WorkItems to scan.
 * @param nowMs - Current time in ms (injectable for tests). Defaults to now.
 * @param escalateAfterMs - Awaiting-verification age before escalation.
 *   Defaults to {@link DEFAULT_VERIFY_ESCALATE_MS}.
 * @returns The unverified items needing escalation + their ids.
 *
 * @example
 * ```ts
 * const { items } = detectUnverifiedWorkItems(pool, Date.now());
 * for (const wi of items) await escalateVerificationToOrc(wi);
 * ```
 */
export function detectUnverifiedWorkItems(
  workItems: WorkItem[],
  nowMs: number = Date.now(),
  escalateAfterMs: number = DEFAULT_VERIFY_ESCALATE_MS,
): { items: WorkItem[]; unverifiedIds: string[] } {
  const items: WorkItem[] = [];
  const unverifiedIds: string[] = [];

  for (const wi of workItems) {
    if (wi.status !== 'done_by_worker') continue;

    // Fire once per item — skip anything the reconciler already escalated.
    const meta = wi.metadata as Record<string, unknown> | undefined;
    if (meta && meta[VERIFY_ESCALATED_AT_KEY]) continue;

    // Age since the worker reported done (when it entered done_by_worker).
    const awaitingSinceIso = wi.completedAt ?? wi.startedAt ?? wi.createdAt;
    const awaitingSince = new Date(awaitingSinceIso).getTime();
    if (!Number.isFinite(awaitingSince)) continue;

    if (nowMs - awaitingSince > escalateAfterMs) {
      items.push(wi);
      unverifiedIds.push(wi.id);
    }
  }

  return { items, unverifiedIds };
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
        // See the orphan rule above — `→ cancelled` is not legal from
        // every non-terminal status. Skip children the state machine
        // gives no legal cancel edge for instead of emitting a correction
        // that throws on every pass. Cancel-only by construction: a dead
        // ancestor is not a verdict on a `done_by_worker` child's output.
        const cascadeTarget = pickCascadeTarget(wi.status);
        if (cascadeTarget === null) continue;
        corrections.push(createCorrection({
          entityType: 'work_item',
          entityId: wi.id,
          previousState: wi.status,
          newState: cascadeTarget,
          reason: `Cascade ${cascadeTarget}: ancestor WorkItem was cancelled/failed`,
          evidence: `parentWorkItemId=${wi.parentWorkItemId} is in cancelled set, child.status=${wi.status} → ${cascadeTarget}`,
        }));
        // Only genuinely cancelled ids may enter `cascadedIds` — the loop
        // below treats this list as the next generation of dead ancestors,
        // so a non-`cancelled` entry would cancel grandchildren off a parent
        // that is still very much alive.
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
 * **2026-05-16 policy change — DO NOT auto-cancel stale queued WIs.**
 * The earlier behavior emitted `queued → cancelled` corrections whenever
 * a WI sat queued for more than `staleThresholdMs` (default 1h). On
 * 2026-05-16 a real user request (Steve's X-article analysis dispatched
 * to inactive Atlas) was destroyed by this rule: the WI sat queued
 * because the target agent was dead, the 60-min timer expired before
 * orc could re-wake Atlas, and the WI was silently cancelled. Cancelling
 * was *masking* the underlying bugs (wake-gate ordering race, idle
 * agents holding the floor under memory pressure) instead of surfacing
 * them. PR #585's eviction-under-pressure is the right mechanism to
 * actually make progress on stale queued WIs — wake their target rather
 * than kill the work.
 *
 * This function now returns ONLY `staleIds` for observability (so
 * callers can log/escalate the stuck condition); no corrections are
 * emitted, so applying the returned (empty) corrections is a no-op. The
 * `corrections` field is preserved for API compatibility with
 * `runPruningPass` which spreads it into the aggregate list.
 *
 * Historical context preserved:
 *   - F-CYCLE7-3 (2026-05-07) was an earlier fix that switched the
 *     emitted correction from `queued→queued` (invalid transition) to
 *     `queued→cancelled` (valid but destructive). The destructive flip
 *     is what we're now reverting; the transition-table-validity lesson
 *     still applies to other rules that DO emit corrections.
 *   - Canonical state machine (`work-item.types.ts`): `queued` → one of
 *     `{ running, proposed, scheduled, cancelled }`.
 *
 * @param workItems - All WorkItems to check
 * @param staleThresholdMs - How long in queued before considered stale (default: 1h)
 * @returns `{ corrections: [], staleIds }` — observability-only. The
 *   `corrections` array is always empty; iterate `staleIds` for the
 *   list of WIs that have been queued past `staleThresholdMs`.
 */
export function detectStaleQueuedWorkItems(
  workItems: WorkItem[],
  staleThresholdMs: number = 60 * 60 * 1000,
): { corrections: ReconcileCorrection[]; staleIds: string[] } {
  const staleIds: string[] = [];
  const now = Date.now();

  for (const wi of workItems) {
    if (wi.status !== 'queued') continue;

    const createdAt = new Date(wi.createdAt).getTime();
    const waitTime = now - createdAt;

    if (waitTime > staleThresholdMs) {
      staleIds.push(wi.id);
    }
  }

  // No corrections — staleIds is observability-only. See the JSDoc
  // banner above for why we no longer auto-cancel.
  return { corrections: [], staleIds };
}

// ---------------------------------------------------------------------------
// Pruning Summary
// ---------------------------------------------------------------------------

/**
 * Result of a pruning pass, aggregating all pruning-related corrections.
 */
export interface PruningResult {
  /**
   * WorkItems the TTL rule **cancelled** (`… → cancelled`) — genuine cleanup,
   * the work is discarded.
   *
   * Replaces the former `ttlExpiredCount`, which was `expiredIds.length` and
   * therefore lumped these together with the auto-ACCEPTED items below. The
   * reconciler folded that combined number into
   * `ReconcileResult.staleItemsCleaned`, so an operator reading
   * `staleItemsCleaned = 10` concluded 10 items were thrown away when some of
   * them had in fact been accepted. Two opposite outcomes must never share a
   * counter; see {@link ttlAutoVerifiedCount}.
   */
  ttlCancelledCount: number;
  /**
   * WorkItems the TTL rule **auto-accepted** rather than discarded — today
   * exclusively the `done_by_worker → verified` 24h implicit-acceptance
   * fallback (see {@link pickTTLExpiryTarget}). Counted separately and
   * deliberately EXCLUDED from `ReconcileResult.staleItemsCleaned`: this is
   * work that passed, not work that was cleaned up.
   *
   * Defined as "TTL acted, but the target was not `cancelled`", so if the
   * target-preference list ever yields a third acceptance-shaped terminal
   * (`done` is listed but unreachable today — every status that permits
   * `done` also permits the higher-priority `cancelled`) it lands here rather
   * than being silently dropped from both counters.
   */
  ttlAutoVerifiedCount: number;
  /** WorkItems cancelled due to orphan cascade */
  orphanCancelledCount: number;
  /** WorkItems cancelled due to deep cascade */
  cascadeCancelledCount: number;
  /**
   * WorkItems still queued past `staleThresholdMs`. Surfaced for
   * observability ONLY — no longer auto-cancelled (policy change
   * 2026-05-16; see {@link detectStaleQueuedWorkItems} banner).
   */
  staleQueuedCount: number;
  /**
   * IDs of the still-queued WIs that exceeded the staleness threshold.
   * Callers (the reconciler service) log these so the stuck condition
   * is visible without destroying the work. Empty when none are stale.
   */
  staleQueuedIds: string[];
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
 * @returns Aggregated pruning result. The TTL outcome is reported as two
 *   separate counters — {@link PruningResult.ttlCancelledCount} (discarded)
 *   and {@link PruningResult.ttlAutoVerifiedCount} (accepted) — because only
 *   the former is "cleanup". Callers aggregating a cleaned-up total must sum
 *   the cancel-shaped counters ONLY.
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
  // Include newly detected TTL + orphan IDs — but ONLY those whose correction
  // is actually `→ cancelled`. `detectTTLExpiredWorkItems` also emits
  // `done_by_worker → verified` (the 24h implicit-acceptance fallback), and a
  // `verified` parent is NOT a dead ancestor: `isParentPermanentlyTerminal`
  // above deliberately counts only `cancelled` / permanently-`failed`. Seeding
  // the cascade set from the raw id list contradicted that definition and
  // cancelled the descendants of a parent that had just been ACCEPTED.
  // `orphans.orphanIds` is cancel-only by construction (see
  // {@link pickCascadeTarget}) but is filtered the same way so the invariant
  // is enforced here rather than assumed from a callee.
  //
  // The same split drives the two TTL counters: a `→ cancelled` correction is
  // cleanup, anything else is an acceptance the caller must NOT report as
  // "cleaned". `ttl.corrections` and `ttl.expiredIds` are pushed in lockstep,
  // so these two counts partition the whole TTL outcome with nothing lost.
  let ttlCancelledCount = 0;
  for (const c of ttl.corrections) {
    if (c.newState === 'cancelled') {
      cancelledIds.add(c.entityId);
      ttlCancelledCount++;
    }
  }
  for (const c of orphans.corrections) {
    if (c.newState === 'cancelled') cancelledIds.add(c.entityId);
  }

  // 4. Deep cascade cancel
  const cascade = cascadeCancelChildren(cancelledIds, allWorkItems);

  // 5. Stale queue detection
  const stale = detectStaleQueuedWorkItems(allWorkItems, staleThresholdMs);

  return {
    ttlCancelledCount,
    ttlAutoVerifiedCount: ttl.corrections.length - ttlCancelledCount,
    orphanCancelledCount: orphans.orphanIds.length,
    cascadeCancelledCount: cascade.cascadedIds.length,
    staleQueuedCount: stale.staleIds.length,
    staleQueuedIds: stale.staleIds,
    totalCorrections: [
      ...ttl.corrections,
      ...orphans.corrections,
      ...cascade.corrections,
      // stale.corrections is intentionally always empty per the
      // 2026-05-16 policy change — the spread is kept for the
      // unlikely case that the policy is ever reverted.
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

  // Find agents that can be woken.
  //   - suspended → rehydrate (resume the paused session)
  //   - inactive  → start     (spin a fresh agent session)
  //   - active + activeWorkItemCount===0 → redeliver (re-POST WI brief to PTY)
  //
  // The `redeliver` bucket targets the 2026-05-20 Sora case: a WorkItem was
  // queued with explicit `target=crewly-test-sora`, the agent was alive at
  // the prompt, but the original /api/terminal/:session/write landed inside
  // claude-code's startup banner and was silently dropped. The WI sat in
  // queued for ~53 minutes until manual /task-pool/claim. We can't catch
  // the drop at dispatch time (it looks like a successful 200 OK), so the
  // reconciler is the safety net: if a targeted, queued WI ages past
  // threshold AND its target is alive-but-empty, re-push the brief.
  const wakableAgents: AgentHealth[] = [];
  const activeIdleByTarget = new Map<string, AgentHealth>();
  for (const agent of agentHealthMap.values()) {
    if (agent.status === 'suspended' || agent.status === 'inactive') {
      wakableAgents.push(agent);
    } else if (agent.status === 'active' && (agent.activeWorkItemCount ?? 0) === 0) {
      activeIdleByTarget.set(agent.sessionName, agent);
    }
  }

  if (wakableAgents.length === 0 && activeIdleByTarget.size === 0) {
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

  // Set of agent session-names that can be woken right now (inactive +
  // suspended). Used to exempt "explicit-target-is-dead" WIs from both
  // the per-WI age threshold and the hasActiveAgent 5-min upgrade.
  //
  // Why exempt: the unclaimedThresholdMs default of 2 min — and the
  // 5-min upgrade when *other* agents are alive — exists for untargeted
  // (skill-match) wakes, so a freshly-queued WI isn't claimed by an
  // active agent that would have picked it up in the next reconcile
  // pass. That gating doesn't apply when the WI names an explicit
  // target and that named target is provably dead — no active agent is
  // going to come along and claim a WI targeted at someone else. Atlas
  // case on 2026-05-23: 3 RESEARCH BRIEF WIs sat blocked for 30 min+
  // because the immediate pre-claim by delegate-task pushed them to
  // `running` before any spawn was attempted, and the wake-rule was
  // gated by both thresholds.
  const wakableSessionNames = new Set(wakableAgents.map((a) => a.sessionName));

  // Find unclaimed queued WorkItems eligible for wake. Either:
  //   - The WI has aged past the unclaimed threshold (original behavior), or
  //   - The WI has an explicit `target` that is in wakableSessionNames —
  //     i.e. the named target is inactive or suspended. No reason to wait;
  //     no other agent is going to claim it.
  const unclaimedItems = workItems
    .filter(wi => {
      if (wi.status !== 'queued') return false;
      const createdAt = new Date(wi.createdAt).getTime();
      const pastThreshold = (now - createdAt) > unclaimedThresholdMs;
      const targetIsWakable = !!wi.target && wakableSessionNames.has(wi.target);
      return pastThreshold || targetIsWakable;
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

    // Same exemption as the filter above: if the explicit target is in the
    // wakable set, bypass the active-agent 5-min upgrade. The threshold
    // was meant to give live skill-match candidates a chance; that's
    // irrelevant when the target is named and dead.
    const targetIsWakable = !!wi.target && wakableSessionNames.has(wi.target);
    if (hasActiveAgent && waitTime < effectiveThreshold && !targetIsWakable) continue;

    // 2026-05-17 — never auto-wake for untargeted WIs. If a WorkItem
    // doesn't name a `target`, the reconciler used to pick the
    // "highest-score" wakable agent by skill match (developer-role +
    // tag-keyword overlap). That meant a stale unassigned delegate WI
    // queued days ago could spin a fresh agent back to life on every
    // restart, racking up RAM with no actual work the agent could do
    // (the WI is unowned). Strict policy: only wake when the WI
    // explicitly names an offline target via `wi.target`.
    if (!wi.target) continue;

    // First chance: if the explicit target is active-but-idle, the original
    // dispatch likely vanished into a startup banner — schedule a redeliver
    // instead of waking some other agent that doesn't own this WI.
    const idleTarget = activeIdleByTarget.get(wi.target);
    if (idleTarget && !agentsToWake.has(idleTarget.sessionName)) {
      wakeActions.push({
        workItemId: wi.id,
        agentSessionName: idleTarget.sessionName,
        strategy: 'redeliver',
        // Redeliver is target-driven, not score-driven — scoring would be
        // misleading. We use a sentinel score of 0 and an all-zero breakdown
        // so audit consumers can filter on `strategy === 'redeliver'`.
        score: 0,
        scoreBreakdown: { skillMatch: 0, urgency: 0, contextFamiliarity: 0, loadPenalty: 0 },
        triggeredAt: new Date().toISOString(),
        teamId: idleTarget.teamId,
        memberId: idleTarget.memberId,
      });
      unclaimedWorkItemIds.push(wi.id);
      agentsToWake.add(idleTarget.sessionName);
      continue;
    }

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
  // 2026-05-17 — when a WorkItem has an explicit `target`, ONLY consider
  // waking that exact agent. The previous "best-score across all agents"
  // behaviour quietly substituted a different agent when the named target
  // was offline (e.g. a queued `respond_to_user` WI for `crewly-orc` would
  // wake Quinn / Reed / Victor based on skill score). That defeats the
  // intent of the WI's target field — Quinn cannot respond to a Slack
  // message addressed to orc. Honouring `target` strictly means: if the
  // target isn't currently wakable, the WI stays queued and only its
  // owning agent will pick it up when it comes back online.
  const candidates = workItem.target
    ? agents.filter((a) => a.sessionName === workItem.target)
    : agents;

  let bestResult: { agent: AgentHealth; score: number; breakdown: AgentScoreBreakdown } | null = null;

  for (const agent of candidates) {
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
 * Grace period before the safety net acts on an undisposed stranded item.
 *
 * The eager writers (the SLA subscriber, the bridge) dispose their own items
 * within the same tick. This window lets them win the common case, so the
 * reconciler only picks up the genuinely dropped ones — a writer that threw,
 * a bridge whose source lookup came back empty, a retry id that collided with
 * an already-terminal retry. Short enough that a real strand is caught within
 * a couple of passes; long enough that the safety net is not racing the
 * writers it exists to back up.
 */
export const DISPOSITION_GRACE_MS = 5 * 60 * 1000;

/**
 * Safety net: find `rejected`/`failed` WorkItems that nobody dealt with.
 *
 * This rule is the backstop, NOT the primary mechanism. The paths that park an
 * item in a stranding status are each responsible for disposing of it eagerly
 * (see `TaskPoolService.disposeFailedWorkItem`). This exists because some of
 * them fail silently — the bridge creates no successor if its source lookup
 * returns empty or its retry id collides with an already-terminal retry, and
 * before this rule the resulting strand had no symptom at all: PR #733 correctly
 * stopped the pruning rules from emitting illegal corrections for these
 * statuses, which also removed the recurring error log that used to be the only
 * way to notice.
 *
 * Deliberately returns items rather than corrections. A disposition is not a
 * status change — the `terminal` outcome leaves the item exactly where it is
 * and writes an audit record instead — so there is nothing for the correction
 * pipeline to apply, and inventing a correction here would put an illegal edge
 * back into a pipeline that was just cleaned of them. The caller performs the
 * disposition through the funnel.
 *
 * Termination: every disposition either stamps the item (skipped forever after)
 * or requeues it with `retryCount` bumped (bounded by `maxRetries`). The rule
 * cannot re-fire indefinitely on the same item.
 *
 * @param workItems - The reconciler's WorkItem snapshot.
 * @param graceMs   - Override for {@link DISPOSITION_GRACE_MS} (tests).
 * @param now       - Injectable clock for deterministic tests.
 * @returns The items needing disposition, oldest strand first.
 *
 * @example
 * ```typescript
 * const { items } = detectUndisposedStrandedWorkItems(workItems);
 * for (const wi of items) await pool.disposeFailedWorkItem(wi.id, {...});
 * ```
 */
export function detectUndisposedStrandedWorkItems(
  workItems: WorkItem[],
  graceMs: number = DISPOSITION_GRACE_MS,
  now: number = Date.now(),
): { items: WorkItem[] } {
  const items: WorkItem[] = [];

  for (const wi of workItems) {
    if (!DISPOSITION_REQUIRED_STATUSES.has(wi.status)) continue;
    // THE successor predicate: a local field read. The reverted 469a3a21 rule
    // asked the same question by scanning other WorkItems and was wrong in
    // both directions — see WorkItemDisposition's doc comment.
    if (isWorkItemDisposed(wi)) continue;

    // `completedAt` is set by transitionStatus for every stranding status, so
    // it is when the item ENTERED the strand. Fall back to createdAt only if
    // it is somehow absent.
    const strandedSince = new Date(wi.completedAt ?? wi.createdAt).getTime();
    if (Number.isNaN(strandedSince)) continue;
    if (now - strandedSince < graceMs) continue;

    items.push(wi);
  }

  // Oldest strand first: if a pass is interrupted, the longest-suffering items
  // are the ones already dealt with.
  items.sort(
    (a, b) =>
      new Date(a.completedAt ?? a.createdAt).getTime() -
      new Date(b.completedAt ?? b.createdAt).getTime(),
  );

  return { items };
}

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
