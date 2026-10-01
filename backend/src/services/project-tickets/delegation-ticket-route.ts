/**
 * Delegation through project tickets — the rule deciding whether a WorkItem
 * created through `POST /api/task-pool/add` is routed through a project
 * ticket (specs/2026-09-28-project-tickets.md §11).
 *
 * Pure: no I/O. The workflow service gathers the inputs (who is calling, the
 * projects of the target's teams) and acts on the decision.
 *
 * @module services/project-tickets/delegation-ticket-route
 */

import { PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { readProjectTicketLink } from '../../types/project-ticket.types.js';

/** The WorkItem fields the rule looks at. */
export type DelegationRouteItem = Pick<WorkItem, 'type' | 'owner' | 'target' | 'triggerId' | 'scheduledAt' | 'metadata'>;

/** Inputs of {@link decideDelegationTicketRoute}. */
export interface DelegationRouteInput {
  /** The WorkItem about to be added */
  workItem: DelegationRouteItem;
  /** The delegating agent (X-Agent-Session, or `metadata.delegatedBy`); absent = unknown */
  callerSession?: string;
  /** `--ticket <ID>` given by the delegator */
  explicitTicketId?: string;
  /** Ids of the projects the target's teams work on */
  targetProjectIds: readonly string[];
}

/**
 * What to do with the WorkItem.
 *
 * - `route`: go through a ticket (the given one, or a new one).
 * - `skip`: add the WorkItem as before, no ticket.
 * - `refuse`: the delegator named a ticket, but this item cannot carry one.
 */
export type DelegationRouteDecision =
  | { action: 'route' }
  | { action: 'skip'; reason: string }
  | { action: 'refuse'; reason: string };

/**
 * Why an item is never routed through a ticket, or null when it may be.
 *
 * @param input - Rule inputs
 * @returns Reason, or null
 */
function exclusionReason(input: DelegationRouteInput): string | null {
  const { workItem: wi, callerSession } = input;
  const types: readonly string[] = PROJECT_TICKET_CONSTANTS.DELEGATION_WORK_ITEM_TYPES;
  if (!types.includes(wi.type)) return `a ${wi.type} item is not a delegation`;
  if (readProjectTicketLink(wi.metadata)) return 'the item already carries a project ticket';
  if (typeof wi.metadata?.verifyOf === 'string') return 'review / verify items do not get tickets';
  if (wi.owner === 'system') return 'system items do not get tickets';
  if (wi.triggerId) return 'trigger / cron items do not get tickets';
  if (wi.scheduledAt) return 'scheduled reminders do not get tickets';
  const target = typeof wi.target === 'string' ? wi.target.trim() : '';
  if (!target) return 'an unassigned item has nobody to put on a ticket';
  if (!callerSession && !input.explicitTicketId) return 'the delegator is unknown, so a self-reminder cannot be told apart';
  if (callerSession && callerSession === target) return 'an item an agent targets at itself is a self-reminder';
  if (input.targetProjectIds.length === 0) return `${target} is not on a team with a project`;
  return null;
}

/**
 * Decide whether a WorkItem goes through a project ticket.
 *
 * Routed: a `delegate` item from a known agent (or the owner, with an
 * explicit ticket) to a DIFFERENT agent whose team works on a project. Never
 * routed: review/verify items, system / trigger / scheduled items, items an
 * agent targets at itself, targets with no project, items already linked.
 * Naming a ticket on an item that cannot carry one is refused rather than
 * silently ignored.
 *
 * @param input - The WorkItem, the caller, the explicit ticket, the target's projects
 * @returns The decision
 */
export function decideDelegationTicketRoute(input: DelegationRouteInput): DelegationRouteDecision {
  const reason = exclusionReason(input);
  if (!reason) return { action: 'route' };
  return input.explicitTicketId ? { action: 'refuse', reason: `--ticket ${input.explicitTicketId} refused: ${reason}` } : { action: 'skip', reason };
}

/**
 * Ticket title for a delegation title: the first non-empty line, markdown
 * heading marks dropped, capped.
 *
 * @param title - WorkItem title (may be the first 200 chars of a brief)
 * @returns Title (never empty)
 */
export function delegationTicketTitle(title: string): string {
  const line = String(title ?? '')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0) ?? '';
  const max = PROJECT_TICKET_CONSTANTS.DELEGATION_TITLE_MAX_CHARS;
  const text = line || 'Delegated task';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
