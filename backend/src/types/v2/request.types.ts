/**
 * V2 Request Type Definitions
 *
 * A Request represents a single user goal — "one thing the user wants
 * the system to accomplish." Requests are the primary user-facing object
 * in V2 architecture.
 *
 * @module types/v2/request.types
 */

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Enums & Literals
// ---------------------------------------------------------------------------

/**
 * Lifecycle statuses for a Request.
 *
 * State machine:
 *   open → ready                  (planner created WorkItems)
 *   open → cancelled              (user cancelled before planning)
 *   ready → running               (first WorkItem started)
 *   running → blocked             (all active WorkItems blocked/failed)
 *   running → waiting_confirmation (all done, requiresConfirmation=true)
 *   running → done                (all done, requiresConfirmation=false)
 *   blocked → running             (WorkItem unblocked or new WorkItem created)
 *   waiting_confirmation → done   (user confirmed)
 *   waiting_confirmation → running (user rejected, new WorkItems needed)
 *   any → cancelled               (user explicitly cancels)
 */
export type RequestStatus =
  | 'open'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'waiting_confirmation'
  | 'done'
  | 'cancelled';

/** All valid RequestStatus values as a readonly array. */
export const REQUEST_STATUSES: readonly RequestStatus[] = [
  'open',
  'ready',
  'running',
  'blocked',
  'waiting_confirmation',
  'done',
  'cancelled',
] as const;

/** Terminal statuses — no further transitions allowed (except cancel). */
export const TERMINAL_REQUEST_STATUSES: ReadonlySet<RequestStatus> = new Set([
  'done',
  'cancelled',
]);

/**
 * Memory Phase 1 — REQ-X (orc-restart recovery filter).
 *
 * Returns `true` if a Request has been **fulfilled** in the strong sense
 * — final reply sent AND state persisted — and therefore should be EXCLUDED
 * from agent-restart recovery briefings to avoid the "orc re-replies after
 * restart" bug.
 *
 * Triple-gate (any one missing → return `false` = not fulfilled):
 *   1. `status === 'done'`     — state machine reached terminal-success
 *   2. `completedAt` is set    — RequestService.update recorded a wall-clock close
 *   3. `result` is non-empty   — orc actually generated and committed a reply
 *
 * Why each gate matters (per Sam's REQ-X risk surface):
 *   - Status alone is insufficient: a worker could mutate status but crash
 *     before completedAt/result land → over-recovery acceptable here.
 *   - `cancelled` is deliberately NOT counted as fulfilled. A user cancellation
 *     is terminal but no reply was sent — surfacing it on restart is correct
 *     (over-recovery, per the conservative bias).
 *   - `waiting_confirmation` is deliberately NOT counted as fulfilled. The
 *     work is done but the orc is still on the hook to handle the confirm/reject.
 *
 * False is the safe default — better to surface a maybe-fulfilled request
 * (worst case: orc re-acknowledges to user once) than silently drop one
 * that needed continuation.
 *
 * @param req - Request to evaluate
 * @returns `true` only if the Request is unambiguously fulfilled
 *
 * @example
 * ```typescript
 * if (!isRequestFulfilled(req)) {
 *   // Surface in active-work briefing
 * }
 * ```
 */
export function isRequestFulfilled(req: Request): boolean {
  return (
    req.status === 'done' &&
    typeof req.completedAt === 'string' &&
    req.completedAt.length > 0 &&
    typeof req.result === 'string' &&
    req.result.length > 0
  );
}

/**
 * Intent category carried from v1 IntentTask system.
 */
export type IntentCategory =
  | 'query'
  | 'code_change'
  | 'debugging'
  | 'deployment'
  | 'research'
  | 'review'
  | 'planning'
  | 'communication'
  | 'other';

/** All valid IntentCategory values. */
export const INTENT_CATEGORIES: readonly IntentCategory[] = [
  'query',
  'code_change',
  'debugging',
  'deployment',
  'research',
  'review',
  'planning',
  'communication',
  'other',
] as const;

/**
 * Intent complexity level — determines planning strategy.
 * - L0: trivial, no WorkItem needed (direct response)
 * - L1: single WorkItem sufficient
 * - L2: multiple WorkItems, potentially parallel
 */
export type IntentLevel = 'L0' | 'L1' | 'L2';

// ---------------------------------------------------------------------------
// Core Interface
// ---------------------------------------------------------------------------

/**
 * A user-level request representing a single goal.
 *
 * Requests are the primary unit of work visible to users.
 * Each Request is fulfilled through one or more WorkItems.
 */
