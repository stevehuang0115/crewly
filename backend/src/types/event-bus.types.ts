/**
 * Event Bus Types Module
 *
 * Type definitions for the agent event bus (pub/sub) system.
 * Agents publish lifecycle events (idle, busy, active, inactive),
 * and subscribers receive notifications when matching events occur.
 *
 * @module types/event-bus
 */

// =============================================================================
// Enums and Constants
// =============================================================================

/**
 * Valid agent lifecycle event types
 */
export const EVENT_TYPES = [
  // Agent lifecycle events
  'agent:status_changed',
  'agent:idle',
  'agent:busy',
  'agent:active',
  'agent:inactive',
  'agent:context_warning',
  'agent:context_critical',
  'agent:oauth_url',

  // Hierarchical task events
  'task:submitted',
  'task:accepted',
  'task:working',
  'task:input_required',
  'task:verification_requested',
  'task:completed',
  'task:failed',
  'task:cancelled',

  // Architecture Upgrade: Task Event Chain (Phase 6)
  'task:assigned',
  'task:done',
  'task:verified',
  'task:blocked',
  'task:needs_clarification',
  'team:all_tasks_done',

  // BRIDGE-1: worker / verification lifecycle events the EventToWorkItemBridge
  // consumes to auto-create verification, retry, and review WorkItems.
  // `task:done_by_worker` is published by `submitForVerification`; `task:rejected`
  // is published by `verifyItem` when a TL rejects a worker's submission.
  'task:done_by_worker',
  'task:rejected',

  // BRIDGE-1: mission-level events the bridge fans out into review WorkItems.
  // `mission:review_due` is REVIEW-1's cadence-driven trigger; `mission:stale`
  // and `mission:replanned` cover the missing autonomy hooks the doc review
  // called out (see autonomy_v1 §4 item 5).
  'mission:review_due',
  'mission:stale',
  'mission:replanned',

  // INBOUND-1: Request lifecycle events. `request:created` is published by
  // RequestService.create() so the SLA subscriber can auto-create a
  // `respond_to_user` WorkItem for the orchestrator when an inbound user
  // message lands without a corresponding WI on the orc's plate.
  // `request:sla_breached` is published by RequestSlaSubscriber when the
  // 5-minute SLA timer fires and the respond_to_user WI is still not done.
  'request:created',
  'request:sla_breached',

  // Hierarchy communication events
  'hierarchy:escalation',
  'hierarchy:delegation',
  'hierarchy:report_up',
] as const;

/**
 * An agent lifecycle event type
 */
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Event priority levels used for subscriber filtering.
 * Critical events are delivered immediately; info events may be suppressed
 * or debounced for subscribers that opt into critical-only mode.
 */
export type EventPriority = 'critical' | 'info';

/**
 * Critical event types that the orchestrator MUST receive.
 * These indicate actionable state changes: task completions, failures,
 * agent crashes, context exhaustion, and escalations.
 */
export const CRITICAL_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'task:completed',
  'task:failed',
  'task:cancelled',
  'task:input_required',
  'agent:idle',
  'agent:inactive',
  'agent:context_critical',
  'hierarchy:escalation',
  // Architecture Upgrade: task event chain — these drive workflow progression
  'task:done',
  'task:verified',
  'task:blocked',
  'task:needs_clarification',
  'task:assigned',
  'team:all_tasks_done',
  // BRIDGE-1: worker submission, TL rejection, and mission-level reviews are
  // all queue-creating events — they MUST not be debounced into oblivion.
  'task:done_by_worker',
  'task:rejected',
  'mission:review_due',
  'mission:stale',
  'mission:replanned',
  // INBOUND-1: a fresh user request and an SLA breach are both
  // user-visible — must bypass any debounce.
  'request:created',
  'request:sla_breached',
]);

/**
 * Info event types that are noisy for the orchestrator terminal.
 * Repeated idle/busy toggles, minor status changes, and routine hierarchy
 * updates fall here. Subscribers can still opt-in via explicit subscription.
 */
export const INFO_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'agent:status_changed',
  'agent:busy',
  'agent:active',
  'agent:context_warning',
  'agent:oauth_url',
  'task:submitted',
  'task:accepted',
  'task:working',
  'task:verification_requested',
  'hierarchy:delegation',
  'hierarchy:report_up',
]);

/**
 * Check if an event type is critical (requires immediate delivery).
 *
 * @param eventType - The event type to check
 * @returns True if the event type is critical
 */
export function isCriticalEventType(eventType: EventType | string): boolean {
  return CRITICAL_EVENT_TYPES.has(eventType as EventType);
}

/**
 * Get the list of critical event types as an array (for subscription creation).
 *
 * @returns Array of critical EventType values
 */
export function getCriticalEventTypes(): EventType[] {
  return Array.from(CRITICAL_EVENT_TYPES);
}

/**
 * Fields that can trigger events when changed
 */
export type ChangedField = 'agentStatus' | 'workingStatus' | 'contextUsage' | 'oauthUrl' | 'taskStatus' | 'hierarchyAction';

// =============================================================================
// Event Interfaces
// =============================================================================

/**
 * An agent lifecycle event published to the event bus
 */
export interface AgentEvent {
  /** Unique event ID */
  id: string;

  /** Type of event */
  type: EventType;

  /** ISO timestamp when event occurred */
  timestamp: string;

