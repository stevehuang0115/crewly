/**
 * Tests for who asks the owner about a ticket (specs/2026-10-01-decision-cards.md §2).
 */
import { pickTicketAsker, teamOfSession } from './decision-routing.js';
import type { Team, TeamMember } from '../../types/index.js';

function member(id: string, sessionName: string, role = 'developer'): TeamMember {
  return { id, name: id, sessionName, role, systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '' } as TeamMember;
}

const teamA = { id: 'team-a', name: 'A', members: [member('lead-a', 'tl-sam', 'team-leader'), member('dev-a', 'dev-ann')], leadId: 'lead-a', projectIds: ['p1'] } as unknown as Team;
const teamB = { id: 'team-b', name: 'B', members: [member('lead-b', 'tl-bo', 'team-leader'), member('dev-b', 'dev-bea')], leadId: 'lead-b', projectIds: ['p1'] } as unknown as Team;

describe('pickTicketAsker', () => {
  it('the assignee asks when it is a team member', () => {
    expect(pickTicketAsker({ assignee: 'dev-bea', team: 'team-a' }, [teamA, teamB])).toEqual({ session: 'dev-bea', teamId: 'team-b', why: 'assignee' });
  });

  it('never the orchestrator: its ticket goes to the ticket team lead', () => {
    expect(pickTicketAsker({ assignee: 'crewly-orc', team: 'team-b' }, [teamA, teamB])).toEqual({ session: 'tl-bo', teamId: 'team-b', why: 'ticket_team_lead' });
  });

  it('no assignee and no team → the first project team lead', () => {
    expect(pickTicketAsker({ assignee: null, team: null }, [teamA, teamB])).toEqual({ session: 'tl-sam', teamId: 'team-a', why: 'project_team_lead' });
  });

  it('an assignee outside the teams falls back to a lead', () => {
    expect(pickTicketAsker({ assignee: 'Steve', team: 'team-a' }, [teamA])?.session).toBe('tl-sam');
  });

  it('null when no team has a lead', () => {
    expect(pickTicketAsker({ assignee: null, team: null }, [{ id: 't', name: 't', members: [] } as unknown as Team])).toBeNull();
  });
});

describe('teamOfSession', () => {
  it('finds the team of a session', () => {
    expect(teamOfSession('dev-ann', [teamA, teamB])).toBe('team-a');
    expect(teamOfSession('nobody', [teamA, teamB])).toBeUndefined();
  });
});
