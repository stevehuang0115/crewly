/**
 * Trigger expiry heads-up — a recurring trigger with `maxFires` stops for
 * good once it has fired that many times, and nothing tells anyone. The
 * owner's nightly report (maxFires 58, daily) would have gone quiet around
 * 2026-11-24 without a word. These helpers decide when a trigger is close to
 * its last run and build the note that goes to its team lead, who renews it
 * or asks the owner. Nothing here renews a trigger.
 *
 * @module services/v3/trigger-expiry
 */

import type { Trigger } from '../../types/v2/trigger.types.js';
import { isRecurringTrigger } from '../../types/v2/trigger.types.js';
import { getNextRunTime } from '../workflow/cron-task.service.js';
import { TRIGGER_ENGINE_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { Team } from '../../types/index.js';
import { pickTeamLead } from '../../utils/team.utils.js';

/**
 * Fires left before a trigger exhausts, or undefined when it is unlimited.
 *
 * @param trigger - Trigger to inspect
 * @returns `maxFires - fireCount` (never negative), or undefined
 */
export function remainingFires(trigger: Pick<Trigger, 'maxFires' | 'fireCount'>): number | undefined {
  if (trigger.maxFires === undefined || trigger.maxFires === null) return undefined;
  return Math.max(0, trigger.maxFires - (trigger.fireCount ?? 0));
}

/**
 * Whether the team lead should now be told the trigger is about to stop:
 * an active, owner-facing, recurring trigger with a fire cap, at most
 * `threshold` fires left, and no heads-up sent yet.
 *
 * @param trigger - Trigger to inspect
 * @param threshold - Remaining-fires level that prompts the heads-up
 * @returns True when a heads-up is due
 */
export function needsExpiryNotice(
  trigger: Trigger,
  threshold: number = TRIGGER_ENGINE_CONSTANTS.EXPIRY_NOTICE_REMAINING_FIRES,
): boolean {
  if (trigger.status !== 'active') return false;
  if (trigger.internal === true) return false;
  if (!isRecurringTrigger(trigger)) return false;
  if (trigger.expiryNoticeSentAt) return false;
  const left = remainingFires(trigger);
  return left !== undefined && left > 0 && left <= threshold;
}

/**
 * When the trigger's last allowed fire will happen, walking its cron forward
 * from the next scheduled fire. Undefined for unlimited, non-cron, finished,
 * or unparseable triggers, and when the walk would exceed `maxSteps`.
 *
 * @param trigger - Trigger to project
 * @param maxSteps - Upper bound on cron steps to walk
 * @returns ISO time of the final fire, or undefined
 */
export function projectLastFireAt(
  trigger: Trigger,
  maxSteps: number = TRIGGER_ENGINE_CONSTANTS.PROJECTION_MAX_STEPS,
): string | undefined {
  if (!isRecurringTrigger(trigger) || trigger.config.type !== 'time') return undefined;
  const left = remainingFires(trigger);
  if (left === undefined || left <= 0 || left > maxSteps) return undefined;
  const { cronExpression, timezone } = trigger.config;
  if (!cronExpression) return undefined;
  const tz = timezone || 'UTC';
  try {
    let at = trigger.nextFireAt ?? getNextRunTime(cronExpression, tz);
    for (let i = 1; i < left; i += 1) {
      at = getNextRunTime(cronExpression, tz, new Date(at));
    }
    return at;
  } catch {
    return undefined;
  }
}

/** Content of the heads-up work item. */
export interface ExpiryNotice {
  title: string;
  description: string;
}

/**
 * Human label for a trigger: its name, else its work item title, else its id.
 *
 * @param trigger - Trigger to label
 * @returns Short label
 */
export function triggerLabel(trigger: Trigger): string {
  const title = trigger.action?.createWorkItem?.title;
  return trigger.name || (typeof title === 'string' && title) || trigger.id.slice(0, 8);
}

/**
 * Build the heads-up the team lead receives.
 *
 * @param trigger - The trigger about to run out
 * @param lastFireAt - Projected final fire (optional)
 * @returns Work-item title + description
 */
export function buildExpiryNotice(trigger: Trigger, lastFireAt?: string): ExpiryNotice {
  const label = triggerLabel(trigger);
  const left = remainingFires(trigger) ?? 0;
  const cfg = trigger.config.type === 'time' ? trigger.config : undefined;
  const schedule = cfg?.cronExpression
    ? `${cfg.cronExpression}${cfg.timezone ? ` (${cfg.timezone})` : ''}`
    : 'unknown';
  const target = trigger.action?.createWorkItem?.target ?? trigger.action?.sendMessage?.target;
  const lines = [
    `The recurring schedule "${label}" has ${left} run(s) left of ${trigger.maxFires} and will then stop on its own.`,
    '',
    `- Trigger id: ${trigger.id}`,
    `- Schedule: ${schedule}`,
    `- Runs so far: ${trigger.fireCount}`,
    lastFireAt ? `- Last run: ${lastFireAt}` : '',
    target ? `- Runs as: ${target}` : '',
    '',
    'Decide whether it should keep going. If the owner asked for it open-ended or you are unsure, ask the owner in your own words.',
    'To renew, create a new schedule with the same name and a new --max-fires (schedule-followup --cron ...) and cancel this one.',
    'Do NOT renew it automatically without that decision; if it should end, do nothing.',
  ].filter((l, i, arr) => l !== '' || (arr[i - 1] ?? '') !== '');
  return {
    title: `Schedule "${label}" stops after ${left} more run(s) — renew or ask the owner`,
    description: lines.join('\n'),
  };
}

/**
 * Who receives the heads-up: the lead of the trigger's team (`teamId`, else
 * the team of the session the trigger runs as), falling back to the
 * orchestrator when no team or lead can be found.
 *
 * @param trigger - The trigger close to exhaustion
 * @param teams - All teams
 * @returns Session name to notify
 */
export function resolveExpiryNoticeTarget(trigger: Trigger, teams: readonly Team[]): string {
  const runsAs = trigger.action?.createWorkItem?.target ?? trigger.action?.sendMessage?.target;
  const team =
    (trigger.teamId ? teams.find((t) => t.id === trigger.teamId) : undefined) ??
    (runsAs ? teams.find((t) => (t.members ?? []).some((m) => m.sessionName === runsAs)) : undefined);
  const lead = team ? pickTeamLead(team) : null;
  return lead?.sessionName || ORCHESTRATOR_SESSION_NAME;
}
