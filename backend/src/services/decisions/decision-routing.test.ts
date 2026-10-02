/**
 * Tests for who asks the owner about a ticket (specs/2026-10-01-decision-cards.md §2).
 */
import { pickTicketAsker, teamOfSession, trackedClosedReason } from './decision-routing.js';
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

describe('trackedClosedReason (specs/2026-10-02-decision-card-thread-answers.md §3)', () => {
  const reply = { requestRef: { requestId: 'r1', itemId: 'q-1' } };
  const req = (status: string, itemStatus = 'open') => ({ status, openItems: [{ id: 'q-1', status: itemStatus }] });

  it('a card whose open item / Request is still open needs its answer', () => {
    expect(trackedClosedReason(reply, { request: req('awaiting_followup') })).toBeNull();
    expect(trackedClosedReason(reply, {})).toBeNull(); // unreadable: never withdraw on a guess
  });

  it('names why a reply-question card is moot', () => {
    expect(trackedClosedReason(reply, { request: req('awaiting_followup', 'superseded') })).toBe('already handled in this thread');
    expect(trackedClosedReason(reply, { request: req('done', 'resolved') })).toBe('ticket done');
    expect(trackedClosedReason(reply, { request: req('cancelled') })).toBe('ticket cancelled');
    // Not found / unreadable is unknown: the card stays open.
    expect(trackedClosedReason(reply, { request: null })).toBeNull();
  });

  it('a ticket ask is moot once its project ticket is done or cancelled', () => {
    const ticket = { ticket: { projectId: 'p', projectPath: '/p', id: 'CE-7', title: 't' } };
    expect(trackedClosedReason(ticket, { ticketStatus: 'in_progress' })).toBeNull();
    expect(trackedClosedReason(ticket, { ticketStatus: 'done' })).toBe('ticket done');
    expect(trackedClosedReason(ticket, { ticketStatus: 'cancelled' })).toBe('ticket cancelled');
  });
});
