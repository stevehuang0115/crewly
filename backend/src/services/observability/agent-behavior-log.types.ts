/**
 * Agent Behavior Log — event type definitions.
 *
 * The behavior log is a single-table append-only event store backing
 * Crewly's minimal internal metrics. Each entry is a strongly-typed
 * domain event the platform records for later analysis (delegation
 * rates, escalation patterns, Slack delivery failures, prompt size
 * trends).
 *
 * Schema lives in `observability-db.ts`. Service API in
 * `agent-behavior-log.service.ts`.
 *
 * @module services/observability/agent-behavior-log.types
 */

// ---------------------------------------------------------------------------
// Event-type discriminator
// ---------------------------------------------------------------------------

/**
 * Canonical event type strings stored in the `event_type` column of
 * `agent_behavior_log`. Adding a new event type is additive — append a
 * new constant here AND extend `BehaviorLogEvent` below; do not rename
 * existing values (downstream digests rely on stable keys).
 */
export const BEHAVIOR_LOG_EVENT_TYPES = {
  /** An agent took a top-level action (delegate, implement, ask_human, send_slack, ...). */
  AGENT_ACTION: 'agent.action',
  /** An agent escalated a decision/issue to a higher level in the chain. */
  AGENT_ESCALATION: 'agent.escalation',
  /** A Slack message could not be delivered (intended-but-not-sent or API failure). */
  SLACK_DELIVERY_FAILED: 'slack.delivery.failed',
  /** Snapshot of an agent's compiled prompt size at session/start build time. */
  PROMPT_SIZE_BYTES: 'prompt.size.bytes',
} as const;

/** Union of all canonical event-type strings. */
export type BehaviorLogEventType =
  (typeof BEHAVIOR_LOG_EVENT_TYPES)[keyof typeof BEHAVIOR_LOG_EVENT_TYPES];

// ---------------------------------------------------------------------------
// Per-event payloads
// ---------------------------------------------------------------------------

/**
 * Vocabulary for `AgentActionEvent.actionType`. Open-ended on purpose —
 * extending this list is additive, but the four current values cover
 * the P0 success-metric needs (delegate-first rate, etc.).
 */
export type AgentActionType =
  | 'delegate'
  | 'implement'
  | 'ask_human'
  | 'send_slack'
  | 'review'
  | 'verify'
  | 'other';

/**
 * One row of `agent_behavior_log` for a top-level agent action.
 * Fields beyond agent/actionType are optional; callers should provide
 * `taskId` and `details` whenever known to enrich downstream digests.
 */
export interface AgentActionEvent {
  type: typeof BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION;
  /** Session name of the agent that performed the action. */
  agent: string;
  /** Canonical action vocabulary entry. */
  actionType: AgentActionType;
  /** Optional related task id (request / work item / spec ticket). */
  taskId?: string;
  /** Optional free-form structured details. Stored as JSON. */
  details?: Record<string, unknown>;
}

/** One row for an agent → upstream escalation. */
export interface AgentEscalationEvent {
  type: typeof BEHAVIOR_LOG_EVENT_TYPES.AGENT_ESCALATION;
  /** Session name doing the escalating. */
  escalatingAgent: string;
  /** Where the escalation went (session name, "owner", "orchestrator", ...). */
  escalatedTo: string;
  /** Short reason — kept short on purpose for digest readability. */
  reason: string;
  /** Optional related task id. */
  taskId?: string;
  /** Optional structured payload for richer review later. */
  details?: Record<string, unknown>;
}

/** One row for a Slack delivery that did not land. */
export interface SlackDeliveryFailedEvent {
  type: typeof BEHAVIOR_LOG_EVENT_TYPES.SLACK_DELIVERY_FAILED;
  /** Session name that intended to send. */
  agent: string;
  /** Slack thread or channel id (free-form — `channel:thread` is fine). */
  thread: string;
  /** Reason: 'no_reply_called' | 'api_error' | 'timeout' | other free string. */
  reason: string;
  /** Optional structured payload (response body, status code, etc.). */
  details?: Record<string, unknown>;
}

/** One row for a prompt-size sample. */
export interface PromptSizeBytesEvent {
  type: typeof BEHAVIOR_LOG_EVENT_TYPES.PROMPT_SIZE_BYTES;
  /** Session name whose prompt was measured. */
  agent: string;
  /** UTF-8 byte size of the compiled prompt. */
  bytes: number;
  /** Optional session id discriminator (e.g. registration id). */
  sessionId?: string;
  /** Optional structured payload (e.g. component byte breakdown). */
  details?: Record<string, unknown>;
}

/** Discriminated union of every behavior-log event the service accepts. */
export type BehaviorLogEvent =
  | AgentActionEvent
  | AgentEscalationEvent
  | SlackDeliveryFailedEvent
  | PromptSizeBytesEvent;

// ---------------------------------------------------------------------------
// Storage row shape (mirrors the `agent_behavior_log` table)
// ---------------------------------------------------------------------------

/**
 * Raw row layout for `agent_behavior_log`. The service translates a
 * `BehaviorLogEvent` into this shape at insert time and back at read
 * time. Direct callers should generally use the service API rather than
 * constructing rows by hand.
 */
export interface BehaviorLogRow {
  /** Auto-increment primary key, populated by SQLite. */
  id: number;
  /** ms-since-epoch (UTC) of the recording. */
  ts: number;
  /** Discriminator string — one of `BehaviorLogEventType`. */
  event_type: BehaviorLogEventType;
  /** Primary actor (agent session name) when applicable. May be empty. */
  agent: string;
  /** Optional secondary subject (escalatedTo, thread, etc.). May be empty. */
  subject: string;
  /** Optional related task id. May be empty. */
  task_id: string;
  /** Optional short reason / actionType / etc. May be empty. */
  reason: string;
  /** Numeric metric (e.g. prompt byte size); 0 for non-numeric events. */
  amount: number;
  /** JSON-encoded details payload; '{}' when no details supplied. */
  details_json: string;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Return true if `value` looks like a known `BehaviorLogEventType`.
 *
 * Useful at deserialisation boundaries (e.g. when querying historic
 * rows) to narrow a generic string into the discriminator union.
 *
 * @param value - any string to test
 */
export function isBehaviorLogEventType(value: string): value is BehaviorLogEventType {
  return (
    Object.values(BEHAVIOR_LOG_EVENT_TYPES).includes(value as BehaviorLogEventType)
  );
}
