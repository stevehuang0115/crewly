/**
 * V2 WorkItem Type Definitions
 *
 * A WorkItem is the unified execution primitive. Every action the system
 * takes to fulfill a Request or advance a Mission materializes as a WorkItem.
 * This replaces v1's separate delegation, scheduled-message, and event-subscription concepts.
 *
 * @module types/v2/work-item.types
 */

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Enums & Literals
// ---------------------------------------------------------------------------

/**
 * Execution type — determines handler and behavior.
 */
export type WorkItemType =
  | 'delegate'      // Assign work to an agent
  | 'project_task'  // Execute a durable project task
  | 'check'         // Verify a condition or status
  | 'notify'        // Send a notification/message
  | 'cron_run'      // Execute a scheduled recurring action
  | 'review'        // Code review, architecture review
  | 'confirm'       // Wait for user confirmation
  | 'reconcile';    // System self-check

/** All valid WorkItemType values. */
export const WORK_ITEM_TYPES: readonly WorkItemType[] = [
  'delegate',
  'project_task',
  'check',
  'notify',
  'cron_run',
  'review',
  'confirm',
  'reconcile',
] as const;

/**
 * Who is responsible for execution.
 */
export type WorkItemOwner =
  | 'orchestrator'
  | 'team_lead'
  | 'agent'
  | 'system';

/** All valid WorkItemOwner values. */
export const WORK_ITEM_OWNERS: readonly WorkItemOwner[] = [
  'orchestrator',
  'team_lead',
  'agent',
  'system',
] as const;

/**
 * Lifecycle statuses for a WorkItem.
 *
 * State machine (extended with acceptance/verification flow):
 *
 *   --- Creation & Scheduling ---
 *   queued → running          (executor picks up item — simple tasks)
 *   queued → proposed         (TL sends task contract to worker)
 *   queued → scheduled        (has future scheduledAt)
 *   queued → cancelled        (parent cancelled)
 *   scheduled → queued        (scheduledAt reached, trigger fires)
 *
 *   --- Acceptance Handshake ---
 *   proposed → accepted       (worker confirms understanding)
 *   proposed → rejected       (worker cannot accept — wrong fit, unclear, etc.)
 *   proposed → cancelled      (parent cancelled before acceptance)
 *   accepted → running        (worker begins execution)
 *   rejected → queued         (TL reassigns or re-scopes)
 *
 *   --- Execution ---
 *   running → done_by_worker  (worker reports completion, pending TL verification)
 *   running → failed          (execution failed, retries exhausted)
 *   running → blocked         (waiting on dependency)
 *   running → escalated       (worker escalates — scope/risk/ambiguity)
 *   running → cancelled       (parent cancelled during execution)
 *
 *   --- Verification ---
 *   done_by_worker → verified (TL verifies and accepts)
 *   done_by_worker → rejected (TL rejects — needs rework)
 *   rejected → queued         (re-queue for retry/reassignment)
 *   escalated → queued        (TL/human resolves and re-queues)
 *   escalated → cancelled     (escalation results in cancellation)
 *
 *   --- Recovery ---
 *   blocked → queued          (dependency resolved, re-queue)
 *   failed → queued           (manual retry or reconciler recovery)
 *
 *   --- Legacy Compatibility ---
 *   running → done            (simple tasks without TL verification)
 *   done is terminal (backward compatible with existing pool operations)
 */
export type WorkItemStatus =
  | 'queued'
  | 'scheduled'
  | 'proposed'        // Task contract sent, awaiting worker acceptance
  | 'accepted'        // Worker confirmed understanding, ready to start
  | 'running'
  | 'blocked'
  | 'escalated'       // Worker escalated to TL/human for alignment
  | 'done_by_worker'  // Worker reports done, pending TL verification
  | 'verified'        // TL verified and accepted the output
  | 'rejected'        // TL rejected or worker rejected proposal
  | 'done'            // Simple completion (no TL verification needed)
  | 'failed'
  | 'cancelled';

/** All valid WorkItemStatus values. */
export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'queued',
  'scheduled',
  'proposed',
  'accepted',
  'running',
  'blocked',
  'escalated',
  'done_by_worker',
  'verified',
  'rejected',
  'done',
  'failed',
  'cancelled',
] as const;

/** Terminal statuses — no further transitions allowed. */
export const TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  'done',
  'verified',
  'cancelled',
]);

/**
 * Broader "exited the active queue" status set used by SLA-style consumers
 * (e.g. `RequestSlaSubscriber`, `MissionReminderService`) that need to
 * treat `failed` and `rejected` as terminal for *their* purposes — even
 * though those statuses are NOT terminal in the strict state-machine sense
 * (they can transition back to `queued` via the retry path).
 *
 * Hoisted to close the canonical-set duplication anti-pattern called out
 * by Arch on PR #357 (INBOUND-1) N2. Previously each SLA caller redeclared
 * a 5-element local set; this single source of truth keeps them aligned
 * if a new "exit-the-queue" status is added in the future.
 *
 * Members:
 * - `done` / `verified` / `cancelled` — strictly terminal (cannot transition).
 * - `failed` / `rejected` — semantically "exited active queue" for SLA timer
 *   no-op + reentrancy-lock release purposes, even though the state machine
 *   permits `rejected → queued` (retry) and `failed` is not formally terminal.
 *
 * Use this set when answering "should the SLA timer / reentrancy lock
 * release based on the current WI state?", and use {@link TERMINAL_WORK_ITEM_STATUSES}
 * when answering "is the state machine done with this WI?".
 */
/**
 * Metadata key recording the last time a WorkItem was put back on the queue
 * after a failure.
 *
 * Written by `TaskPoolService.requeueAfterFailure`. Read only through
 * {@link getTtlAnchorAt} — call sites must not reach for it directly, so the
 * "which timestamp does age mean?" decision stays in one place.
 */
