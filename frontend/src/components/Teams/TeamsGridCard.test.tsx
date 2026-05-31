/**
 * TeamsGridCard Component Tests
 *
 * Tests for the standardized team grid card including
 * layout, Start/Stop buttons, confirm dialog, and last activity.
 *
 * @module components/Teams/TeamsGridCard.test
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TeamsGridCard } from './TeamsGridCard';
import type { Team } from '@/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Users: () => <svg data-testid="users-icon" />,
  FolderOpen: () => <svg data-testid="folder-icon" />,
  Play: () => <svg data-testid="play-icon" />,
  Square: () => <svg data-testid="square-icon" />,
  Clock: () => <svg data-testid="clock-icon" />,
  MoreVertical: () => <svg data-testid="more-icon" />,
}));

// Mock OverflowMenu — render the items as buttons so item wiring is testable.
vi.mock('@/components/UI/OverflowMenu', () => ({
  OverflowMenu: ({ items = [] }: { items?: Array<{ label: string; onClick?: () => void }> }) => (
    <div data-testid="overflow-menu">
      {items.map((item) => (
        <button key={item.label} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

// Mock MemberAvatar
vi.mock('@/components/common/MemberAvatar', () => ({
  MemberAvatar: ({ name, status }: any) => (
    <div data-testid={`avatar-${name}`} data-status={status}>
      {name}
    </div>
  ),
}));

// Mock ConfirmDialog
vi.mock('@/components/UI/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onCancel, onConfirm, title, message }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <h2>{title}</h2>
        <p data-testid="confirm-dialog-message">{message}</p>
        <button data-testid="confirm-dialog-cancel" onClick={onCancel}>Cancel</button>
        <button data-testid="confirm-dialog-confirm" onClick={onConfirm}>Confirm</button>
      </div>
    ) : null,
}));

/** Create a minimal team for testing */
function createTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1',
    name: 'Test Team',
    projectIds: ['proj-1'],
    members: [
      {
        id: 'm1',
        name: 'Alice',
        sessionName: 'alice-session',
        role: 'developer',
        agentStatus: 'active',
        workingStatus: 'idle',
        runtimeType: 'claude-code',
        systemPrompt: '',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-10T12:00:00Z',
      },
      {
        id: 'm2',
        name: 'Bob',
        sessionName: 'bob-session',
        role: 'designer',
        agentStatus: 'inactive',
        workingStatus: 'idle',
        runtimeType: 'claude-code',
        systemPrompt: '',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-05T08:00:00Z',
      },
    ],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-10T12:00:00Z',
    ...overrides,
  } as Team;
}

