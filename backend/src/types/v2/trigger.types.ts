/**
 * V2 Trigger Type Definitions
 *
 * Triggers unify v1's ScheduledMessage, CronTask, and EventSubscription
 * into a single time/signal/compound mechanism that creates or wakes WorkItems.
 *
 * @module types/v2/trigger.types
 */

import { v4 as uuidv4 } from 'uuid';
import type { WorkItem } from './work-item.types.js';

// ---------------------------------------------------------------------------
// Enums & Literals
// ---------------------------------------------------------------------------

/**
 * What kind of trigger.
 * - time: Cron expression or one-shot delay (replaces ScheduledMessage + CronTask)
 * - signal: Agent event, webhook, or status change (replaces EventSubscription)
 * - compound: Multiple conditions combined with AND/OR
 */
export type TriggerType = 'time' | 'signal' | 'compound';

/** All valid TriggerType values. */
export const TRIGGER_TYPES: readonly TriggerType[] = ['time', 'signal', 'compound'] as const;

/**
 * Trigger lifecycle statuses.
 */
export type TriggerStatus =
  | 'active'
  | 'paused'
  | 'exhausted'   // maxFires reached
  | 'cancelled';

/** All valid TriggerStatus values. */
export const TRIGGER_STATUSES: readonly TriggerStatus[] = [
  'active',
  'paused',
  'exhausted',
  'cancelled',
] as const;

// ---------------------------------------------------------------------------
// Trigger Configuration Types
// ---------------------------------------------------------------------------

/**
 * Time trigger: fires on schedule or after delay.
 * Replaces v1 ScheduledMessage + CronTask.
 */
export interface TimeTriggerConfig {
  type: 'time';
  /** Cron expression for recurring (e.g., "0 9 * * 1") */
  cronExpression?: string;
  /** IANA timezone (e.g., "America/New_York") */
  timezone?: string;
  /** One-shot delay in ms from creation */
  delayMs?: number;
  /** Fixed ISO8601 datetime for one-shot */
  fireAt?: string;
}

/**
 * Signal trigger: fires when an event matches.
 * Replaces v1 EventSubscription.
 */
export interface SignalTriggerConfig {
  type: 'signal';
  /** Event type to watch for (e.g., "agent:idle", "task:completed") */
  eventType: string;
  /** Optional filter — only fire if event payload matches */
  filter?: Record<string, unknown>;
  /**
   * Origin filter for cross-machine event triggers (autonomy_v1.f1).
   * - `'local'` (default): only fire on events emitted on this device.
   * - `'remote'`: only fire on events relayed from a paired device via
   *   Cloud Relay.
   * - `'any'`: fire on both local and remote events.
   *
   * Defaults to `'local'` at evaluation when unset — backward compatible
   * for every existing trigger. Defaulting to `'any'` would silently flip
   * every trigger's scope, the exact regression the WIRE-1 V4 veto was
   * designed to prevent (Arch verdict 2026-04-28 Q2 LOCKED).
   */
  source?: 'local' | 'remote' | 'any';
}

/**
 * Compound trigger: combines sub-conditions with AND/OR.
 */
export interface CompoundTriggerConfig {
  type: 'compound';
  /** How sub-conditions combine */
  operator: 'and' | 'or';
  /** Sub-trigger configs */
  conditions: (TimeTriggerConfig | SignalTriggerConfig)[];
}

/**
 * Discriminated union of all trigger configuration types.
 */
export type TriggerConfig = TimeTriggerConfig | SignalTriggerConfig | CompoundTriggerConfig;

// ---------------------------------------------------------------------------
// Trigger Action
// ---------------------------------------------------------------------------

/**
 * What happens when a trigger fires. At least one field should be set.
 */
export interface TriggerAction {
  /** Create a new WorkItem from this template */
  createWorkItem?: Partial<WorkItem>;
  /** Wake (re-queue) an existing WorkItem by ID */
  wakeWorkItemId?: string;
  /** Send a message to a session */
  sendMessage?: { target: string; message: string };
  /** Run the Reconciler */
  runReconciler?: boolean;
}

// ---------------------------------------------------------------------------
// Core Interface
// ---------------------------------------------------------------------------

/**
 * A Trigger monitors time or signals and produces actions (WorkItems, messages, reconciliation).
 *
 * Triggers are the unified replacement for v1's ScheduledMessage, CronTask,
 * and EventSubscription patterns.
 */