/**
 * How a WorkItem that landed in `rejected`/`failed` was dealt with.
 *
 * - `retried_in_place`  the same WorkItem went back on the queue (`→ queued`)
 *                       with `retryCount` bumped. The successor IS the item.
 * - `succeeded_by`      a distinct WorkItem picked the work up (the
 *                       `EventToWorkItemBridge` retry/escalation WI). The
 *                       source stays where it is; `successorWorkItemId` names
 *                       the item that carries the work now.
 * - `terminal`          no successor, deliberately. The retry budget is spent
 *                       or the status has no retry path, so the work stops
 *                       here and an escalation carries the decision to a human
 *                       or the orchestrator. `escalationId` names that record.
 */
export type WorkItemDispositionKind =
  | 'retried_in_place'
  | 'succeeded_by'
  | 'terminal';

/**
 * The audit record proving a `rejected`/`failed` WorkItem was actually dealt
 * with, rather than merely left in a status nothing acts on.
 *
 * This exists because the previous attempt at a successor model (reverted in
 * `469a3a21`) tried to INFER whether a successor existed by scanning other
 * WorkItems, and inference over a live filtered collection is wrong in both
 * directions by construction:
 *
 *  - `getActiveWorkItems()` drops `done`/`cancelled`, so a successor that had
 *    already completed was invisible → the rule concluded "no successor" and
 *    re-dispatched the source → completed work ran a second time.
 *  - `buildAutoWorkItem` sets `parentWorkItemId` on VERIFY WorkItems too, so an
 *    unrelated verification child read as a successor → the rule skipped the
 *    exact SLA case it was written to rescue.
 *
 * No refinement of that query fixes it, because the query is reconstructing
 * information the writer already had and discarded. So the writer records it
 * instead: whoever performs the disposition stamps it, in the same operation.
 * The predicate then becomes a local field read with no collection to filter
 * and no `parentWorkItemId` to misread.
 */
export interface WorkItemDisposition {
  /** What was done. See {@link WorkItemDispositionKind}. */
  kind: WorkItemDispositionKind;
  /** ISO-8601 timestamp of the disposition. */
  at: string;
  /** Role that performed it. `'system'` for reconciler/subscriber paths. */
  by: WorkItemOwner;
  /** Human-readable justification, carried into the audit trail. */
  reason: string;
  /** Set when `kind === 'succeeded_by'`: the WorkItem now carrying the work. */
  successorWorkItemId?: string;
  /** Set when `kind === 'terminal'`: the PendingEscalation raised, if any. */
  escalationId?: string;
}

/** Metadata key under which {@link WorkItemDisposition} is stored. */
export const DISPOSITION_METADATA_KEY = 'disposition';

/**
 * Reads a WorkItem's disposition record, validating its shape.
 *
 * `metadata` is `Record<string, unknown>` and round-trips through storage, so
 * the value is validated rather than cast. An unrecognised shape is treated as
 * absent — the safety-net rule will then re-dispose the item, which is safe
 * (dispositions are idempotent) whereas trusting a malformed record is not.
 *
 * @param wi - WorkItem (or any object carrying `metadata`) to read.
 * @returns The disposition, or `null` if the item has not been disposed.
 *
 * @example
 * ```typescript
 * if (!isWorkItemDisposed(wi)) await pool.disposeFailedWorkItem(wi.id, {...});
 * ```
 */
