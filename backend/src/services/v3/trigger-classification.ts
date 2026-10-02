/**
 * Trigger classification — who created a trigger and whether it is
 * harness-internal plumbing the owner should not have to look at.
 *
 * Until 2026-09-30 the agent skills (`schedule-followup`, `watch-for-event`)
 * stamped every trigger `createdBy: 'system'`, and the Schedules page hid
 * everything `system`. The owner's own nightly report — an agent created it
 * for them — was therefore invisible. Two fixes live here:
 *
 * 1. {@link resolveTriggerCreator}: the API decides `createdBy` from the
 *    caller (the `X-Agent-Session` header, or the owner's dashboard) instead
 *    of trusting the body.
 * 2. {@link classifyTriggerOnLoad}: a one-time, per-row migration that fills
 *    the new explicit `internal` flag for rows persisted before it existed.
 *
 * @module services/v3/trigger-classification
 */

import {
  type Trigger,
  type TriggerCreator,
  isInternalByDefault,
  isRecurringTrigger,
} from '../../types/v2/trigger.types.js';

/** Name prefix of the harness's own named triggers (e.g. `system:escalation`). */
export const SYSTEM_TRIGGER_NAME_PREFIX = 'system:';

/** The creator fields the API stamps on a new trigger. */
export interface ResolvedTriggerCreator {
  createdBy: TriggerCreator;
  createdBySession?: string;
  internal: boolean;
}

/** What the API knows about the request when it creates a trigger. */
export interface TriggerCreatorContext {
  /** `createdBy` as sent in the body (untrusted) */
  requestedCreatedBy?: TriggerCreator;
  /** `internal` as sent in the body */
  requestedInternal?: boolean;
  /** `X-Agent-Session`, when an agent made the call */
  callerSession?: string;
  /** Whether the caller session is the orchestrator */
  callerIsOrchestrator?: boolean;
  /** Whether the call carried the owner-dashboard marker (and no agent session) */
  isOwnerDashboard?: boolean;
}

/**
 * Decide `createdBy` / `createdBySession` / `internal` for a trigger created
 * through the API.
 *
 * - An agent session header wins: the trigger belongs to that agent
 *   (`orchestrator` for the orc, `agent` otherwise), and it is owner-facing
 *   unless the body explicitly marks it internal. delegate-task's fallback
 *   check keeps `createdBy: 'delegate-task'` and is internal.
 * - The owner's dashboard is always `user` and never internal.
 * - Any other caller (server-to-server, curl without headers) keeps what it
 *   sent, defaulting to `user`.
 *
 * @param ctx - Request facts
 * @returns The creator fields to store
 */
export function resolveTriggerCreator(ctx: TriggerCreatorContext): ResolvedTriggerCreator {
  const requested = ctx.requestedCreatedBy;
  if (ctx.callerSession) {
    if (requested === 'delegate-task') {
      return {
        createdBy: 'delegate-task',
        createdBySession: ctx.callerSession,
        internal: ctx.requestedInternal ?? true,
      };
    }
    if (ctx.requestedInternal === true) {
      return {
        createdBy: requested ?? 'system',
        createdBySession: ctx.callerSession,
        internal: true,
      };
    }
    const createdBy: TriggerCreator = requested === 'mission'
      ? 'mission'
      : ctx.callerIsOrchestrator ? 'orchestrator' : 'agent';
    return { createdBy, createdBySession: ctx.callerSession, internal: false };
  }
  if (ctx.isOwnerDashboard) {
    return { createdBy: 'user', internal: false };
  }
  const createdBy = requested ?? 'user';
  return { createdBy, internal: ctx.requestedInternal ?? isInternalByDefault(createdBy) };
}

/**
 * Whether a trigger is unmistakably harness plumbing: the escalation sweep
 * (`runReconciler` / `system:*` names) or a delegate-task fallback check.
 *
 * A `fallback-*` name alone is not enough: team leads schedule their own
 * "fallback check on X" follow-ups through schedule-followup, and those are
 * reminders the owner may want to see. Only delegate-task's own rows
 * (`createdBy: 'delegate-task'`) are plumbing.
 *
 * @param trigger - Trigger to inspect
 * @returns True for harness-internal plumbing
 */
export function isHarnessPlumbing(
  trigger: Pick<Trigger, 'createdBy' | 'name' | 'action'>,
): boolean {
  if (trigger.createdBy === 'delegate-task') return true;
  if (trigger.action?.runReconciler) return true;
  return (trigger.name ?? '').startsWith(SYSTEM_TRIGGER_NAME_PREFIX);
}

/**
 * One-time migration for a row persisted before `internal` existed. Mutates
 * the trigger in place and reports whether it changed; rows that already
 * carry `internal` are left alone, which is what makes it one-time.
 *
 * Rules, in order:
 * 1. Harness plumbing ({@link isHarnessPlumbing}) → `internal: true`.
 * 2. A trigger with a `name`, a recurring cron, or a `teamId` plus a
 *    createWorkItem action is someone's real schedule or reminder →
 *    `internal: false`. If it was mislabelled `system` it becomes `user`
 *    (team-spec rows — the owner's team config) or `agent` (everything else:
 *    the agent skills were the only other writers of `system`).
 * 3. Anything else keeps its `createdBy` and gets the creator's default.
 *
 * @param trigger - Trigger loaded from disk (mutated)
 * @returns True when the row was changed and should be persisted
 */
export function classifyTriggerOnLoad(trigger: Trigger): boolean {
  if (typeof trigger.internal === 'boolean') return false;

  if (isHarnessPlumbing(trigger)) {
    trigger.internal = true;
    return true;
  }

  const ownerFacing =
    !!trigger.name ||
    isRecurringTrigger(trigger) ||
    (!!trigger.teamId && !!trigger.action?.createWorkItem);
  if (ownerFacing) {
    trigger.internal = false;
    if (trigger.createdBy === 'system') {
      trigger.createdBy = trigger.managedBy === 'team-spec' ? 'user' : 'agent';
    }
    return true;
  }

  trigger.internal = isInternalByDefault(trigger.createdBy);
  return true;
}