export interface Request {
  /** UUID v4 */
  id: string;
  /** ConversationItem that originated this Request */
  sourceConversationItemId: string;
  /** Human-readable title (generated from intent parsing) */
  title: string;
  /** Detailed description of what the user wants */
  description: string;
  /** Lifecycle status */
  status: RequestStatus;
  /** User-assigned or auto-classified priority */
  priority: 'low' | 'normal' | 'high';
  /** Whether completion requires explicit user confirmation */
  requiresConfirmation: boolean;
  /** Reason confirmation is needed (shown to user) */
  confirmationReason?: string;
  /** WorkItem IDs created to fulfill this Request */
  workItemIds: string[];
  /** Optional link to a Mission this Request contributes to */
  missionId?: string;
  /** Optional link to a ProjectTask created from this Request */
  projectTaskId?: string;
  /** Intent complexity level */
  intentLevel: IntentLevel;
  /** Intent category */
  intentCategory: IntentCategory;
  /** Tags for filtering */
  tags: string[];
  /** ISO8601 timestamps */
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Result summary (set on completion) */
  result?: string;
  /** Total token usage across all WorkItems */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Total cost in USD */
  totalCost: number;
  /** Session name of the agent that handled this Request directly (no WorkItem delegation) */
  ownerAgent?: string;
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

/**
 * Input for creating a new Request.
 * Fields with defaults are optional.
 */
export interface CreateRequestInput {
  sourceConversationItemId: string;
  title: string;
  description: string;
  priority?: 'low' | 'normal' | 'high';
  requiresConfirmation?: boolean;
  confirmationReason?: string;
  missionId?: string;
  intentLevel?: IntentLevel;
  intentCategory?: IntentCategory;
  tags?: string[];
}

/**
 * Input for updating an existing Request.
 * All fields optional — only provided fields are updated.
 */
export interface UpdateRequestInput {
  title?: string;
  description?: string;
  status?: RequestStatus;
  priority?: 'low' | 'normal' | 'high';
  requiresConfirmation?: boolean;
  confirmationReason?: string;
  missionId?: string;
  projectTaskId?: string;
  result?: string;
  tags?: string[];
  /** Token roll-up fields — incremented by V3.1 task completion hooks */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: number;
  /** Session name of the agent that handled this Request directly */
  ownerAgent?: string;
}

// ---------------------------------------------------------------------------
// Valid State Transitions
// ---------------------------------------------------------------------------

/**
 * Map of valid status transitions.
 * Key = current status, Value = set of allowed next statuses.
 */
export const REQUEST_TRANSITIONS: Record<RequestStatus, ReadonlySet<RequestStatus>> = {
  open: new Set(['ready', 'done', 'cancelled']),
  ready: new Set(['running', 'cancelled']),
  running: new Set(['blocked', 'waiting_confirmation', 'done', 'cancelled']),
  blocked: new Set(['running', 'cancelled']),
  waiting_confirmation: new Set(['done', 'running', 'cancelled']),
  done: new Set<RequestStatus>(),
  cancelled: new Set<RequestStatus>(),
};

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Checks whether a string is a valid RequestStatus.
 *
 * @param value - The string to check
 * @returns True if value is a valid RequestStatus
 */
export function isValidRequestStatus(value: string): value is RequestStatus {
  return (REQUEST_STATUSES as readonly string[]).includes(value);
}

/**
 * Checks whether a string is a valid IntentCategory.
 *
 * @param value - The string to check
 * @returns True if value is a valid IntentCategory
 */
export function isValidIntentCategory(value: string): value is IntentCategory {
  return (INTENT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Checks whether a status transition is valid according to the state machine.
 *
 * @param from - Current status
 * @param to - Desired next status
 * @returns True if transition is allowed
 */
export function isValidRequestTransition(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].has(to);
}

/**
 * Validates that an object is structurally a valid Request.
 *
 * @param value - Unknown value to validate
 * @returns True if value conforms to the Request interface
 */
export function isRequest(value: unknown): value is Request {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.sourceConversationItemId === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.status === 'string' &&
    isValidRequestStatus(obj.status) &&
    typeof obj.createdAt === 'string' &&
    typeof obj.updatedAt === 'string' &&
    Array.isArray(obj.workItemIds)
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates CreateRequestInput and returns an array of error messages.
 * Empty array means input is valid.
 *
 * @param input - The creation input to validate
 * @returns Array of validation error strings (empty = valid)
 */
export function validateCreateRequestInput(input: CreateRequestInput): string[] {
  const errors: string[] = [];
  if (!input.sourceConversationItemId || typeof input.sourceConversationItemId !== 'string') {
    errors.push('sourceConversationItemId is required and must be a string');
  }
  if (!input.title || typeof input.title !== 'string') {
    errors.push('title is required and must be a non-empty string');
  }
  if (!input.description || typeof input.description !== 'string') {
    errors.push('description is required and must be a non-empty string');
  }
  if (input.priority && !['low', 'normal', 'high'].includes(input.priority)) {
    errors.push('priority must be one of: low, normal, high');
  }
  if (input.intentCategory && !isValidIntentCategory(input.intentCategory)) {
    errors.push(`intentCategory must be one of: ${INTENT_CATEGORIES.join(', ')}`);
  }
  if (input.intentLevel && !['L0', 'L1', 'L2'].includes(input.intentLevel)) {
    errors.push('intentLevel must be one of: L0, L1, L2');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new Request with sensible defaults.
 *
 * @param input - Required and optional creation fields
 * @returns A fully populated Request object
 *
 * @example
 * ```typescript
 * const request = createRequest({
 *   sourceConversationItemId: 'conv-123',
 *   title: 'Deploy staging',
 *   description: 'Deploy the current build to staging env',
 * });
 * ```
 */
export function createRequest(input: CreateRequestInput): Request {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    sourceConversationItemId: input.sourceConversationItemId,
    title: input.title,
    description: input.description,
    status: 'open',
    priority: input.priority ?? 'normal',
    requiresConfirmation: input.requiresConfirmation ?? false,
    confirmationReason: input.confirmationReason,
    workItemIds: [],
    missionId: input.missionId,
    intentLevel: input.intentLevel ?? 'L1',
    intentCategory: input.intentCategory ?? 'other',
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
  };
}