export function getWorkItemDisposition(
  wi: Pick<WorkItem, 'metadata'>,
): WorkItemDisposition | null {
  const raw = wi.metadata?.[DISPOSITION_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<WorkItemDisposition>;
  const kindOk =
    candidate.kind === 'retried_in_place' ||
    candidate.kind === 'succeeded_by' ||
    candidate.kind === 'terminal';
  if (!kindOk) return null;
  if (typeof candidate.at !== 'string' || typeof candidate.reason !== 'string') {
    return null;
  }
  return candidate as WorkItemDisposition;
}

/**
 * Whether a WorkItem has an explicit disposition record.
 *
 * This is THE successor predicate. It is a local field read by design — see
 * {@link WorkItemDisposition} for why the scan-based version it replaces could
 * not be made correct.
 *
 * @param wi - WorkItem to test.
 * @returns True if the item has been dealt with and must not be re-dispatched.
 */
export function isWorkItemDisposed(wi: Pick<WorkItem, 'metadata'>): boolean {
  return getWorkItemDisposition(wi) !== null;
}


export const LAST_REQUEUED_AT_METADATA_KEY = 'lastRequeuedAt';

/**
 * The timestamp that age-based expiry rules must measure from.
 *
 * `createdAt` answers "when was this work first asked for?" and is never
 * mutated anywhere in the codebase — age metrics, ordering and postmortems all
 * depend on that. It is therefore the wrong clock for a TTL, because a WorkItem
 * that is legitimately retried is not stale merely because its *original*
 * request is old.
 *
 * Using `createdAt` for TTL caused a live data-loss bug: a WorkItem that failed
 * after the 24h TTL and was auto-retried by `detectRetryableFailedWorkItems`
 * landed back in `queued` still carrying its original `createdAt`, so the very
 * next reconciler pass (60s later) TTL-cancelled it. Every retry granted past
 * the 24h mark was silently destroyed a minute after being granted.
 *
 * This function resolves the anchor instead: a requeued item's TTL window
 * restarts from the requeue, while an item that has never been requeued keeps
 * `createdAt` and behaves exactly as before.
 *
 * @param wi - The WorkItem whose age is being measured.
 * @returns ISO-8601 timestamp to measure age from. Falls back to `createdAt`
 *          when no requeue has happened, or when the stored value is not a
 *          usable date (defensive: `metadata` is untyped and may be
 *          round-tripped through storage by older writers).
 *
 * @example
 * ```typescript
 * const age = Date.now() - new Date(getTtlAnchorAt(wi)).getTime();
 * ```
 */
export function getTtlAnchorAt(wi: Pick<WorkItem, 'createdAt' | 'metadata'>): string {
  const raw = wi.metadata?.[LAST_REQUEUED_AT_METADATA_KEY];
  if (typeof raw !== 'string') return wi.createdAt;
  // Reject unparseable values rather than letting a NaN age silently disable
  // (or instantly trip) the TTL rule for this item.
  if (Number.isNaN(new Date(raw).getTime())) return wi.createdAt;
  return raw;
}

export const SLA_TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<WorkItemStatus> =
  new Set<WorkItemStatus>([
    'done',
    'verified',
    'cancelled',
    'failed',
    'rejected',
  ]);

// ---------------------------------------------------------------------------
// Core Interface
// ---------------------------------------------------------------------------

/**
 * A single unit of system execution.
 *
 * WorkItems are the internal execution primitive — users rarely see them directly.
 * They unify what v1 had as separate concepts: delegations, scheduled messages,
 * event subscriptions, cron runs, and checks.
 */
/**
 * Sources of a `blocked` status that change how the item is recovered.
 * See {@link WorkItem.blockSource}.
 */
export const WORK_ITEM_BLOCK_SOURCES = {
  /** Blocked through the block API by the agent / a lead: stays blocked until unblocked. */
  EXPLICIT: 'explicit',
} as const;

/** A value of {@link WORK_ITEM_BLOCK_SOURCES}. */
export type WorkItemBlockSource = (typeof WORK_ITEM_BLOCK_SOURCES)[keyof typeof WORK_ITEM_BLOCK_SOURCES];

/**
 * Whether a WorkItem is blocked on purpose (block API) rather than parked by
 * the system. Such an item is never re-queued or re-dispatched automatically.
 *
 * @param wi - WorkItem (status + blockSource)
 * @returns True for a `blocked` item whose block was explicit
 *
 * @example
 * ```typescript
 * if (isExplicitlyBlocked(wi)) continue; // reconciler: leave it alone
 * ```
 */
export function isExplicitlyBlocked(wi: Pick<WorkItem, 'status' | 'blockSource'>): boolean {
  return wi.status === 'blocked' && wi.blockSource === WORK_ITEM_BLOCK_SOURCES.EXPLICIT;
}

export interface WorkItem {
  /** UUID v4 */
  id: string;
  /** Parent Request (undefined for Mission-generated items) */
  requestId?: string;
  /** Parent WorkItem for sub-tasks / retries */
  parentWorkItemId?: string;
  /** Execution type — determines handler and behavior */
  type: WorkItemType;
  /** Who is responsible for execution */
  owner: WorkItemOwner;
  /** Target agent session, team, or system component */
  target?: string;
  /** Human-readable title */
  title: string;
  /** Short summary / instructions (legacy; capped at 500 chars by callers) */
  description?: string;
  /**
   * Long-form task brief in markdown. Replaces the legacy
   * `.crewly/tasks/delegated/*.md` body that v1 task-management used to
   * write to disk. Carries the full instruction set the worker reads
   * before starting. Length is capped to {@link MAX_BRIEF_MARKDOWN_BYTES}
   * by {@link validateCreateWorkItemInput} to keep `pool.json` readable
   * and within `atomicWriteJson`'s practical size budget.
   */
  briefMarkdown?: string;
  /** Lifecycle status */
  status: WorkItemStatus;
  /**
   * Worker-supplied structured output produced during execution.
   *
   * Used for the v1→V3 deprecation handoff: previously workers wrote
   * `<taskId>.output.json` files alongside the `.md` task body and the TL
   * `verify-output` skill read them. With v1 retired, this output now lives
   * on the WorkItem itself and is read via `GET /api/task-pool/items/:id`.
   *
   * Shape is intentionally `Record<string, unknown>` — the schema is
   * task-specific (an audit run, a code-gen artifact, etc.).
   */
  output?: Record<string, unknown>;
  /** When this item should execute (null = immediately) */
  scheduledAt?: string;
  /** ISO8601 timestamps */
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Execution result data */
  result?: Record<string, unknown>;
  /** Error details if failed */
  error?: string;
  /**
   * Human-readable reason recorded when the item transitions to
   * `cancelled`. Surfaces in the work-item activity timeline so the
   * cancellation isn't an opaque event ("WorkItem was cancelled.").
   * Sources include: reconciler stale-pickup detection, mission
   * cascade, parent-cancel ripple, manual user cancel, etc.
   */
  cancelReason?: string;
  /**
   * Human-readable reason recorded when the item transitions to
   * `blocked` (or is created already in `blocked` because of unmet
   * dependencies). Surfaces in the work-item activity timeline so the
   * user understands WHY a WI is stuck — "Waiting on Plan WI to
   * complete" reads very differently from "Agent inactive — system
   * paused this item" reads very differently from "Worker explicitly
   * blocked with reason X". (Steve 2026-05-15 dogfood: UI showed
   * `Blocked` badge with no timeline event explaining why.)
   *
   * Sources: RequestDecomposeSubscriber (dependency-blocked at
   * create time), ReconcilerDataProvider (agent-inactive correction),
   * TaskPoolService.blockItem (explicit worker block).
   */
  blockedReason?: string;
  /**
   * Who parked the item in `blocked`, when it matters for recovery.
   *
   * - `'explicit'`: an agent (or a lead on its behalf) blocked the item
   *   through the block API, e.g. "waiting on the owner". The claim is
   *   released on block, the item is terminal-until-unblocked, and the
   *   reconciler never re-queues it. Only an explicit unblock (a release /
   *   blocked→queued transition) returns it to the queue.
   * - absent: a system block (the reconciler parked it because the agent went
   *   inactive, or it waits on dependencies); the reconciler recovers those.
   *
   * Cleared whenever the item leaves `blocked`.
   */
  blockSource?: WorkItemBlockSource;
  /**
   * Number of FAILED attempts so far.
   *
   * SEMANTICS (deliberate, load-bearing): this counter means *failures
   * only*. It is incremented by `requeueAfterFailure` — the path taken
   * when work genuinely failed — and by nothing else. Consumers branch on
   * `retryCount < maxRetries` to choose retry-in-place vs terminal-and-
   * escalate, so anything that inflates it without a real failure takes
   * live work terminal.
   *
   * In particular, an administrative release (lease expiry, claim revoke,
   * reconciler requeue, an agent handing work back) is NOT a failure and
   * MUST NOT touch this field — see {@link releaseCount}. Before
   * 2026-08-21 `releaseBack` incremented it on every release, so an agent
   * who simply went heads-down for longer than the lease accumulated
   * retries it never earned and was driven to 3/3 with zero failures.
   */
  retryCount: number;
  /** Maximum retries before permanent failure */
  maxRetries: number;
  /**
   * Number of administrative releases back to the pool (lease expiry,
   * claim revoke, reconciler requeue, explicit hand-back).
   *
   * Purely diagnostic — deliberately kept SEPARATE from {@link retryCount}
   * so release churn stays observable without being mistaken for failure.
   * Nothing branches on this field; it exists so a release loop can be
   * spotted without corrupting retry semantics.
   *
   * Optional for back-compat: items persisted before this field existed
   * read as `undefined`, which callers treat as 0.
   */
  releaseCount?: number;
  /**
   * Provenance of {@link target} — how this item came to point at an agent.
   *
   * - `'assigned'` (or absent): a DELIBERATE assignment. A TL delegated the
   *   work, or it was handed off explicitly. This survives a release: the
   *   work still belongs to that agent.
   * - `'claim'`: an incidental stamp. The item was a broadcast item with no
   *   target, and `claimFromPool` / `claimSpecificItem` recorded whoever
   *   picked it up. This must NOT survive a release — otherwise a single
   *   claim would permanently bind broadcast work to one agent, and if that
   *   agent died the item could only ever be re-claimed by a dead session.
   *
   * The distinction exists because "preserve the target on release" is
   * correct for an assignment and actively harmful for a claim stamp.
   */
  /** `escalated`: routed to someone who decides (unassigned work, 2026-09-24) — kept on release like `assigned` */
  targetSource?: 'assigned' | 'claim' | 'escalated';
  /** Trigger ID that created or will wake this WorkItem */
  triggerId?: string;
  /** Link to ProjectTask (for durable project work) */
  projectTaskId?: string;
  /** Link to Mission (for autonomy-generated work) */
  missionId?: string;
  /** Token usage for this specific WorkItem */
  inputTokens: number;
  outputTokens: number;
  /** Cost in USD for this WorkItem */
  cost: number;
  /** Extensible metadata (dependency tracking, skill requirements, etc.) */
  metadata?: Record<string, unknown>;
  /**
   * IDs of upstream WorkItems that must reach terminal success (`done` or
   * `verified`) before this item is allowed to run. When any dep is still
   * pending at creation time, the item starts in `blocked` status and is
   * auto-promoted to `queued` by the TaskPool resolver once every dep
   * completes.
   */
  dependsOn?: string[];
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

/**
 * Input for creating a new WorkItem.
 */
export interface CreateWorkItemInput {
  /**
   * Optional deterministic id. When omitted a random uuid is generated. Supply
   * a stable id when the WorkItem represents an idempotent occurrence (e.g. a
   * cron fire keyed to its slot) so re-creating the same occurrence is a no-op
   * via the pool's `(id)` dedup instead of a duplicate.
   */
  id?: string;
  requestId?: string;
  parentWorkItemId?: string;
  type: WorkItemType;
  owner: WorkItemOwner;
  target?: string;
  title: string;
  description?: string;
  /**
   * Long-form task brief in markdown. See {@link WorkItem.briefMarkdown}
   * for rationale. Validated against {@link MAX_BRIEF_MARKDOWN_BYTES}.
   */
  briefMarkdown?: string;
  scheduledAt?: string;
  maxRetries?: number;
  triggerId?: string;
  projectTaskId?: string;
  missionId?: string;
  metadata?: Record<string, unknown>;
  /** Upstream WorkItem IDs that must reach terminal success before this runs. */
  dependsOn?: string[];
}

/**
 * Input for updating an existing WorkItem.
 */
export interface UpdateWorkItemInput {
  status?: WorkItemStatus;
  target?: string;
  result?: Record<string, unknown>;
  /** Worker-supplied structured output — see {@link WorkItem.output}. */
  output?: Record<string, unknown>;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

// ---------------------------------------------------------------------------
// Valid State Transitions
// ---------------------------------------------------------------------------

/**
 * Map of valid status transitions for WorkItems.
 *
 * Includes both the original simple flow (queued→running→done) and
 * the extended acceptance/verification flow (proposed→accepted→running→done_by_worker→verified).
 */
export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, ReadonlySet<WorkItemStatus>> = {
  queued:         new Set(['running', 'proposed', 'scheduled', 'cancelled']),
  scheduled:      new Set(['queued', 'cancelled']),
  proposed:       new Set(['accepted', 'rejected', 'cancelled']),
  accepted:       new Set(['running', 'cancelled']),
  // TRANS-2: `running → queued` legalised so TaskPoolService.releaseBack
  // (Reconciler abandon path, controller-initiated agent-busy releases)
  // can route through the guarded {@link transitionStatus} helper. Gated
  // in TRANSITION_PERMISSIONS to TL/orchestrator/system — agents cannot
  // self-revive a running claim.
  running:        new Set(['done', 'done_by_worker', 'failed', 'blocked', 'escalated', 'cancelled', 'queued']),
  blocked:        new Set(['queued', 'cancelled']),
  escalated:      new Set(['queued', 'cancelled']),
  done_by_worker: new Set(['verified', 'rejected']),
  verified:       new Set<WorkItemStatus>(),
  rejected:       new Set(['queued']),
  done:           new Set<WorkItemStatus>(),
  failed:         new Set(['queued']),
  cancelled:      new Set<WorkItemStatus>(),
};

/**
 * Statuses that require a disposition record before a WorkItem can be
 * considered dealt with.
 *
 * These are exactly the statuses that are neither terminal
 * ({@link TERMINAL_WORK_ITEM_STATUSES}) nor able to reach a terminal state —
 * their only outbound edge is `→ queued`. That combination is what makes them
 * strand: every consumer treats them as finished (see
 * {@link SLA_TERMINAL_WORK_ITEM_STATUSES}) while the state machine does not.
 *
 * Derived rather than hand-listed so a future `WorkItemStatus` with the same
 * shape is covered automatically instead of silently stranding.
 */
export const DISPOSITION_REQUIRED_STATUSES: ReadonlySet<WorkItemStatus> = new Set(
  (Object.keys(WORK_ITEM_TRANSITIONS) as WorkItemStatus[]).filter((status) => {
    if (TERMINAL_WORK_ITEM_STATUSES.has(status)) return false;
    const outbound = WORK_ITEM_TRANSITIONS[status];
    if (outbound.size === 0) return false;
    // No outbound edge reaches a strictly terminal status.
    return ![...outbound].some((next) => TERMINAL_WORK_ITEM_STATUSES.has(next));
  }),
);

// ---------------------------------------------------------------------------
// Transition Actors
// ---------------------------------------------------------------------------

/**
 * Who may act on a WorkItem's status. The {@link WorkItemOwner} roles plus
 * `owner` — the human who owns the Crewly install (dashboard / API token).
 * `owner` is never a WorkItem's `owner` field, so it is not a WorkItemOwner.
 */
export type TransitionActorRole = WorkItemOwner | 'owner';

/** All valid TransitionActorRole values. */
export const TRANSITION_ACTOR_ROLES: readonly TransitionActorRole[] = [
  ...WORK_ITEM_OWNERS,
  'owner',
] as const;

/**
 * The caller of a status transition.
 *
 * `role` decides which edges the caller may take at all; `session` is who
 * the caller is, and is what the verdict edges check (#813). A role alone is
 * a claim about trust posture; only a session can be the item's reviewer.
 */
export interface TransitionActor {
  /** Trust posture of the caller */
  role: TransitionActorRole;
  /** Agent session name, when the caller is an agent (resolved server-side) */
  session?: string;
  /** Server component or entry point that made the call, for the audit log */
  via?: string;
}

/** What callers may pass where an actor is expected: a full actor or a bare role. */
export type TransitionActorInput = TransitionActor | TransitionActorRole;

/**
 * Normalise an actor argument. Anything that is not a known role — including
 * `undefined`, `null` and `''` — yields `undefined`, which the gate refuses.
 * There is deliberately no default role (#813: a missing actor used to
 * become `'system'`, the most privileged role).
 *
 * @param input - Actor object, bare role, or nothing
 * @returns The normalised actor, or undefined when no valid actor was given
 *
 * @example
 * ```typescript
 * normalizeTransitionActor('system');                       // { role: 'system' }
 * normalizeTransitionActor({ role: 'team_lead', session }); // unchanged
 * normalizeTransitionActor(undefined);                      // undefined → refused
 * ```
 */
export function normalizeTransitionActor(
  input: TransitionActorInput | null | undefined,
): TransitionActor | undefined {
  if (input === null || input === undefined) return undefined;
  const actor: TransitionActor = typeof input === 'string' ? { role: input } : input;
  if (typeof actor !== 'object' || !(TRANSITION_ACTOR_ROLES as readonly string[]).includes(actor.role)) {
    return undefined;
  }
  const session = typeof actor.session === 'string' && actor.session.trim() ? actor.session.trim() : undefined;
  return { role: actor.role, ...(session ? { session } : {}), ...(actor.via ? { via: actor.via } : {}) };
}

/**
 * Render an actor for logs and error messages: `team_lead(sam-1)`,
 * `system[reconciler]`, `(none)`.
 *
 * @param actor - Normalised actor, or undefined
 * @returns A short human-readable label
 */
export function describeTransitionActor(actor: TransitionActor | undefined): string {
  if (!actor) return '(none)';
  return `${actor.role}${actor.session ? `(${actor.session})` : ''}${actor.via ? `[${actor.via}]` : ''}`;
}

// ---------------------------------------------------------------------------
// Review metadata (#813)
// ---------------------------------------------------------------------------

/**
 * `WorkItem.metadata` key naming the session that must review a
 * `done_by_worker` item, when set explicitly. Usually absent: the reviewer of
 * record is then the target of the item's review WorkItem
 * (`<id>:verify:<id>`), which the EventToWorkItemBridge routes to the
 * worker's own lead, else the orchestrator. TaskPoolService fills it from
 * there before calling the gate.
 */
export const WORK_ITEM_REVIEWER_KEY = 'reviewer';

/**
 * `WorkItem.metadata` key stamped when an overdue review was escalated to the
 * orchestrator. From then on the orchestrator may render the verdict too.
 */
export const REVIEW_ESCALATED_TO_ORC_KEY = 'verifyEscalatedAt';

/**
 * `WorkItem.metadata` key stamped when a review still open at the TTL was
 * escalated to the owner (replaces the old 24h auto-verify).
 */
export const REVIEW_ESCALATED_TO_OWNER_KEY = 'reviewOwnerEscalatedAt';

/** The two verdict edges: the only way out of `done_by_worker`. */
export const VERDICT_TRANSITIONS: ReadonlySet<string> = new Set([
  'done_by_worker→verified',
  'done_by_worker→rejected',
]);

/**
 * The session recorded as a WorkItem's reviewer, if any.
 *
 * @param item - WorkItem (only `metadata` is read)
 * @returns The reviewer session, or undefined
 */
export function getWorkItemReviewer(item: Pick<WorkItem, 'metadata'>): string | undefined {
  const v = item.metadata?.[WORK_ITEM_REVIEWER_KEY];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Transition Permissions (closed table)
// ---------------------------------------------------------------------------

/**
 * Which actor roles may take each legal status edge.
 *
 * Format: `from→to` key → set of allowed {@link TransitionActorRole}s.
 *
 * **Closed (#813).** Every edge in {@link WORK_ITEM_TRANSITIONS} has an entry;
 * an edge with no entry is refused for every actor, `system` included. The
 * test suite fails if a legal edge is added without an entry here. `system`
 * no longer bypasses the table: it is listed on the edges server code
 * actually takes, and is absent from `done_by_worker→verified` — no timer,
 * sweeper or fallback may certify work.
 *
 * The verdict edges ({@link VERDICT_TRANSITIONS}) additionally require the
 * caller to be the item's reviewer — see {@link checkTransitionPermission}.
 */
export const TRANSITION_PERMISSIONS: Record<string, ReadonlySet<TransitionActorRole>> = {
  // --- queued ---
  // Claims run server-side (claimFromPool → 'system'); agents / leads that
  // move an item straight to running keep the access they always had.
  'queued→running':           new Set(['agent', 'team_lead', 'orchestrator', 'system']),
  // Only TL or orchestrator can propose tasks
  'queued→proposed':          new Set(['team_lead', 'orchestrator']),
  // Mission executor defers an item to a future slot
  'queued→scheduled':         new Set(['team_lead', 'orchestrator', 'system']),
  'queued→cancelled':         new Set(['team_lead', 'orchestrator', 'owner', 'system']),
  // --- scheduled ---
  'scheduled→queued':         new Set(['team_lead', 'orchestrator', 'system']),
  'scheduled→cancelled':      new Set(['team_lead', 'orchestrator', 'owner', 'system']),
  // --- proposed ---
  // Only the assigned agent can accept or reject a proposal
  'proposed→accepted':        new Set(['agent']),
  'proposed→rejected':        new Set(['agent']),
  'proposed→cancelled':       new Set(['team_lead', 'orchestrator', 'owner', 'system']),
  // --- accepted ---
  'accepted→running':         new Set(['agent', 'system']),
  'accepted→cancelled':       new Set(['team_lead', 'orchestrator', 'owner', 'system']),
  // --- running ---
  // Simple done — allowed for agents (simple tasks) and system (reconciler)
  'running→done':             new Set(['agent', 'system', 'orchestrator']),
  // Only the assigned agent can report completion
  'running→done_by_worker':   new Set(['agent']),
  'running→failed':           new Set(['agent', 'system']),
  'running→blocked':          new Set(['agent', 'team_lead', 'orchestrator', 'system']),
  // Only the assigned agent can escalate
  'running→escalated':        new Set(['agent']),
  'running→cancelled':        new Set(['team_lead', 'orchestrator', 'owner', 'system']),
  // TRANS-2: running→queued (releaseBack abandon path). Reconciler revoke and
  // TL manual release are the legitimate callers; agents cannot self-revive a
  // running claim by re-queueing it.
  'running→queued':           new Set(['team_lead', 'orchestrator', 'system']),
  // --- blocked / escalated ---
  // blocked→queued (dependency-resolution path) — resolveBlockedDependents
  // runs as system.
  'blocked→queued':           new Set(['team_lead', 'orchestrator', 'system']),
  'blocked→cancelled':        new Set(['team_lead', 'orchestrator', 'owner', 'system']),
  'escalated→queued':         new Set(['team_lead', 'orchestrator', 'system']),
  'escalated→cancelled':      new Set(['team_lead', 'orchestrator', 'owner', 'system']),
  // --- verdicts (identity-checked, see checkTransitionPermission) ---
  // No 'system': work is verified only by its reviewer.
  'done_by_worker→verified':  new Set(['team_lead', 'orchestrator', 'owner']),
  // 'system' may send work BACK (SLA escalation timeout); it may never pass it.
  'done_by_worker→rejected':  new Set(['team_lead', 'orchestrator', 'owner', 'system']),
  // --- re-queue after a verdict / failure ---
  // TRANS-1 F-F: the agent whose work was rejected or failed cannot re-queue
  // itself; BRIDGE-1 retry policy (system) and a lead are the legal paths.
  'rejected→queued':          new Set(['team_lead', 'orchestrator', 'system']),
  'failed→queued':            new Set(['team_lead', 'orchestrator', 'system']),
};

/** Why a transition was refused. */
export type TransitionDenialReason =
  | 'missing_actor'
  | 'unlisted_transition'
  | 'role_not_permitted'
  | 'not_reviewer'
  | 'self_review';

/** Outcome of {@link checkTransitionPermission}. */
export type TransitionDecision =
  | { allowed: true }
  | { allowed: false; reason: TransitionDenialReason; detail: string };

/**
 * Whether `actor` is the rightful reviewer of a `done_by_worker` item.
 *
 * - `owner`: always — the owner is the last escalation step.
 * - `orchestrator`: when it is the recorded reviewer, when no reviewer was
 *   recorded (items that predate reviewer stamping — the orchestrator is the
 *   escalation reviewer), or once the review was escalated.
 * - `team_lead`: only as the recorded reviewer, identified by session.
 * - `system` (rejection only — the table keeps it off `verified`).
 *
 * @param item - The WorkItem under review
 * @param actor - The normalised caller
 * @returns A decision (never throws)
 */
function checkReviewer(
  item: Pick<WorkItem, 'target' | 'metadata'>,
  actor: TransitionActor,
): TransitionDecision {
  if (actor.role === 'owner' || actor.role === 'system') return { allowed: true };
  const reviewer = getWorkItemReviewer(item);
  if (actor.session && item.target && actor.session === item.target) {
    return { allowed: false, reason: 'self_review', detail: `${actor.session} is the worker on this item and cannot review its own work` };
  }
  if (actor.session && reviewer && actor.session === reviewer) return { allowed: true };
  if (actor.role === 'orchestrator') {
    const escalated =
      !!item.metadata?.[REVIEW_ESCALATED_TO_ORC_KEY] || !!item.metadata?.[REVIEW_ESCALATED_TO_OWNER_KEY];
    if (!reviewer || escalated) return { allowed: true };
  }
  return {
    allowed: false,
    reason: 'not_reviewer',
    detail: reviewer
      ? `only the reviewer (${reviewer}), the orchestrator after escalation, or the owner may render this verdict`
      : 'no reviewer is recorded; only the orchestrator or the owner may render this verdict',
  };
}

/**
 * Decide whether `actor` may move `item` to status `to`.
 *
 * Deny by default (#813):
 * 1. No actor → refused (`missing_actor`). There is no default role.
 * 2. Edge not in {@link TRANSITION_PERMISSIONS} → refused for everyone
 *    (`unlisted_transition`).
 * 3. Role not listed for the edge → refused (`role_not_permitted`).
 * 4. Verdict edges ({@link VERDICT_TRANSITIONS}) also require the caller to
 *    be the item's reviewer, and never the worker itself.
 *
 * Checks permission only — state-machine legality is
 * {@link isValidWorkItemTransition}'s job.
 *
 * @param item - The WorkItem (its current `status`, `target`, `metadata` are read)
 * @param to - Desired next status
 * @param actorInput - The caller (object or bare role); undefined is refused
 * @returns `{ allowed: true }` or the refusal reason and a readable detail
 *
 * @example
 * ```typescript
 * checkTransitionPermission(wi, 'verified', { role: 'team_lead', session: 'sam' });
 * // → { allowed: true } only when wi.metadata.reviewer === 'sam'
 * ```
 */
export function checkTransitionPermission(
  item: Pick<WorkItem, 'status' | 'target' | 'metadata'>,
  to: WorkItemStatus,
  actorInput: TransitionActorInput | null | undefined,
): TransitionDecision {
  const actor = normalizeTransitionActor(actorInput);
  const key = `${item.status}→${to}`;
  if (!actor) {
    return { allowed: false, reason: 'missing_actor', detail: `no actor supplied for ${key}` };
  }
  const allowed = TRANSITION_PERMISSIONS[key];
  if (!allowed) {
    return { allowed: false, reason: 'unlisted_transition', detail: `${key} is not in the transition permission table` };
  }
  if (!allowed.has(actor.role)) {
    return { allowed: false, reason: 'role_not_permitted', detail: `role '${actor.role}' may not perform ${key}` };
  }
  if (VERDICT_TRANSITIONS.has(key)) return checkReviewer(item, actor);
  return { allowed: true };
}

/**
 * Boolean form of {@link checkTransitionPermission}.
 *
 * @param item - The WorkItem (its current status, target and metadata)
 * @param to - Desired next status
 * @param actor - The caller; undefined is refused
 * @returns True if the actor may perform the transition
 */
export function isTransitionPermitted(
  item: Pick<WorkItem, 'status' | 'target' | 'metadata'>,
  to: WorkItemStatus,
  actor: TransitionActorInput | null | undefined,
): boolean {
  return checkTransitionPermission(item, to, actor).allowed;
}

/**
 * Thrown when a transition is legal in the state machine but the actor may
 * not take it. Controllers map it to HTTP 403.
 */
export class ForbiddenTransitionError extends Error {
  /** Machine-readable refusal reason */
  readonly reason: TransitionDenialReason;

  /**
   * @param workItemId - The WorkItem the transition was attempted on
   * @param from - Its current status
   * @param to - The refused target status
   * @param actor - Who attempted it
   * @param decision - The refusal from {@link checkTransitionPermission}
   */
  constructor(
    workItemId: string,
    from: WorkItemStatus,
    to: WorkItemStatus,
    actor: TransitionActor | undefined,
    decision: Extract<TransitionDecision, { allowed: false }>,
  ) {
    super(
      `Forbidden transition for WorkItem ${workItemId}: actor='${describeTransitionActor(actor)}' ` +
        `not permitted to perform ${from} → ${to} (${decision.reason}: ${decision.detail}).`,
    );
    this.name = 'ForbiddenTransitionError';
    this.reason = decision.reason;
  }
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Checks whether a string is a valid WorkItemType.
 *
 * @param value - The string to check
 * @returns True if value is a valid WorkItemType
 */
export function isValidWorkItemType(value: string): value is WorkItemType {
  return (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

/**
 * Checks whether a string is a valid WorkItemStatus.
 *
 * @param value - The string to check
 * @returns True if value is a valid WorkItemStatus
 */
export function isValidWorkItemStatus(value: string): value is WorkItemStatus {
  return (WORK_ITEM_STATUSES as readonly string[]).includes(value);
}

/**
 * Checks whether a string is a valid WorkItemOwner.
 *
 * @param value - The string to check
 * @returns True if value is a valid WorkItemOwner
 */
export function isValidWorkItemOwner(value: string): value is WorkItemOwner {
  return (WORK_ITEM_OWNERS as readonly string[]).includes(value);
}

/**
 * Checks whether a WorkItem status transition is valid.
 *
 * @param from - Current status
 * @param to - Desired next status
 * @returns True if transition is allowed
 */
export function isValidWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return WORK_ITEM_TRANSITIONS[from].has(to);
}

/**
 * Validates that an unknown value is structurally a valid WorkItem.
 *
 * @param value - Unknown value to validate
 * @returns True if value conforms to the WorkItem interface
 */
export function isWorkItem(value: unknown): value is WorkItem {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.type === 'string' &&
    isValidWorkItemType(obj.type) &&
    typeof obj.owner === 'string' &&
    isValidWorkItemOwner(obj.owner) &&
    typeof obj.title === 'string' &&
    typeof obj.status === 'string' &&
    isValidWorkItemStatus(obj.status) &&
    typeof obj.createdAt === 'string' &&
    typeof obj.retryCount === 'number' &&
    typeof obj.maxRetries === 'number'
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates CreateWorkItemInput and returns an array of error messages.
 *
 * @param input - The creation input to validate
 * @returns Array of validation error strings (empty = valid)
 */
export function validateCreateWorkItemInput(input: CreateWorkItemInput): string[] {
  const errors: string[] = [];
  if (!input.type || !isValidWorkItemType(input.type)) {
    errors.push(`type must be one of: ${WORK_ITEM_TYPES.join(', ')}`);
  }
  if (!input.owner || !isValidWorkItemOwner(input.owner)) {
    errors.push(`owner must be one of: ${WORK_ITEM_OWNERS.join(', ')}`);
  }
  if (!input.title || typeof input.title !== 'string') {
    errors.push('title is required and must be a non-empty string');
  }
  if (input.scheduledAt) {
    const d = new Date(input.scheduledAt);
    if (isNaN(d.getTime())) {
      errors.push('scheduledAt must be a valid ISO8601 date string');
    }
  }
  if (input.maxRetries !== undefined && (input.maxRetries < 0 || !Number.isInteger(input.maxRetries))) {
    errors.push('maxRetries must be a non-negative integer');
  }
  if (input.briefMarkdown !== undefined) {
    if (typeof input.briefMarkdown !== 'string') {
      errors.push('briefMarkdown must be a string');
    } else if (Buffer.byteLength(input.briefMarkdown, 'utf8') > MAX_BRIEF_MARKDOWN_BYTES) {
      errors.push(
        `briefMarkdown exceeds ${MAX_BRIEF_MARKDOWN_BYTES} bytes; trim or attach via metadata reference`,
      );
    }
  }
  return errors;
}

/**
 * Maximum size of {@link WorkItem.briefMarkdown} in UTF-8 bytes.
 *
 * Replaces the legacy `.crewly/tasks/delegated/*.md` files which had no
 * size cap. 16 KB is enough to carry a typical TL-to-worker dispatch
 * brief (~ 3000 words) plus a small spec excerpt; longer briefs should
 * reference an attached file via `metadata` rather than inlining the
 * full body so `pool.json` stays human-readable and `atomicWriteJson`
 * stays fast.
 */
export const MAX_BRIEF_MARKDOWN_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Default max retries for WorkItems. */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Creates a new WorkItem with sensible defaults.
 *
 * @param input - Required and optional creation fields
 * @returns A fully populated WorkItem object
 *
 * @example
 * ```typescript
 * const workItem = createWorkItem({
 *   type: 'delegate',
 *   owner: 'agent',
 *   target: 'crewly-product-leo-member-n',
 *   title: 'Implement TaskPoolService',
 * });
 * ```
 */
export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const now = new Date().toISOString();
  const hasDeps = Array.isArray(input.dependsOn) && input.dependsOn.length > 0;
  const hasSchedule = !!input.scheduledAt;
  // Dep gating wins over schedule — a blocked item should not be queued or
  // fired by a cron. The dependency resolver will promote it to 'queued' once
  // all upstream items reach terminal success.
  const initialStatus: WorkItemStatus = hasDeps
    ? 'blocked'
    : hasSchedule
      ? 'scheduled'
      : 'queued';
  return {
    id: input.id ?? uuidv4(),
    requestId: input.requestId,
    parentWorkItemId: input.parentWorkItemId,
    type: input.type,
    owner: input.owner,
    target: input.target,
    title: input.title,
    description: input.description,
    briefMarkdown: input.briefMarkdown,
    status: initialStatus,
    scheduledAt: input.scheduledAt,
    createdAt: now,
    retryCount: 0,
    maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
    triggerId: input.triggerId,
    projectTaskId: input.projectTaskId,
    missionId: input.missionId,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    metadata: input.metadata,
    dependsOn: hasDeps ? [...input.dependsOn!] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Task Contract (TL → Worker delegation protocol)
// ---------------------------------------------------------------------------

/**
 * Structured contract that a Team Lead sends when delegating a task.
 *
 * The worker must confirm understanding before execution begins.
 * This prevents misaligned expectations and reduces costly late-stage rework.
 */
export interface TaskContract {
  /** What the worker must achieve */
  goal: string;
  /** What is explicitly out of scope */
  nonGoals: string[];
  /** Specific, verifiable conditions for "done" */
  acceptanceCriteria: string[];
  /** Expected deliverable structure */
  outputFormat: string;
  /** When to stop and report back (time, complexity, risk thresholds) */
  cutoffConditions: string[];
  /** Situations that require immediate escalation */
  escalationTriggers: string[];
  /** If true, worker may skip classification gate and proceed directly */
  preClassified?: boolean;
}

/**
 * Worker's structured confirmation of a received Task Contract.
 *
 * TL reviews this before allowing the task to enter 'running' status.
 */
export interface TaskAcceptance {
  /** Worker's understanding of the goal */
  understoodGoal: string;
  /** How the worker intends to accomplish it */
  plannedApproach: string;
  /** What the worker will NOT do */
  outOfScope: string[];
  /** Risks or blockers the worker foresees */
  identifiedRisks: string[];
}

// ---------------------------------------------------------------------------
// Alignment Request (Worker → TL/Human escalation protocol)
// ---------------------------------------------------------------------------

/** Target for an alignment request. */
export type AlignmentTarget = 'team_lead' | 'human';

/**
 * Reason categories for why a worker cannot proceed with direct execution.
 */
export type AlignmentReason =
  | 'scope_change'           // Task requires more work than described
  | 'priority_resource'      // Needs to interrupt others or use expensive resources
  | 'ownership_authority'    // Requires access/decisions beyond worker authority
  | 'ambiguity_tradeoff'    // Multiple valid approaches, unclear requirements
  | 'high_risk';            // Could affect stability, security, compliance

/**
 * A structured escalation from a worker who determines that direct execution
 * is inappropriate for the current task.
 *
 * This replaces unstructured "I'm blocked" messages with actionable information
 * that enables fast decision-making by TLs or humans.
 */
export interface AlignmentRequest {
  /** The task the worker was asked to do */
  currentTask: string;
  /** What triggered the escalation */
  discoveredIssue: string;
  /** Category of alignment needed */
  reason: AlignmentReason;
  /** Why direct execution is inappropriate */
  whyCannotExecute: string;
  /** 2-3 possible approaches with impact analysis */
  options: AlignmentOption[];
  /** Worker's recommended path */
  recommendation: string;
  /** What the TL/human needs to decide */
  decisionNeeded: string;
  /** Who should make this decision */
  target: AlignmentTarget;
}

/**
 * A single option in an Alignment Request.
 */
export interface AlignmentOption {
  /** Brief description of the approach */
  description: string;
  /** Expected positive outcomes */
  pros: string[];
  /** Expected negative outcomes or risks */
  cons: string[];
  /** Estimated effort/impact level */
  impact: 'low' | 'medium' | 'high';
}
