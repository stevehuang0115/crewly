// @vitest-environment jsdom
/**
 * PtyIsolationMap Component Tests
 *
 * @module components/Security/PtyIsolationMap.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PtyIsolationMap } from './PtyIsolationMap';
import type { PtySessionInfo } from '../../hooks/usePtyStatus';

const mockSessions: PtySessionInfo[] = [
  {
    sessionName: 'agent-sam',
    agentName: 'Sam',
    role: 'team-leader',
    agentStatus: 'active',
    workingStatus: 'in_progress',
    ptyPid: 4821,
    memoryUsage: 134217728,
    uptimeSeconds: 8040,
    fsScope: 'sandboxed',
    netScope: 'localhost',
  },
  {
    sessionName: 'agent-leo',
    agentName: 'Leo',
    role: 'developer',
    agentStatus: 'active',
    workingStatus: 'testing',
    ptyPid: 4822,
    memoryUsage: 100663296,
    uptimeSeconds: 6480,
    fsScope: 'sandboxed',
    netScope: 'localhost',
  },
];

describe('PtyIsolationMap', () => {
  it('should render section heading', () => {
    render(<PtyIsolationMap sessions={[]} loading={false} />);
    expect(screen.getByText('PTY Isolation Map')).toBeInTheDocument();
  });

  it('should show loading state', () => {
    render(<PtyIsolationMap sessions={[]} loading={true} />);
    expect(screen.getByText('Loading PTY sessions...')).toBeInTheDocument();
  });

  it('should show empty state when no sessions', () => {
    render(<PtyIsolationMap sessions={[]} loading={false} />);
    expect(screen.getByText('No active agent sessions')).toBeInTheDocument();
  });

  it('should render session nodes', () => {
    render(<PtyIsolationMap sessions={mockSessions} loading={false} />);
    expect(screen.getByText('Sam')).toBeInTheDocument();
    expect(screen.getByText('Leo')).toBeInTheDocument();
    expect(screen.getByText('(team-leader)')).toBeInTheDocument();
    expect(screen.getByText('(developer)')).toBeInTheDocument();
  });

  it('should show PTY details for each session', () => {
    render(<PtyIsolationMap sessions={mockSessions} loading={false} />);
    expect(screen.getByText('PTY pid:4821')).toBeInTheDocument();
    expect(screen.getByText('PTY pid:4822')).toBeInTheDocument();
  });

  it('should show cross-access blocked indicators between sessions', () => {
    render(<PtyIsolationMap sessions={mockSessions} loading={false} />);
    expect(screen.getByText('(no lateral access)')).toBeInTheDocument();
  });

  it('should show legend', () => {
    render(<PtyIsolationMap sessions={mockSessions} loading={false} />);
    // "Active" appears both in session nodes and legend, so use getAllByText
    const activeElements = screen.getAllByText('Active');
    expect(activeElements.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText('No cross-session access')).toBeInTheDocument();
  });

  it('should toggle collapse/expand', () => {
    render(<PtyIsolationMap sessions={mockSessions} loading={false} />);

    // Initially expanded — sessions should be visible
    expect(screen.getByText('Sam')).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByRole('button', { name: /PTY Isolation Map/i }));

    // Sessions should be hidden
    expect(screen.queryByText('Sam')).not.toBeInTheDocument();

    // Click to expand again
    fireEvent.click(screen.getByRole('button', { name: /PTY Isolation Map/i }));
    expect(screen.getByText('Sam')).toBeInTheDocument();
  });

  it('should expand session details on click', () => {
    render(<PtyIsolationMap sessions={mockSessions} loading={false} />);

    const samNode = screen.getByTestId('pty-node-agent-sam');
    fireEvent.click(samNode);

    expect(screen.getByText('Session: agent-sam')).toBeInTheDocument();
    expect(screen.getByText('Process ID: 4821')).toBeInTheDocument();
  });

  it('should have proper aria attributes', () => {
    render(<PtyIsolationMap sessions={mockSessions} loading={false} />);

    const section = screen.getByRole('img');
    expect(section).toHaveAttribute('aria-label', expect.stringContaining('2 isolated agent sessions'));
  });

  it('should handle sessions with null PTY data', () => {
    const sessionsWithNull: PtySessionInfo[] = [{
      sessionName: 'agent-null',
      agentName: 'NullAgent',
      role: 'dev',
      agentStatus: 'inactive',
      workingStatus: 'idle',
      ptyPid: null,
      memoryUsage: null,
      uptimeSeconds: null,
      fsScope: 'sandboxed',
      netScope: 'localhost',
    }];

    render(<PtyIsolationMap sessions={sessionsWithNull} loading={false} />);
    expect(screen.getByText('PTY pid:N/A')).toBeInTheDocument();
  });
});
