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
import type {
  TicketKind,
  TicketOrigin,
  TicketAcceptance,
  TicketReceipt,
  TicketDiscussionEntry,
  TicketChatRef,
  TicketReply,
} from './ticket.types.js';

// ---------------------------------------------------------------------------
// Enums & Literals
// ---------------------------------------------------------------------------

/**
 * Lifecycle statuses for a Request.
 *
 * State machine:
 *   open → ready                  (planner created WorkItems)
 *   open/ready → running          (ticket being worked on directly)
 *   open/ready → waiting_confirmation (ticket answered directly, owner to accept)
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
 * Request priority. `urgent` (P0) was added by the ticket loop; the others
 * map to P1 (high), P2 (normal), P3 (low).
 */
export type RequestPriority = 'low' | 'normal' | 'high' | 'urgent';

/** All valid {@link RequestPriority} values. */
export const REQUEST_PRIORITIES: readonly RequestPriority[] = ['low', 'normal', 'high', 'urgent'] as const;

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
  | 'growth'
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
  'growth',
  'other',
] as const;

/**
 * Intent complexity level — determines planning strategy.
 * - L0: trivial, no WorkItem needed (direct response)
 * - L1: single WorkItem sufficient
 * - L2: multiple WorkItems, potentially parallel
 * - L3: OKR/sprint-scoped initiative — multi-day, multi-PR, ORC owns the
 *   plan personally and recursively decomposes into L2 over time.
 *   v0 routes L3 the same as L2 internally; the *label* is preserved so
 *   future routing-split lands without retro-classifying.
 */
export type IntentLevel = 'L0' | 'L1' | 'L2' | 'L3';

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
  priority: RequestPriority;
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

  // --- Ticket loop (specs/ticket-loop.md) — all optional so old files stay valid ---

  /** Monotonic per data dir; displayed `TKT-{n}` */
  ticketNumber?: number;
  /** issue / feature / idea (default feature) */
  kind?: TicketKind;
  /** Where it was said and by whom */
  origin?: TicketOrigin;
  /** Agent session that owns it (pre-filled for a DM) */
  assignee?: string;
  /** Acceptance criteria (Phase 2) */
  acceptance?: TicketAcceptance[];
  /** Times the owner sent it back (Phase 2) */
  rejectCount?: number;
  /** Times work was submitted for review (Phase 2) */
  submitCount?: number;
  /** Where the receipt was posted, so it can be edited */
  receipt?: TicketReceipt;
  /** Follow-ups in the ticket's thread */
  discussion?: TicketDiscussionEntry[];
  /** The chat-v2 turn that opened it (Phase 2: matches agent answers) */
  chatRef?: TicketChatRef;
  /** Latest agent answer in its thread (Phase 2) */
  reply?: TicketReply;
  /** When it last went to 待验收 (ISO-8601) */
  submittedAt?: string;
  /** Times the answering agent was nudged to ask the owner again */
  nudgeCount?: number;
  /** When it was last nudged (ISO-8601) */
  lastNudgeAt?: string;
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
  priority?: RequestPriority;
  requiresConfirmation?: boolean;
  confirmationReason?: string;
  missionId?: string;
  intentLevel?: IntentLevel;
  intentCategory?: IntentCategory;
  tags?: string[];
  /** Ticket fields (set by TicketIntakeService) */
  ticketNumber?: number;
  kind?: TicketKind;
  origin?: TicketOrigin;
  assignee?: string;
}

/**
 * Input for updating an existing Request.
 * All fields optional — only provided fields are updated.
 */
export interface UpdateRequestInput {
  title?: string;
  description?: string;
  status?: RequestStatus;
  priority?: RequestPriority;
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
  /** Ticket fields */
  kind?: TicketKind;
  assignee?: string;
  receipt?: TicketReceipt;
  discussion?: TicketDiscussionEntry[];
  acceptance?: TicketAcceptance[];
  rejectCount?: number;
  submitCount?: number;
  submittedAt?: string;
  chatRef?: TicketChatRef;
  reply?: TicketReply;
  nudgeCount?: number;
  lastNudgeAt?: string;
  /**
   * The owner accepted it (or it was auto-accepted). Without this a ticket
   * that needs review cannot become `done`: the update is turned into
   * `waiting_confirmation` instead. Not stored.
   */
  accepted?: boolean;
}

// ---------------------------------------------------------------------------
// Valid State Transitions
// ---------------------------------------------------------------------------

/**
 * Map of valid status transitions.
 * Key = current status, Value = set of allowed next statuses.
 */
export const REQUEST_TRANSITIONS: Record<RequestStatus, ReadonlySet<RequestStatus>> = {
  // → waiting_confirmation: a ticket answered directly, now with the owner.
  open: new Set(['ready', 'running', 'waiting_confirmation', 'done', 'cancelled']),
  ready: new Set(['running', 'waiting_confirmation', 'cancelled']),
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
  if (input.priority && !(REQUEST_PRIORITIES as readonly string[]).includes(input.priority)) {
    errors.push(`priority must be one of: ${REQUEST_PRIORITIES.join(', ')}`);
  }
  if (input.ticketNumber !== undefined && (!Number.isInteger(input.ticketNumber) || input.ticketNumber < 1)) {
    errors.push('ticketNumber must be a positive integer');
  }
  if (input.intentCategory && !isValidIntentCategory(input.intentCategory)) {
    errors.push(`intentCategory must be one of: ${INTENT_CATEGORIES.join(', ')}`);
  }
  if (input.intentLevel && !['L0', 'L1', 'L2', 'L3'].includes(input.intentLevel)) {
    errors.push('intentLevel must be one of: L0, L1, L2, L3');
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
    ...(input.ticketNumber !== undefined ? { ticketNumber: input.ticketNumber } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.assignee ? { assignee: input.assignee } : {}),
  };
}
