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
 * State machine:
 *   queued → running          (executor picks up item)
 *   queued → scheduled        (has future scheduledAt)
 *   queued → cancelled        (parent cancelled)
 *   scheduled → queued        (scheduledAt reached, trigger fires)
 *   running → done            (execution succeeded)
 *   running → failed          (execution failed, retries exhausted)
 *   running → blocked         (waiting on dependency)
 *   running → cancelled       (parent cancelled during execution)
 *   blocked → queued          (dependency resolved, re-queue)
 *   failed → queued           (manual retry or reconciler recovery)
 */
export type WorkItemStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

/** All valid WorkItemStatus values. */
export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'queued',
  'scheduled',
  'running',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const;

/** Terminal statuses — no further transitions allowed. */
export const TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  'done',
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
 */
export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, ReadonlySet<WorkItemStatus>> = {
  queued: new Set(['running', 'scheduled', 'cancelled']),
  scheduled: new Set(['queued', 'cancelled']),
  running: new Set(['done', 'failed', 'blocked', 'cancelled']),
  blocked: new Set(['queued', 'cancelled']),
  failed: new Set(['queued']),
  done: new Set<WorkItemStatus>(),
  cancelled: new Set<WorkItemStatus>(),
};

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
  const hasSchedule = !!input.scheduledAt;
  return {
    id: uuidv4(),
    requestId: input.requestId,
    parentWorkItemId: input.parentWorkItemId,
    type: input.type,
    owner: input.owner,
    target: input.target,
    title: input.title,
    description: input.description,
    status: hasSchedule ? 'scheduled' : 'queued',
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
  };
}
