/**
 * Tests for TeamMemberRow component
 * Tests loading states, status display, and button interactions
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TeamMemberRow } from './TeamMemberRow';
import { TeamMember } from '@/types';

// Mock lucide-react icons
vi.mock('lucide-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lucide-react')>()),
  Play: () => <span data-testid="play-icon">Play</span>,
  Square: () => <span data-testid="square-icon">Square</span>,
  Loader2: () => <span data-testid="loader-icon">Loader</span>,
  KeyRound: () => <span data-testid="key-icon">Key</span>,
  Copy: () => <span data-testid="copy-icon">Copy</span>,
  Check: () => <span data-testid="check-icon">Check</span>,
  ExternalLink: () => <span data-testid="link-icon">Link</span>,
}));

// Mock OverflowMenu component
vi.mock('@crewly/ui/OverflowMenu', () => ({
  OverflowMenu: ({ items }: { items: Array<{ label: string; onClick: () => void }> }) => (
    <div data-testid="overflow-menu">
      {items.map((item, index) => (
        <button key={index} onClick={item.onClick} data-testid={`menu-item-${index}`}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

/**
 * Create a default test member
 */
function createTestMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'member-1',
    name: 'Test Developer',
    role: 'developer',
    sessionName: 'test-session',
    agentStatus: 'inactive',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TeamMemberRow', () => {
  const defaultProps = {
    member: createTestMember(),
    teamId: 'team-1',
  };

  describe('rendering', () => {
    it('should render member name', () => {
      render(<TeamMemberRow {...defaultProps} />);
      expect(screen.getByText('Test Developer')).toBeInTheDocument();
    });

    it('shows the fallback badge while the agent runs on another runtime', () => {
      const member = createTestMember({
        runtimeOverride: {
          runtime: 'crewly-agent',
          primary: 'claude-code',
          reason: 'usage_limit',
          since: '2026-10-01T12:00:00.000Z',
          until: '2026-10-01T22:00:00.000Z',
          badge: 'on DeepSeek (Claude limit)',
        },
      });
      render(<TeamMemberRow {...defaultProps} member={member} />);
      expect(screen.getByTestId('runtime-override-badge')).toHaveTextContent('on DeepSeek (Claude limit)');
    });

    it('shows no fallback badge normally', () => {
      render(<TeamMemberRow {...defaultProps} />);
      expect(screen.queryByTestId('runtime-override-badge')).not.toBeInTheDocument();
    });

    it('should render session name', () => {
      render(<TeamMemberRow {...defaultProps} />);
      expect(screen.getByText('Session: test-session')).toBeInTheDocument();
    });

    it('should display "Stopped" when session is not active', () => {
      render(<TeamMemberRow {...defaultProps} />);
      expect(screen.getByText('Stopped')).toBeInTheDocument();
    });

    it('should display avatar initial when no avatar provided', () => {
      render(<TeamMemberRow {...defaultProps} />);
      expect(screen.getByText('T')).toBeInTheDocument(); // First letter of "Test Developer"
    });

    it('should display emoji avatar when provided', () => {
      const member = createTestMember({ avatar: '🤖' });
      render(<TeamMemberRow {...defaultProps} member={member} />);
      expect(screen.getByText('🤖')).toBeInTheDocument();
    });

    it('should display image avatar when URL is provided', () => {
      const member = createTestMember({ avatar: 'https://example.com/avatar.png' });
      render(<TeamMemberRow {...defaultProps} member={member} />);
      const img = screen.getByAltText('Test Developer');
      expect(img).toHaveAttribute('src', 'https://example.com/avatar.png');
    });
  });

  describe('status display', () => {
    it('should show "Stopped" for inactive status', () => {
      const member = createTestMember({ agentStatus: 'inactive' });
      render(<TeamMemberRow {...defaultProps} member={member} />);
      expect(screen.getByText('Stopped')).toBeInTheDocument();
    });

    it('should show "Started" for active status', () => {
      const member = createTestMember({ agentStatus: 'active' });
      render(<TeamMemberRow {...defaultProps} member={member} />);
      expect(screen.getByText('Started')).toBeInTheDocument();
    });

    it('should show "Starting..." for activating status', () => {
      const member = createTestMember({ agentStatus: 'activating' });
      render(<TeamMemberRow {...defaultProps} member={member} />);
      expect(screen.getByText('Starting...')).toBeInTheDocument();
    });
  });

  describe('start button', () => {
    it('should show Play button when member is inactive', () => {
      const member = createTestMember({ agentStatus: 'inactive' });
      render(<TeamMemberRow {...defaultProps} member={member} />);
      expect(screen.getByTestId('play-icon')).toBeInTheDocument();
    });

    it('should call onStart when Play button is clicked', async () => {
      const onStart = vi.fn().mockResolvedValue(undefined);
      const member = createTestMember({ agentStatus: 'inactive' });
      render(<TeamMemberRow {...defaultProps} member={member} onStart={onStart} />);

      const playButton = screen.getByTitle('Start');
      fireEvent.click(playButton);

      expect(onStart).toHaveBeenCalledWith('member-1');
    });

    it('should show loading state when starting', async () => {
      let resolveStart: () => void;
      const startPromise = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const onStart = vi.fn().mockReturnValue(startPromise);
      const member = createTestMember({ agentStatus: 'inactive' });

      render(<TeamMemberRow {...defaultProps} member={member} onStart={onStart} />);

      const playButton = screen.getByTitle('Start');
      fireEvent.click(playButton);

      // Should show loader while starting
      await waitFor(() => {
        expect(screen.getByText('Starting...')).toBeInTheDocument();
      });

      // Resolve the promise
      resolveStart!();

      // Wait for loading to finish
      await waitFor(() => {
        expect(screen.queryByText('Starting...')).not.toBeInTheDocument();
      });
    });

    it('should disable button while starting', async () => {
      let resolveStart: () => void;
      const startPromise = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const onStart = vi.fn().mockReturnValue(startPromise);
      const member = createTestMember({ agentStatus: 'inactive' });

      render(<TeamMemberRow {...defaultProps} member={member} onStart={onStart} />);

      const playButton = screen.getByTitle('Start');
      fireEvent.click(playButton);

      // Button should be disabled
      await waitFor(() => {
        expect(playButton).toBeDisabled();
      });

      // Resolve and cleanup
      resolveStart!();
      await waitFor(() => {
        expect(playButton).not.toBeDisabled();
      });
    });
  });

  describe('stop button', () => {
    it('should show Square button when member is active', () => {
      const member = createTestMember({ agentStatus: 'active' });
      render(<TeamMemberRow {...defaultProps} member={member} />);
      expect(screen.getByTestId('square-icon')).toBeInTheDocument();
    });

    it('should call onStop when Stop button is clicked', async () => {
      const onStop = vi.fn().mockResolvedValue(undefined);
      const member = createTestMember({ agentStatus: 'active' });
      render(<TeamMemberRow {...defaultProps} member={member} onStop={onStop} />);

      const stopButton = screen.getByTitle('Stop');
      fireEvent.click(stopButton);

      expect(onStop).toHaveBeenCalledWith('member-1');
    });

    it('should show loading state when stopping', async () => {
      let resolveStop: () => void;
      const stopPromise = new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
      const onStop = vi.fn().mockReturnValue(stopPromise);
      const member = createTestMember({ agentStatus: 'active' });

      render(<TeamMemberRow {...defaultProps} member={member} onStop={onStop} />);

      const stopButton = screen.getByTitle('Stop');
      fireEvent.click(stopButton);

      // Should show "Stopping..." text
      await waitFor(() => {
        expect(screen.getByText('Stopping...')).toBeInTheDocument();
      });

      // Resolve the promise
      resolveStop!();

      // Wait for loading to finish
      await waitFor(() => {
        expect(screen.queryByText('Stopping...')).not.toBeInTheDocument();
      });
    });
  });

  describe('overflow menu', () => {
    it('should show View Terminal option when session exists', () => {
      const onViewTerminal = vi.fn();
      const member = createTestMember({ sessionName: 'test-session' });
      render(
        <TeamMemberRow
          {...defaultProps}
          member={member}
          onViewTerminal={onViewTerminal}
        />
      );

      expect(screen.getByText('View Terminal')).toBeInTheDocument();
    });

    it('should not show View Terminal option when no session', () => {
      const onViewTerminal = vi.fn();
      const member = createTestMember({ sessionName: undefined });
      render(
        <TeamMemberRow
          {...defaultProps}
          member={member}
          onViewTerminal={onViewTerminal}
        />
      );

      expect(screen.queryByText('View Terminal')).not.toBeInTheDocument();
    });

    it('should call onViewTerminal when View Terminal is clicked', () => {
      const onViewTerminal = vi.fn();
      const member = createTestMember({ sessionName: 'test-session' });
      render(
        <TeamMemberRow
          {...defaultProps}
          member={member}
          onViewTerminal={onViewTerminal}
        />
      );

      fireEvent.click(screen.getByText('View Terminal'));
      expect(onViewTerminal).toHaveBeenCalledWith(member);
    });
  });

  describe('loading state interactions', () => {
    it('should not allow multiple simultaneous start clicks', async () => {
      let resolveStart: () => void;
      const startPromise = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const onStart = vi.fn().mockReturnValue(startPromise);
      const member = createTestMember({ agentStatus: 'inactive' });

      render(<TeamMemberRow {...defaultProps} member={member} onStart={onStart} />);

      const playButton = screen.getByTitle('Start');

      // Click twice rapidly
      fireEvent.click(playButton);
      fireEvent.click(playButton);

      // Should only be called once due to isLoading check
      expect(onStart).toHaveBeenCalledTimes(1);

      // Cleanup
      resolveStart!();
    });

    it('should reset loading state after operation completes', async () => {
      // Create a promise that resolves after a delay
      let resolveStart: () => void;
      const startPromise = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const onStart = vi.fn().mockReturnValue(startPromise);
      const member = createTestMember({ agentStatus: 'inactive' });

      render(<TeamMemberRow {...defaultProps} member={member} onStart={onStart} />);

      const playButton = screen.getByTitle('Start');
      fireEvent.click(playButton);

      // Verify loading state is active
      await waitFor(() => {
        expect(playButton).toBeDisabled();
      });

      // Resolve the promise
      resolveStart!();

      // Wait for loading to reset
      await waitFor(() => {
        expect(playButton).not.toBeDisabled();
      });
    });
  });

  describe('sign-in needed', () => {
    it('does not render the chip when the member has no pending sign-in', () => {
      render(<TeamMemberRow member={createTestMember()} teamId="team-1" />);
      expect(screen.queryByTestId('sign-in-needed-chip')).not.toBeInTheDocument();
    });

    it('renders the chip and opens the panel with the URL and code', () => {
      const member = createTestMember({
        agentStatus: 'starting',
        loginRequired: { url: 'https://auth.openai.com/device', code: 'FBVZ-MJHKK', detectedAt: '2026-09-18T10:00:00.000Z' },
        runtimeType: 'codex-cli',
      });
      render(<TeamMemberRow member={member} teamId="team-1" />);

      expect(screen.getByTestId('sign-in-needed-chip')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
      expect(screen.getByRole('dialog')).toHaveTextContent('Test Developer needs you to sign in');
      expect(screen.getByTestId('sign-in-url')).toHaveAttribute('href', 'https://auth.openai.com/device');
      expect(screen.getByTestId('sign-in-code')).toHaveTextContent('FBVZ-MJHKK');
    });
  });
  describe('team lead toggle', () => {
    it('shows the Lead badge for the lead and no toggle', () => {
      render(<TeamMemberRow member={createTestMember()} teamId="team-1" isLead onMakeLead={vi.fn()} />);
      expect(screen.getByTestId('lead-badge')).toHaveTextContent('Lead');
      expect(screen.queryByTestId('make-lead-button')).not.toBeInTheDocument();
    });

    it('offers "Make lead" on other members — no hierarchical mode needed — and calls back with the member id', async () => {
      const onMakeLead = vi.fn().mockResolvedValue(undefined);
      render(<TeamMemberRow member={createTestMember({ id: 'nova' })} teamId="team-1" onMakeLead={onMakeLead} />);
      fireEvent.click(screen.getByTestId('make-lead-button'));
      await waitFor(() => expect(onMakeLead).toHaveBeenCalledWith('nova'));
      expect(screen.queryByTestId('lead-badge')).not.toBeInTheDocument();
    });

    it('shows neither without a handler (e.g. the orchestrator team)', () => {
      render(<TeamMemberRow member={createTestMember()} teamId="team-1" />);
      expect(screen.queryByTestId('make-lead-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('lead-badge')).not.toBeInTheDocument();
    });
  });
});
