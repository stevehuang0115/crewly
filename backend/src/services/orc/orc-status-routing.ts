/**
 * Who an agent status report wakes (specs/2026-10-01-orc-status-wakes.md).
 *
 * Every `report-status` line used to be queued for the orchestrator. On
 * 2026-09-29 that was 134 full-context orchestrator turns, almost all of them
 * team members' [DONE] lines about work their own team lead owns and reviews.
 * Now the report goes to whoever is responsible:
 *
 * | Report | Goes to |
 * |---|---|
 * | [IN_PROGRESS] [ACTIVE] [READY] [WORKING] [IDLE] … | recorded only |
 * | [DONE] that a pending owner delivery is waiting for | orchestrator |
 * | [DONE] on work the orchestrator delegated | orchestrator |
 * | [DONE] on anyone else's work item | recorded (the lead's review path takes it) |
 * | [DONE] with no work item | digest (actionable only without a lead) |
 * | [BLOCKED] [FAILED] [ERROR] | the sender's lead; orchestrator when there is none or the lead sent it |
 * | [MILESTONE] | orchestrator (it forwards milestones to the owner) |
 * | other markers | digest (actionable only on orchestrator work or without a lead) |
 * | no marker (an answer someone waits for) | orchestrator, as before |
 *
 * Pure functions only; {@link OrcStatusRouterService} carries out the plan.
 *
 * @module services/orc/orc-status-routing
 */

