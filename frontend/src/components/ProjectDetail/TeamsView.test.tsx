import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TeamsView, { teamMembersMeta } from './TeamsView';
import type { Team } from '../../types';

const team = (over: Partial<Team>): Team =>
  ({
    id: 't1',
    name: 'Frontend Team',
    projectIds: ['p1'],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    members: [],
    ...over,
  }) as Team;

const frontend = team({
  id: 'team-1',
  name: 'Frontend Team',
  leaderIds: ['m1'],
  members: [
    { id: 'm1', name: 'John', role: 'developer', agentStatus: 'active', sessionName: 'john-session' },
    { id: 'm2', name: 'Jane', role: 'designer', agentStatus: 'inactive', sessionName: '' },
  ] as Team['members'],
});
const backend = team({
  id: 'team-2',
  name: 'Backend Team',
  members: [{ id: 'm3', name: 'Bob', role: 'developer', agentStatus: 'inactive', sessionName: '' }] as Team['members'],
});

describe('TeamsView', () => {
  const onUnassignTeam = vi.fn();
  const openTerminalWithSession = vi.fn();
  const onViewTeam = vi.fn();
  const onEditTeam = vi.fn();
  const onAssignTeam = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  const renderView = (teams: Team[]) =>
    render(
      <TeamsView
        assignedTeams={teams}
        onUnassignTeam={onUnassignTeam}
        openTerminalWithSession={openTerminalWithSession}
        onViewTeam={onViewTeam}
        onEditTeam={onEditTeam}
        onAssignTeam={onAssignTeam}
      />,
    );

  it('shows one row per team with members, lead and status', () => {
    renderView([frontend, backend]);
    expect(screen.getByText('Frontend Team')).toBeInTheDocument();
    expect(screen.getByText('2 members · lead John')).toBeInTheDocument();
    expect(screen.getByText('1 member')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('opens the team when the row is clicked', () => {
    renderView([frontend]);
    fireEvent.click(screen.getByText('Frontend Team'));
    expect(onViewTeam).toHaveBeenCalledWith('team-1');
  });

  it('keeps view, edit, terminal and unassign in the ⋯ menu', () => {
    renderView([frontend]);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Frontend Team' }));
    fireEvent.click(screen.getByText('Open terminal'));
    expect(openTerminalWithSession).toHaveBeenCalledWith('john-session');

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Frontend Team' }));
    fireEvent.click(screen.getByText('Edit team'));
    expect(onEditTeam).toHaveBeenCalledWith('team-1');

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Frontend Team' }));
    fireEvent.click(screen.getByText('Unassign'));
    expect(onUnassignTeam).toHaveBeenCalledWith('team-1', 'Frontend Team');
  });

  it('hides Open terminal when no member has a session', () => {
    renderView([backend]);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Backend Team' }));
    expect(screen.queryByText('Open terminal')).not.toBeInTheDocument();
  });

  it('assigns a team from the button under the list', () => {
    renderView([frontend]);
    fireEvent.click(screen.getByRole('button', { name: /Assign team/ }));
    expect(onAssignTeam).toHaveBeenCalled();
  });

  it('shows the empty state when no teams are assigned', () => {
    renderView([]);
    expect(screen.getByText('No teams assigned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Assign team/ })).toBeInTheDocument();
  });

  it('handles a team without members', () => {
    expect(teamMembersMeta(team({ members: undefined as unknown as Team['members'] }))).toBe('0 members');
  });
});
