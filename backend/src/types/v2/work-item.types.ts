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
  /** Detailed instructions or description */
  description?: string;
  /** Lifecycle status */
  status: WorkItemStatus;
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
  /** Number of retry attempts so far */
  retryCount: number;
  /** Maximum retries before permanent failure */
  maxRetries: number;
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
  requestId?: string;
  parentWorkItemId?: string;
  type: WorkItemType;
  owner: WorkItemOwner;
  target?: string;
  title: string;
  description?: string;
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
  running:        new Set(['done', 'done_by_worker', 'failed', 'blocked', 'escalated', 'cancelled']),
  blocked:        new Set(['queued', 'cancelled']),
  escalated:      new Set(['queued', 'cancelled']),
  done_by_worker: new Set(['verified', 'rejected']),
  verified:       new Set<WorkItemStatus>(),
  rejected:       new Set(['queued']),
  done:           new Set<WorkItemStatus>(),
  failed:         new Set(['queued']),
  cancelled:      new Set<WorkItemStatus>(),
};

// ---------------------------------------------------------------------------
// Role-Based Transition Permissions
// ---------------------------------------------------------------------------

/**
 * Defines which roles are allowed to trigger specific status transitions.
 *
 * Format: `from→to` key maps to a set of allowed WorkItemOwner roles.
 * If a transition is not listed here, any role may trigger it (backward compatible).
 * The 'system' role (reconciler) can always trigger any valid transition.
 */
export const TRANSITION_PERMISSIONS: Record<string, ReadonlySet<WorkItemOwner>> = {
  // Only TL or orchestrator can propose tasks
  'queued→proposed':          new Set(['team_lead', 'orchestrator']),
  // Only the assigned agent can accept or reject a proposal
  'proposed→accepted':        new Set(['agent']),
  'proposed→rejected':        new Set(['agent']),
  // Only the assigned agent can report completion
  'running→done_by_worker':   new Set(['agent']),
  // Only the assigned agent can escalate
  'running→escalated':        new Set(['agent']),
  // Only TL can verify or reject worker output
  'done_by_worker→verified':  new Set(['team_lead']),
  'done_by_worker→rejected':  new Set(['team_lead']),
  // Simple done — allowed for agents (simple tasks) and system (reconciler)
  'running→done':             new Set(['agent', 'system', 'orchestrator']),
  // TRANS-1 F-F: only TL / orchestrator / system may re-queue a rejected
  // WorkItem. Without this entry, the backward-compat default-allow at
  // isTransitionPermitted line ~322 lets any actor (including the agent
  // whose work was rejected) re-queue itself — a self-revival hazard.
  // BRIDGE-1 retry policy is the canonical re-queueing path; manual
  // TL action (or system reconciler) is the only other legal path.
  'rejected→queued':          new Set(['team_lead', 'orchestrator', 'system']),
  // failed→queued (BRIDGE-1 retry path) — same gate as rejected→queued.
  // Agent cannot self-resurrect a failed WorkItem.
  'failed→queued':            new Set(['team_lead', 'orchestrator', 'system']),
  // blocked→queued (dependency-resolution path) — system-only by
  // default. The TaskPoolService.resolveBlockedDependents() helper
  // is the canonical caller and runs as system.
  'blocked→queued':           new Set(['team_lead', 'orchestrator', 'system']),
};

/**
 * Checks whether a role is permitted to trigger a specific status transition.
 *
 * If no explicit permission is defined for a transition, it is considered
 * open to all roles (backward compatible). The 'system' role always has
 * permission for any valid transition.
 *
 * @param from - Current status
 * @param to - Desired next status
 * @param actorRole - Role of the agent/system attempting the transition
 * @returns True if the role is permitted to trigger this transition
 */
export function isTransitionPermitted(
  from: WorkItemStatus,
  to: WorkItemStatus,
  actorRole: WorkItemOwner,
): boolean {
  // System role can always transition
  if (actorRole === 'system') return true;

  const key = `${from}→${to}`;
  const allowed = TRANSITION_PERMISSIONS[key];

  // If no explicit permission defined, allow any role (backward compatible)
  if (!allowed) return true;

  return allowed.has(actorRole);
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
  return errors;
}

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
    id: uuidv4(),
    requestId: input.requestId,
    parentWorkItemId: input.parentWorkItemId,
    type: input.type,
    owner: input.owner,
    target: input.target,
    title: input.title,
    description: input.description,
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