  /** Team ID where the change occurred */
  teamId: string;

  /** Human-readable team name */
  teamName: string;

  /** Team member ID */
  memberId: string;

  /** Human-readable member name */
  memberName: string;

  /** PTY session name of the agent */
  sessionName: string;

  /** Previous field value */
  previousValue: string;

  /** New field value */
  newValue: string;

  /** Which field changed to trigger this event */
  changedField: ChangedField;

  // === Hierarchy metadata (optional, used for task/hierarchy events) ===

  /** Task ID associated with this event (for task:* and hierarchy:* events) */
  taskId?: string;

  /** Hierarchy level of the member who triggered the event */
  hierarchyLevel?: number;

  /** Parent member ID of the member who triggered the event */
  parentMemberId?: string;

  // === BRIDGE-1 autonomy correlation fields (optional) ===
  // The EventToWorkItemBridge needs the source WorkItem and Mission ids to
  // build deterministic idempotency keys + look up `triggerSource` /
  // `retryCount` from storage. Publishers fill these where the value is
  // already in scope (e.g. `submitForVerification` has `workItemId`
  // trivially); bridge falls back to a storage lookup keyed on `taskId`
  // when both are absent. Adding two optional fields was preferred over a
  // discriminated union to avoid forcing every existing publish call site
  // through a type-level rewrite.

  /**
   * Source WorkItem id for `task:*` events the BRIDGE-1 service consumes.
   * Optional everywhere except inside the bridge handlers, which require
   * either this or `taskId` to resolve the source WI.
   */
  workItemId?: string;

  /**
   * Mission id for `mission:*` events. Required for mission events to be
   * actionable downstream; optional on task events where a mission link
   * exists incidentally (e.g. the source WI has `missionId`).
   */
  missionId?: string;

  /**
   * Request id for `request:*` events (INBOUND-1). Carries the Request the
   * SLA subscriber will key its `respond_to_user` WorkItem on. Optional for
   * other event types — never read outside the request handlers.
   */
  requestId?: string;
}

// =============================================================================
// Subscription Interfaces
// =============================================================================

/**
 * Filter criteria for matching events to subscriptions
 */
export interface EventFilter {
  /** Match events for a specific session name */
  sessionName?: string;

  /** Match events for a specific team member ID */
  memberId?: string;

  /** Match events for a specific team ID */
  teamId?: string;

  /** Match events for a specific task ID (hierarchy task events) */
  taskId?: string;

  /** Match events at a specific hierarchy level (0=orc, 1=TL, 2=worker) */
  hierarchyLevel?: number;

  /** Match events from subordinates of a specific parent member */
  parentMemberId?: string;
}

/**
 * A stored event subscription
 */
export interface EventSubscription {
  /** Unique subscription ID */
  id: string;

  /** Event type(s) to subscribe to */
  eventType: EventType | EventType[];

  /** Filter criteria for matching events */
  filter: EventFilter;

  /** If true, subscription is removed after first match */
  oneShot: boolean;

  /** Session name of the subscriber (who receives notifications) */
  subscriberSession: string;

  /** ISO timestamp when subscription was created */
  createdAt: string;

  /** ISO timestamp when subscription expires (optional) */
  expiresAt?: string;

  /** Custom notification template with placeholders */
  messageTemplate?: string;
}

/**
 * Input for creating a new subscription
 */
export interface CreateSubscriptionInput {
  /** Event type(s) to subscribe to */
  eventType: EventType | EventType[];

  /** Filter criteria for matching events */
  filter: EventFilter;

  /** If true, subscription is removed after first match (default: true) */
  oneShot?: boolean;

  /** Time-to-live in minutes (default: 30) */
  ttlMinutes?: number;

  /** Session name of the subscriber */
  subscriberSession: string;

  /** Custom notification template with placeholders */
  messageTemplate?: string;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a value is a valid EventType
 *
 * @param value - Value to check
 * @returns True if value is a valid EventType
 */
export function isValidEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_TYPES.includes(value as EventType);
}

/**
 * Check if an object is a valid CreateSubscriptionInput
 *
 * @param value - Value to check
 * @returns True if value is a valid CreateSubscriptionInput
 */
export function isValidCreateSubscriptionInput(value: unknown): value is CreateSubscriptionInput {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const input = value as Record<string, unknown>;

  // Validate eventType: single string or array of strings
  if (Array.isArray(input.eventType)) {
    if (input.eventType.length === 0) {
      return false;
    }
    if (!input.eventType.every((t: unknown) => isValidEventType(t))) {
      return false;
    }
  } else if (!isValidEventType(input.eventType)) {
    return false;
  }

  // Validate filter
  if (!input.filter || typeof input.filter !== 'object') {
    return false;
  }

  // Validate subscriberSession
  if (typeof input.subscriberSession !== 'string' || input.subscriberSession.trim().length === 0) {
    return false;
  }

  // Validate optional ttlMinutes
  if (input.ttlMinutes !== undefined) {
    if (typeof input.ttlMinutes !== 'number' || input.ttlMinutes <= 0) {
      return false;
    }
  }

  // Validate optional oneShot
  if (input.oneShot !== undefined && typeof input.oneShot !== 'boolean') {
    return false;
  }

  // Validate optional messageTemplate
  if (input.messageTemplate !== undefined && typeof input.messageTemplate !== 'string') {
    return false;
  }

  return true;
}