export interface Trigger {
  /** UUID v4 */
  id: string;
  /** What kind of trigger */
  type: TriggerType;
  /** Trigger-specific configuration */
  config: TriggerConfig;
  /** What action to take when the trigger fires */
  action: TriggerAction;
  /** Lifecycle status */
  status: TriggerStatus;
  /** Who created this trigger */
  createdBy: 'user' | 'orchestrator' | 'system' | 'mission';
  /** ISO8601 timestamps */
  createdAt: string;
  lastFiredAt?: string;
  nextFireAt?: string;
  /** Number of times this trigger has fired */
  fireCount: number;
  /** Maximum fires before auto-disable (undefined = unlimited) */
  maxFires?: number;
  /** Auto-cancel after N consecutive idle fires (v1 lesson from issue #131) */
  maxIdleFires: number;
  /** Current count of consecutive idle fires */
  consecutiveIdleFires: number;
  /**
   * Owning team, if this trigger was provisioned from a Team's `triggers` spec.
   * Used by {@link TeamTriggerReconciler} to look up and cancel team-scoped
   * triggers without touching user/mission/system triggers.
   */
  teamId?: string;
  /**
   * Stable name set by the provisioner (e.g. `"youtube-monthly-kickoff"`).
   * The reconciler uses (teamId, name) as the identity key so editing
   * `Team.triggers[].cronExpression` replaces instead of duplicating.
   */
  name?: string;
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

/**
 * Input for creating a new Trigger.
 */
export interface CreateTriggerInput {
  type: TriggerType;
  config: TriggerConfig;
  action: TriggerAction;
  createdBy: 'user' | 'orchestrator' | 'system' | 'mission';
  maxFires?: number;
  maxIdleFires?: number;
  /** Optional owning team (team-scoped triggers) */
  teamId?: string;
  /** Optional stable name for reconciliation-by-identity */
  name?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max idle fires before auto-cancel. From v1 issue #131 lesson. */
export const DEFAULT_MAX_IDLE_FIRES = 3;

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Checks whether a string is a valid TriggerType.
 *
 * @param value - The string to check
 * @returns True if value is a valid TriggerType
 */
export function isValidTriggerType(value: string): value is TriggerType {
  return (TRIGGER_TYPES as readonly string[]).includes(value);
}

/**
 * Checks whether a string is a valid TriggerStatus.
 *
 * @param value - The string to check
 * @returns True if value is a valid TriggerStatus
 */
export function isValidTriggerStatus(value: string): value is TriggerStatus {
  return (TRIGGER_STATUSES as readonly string[]).includes(value);
}

/**
 * Validates that a trigger config's type field matches its parent type.
 *
 * @param config - The config to validate
 * @returns True if the config is internally consistent
 */
export function isValidTriggerConfig(config: TriggerConfig): boolean {
  if (!config || typeof config !== 'object') return false;
  switch (config.type) {
    case 'time':
      return !!(config.cronExpression || config.delayMs || config.fireAt);
    case 'signal': {
      if (typeof config.eventType !== 'string' || config.eventType.length === 0) return false;
      // autonomy_v1.f1: source filter is optional but, when present, must be
      // one of the three accepted values. Reject malformed values instead of
      // silently coercing to default (which would mask typos at registration).
      if (config.source !== undefined && config.source !== 'local' && config.source !== 'remote' && config.source !== 'any') {
        return false;
      }
      return true;
    }
    case 'compound':
      return (
        (config.operator === 'and' || config.operator === 'or') &&
        Array.isArray(config.conditions) &&
        config.conditions.length > 0
      );
    default:
      return false;
  }
}

/**
 * Validates that an unknown value is structurally a valid Trigger.
 *
 * @param value - Unknown value to validate
 * @returns True if value conforms to the Trigger interface
 */
export function isTrigger(value: unknown): value is Trigger {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.type === 'string' &&
    isValidTriggerType(obj.type) &&
    typeof obj.status === 'string' &&
    isValidTriggerStatus(obj.status) &&
    typeof obj.createdAt === 'string' &&
    typeof obj.fireCount === 'number' &&
    typeof obj.maxIdleFires === 'number'
  );
}

/**
 * Checks whether a TriggerAction has at least one action defined.
 *
 * @param action - The action to validate
 * @returns True if at least one action field is set
 */
export function isValidTriggerAction(action: TriggerAction): boolean {
  if (!action || typeof action !== 'object') return false;
  return !!(
    action.createWorkItem ||
    action.wakeWorkItemId ||
    action.sendMessage ||
    action.runReconciler
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates CreateTriggerInput and returns an array of error messages.
 *
 * @param input - The creation input to validate
 * @returns Array of validation error strings (empty = valid)
 */
export function validateCreateTriggerInput(input: CreateTriggerInput): string[] {
  const errors: string[] = [];
  if (!input.type || !isValidTriggerType(input.type)) {
    errors.push(`type must be one of: ${TRIGGER_TYPES.join(', ')}`);
  }
  if (!input.config) {
    errors.push('config is required');
  } else if (!isValidTriggerConfig(input.config)) {
    errors.push('config is invalid for the given trigger type');
  }
  if (!input.action) {
    errors.push('action is required');
  } else if (!isValidTriggerAction(input.action)) {
    errors.push('action must have at least one action field set');
  }
  if (!input.createdBy) {
    errors.push('createdBy is required');
  }
  if (input.maxFires !== undefined && (input.maxFires < 1 || !Number.isInteger(input.maxFires))) {
    errors.push('maxFires must be a positive integer');
  }
  if (input.maxIdleFires !== undefined && (input.maxIdleFires < 1 || !Number.isInteger(input.maxIdleFires))) {
    errors.push('maxIdleFires must be a positive integer');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new Trigger with sensible defaults.
 *
 * @param input - Required and optional creation fields
 * @returns A fully populated Trigger object
 *
 * @example
 * ```typescript
 * const trigger = createTrigger({
 *   type: 'time',
 *   config: { type: 'time', cronExpression: '0 9 * * 1' },
 *   action: { runReconciler: true },
 *   createdBy: 'system',
 * });
 * ```
 */
export function createTrigger(input: CreateTriggerInput): Trigger {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    type: input.type,
    config: input.config,
    action: input.action,
    status: 'active',
    createdBy: input.createdBy,
    createdAt: now,
    fireCount: 0,
    maxFires: input.maxFires,
    maxIdleFires: input.maxIdleFires ?? DEFAULT_MAX_IDLE_FIRES,
    consecutiveIdleFires: 0,
    teamId: input.teamId,
    name: input.name,
  };
}