import { ORC_WAKE_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

/** Why the orchestrator is woken (the hourly counter's categories). */
export type OrcWakeCategory = 'owner' | 'delegated-done' | 'escalation' | 'digest' | 'other';

/** What happens to one status report. */
export type OrcStatusRoute =
  /** Status store / UI / ticket log only */
  | { action: 'record'; reason: string }
  /** Wake the orchestrator now */
  | { action: 'orc'; category: Exclude<OrcWakeCategory, 'digest'>; reason: string }
  /** Hand it to the sender's team lead */
  | { action: 'team-lead'; lead: string; reason: string }
  /** Hold for the next digest; only actionable entries make a digest go out */
  | { action: 'digest'; actionable: boolean; reason: string };

/** Inputs of {@link planOrcStatusRoute}. */
export interface OrcStatusRouteInput {
  /** The report text (`[DONE] Agent x: …`) */
  content: string;
  /** Reporting agent session */
  sender: string;
  /** The work item the report is about, when known */
  workItem: WorkItem | null;
  /** The sender's lead (parent member, else team lead), never the sender itself */
  lead: string | null;
  /** True when the sender leads its own team (reason text only; a lead with a parent still reports up) */
  senderIsLead: boolean;
  /** True when the owner is waiting on the orchestrator to deliver this (OrcDeliveryEnforcer tracked it) */
  deliveryOwed: boolean;
  /** Orchestrator check for a session / name */
  isOrchestrator: (name: string) => boolean;
}

/**
 * The bracketed marker a report starts with, upper-cased.
 *
 * @param content - Report text
 * @returns e.g. `DONE`, or null when the text has no leading marker
 */
export function statusMarkerOf(content: string): string | null {
  const m = /^\s*\[([A-Za-z_ ]{2,40})\]/.exec(content ?? '');
  return m ? m[1].trim().toUpperCase() : null;
}

/**
 * Whether the orchestrator delegated (or created) a work item: its owner is
 * the orchestrator, or the orchestrator stamped itself as the delegator.
 *
 * @param wi - Work item
 * @param isOrchestrator - Orchestrator check
 * @returns True for orchestrator work
 */
export function isOrcDelegated(wi: WorkItem, isOrchestrator: (name: string) => boolean): boolean {
  if (wi.owner === 'orchestrator') return true;
  const meta = (wi.metadata ?? {}) as Record<string, unknown>;
  for (const key of ['delegatedBy', 'createdBy']) {
    const v = meta[key];
    if (typeof v === 'string' && v && isOrchestrator(v)) return true;
  }
  return false;
}

/**
 * The work item a report is about: the one it names; else the sender's
 * running/accepted item (newest); else the sender's most recently finished
 * item, when it finished within {@link ORC_WAKE_CONSTANTS.RECENT_COMPLETION_MS}.
 *
 * `report-status` posts the line BEFORE it completes the item, so the
 * running item is normally the answer.
 *
 * @param items - Pool items
 * @param sender - Reporting agent
 * @param workItemId - Id the report named, if any
 * @param now - Clock (epoch ms)
 * @returns The item, or null
 */
export function findStatusWorkItem(
  items: readonly WorkItem[],
  sender: string,
  workItemId: string | undefined,
  now: number,
): WorkItem | null {
  if (workItemId) {
    const named = items.find((wi) => wi.id === workItemId);
    if (named) return named;
  }
  let running: WorkItem | null = null;
  let runningAt = -Infinity;
  let finished: WorkItem | null = null;
  let finishedAt = -Infinity;
  for (const wi of items) {
    if (wi.target !== sender) continue;
    if (wi.status === 'running' || wi.status === 'accepted') {
      const at = Date.parse(wi.startedAt ?? wi.createdAt) || 0;
      if (at > runningAt) {
        running = wi;
        runningAt = at;
      }
      continue;
    }
    const doneAt = Date.parse(wi.completedAt ?? '') || 0;
    if (doneAt && now - doneAt <= ORC_WAKE_CONSTANTS.RECENT_COMPLETION_MS && doneAt > finishedAt) {
      finished = wi;
      finishedAt = doneAt;
    }
  }
  return running ?? finished;
}

/**
 * Decide where one agent status report goes.
 *
 * @param input - Report, sender, its work item and lead
 * @returns The route
 */
export function planOrcStatusRoute(input: OrcStatusRouteInput): OrcStatusRoute {
  const { content, sender, workItem, lead, senderIsLead, deliveryOwed, isOrchestrator } = input;
  const marker = statusMarkerOf(content);
  const hasLead = Boolean(lead) && lead !== sender && !isOrchestrator(String(lead));

  if (ORC_WAKE_CONSTANTS.RECORD_ONLY_MARKERS.test(content)) {
    return { action: 'record', reason: `progress marker [${marker}]` };
  }
  if (deliveryOwed) {
    return { action: 'orc', category: 'owner', reason: 'the owner is waiting on the orchestrator to deliver this' };
  }
  if (!marker) {
    return { action: 'orc', category: 'other', reason: 'not a status line — someone may be waiting for this answer' };
  }
  if (ORC_WAKE_CONSTANTS.ALWAYS_ORC_MARKERS.test(content)) {
    return { action: 'orc', category: 'other', reason: `[${marker}] is forwarded to the owner by the orchestrator` };
  }
  const orcWork = workItem ? isOrcDelegated(workItem, isOrchestrator) : false;

  if (ORC_WAKE_CONSTANTS.DONE_MARKERS.test(content)) {
    if (workItem && orcWork) {
      return { action: 'orc', category: 'delegated-done', reason: `work item ${workItem.id} was delegated by the orchestrator` };
    }
    if (workItem) {
      return { action: 'record', reason: `work item ${workItem.id} is owned by ${workItem.owner}; its review path takes the [DONE]` };
    }
    return hasLead
      ? { action: 'digest', actionable: false, reason: `no work item; ${sender} reports to ${lead}` }
      : { action: 'digest', actionable: true, reason: `no work item and no lead above ${sender}` };
  }

  if (ORC_WAKE_CONSTANTS.ATTENTION_MARKERS.test(content)) {
    if (hasLead && lead) return { action: 'team-lead', lead, reason: `[${marker}] goes to ${sender}'s lead first` };
    return { action: 'orc', category: 'escalation', reason: senderIsLead ? `[${marker}] from a team lead` : `[${marker}] and ${sender} has no lead` };
  }

  // Structured reports and unknown markers.
  const actionable = orcWork || !hasLead;
  return {
    action: 'digest',
    actionable,
    reason: actionable ? `[${marker}] ${orcWork ? 'on orchestrator work' : 'from an agent with no lead'}` : `[${marker}] on work its lead owns`,
  };
}
