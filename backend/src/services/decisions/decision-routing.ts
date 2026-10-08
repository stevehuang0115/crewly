/**
 * Who asks the owner about a ticket (specs/2026-10-01-decision-cards.md §2), and
 * whether what a card tracks is already closed
 * (specs/2026-10-02-decision-card-thread-answers.md §3). Pure.
 *
 * The responsible agent asks, never the orchestrator: the ticket's assignee
 * when it is a member of one of the project's teams, else the lead of the
 * ticket's team, else the lead of the first project team.
 *
 * @module services/decisions/decision-routing
 */

import { DECISION_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { ACTIVE_OPEN_ITEM_STATUSES } from '../../types/v2/open-item.types.js';
import type { ProjectTicket } from '../../types/project-ticket.types.js';
import { getTeamLeads } from '../../utils/team.utils.js';

/** The chosen asker. */
export interface TicketAsker {
  session: string;
  teamId: string;
  why: 'assignee' | 'ticket_team_lead' | 'project_team_lead';
}

/**
 * A member's session name.
 *
 * @param m - Member
 * @returns Session (falls back to the member id)
 */
function sessionOf(m: TeamMember): string {
  return m.sessionName || m.id;
}

/**
 * Pick the agent that asks the owner about a ticket.
 *
 * @param ticket - Ticket (assignee, team)
 * @param teams - The project's non-archived teams
 * @returns The asker, or null when the project has no team with a lead
 */
export function pickTicketAsker(ticket: Pick<ProjectTicket, 'assignee' | 'team'>, teams: Team[]): TicketAsker | null {
  const assignee = ticket.assignee?.trim();
  if (assignee && assignee !== ORCHESTRATOR_SESSION_NAME) {
    for (const team of teams) {
      const m = (team.members ?? []).find((x) => x.sessionName === assignee || x.agentId === assignee || x.id === assignee);
      if (m) return { session: sessionOf(m), teamId: team.id, why: 'assignee' };
    }
  }
  const own = ticket.team ? teams.find((t) => t.id === ticket.team) : undefined;
  if (own) {
    const lead = getTeamLeads(own)[0];
    if (lead) return { session: sessionOf(lead), teamId: own.id, why: 'ticket_team_lead' };
  }
  for (const team of teams) {
    const lead = getTeamLeads(team)[0];
    if (lead) return { session: sessionOf(lead), teamId: team.id, why: 'project_team_lead' };
  }
  return null;
}

/**
 * The team an agent session belongs to.
 *
 * @param session - Agent session
 * @param teams - Teams
 * @returns Team id, or undefined
 */
export function teamOfSession(session: string, teams: Team[]): string | undefined {
  for (const team of teams) {
    if ((team.members ?? []).some((m) => m.sessionName === session || m.agentId === session)) return team.id;
  }
  return undefined;
}

/** What {@link trackedClosedReason} reads about the thing a card tracks. */
export interface TrackedState {
  /** The Request of a `reply_question` card: null when not found / unreadable (unknown — never moot), undefined when not looked up */
  request?: { status: string; openItems?: Array<{ id: string; status: string }> } | null;
  /** The project ticket's status, when the card is a ticket ask */
  ticketStatus?: string | null;
}

/**
 * Why a card no longer needs the owner's answer, or null while it does
 * (specs/2026-10-02-decision-card-thread-answers.md §3). Pure.
 *
 * @param d - The decision
 * @param state - Its Request / ticket as they are now
 * @returns A withdraw reason (`DECISION_CONSTANTS.CLOSED_REASONS`), or null
 */
export function trackedClosedReason(d: Pick<OwnerDecision, 'requestRef' | 'ticket'>, state: TrackedState): string | null {
  const R = DECISION_CONSTANTS.CLOSED_REASONS;
  if (d.requestRef && state.request !== undefined) {
    const request = state.request;
    // Not found / unreadable is unknown, not "done": keep the card open.
    if (!request) return null;
    if (request.status === 'done') return R.TICKET_DONE;
    if (request.status === 'cancelled') return R.TICKET_CANCELLED;
    const item = request.openItems?.find((i) => i.id === d.requestRef?.itemId);
    if (item && !ACTIVE_OPEN_ITEM_STATUSES.has(item.status as never)) return item.status === 'expired' ? R.STALE : R.HANDLED_IN_THREAD;
  }
  if (d.ticket && state.ticketStatus) {
    if (state.ticketStatus === 'done') return R.TICKET_DONE;
    if (state.ticketStatus === 'cancelled') return R.TICKET_CANCELLED;
  }
  return null;
}
