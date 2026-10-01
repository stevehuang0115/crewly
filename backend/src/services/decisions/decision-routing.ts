/**
 * Who asks the owner about a ticket (specs/2026-10-01-decision-cards.md §2). Pure.
 *
 * The responsible agent asks, never the orchestrator: the ticket's assignee
 * when it is a member of one of the project's teams, else the lead of the
 * ticket's team, else the lead of the first project team.
 *
 * @module services/decisions/decision-routing
 */

import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
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
