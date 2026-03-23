/**
 * Tests for HeartbeatPanel component
 *
 * @module components/Settings/HeartbeatPanel.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { HeartbeatPanel } from './HeartbeatPanel';
import { useAgentHeartbeat } from '../../hooks/useAgentHeartbeat';
import type { AgentHeartbeatInfo } from '../../hooks/useAgentHeartbeat';

vi.mock('../../hooks/useAgentHeartbeat', () => ({
  useAgentHeartbeat: vi.fn(),
}));

const mockActiveAgent: AgentHeartbeatInfo = {
  memberId: 'member-001',
  name: 'Sam',
  sessionName: 'crewly-product-sam-217bfbbf',
  role: 'developer',
  teamName: 'Crewly Product',
  teamId: 'team-001',
  agentStatus: 'active',
  workingStatus: 'in_progress',
  readyAt: '2026-03-23T08:00:00.000Z',
  lastActivityCheck: new Date().toISOString(),
  runtimeType: 'claude-code',
};

const mockInactiveAgent: AgentHeartbeatInfo = {
  memberId: 'member-002',
  name: 'Leo',
  sessionName: 'crewly-product-leo-member-n',
  role: 'developer',
  teamName: 'Crewly Product',
  teamId: 'team-001',
  agentStatus: 'inactive',
  workingStatus: 'idle',
  readyAt: null,
  lastActivityCheck: null,
  runtimeType: 'claude-code',
};

const mockRefresh = vi.fn();

const defaultHookReturn = {
  agents: [mockActiveAgent, mockInactiveAgent],
  isLoading: false,
  error: null,
  refresh: mockRefresh,
};

describe('HeartbeatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAgentHeartbeat).mockReturnValue(defaultHookReturn);
  });

  it('should render loading state', () => {
    vi.mocked(useAgentHeartbeat).mockReturnValue({ ...defaultHookReturn, agents: [], isLoading: true });
    render(<HeartbeatPanel />);
    expect(screen.getByText('Loading heartbeat status...')).toBeInTheDocument();
  });

  it('should render error state', () => {
    vi.mocked(useAgentHeartbeat).mockReturnValue({ ...defaultHookReturn, agents: [], error: 'Network failure' });
    render(<HeartbeatPanel />);
    expect(screen.getByText('Network failure')).toBeInTheDocument();
  });

  it('should render empty state', () => {
    vi.mocked(useAgentHeartbeat).mockReturnValue({ ...defaultHookReturn, agents: [] });
    render(<HeartbeatPanel />);
    expect(screen.getByText('No agents found')).toBeInTheDocument();
  });

  it('should render section header with online count', () => {
    render(<HeartbeatPanel />);
    expect(screen.getByText('Agent Heartbeat')).toBeInTheDocument();
    expect(screen.getByText('1/2 online')).toBeInTheDocument();
  });

  it('should display agent names', () => {
    render(<HeartbeatPanel />);
    expect(screen.getByText('Sam')).toBeInTheDocument();
    expect(screen.getByText('Leo')).toBeInTheDocument();
  });

  it('should display Active badge for active agents', () => {
    render(<HeartbeatPanel />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('should display Offline badge for inactive agents', () => {
    render(<HeartbeatPanel />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('should display agent roles', () => {
    render(<HeartbeatPanel />);
    const roleElements = screen.getAllByText('developer');
    expect(roleElements.length).toBeGreaterThanOrEqual(2);
  });

  it('should display team names', () => {
    render(<HeartbeatPanel />);
    const teamElements = screen.getAllByText('Crewly Product');
    expect(teamElements.length).toBeGreaterThanOrEqual(2);
  });

  it('should display working status', () => {
    render(<HeartbeatPanel />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('should display runtime type', () => {
    render(<HeartbeatPanel />);
    const runtimeElements = screen.getAllByText('claude-code');
    expect(runtimeElements.length).toBeGreaterThanOrEqual(2);
  });

  it('should display "Never" for agents with no activity', () => {
    render(<HeartbeatPanel />);
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('should call refresh when Refresh button is clicked', () => {
    render(<HeartbeatPanel />);
    fireEvent.click(screen.getByText('Refresh'));
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('should show all online count as 0 when all agents are inactive', () => {
    vi.mocked(useAgentHeartbeat).mockReturnValue({
      ...defaultHookReturn,
      agents: [mockInactiveAgent],
    });
    render(<HeartbeatPanel />);
    expect(screen.getByText('0/1 online')).toBeInTheDocument();
  });

  it('should count started agents as online', () => {
    const startedAgent = { ...mockActiveAgent, agentStatus: 'started' as const };
    vi.mocked(useAgentHeartbeat).mockReturnValue({
      ...defaultHookReturn,
      agents: [startedAgent],
    });
    render(<HeartbeatPanel />);
    expect(screen.getByText('1/1 online')).toBeInTheDocument();
  });
});
