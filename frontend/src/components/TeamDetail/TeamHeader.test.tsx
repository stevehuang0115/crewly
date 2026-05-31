import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { vi } from 'vitest';
import { TeamHeader } from './TeamHeader';
import { Team } from '../../types';

const mockTeam: Team = {
  id: 'test-team',
  name: 'Test Team',
  description: 'A test team',
  members: [],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const mockProps = {
  team: mockTeam,
  teamStatus: 'idle',
  orchestratorSessionActive: false,
  onStartTeam: vi.fn(),
  onStopTeam: vi.fn(),
  onViewTerminal: vi.fn(),
  onDeleteTeam: vi.fn(),
};

describe('TeamHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders team name correctly', () => {
    render(<TeamHeader {...mockProps} />);
    expect(screen.getByText('Test Team')).toBeInTheDocument();
  });

  it('shows Start Team button when team status is idle', () => {
    render(<TeamHeader {...mockProps} teamStatus="idle" />);
    expect(screen.getByText('Start Team')).toBeInTheDocument();
  });

  it('shows Stop Team button when team status is active', () => {
    render(<TeamHeader {...mockProps} teamStatus="active" />);
    expect(screen.getByText('Stop Team')).toBeInTheDocument();
  });

  it('calls onStartTeam when Start Team button is clicked', () => {
    render(<TeamHeader {...mockProps} teamStatus="idle" />);
    fireEvent.click(screen.getByText('Start Team'));
    expect(mockProps.onStartTeam).toHaveBeenCalled();
  });

  it('shows View Terminal button for an active orchestrator team', () => {
    // View Terminal only renders for the orchestrator team while it is active.
    const orchestratorTeam = { ...mockTeam, id: 'orchestrator', name: 'Orchestrator Team' };
    render(<TeamHeader {...mockProps} team={orchestratorTeam} teamStatus="active" />);
    expect(screen.getByText('View Terminal')).toBeInTheDocument();
  });

  it('does not render the overflow menu (nor Delete Team) for the orchestrator team', () => {
    const orchestratorTeam = { ...mockTeam, id: 'orchestrator', name: 'Orchestrator Team' };
    render(<TeamHeader {...mockProps} team={orchestratorTeam} />);

    // The orchestrator team intentionally has no edit/delete overflow menu.
    expect(screen.queryByRole('button', { name: /more options/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Team')).not.toBeInTheDocument();
  });

  it('shows Delete Team option in overflow menu for regular teams', async () => {
    render(<TeamHeader {...mockProps} />);

    // Open the overflow menu
    const menuButton = screen.getByRole('button', { name: /more options/i });
    fireEvent.click(menuButton);

    // Delete Team should be visible in the menu
    expect(screen.getByText('Delete Team')).toBeInTheDocument();
  });

  it('renders Chat and Wiki buttons and fires their callbacks for a regular team', () => {
    const onOpenChat = vi.fn();
    const onOpenWiki = vi.fn();
    render(<TeamHeader {...mockProps} onOpenChat={onOpenChat} onOpenWiki={onOpenWiki} />);

    fireEvent.click(screen.getByText('Chat'));
    expect(onOpenChat).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Wiki'));
    expect(onOpenWiki).toHaveBeenCalledTimes(1);
  });

  it('does not render Chat/Wiki buttons when no callbacks are provided', () => {
    render(<TeamHeader {...mockProps} />);
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Wiki')).not.toBeInTheDocument();
  });

  it('hides Chat/Wiki buttons for the orchestrator team even when callbacks are given', () => {
    const orchestratorTeam = { ...mockTeam, id: 'orchestrator', name: 'Orchestrator Team' };
    render(
      <TeamHeader
        {...mockProps}
        team={orchestratorTeam}
        onOpenChat={vi.fn()}
        onOpenWiki={vi.fn()}
      />,
    );
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Wiki')).not.toBeInTheDocument();
  });
});