describe('TeamsGridCard', () => {
  const defaultProps = {
    team: createTeam(),
    projectName: 'My Project',
    onClick: vi.fn(),
    onViewTeam: vi.fn(),
    onEditTeam: vi.fn(),
    onStartTeam: vi.fn(),
    onStopTeam: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render team name', () => {
      render(<TeamsGridCard {...defaultProps} />);
      expect(screen.getByText('Test Team')).toBeInTheDocument();
    });

    it('should show Active badge when team has active members', () => {
      render(<TeamsGridCard {...defaultProps} />);
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('should show Idle badge when no active members', () => {
      const team = createTeam({
        members: [
          {
            id: 'm1', name: 'Alice', sessionName: 'a', role: 'dev',
            agentStatus: 'inactive', workingStatus: 'idle', runtimeType: 'claude-code',
            systemPrompt: '', createdAt: '2024-01-01', updatedAt: '2024-01-01',
          },
        ],
      });
      render(<TeamsGridCard {...defaultProps} team={team} />);
      expect(screen.getByText('Idle')).toBeInTheDocument();
    });

    it('should display project name when provided', () => {
      render(<TeamsGridCard {...defaultProps} />);
      expect(screen.getByText('My Project')).toBeInTheDocument();
    });

    it('should show "Assign a project" guidance when no projects assigned', () => {
      const team = createTeam({ projectIds: [] });
      render(<TeamsGridCard {...defaultProps} team={team} projectName={undefined} />);
      expect(screen.getByTestId('assign-project-cta')).toBeInTheDocument();
      expect(screen.getByText('Assign a project to get started')).toBeInTheDocument();
    });

    it('should display member count', () => {
      render(<TeamsGridCard {...defaultProps} />);
      expect(screen.getByText('2 members')).toBeInTheDocument();
    });

    it('should display singular member count for 1 member', () => {
      const team = createTeam({
        members: [{
          id: 'm1', name: 'Alice', sessionName: 'a', role: 'dev',
          agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code',
          systemPrompt: '', createdAt: '2024-01-01', updatedAt: '2024-01-01',
        }],
      });
      render(<TeamsGridCard {...defaultProps} team={team} />);
      expect(screen.getByText('1 member')).toBeInTheDocument();
    });

    it('should render member avatars with status', () => {
      render(<TeamsGridCard {...defaultProps} />);
      expect(screen.getByTestId('avatar-Alice')).toHaveAttribute('data-status', 'active');
      expect(screen.getByTestId('avatar-Bob')).toHaveAttribute('data-status', 'inactive');
    });

    it('should show +N for extra members beyond 3', () => {
      const members = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`, name: `User${i}`, sessionName: `s${i}`, role: 'dev',
        agentStatus: 'inactive' as const, workingStatus: 'idle' as const,
        runtimeType: 'claude-code' as const, systemPrompt: '',
        createdAt: '2024-01-01', updatedAt: '2024-01-01',
      }));
      const team = createTeam({ members });
      render(<TeamsGridCard {...defaultProps} team={team} />);
      expect(screen.getByText('+2')).toBeInTheDocument();
    });

    it('should display sub-team count when provided', () => {
      render(<TeamsGridCard {...defaultProps} subTeamCount={3} />);
      expect(screen.getByText(/3 sub-teams/)).toBeInTheDocument();
    });

    it('should display last activity timestamp', () => {
      render(<TeamsGridCard {...defaultProps} />);
      expect(screen.getByTestId('clock-icon')).toBeInTheDocument();
    });
  });

  describe('Start/Stop Controls', () => {
    it('should show Stop button when team has active members', () => {
      render(<TeamsGridCard {...defaultProps} />);
      expect(screen.getByTestId(`stop-btn-${defaultProps.team.id}`)).toBeInTheDocument();
    });

    it('should show Start button when team has no active members', () => {
      const team = createTeam({
        members: [{
          id: 'm1', name: 'Alice', sessionName: 'a', role: 'dev',
          agentStatus: 'inactive', workingStatus: 'idle', runtimeType: 'claude-code',
          systemPrompt: '', createdAt: '2024-01-01', updatedAt: '2024-01-01',
        }],
      });
      render(<TeamsGridCard {...defaultProps} team={team} />);
      expect(screen.getByTestId(`start-btn-${team.id}`)).toBeInTheDocument();
    });

    it('should call onStartTeam when Start button is clicked', () => {
      const team = createTeam({
        members: [{
          id: 'm1', name: 'Alice', sessionName: 'a', role: 'dev',
          agentStatus: 'inactive', workingStatus: 'idle', runtimeType: 'claude-code',
          systemPrompt: '', createdAt: '2024-01-01', updatedAt: '2024-01-01',
        }],
      });
      render(<TeamsGridCard {...defaultProps} team={team} />);
      fireEvent.click(screen.getByTestId(`start-btn-${team.id}`));
      expect(defaultProps.onStartTeam).toHaveBeenCalledWith(team.id);
      // Should NOT trigger card onClick
      expect(defaultProps.onClick).not.toHaveBeenCalled();
    });

    it('should open confirm dialog when Stop button is clicked', () => {
      render(<TeamsGridCard {...defaultProps} />);
      fireEvent.click(screen.getByTestId(`stop-btn-${defaultProps.team.id}`));
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
      expect(screen.getByText('Stop Team')).toBeInTheDocument();
    });

    it('should call onStopTeam after confirming stop', () => {
      render(<TeamsGridCard {...defaultProps} />);
      fireEvent.click(screen.getByTestId(`stop-btn-${defaultProps.team.id}`));
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
      expect(defaultProps.onStopTeam).toHaveBeenCalledWith(defaultProps.team.id);
    });

    it('should close confirm dialog on cancel', () => {
      render(<TeamsGridCard {...defaultProps} />);
      fireEvent.click(screen.getByTestId(`stop-btn-${defaultProps.team.id}`));
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      expect(defaultProps.onStopTeam).not.toHaveBeenCalled();
    });
  });

  describe('Card Interaction', () => {
    it('should call onClick when card is clicked', () => {
      render(<TeamsGridCard {...defaultProps} />);
      fireEvent.click(screen.getByTestId(`team-card-${defaultProps.team.id}`));
      expect(defaultProps.onClick).toHaveBeenCalled();
    });
  });

  describe('Chat / Wiki menu actions', () => {
    it('renders Open Chat / Open Wiki items and fires their callbacks with the team id', () => {
      const onOpenChat = vi.fn();
      const onOpenWiki = vi.fn();
      render(<TeamsGridCard {...defaultProps} onOpenChat={onOpenChat} onOpenWiki={onOpenWiki} />);

      fireEvent.click(screen.getByText('Open Chat'));
      expect(onOpenChat).toHaveBeenCalledWith(defaultProps.team.id);

      fireEvent.click(screen.getByText('Open Wiki'));
      expect(onOpenWiki).toHaveBeenCalledWith(defaultProps.team.id);
    });

    it('omits the Chat/Wiki items when no callbacks are provided', () => {
      render(<TeamsGridCard {...defaultProps} />);
      expect(screen.queryByText('Open Chat')).not.toBeInTheDocument();
      expect(screen.queryByText('Open Wiki')).not.toBeInTheDocument();
    });
  });
});
