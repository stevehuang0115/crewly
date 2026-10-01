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

/**
 * Who created a trigger.
 *
 * - `user`: the owner (dashboard or a direct API call with no agent header),
 *   including triggers provisioned from a team's `triggers` spec.
 * - `orchestrator`: the orchestrator session.
 * - `agent`: a team member session (the session is in `createdBySession`).
 * - `mission`: a mission cadence.
 * - `delegate-task`: the delegate-task skill's post-dispatch fallback check.
 * - `system`: harness-internal automation (escalation sweep, …).
 *
 * Whether the owner should see a trigger by default is the separate
 * {@link Trigger.internal} flag — do not infer it from this field.
 */
export type TriggerCreator = 'user' | 'orchestrator' | 'agent' | 'mission' | 'delegate-task' | 'system';

/** All valid TriggerCreator values. */
export const TRIGGER_CREATORS: readonly TriggerCreator[] = [
  'user',
  'orchestrator',
  'agent',
  'mission',
  'delegate-task',
  'system',
] as const;

/**
 * What the last fire actually did, as reported by the action handler.
 * `ok` = the action ran, `skipped` = nothing to do (e.g. the same work item
 * is still open), `failed` = the action threw or could not be carried out.
 */
export interface TriggerFireOutcome {
  status: 'ok' | 'skipped' | 'failed';
  /** Short human-readable detail (error message, skip reason) */
  detail?: string;
  /** WorkItem created by this fire, when there was one */
  workItemId?: string;
}

/** A {@link TriggerFireOutcome} stamped with the fire time. */
export interface TriggerLastFireResult extends TriggerFireOutcome {
  /** ISO8601 time of the fire this result belongs to */
  at: string;
}

/**
 * Who owns a trigger's lifecycle. See {@link Trigger.managedBy}.
 */
export type TriggerManagedBy = 'team-spec' | 'agent';

/** All valid TriggerManagedBy values. */
export const TRIGGER_MANAGED_BY: readonly TriggerManagedBy[] = ['team-spec', 'agent'] as const;

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
  /** Who created this trigger. See {@link TriggerCreator}. */
  createdBy: TriggerCreator;
  /**
   * The agent session that created it (from `X-Agent-Session`), when an
   * agent did. Absent for owner- and harness-created triggers.
   */
  createdBySession?: string;
  /**
   * Harness-internal plumbing the owner does not schedule (escalation sweep,
   * delegate-task fallback checks, …). Hidden from the owner's Schedules page
   * by default. Always set on rows created or loaded by this version; the
   * boot migration ({@link classifyTriggerOnLoad}) fills it for older rows.
   */
  internal?: boolean;
  /** What the last fire did, when the action handler reported it. */
  lastFireResult?: TriggerLastFireResult;
  /**
   * When the team lead was told this recurring trigger is about to run out
   * of `maxFires`. Set once so the heads-up is not repeated every fire.
   */
  expiryNoticeSentAt?: string;
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
  /**
   * Who owns this trigger's lifecycle — the reconciler's deletion authority.
   *
   * - `'team-spec'`: provisioned by the TeamTriggerReconciler from
   *   `Team.triggers[]`. The reconciler may delete it when its name leaves
   *   the spec.
   * - `'agent'`: created by an agent skill (`schedule-followup`,
   *   `watch-for-event`, `delegate-task`), the API, or a mission. The
   *   reconciler never deletes these, even when they carry a `teamId` — it
   *   cannot prove it created them. `createTrigger` stamps this by default.
   * - absent: a row persisted before this field existed. Treated as
   *   `'agent'` everywhere, with one exception: the reconciler adopts an
   *   unmarked row whose name the team spec *currently* lists (otherwise
   *   the first boot after upgrade would duplicate every spec trigger).
   *
   * `teamId` + `name` alone are NOT ownership: agent follow-ups carry both.
   */
  managedBy?: TriggerManagedBy;
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
  createdBy: TriggerCreator;
  /** Agent session that created it (set by the API from X-Agent-Session) */
  createdBySession?: string;
  /**
   * Harness-internal? Defaults to true for `system` / `delegate-task`
   * creators and false otherwise (see {@link isInternalByDefault}).
   */
  internal?: boolean;
  maxFires?: number;
  maxIdleFires?: number;
  /** Optional owning team (team-scoped triggers) */
  teamId?: string;
  /** Lifecycle owner; defaults to `'agent'`. Only the reconciler passes `'team-spec'`. */
  managedBy?: TriggerManagedBy;
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
    case 'signal':
      return typeof config.eventType === 'string' && config.eventType.length > 0;
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
  } else if (!(TRIGGER_CREATORS as readonly string[]).includes(input.createdBy)) {
    errors.push(`createdBy must be one of: ${TRIGGER_CREATORS.join(', ')}`);
  }
  if (input.managedBy !== undefined && !(TRIGGER_MANAGED_BY as readonly string[]).includes(input.managedBy)) {
    errors.push(`managedBy must be one of: ${TRIGGER_MANAGED_BY.join(', ')}`);
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
    ...(input.createdBySession ? { createdBySession: input.createdBySession } : {}),
    internal: input.internal ?? isInternalByDefault(input.createdBy),
    createdAt: now,
    fireCount: 0,
    maxFires: input.maxFires,
    maxIdleFires: input.maxIdleFires ?? DEFAULT_MAX_IDLE_FIRES,
    consecutiveIdleFires: 0,
    teamId: input.teamId,
    name: input.name,
    managedBy: input.managedBy ?? 'agent',
  };
}

/**
 * Default for {@link Trigger.internal} when the creator did not say: the
 * harness's own creators (`system`, `delegate-task`) are internal, everyone
 * else's triggers are the owner's to see.
 *
 * @param createdBy - Who created the trigger
 * @returns True for harness-internal creators
 */
export function isInternalByDefault(createdBy: TriggerCreator): boolean {
  return createdBy === 'system' || createdBy === 'delegate-task';
}

/**
 * Whether a trigger repeats on a cron schedule (as opposed to a one-shot
 * delay/fireAt or a signal subscription).
 *
 * @param trigger - Any object carrying a trigger config
 * @returns True for a time trigger with a cron expression
 */
export function isRecurringTrigger(trigger: Pick<Trigger, 'config'>): boolean {
  return trigger.config?.type === 'time' && !!trigger.config.cronExpression;
}

/**
 * Whether the TeamTriggerReconciler owns this trigger's lifecycle.
 *
 * Only an explicit `'team-spec'` marker counts. A missing marker is a legacy
 * row and a `'agent'` marker is an agent-created trigger; neither may be
 * deleted as a spec orphan. Absence of proof is not proof of ownership.
 *
 * @param trigger - Any object carrying the optional `managedBy` field
 * @returns True only when `managedBy === 'team-spec'`
 */
export function isSpecManaged(trigger: Pick<Trigger, 'managedBy'>): boolean {
  return trigger.managedBy === 'team-spec';
}
