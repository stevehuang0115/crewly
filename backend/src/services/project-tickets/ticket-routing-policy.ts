/**
 * Ticket routing policy (CREW-151): which member may claim a ticket by itself.
 *
 * - A ticket with a team goes only to members of that team.
 * - A ticket with no team that is labelled harness-gap / engineering goes only
 *   to engineering roles (developer, engineer, …), so an idle Marketing member
 *   cannot pick up engineering work.
 *
 * Pure functions; the workflow service applies them on self-claim and idle
 * auto-pickup. A lead's or the orchestrator's assign does not use them.
 *
 * @module services/project-tickets/ticket-routing-policy
 */

import { TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';

/**
 * Whether a ticket's labels mark it as engineering work.
 *
 * @param labels - Ticket labels
 * @returns True for harness-gap / engineering
 */
export function isEngineeringTicket(labels: readonly string[]): boolean {
  const wanted = TICKET_AUTOPILOT_CONSTANTS.ENGINEERING_TICKET_LABELS;
  return labels.some((l) => wanted.includes(l.trim().toLowerCase()));
}

/**
 * Whether a member role is an engineering role.
 *
 * @param role - Member role id (e.g. "developer", "frontend-developer")
 * @returns True for engineering roles
 */
export function isEngineeringRole(role: string | undefined | null): boolean {
  return new RegExp(TICKET_AUTOPILOT_CONSTANTS.ENGINEERING_ROLE_PATTERN, 'i').test(String(role ?? ''));
}

/**
 * Why a member may not self-claim a ticket, or null when it may.
 *
 * @param ticket - The ticket's id, team and labels
 * @param member - The claiming member's team id and role
 * @returns A refusal sentence, or null
 */
export function selfClaimRefusal(ticket: { id: string; team?: string | null; labels: readonly string[] }, member: { teamId: string; role?: string }): string | null {
  if (ticket.team) return ticket.team === member.teamId ? null : `${ticket.id} belongs to team ${ticket.team}, not ${member.teamId}`;
  if (isEngineeringTicket(ticket.labels) && !isEngineeringRole(member.role)) {
    return `${ticket.id} is engineering work with no team; role "${member.role ?? 'unknown'}" cannot claim it (a lead or the orchestrator can assign it)`;
  }
  return null;
}
