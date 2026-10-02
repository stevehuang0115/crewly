import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TeamHeader, isOrchestratorTeam } from './TeamHeader';
import { Team } from '../../types';

const mockTeam: Team = {
  id: 'test-team',
  name: 'Test Team',
  description: 'A test team',
  members: [],
  projectIds: [],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};
const orchestratorTeam = { ...mockTeam, id: 'orchestrator', name: 'Orchestrator Team' };

const props = {
  team: mockTeam,
  teamStatus: 'idle',
  orchestratorSessionActive: false,
  onStartTeam: vi.fn(),
  onStopTeam: vi.fn(),
  onViewTerminal: vi.fn(),
  onDeleteTeam: vi.fn(),
  onEditTeam: vi.fn(),
};

const renderHeader = (over: Partial<React.ComponentProps<typeof TeamHeader>> = {}) =>
  render(
    <MemoryRouter>
      <TeamHeader {...props} {...over} />
    </MemoryRouter>,
  );

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'More team actions' }));

describe('TeamHeader', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the breadcrumb, name and status', () => {
    renderHeader();
    expect(screen.getByRole('heading', { level: 1, name: 'Test Team' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Teams' })).toHaveAttribute('href', '/teams');
    expect(screen.getByTestId('team-status')).toHaveTextContent('Idle');
  });

  it('shows Start Team while idle and calls onStartTeam', () => {
    renderHeader({ teamStatus: 'idle' });
    fireEvent.click(screen.getByText('Start Team'));
    expect(props.onStartTeam).toHaveBeenCalled();
  });

  it('puts Stop Team in the ⋯ menu while active', () => {
    renderHeader({ teamStatus: 'active' });
    expect(screen.queryByText('Start Team')).not.toBeInTheDocument();
    expect(screen.getByTestId('team-status')).toHaveTextContent('Active');
    openMenu();
    fireEvent.click(screen.getByText('Stop Team'));
    expect(props.onStopTeam).toHaveBeenCalled();
  });

  it('shows Starting… while the team starts', () => {
    renderHeader({ isStartingTeam: true });
    expect(screen.getByRole('button', { name: /Starting/ })).toBeDisabled();
  });

  it('keeps wiki, edit, change project and delete in the ⋯ menu', () => {
    const onOpenWiki = vi.fn();
    const onChangeProject = vi.fn();
    renderHeader({ onOpenWiki, onChangeProject });
    openMenu();
    fireEvent.click(screen.getByText('Open wiki'));
    expect(onOpenWiki).toHaveBeenCalled();
    openMenu();
    fireEvent.click(screen.getByText('Edit Team'));
    expect(props.onEditTeam).toHaveBeenCalled();
    openMenu();
    fireEvent.click(screen.getByText('Change project'));
    expect(onChangeProject).toHaveBeenCalled();
    openMenu();
    fireEvent.click(screen.getByText('Delete Team'));
    expect(props.onDeleteTeam).toHaveBeenCalled();
  });

  it('shows Chat as the primary action for a regular team', () => {
    const onOpenChat = vi.fn();
    renderHeader({ onOpenChat });
    fireEvent.click(screen.getByRole('button', { name: /Chat/ }));
    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });

  it('shows the goal sentence and opens the goal', () => {
    const onOpenGoal = vi.fn();
    renderHeader({ goal: { id: 'g1', objective: 'Ship the pricing page' }, moreGoals: 2, onOpenGoal });
    expect(screen.getByTestId('team-goal')).toHaveTextContent('Goal: Ship the pricing page +2 more');
    fireEvent.click(screen.getByText('Ship the pricing page'));
    expect(onOpenGoal).toHaveBeenCalledWith('g1');
  });

  it('flags a team with no goal and offers Set a goal', () => {
    const onSetGoal = vi.fn();
    renderHeader({ goal: null, onSetGoal });
    expect(screen.getByTestId('team-no-goal')).toHaveTextContent('No goal yet');
    fireEvent.click(screen.getByText('Set a goal'));
    expect(onSetGoal).toHaveBeenCalled();
  });

  it('says nothing about goals while they load', () => {
    renderHeader({ goal: undefined });
    expect(screen.queryByTestId('team-goal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('team-no-goal')).not.toBeInTheDocument();
  });

  describe('orchestrator team', () => {
    it('shows View Terminal while active and Stop Orchestrator in ⋯', () => {
      renderHeader({ team: orchestratorTeam, teamStatus: 'active', onOpenChat: vi.fn(), onOpenWiki: vi.fn() });
      fireEvent.click(screen.getByText('View Terminal'));
      expect(props.onViewTerminal).toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /^Chat$/ })).not.toBeInTheDocument();
      openMenu();
      expect(screen.getByText('Stop Orchestrator')).toBeInTheDocument();
      expect(screen.queryByText('Delete Team')).not.toBeInTheDocument();
      expect(screen.queryByText('Edit Team')).not.toBeInTheDocument();
      expect(screen.queryByText('Open wiki')).not.toBeInTheDocument();
    });

    it('shows Start Orchestrator while idle and no menu', () => {
      renderHeader({ team: orchestratorTeam, teamStatus: 'idle' });
      expect(screen.getByText('Start Orchestrator')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'More team actions' })).not.toBeInTheDocument();
    });
  });

  it('recognises the orchestrator team', () => {
    expect(isOrchestratorTeam({ id: 'orchestrator' })).toBe(true);
    expect(isOrchestratorTeam({ name: 'Orchestrator Team' })).toBe(true);
    expect(isOrchestratorTeam({ id: 'x', name: 'y' })).toBe(false);
    expect(isOrchestratorTeam(null)).toBe(false);
  });
});
