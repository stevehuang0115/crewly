/**
 * Trigger Type Definitions (Frontend)
 *
 * Mirrors backend v2/trigger.types for use in the Triggers UI.
 *
 * @module types/trigger.types
 */

// ---------------------------------------------------------------------------
// Config Types
// ---------------------------------------------------------------------------

export interface TimeTriggerConfig {
  type: 'time';
  cronExpression?: string;
  timezone?: string;
  delayMs?: number;
  fireAt?: string;
}

export interface SignalTriggerConfig {
  type: 'signal';
  eventType: string;
  filter?: Record<string, unknown>;
}

export interface CompoundTriggerConfig {
  type: 'compound';
  operator: 'and' | 'or';
  conditions: (TimeTriggerConfig | SignalTriggerConfig)[];
}

export type TriggerConfig = TimeTriggerConfig | SignalTriggerConfig | CompoundTriggerConfig;

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export interface TriggerAction {
  createWorkItem?: Record<string, unknown>;
  wakeWorkItemId?: string;
  sendMessage?: { target: string; message: string };
  runReconciler?: boolean;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export type TriggerType = 'time' | 'signal' | 'compound';
export type TriggerStatus = 'active' | 'paused' | 'exhausted' | 'cancelled';

/**
 * Who created a trigger. `agent` triggers name the session in
 * `createdBySession`; `system` / `delegate-task` are harness-internal.
 */
export type TriggerCreator = 'user' | 'orchestrator' | 'agent' | 'mission' | 'delegate-task' | 'system';

/** What the last fire did, as reported by the backend. */
export interface TriggerLastFireResult {
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
  workItemId?: string;
  at: string;
}

export interface Trigger {
  id: string;
  type: TriggerType;
  config: TriggerConfig;
  action: TriggerAction;
  status: TriggerStatus;
  createdBy: TriggerCreator;
  /** Agent session that created it, when an agent did */
  createdBySession?: string;
  /** Harness-internal plumbing — hidden unless "show system" is on */
  internal?: boolean;
  createdAt: string;
  lastFiredAt?: string;
  nextFireAt?: string;
  fireCount: number;
  maxFires?: number;
  maxIdleFires: number;
  consecutiveIdleFires: number;
  /** Owning team */
  teamId?: string;
  /** Stable name (e.g. "daily-ops-nightly-2230") */
  name?: string;
  /** What the last fire did */
  lastFireResult?: TriggerLastFireResult;
  /** When the team lead was told the trigger is about to run out */
  expiryNoticeSentAt?: string;
  /** List endpoint only: projected final fire of a capped recurring trigger */
  projectedLastFireAt?: string;
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

export interface CreateTriggerInput {
  type: TriggerType;
  config: TriggerConfig;
  action: TriggerAction;
  createdBy: TriggerCreator;
  name?: string;
  maxFires?: number;
  maxIdleFires?: number;
}

// ---------------------------------------------------------------------------
// EventBus Subscription (read-only display in Triggers UI)
// ---------------------------------------------------------------------------

export interface EventSubscription {
  id: string;
  eventType: string;
  filter: Record<string, unknown>;
  oneShot: boolean;
  subscriberSession: string;
  createdAt: string;
  expiresAt?: string;
}

export interface TriggerEngineStatus {
  running: boolean;
  total: number;
  byStatus: Record<TriggerStatus, number>;
  byType: Record<string, number>;
  /** Active, owner-facing recurring triggers */
  recurringActive?: number;
}
