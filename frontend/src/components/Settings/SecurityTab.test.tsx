/**
 * Tests for Settings › Security.
 *
 * @module components/Settings/SecurityTab.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SecurityTab } from './SecurityTab';
import type { UsePtyStatusResult } from '../../hooks/usePtyStatus';

const ptyResult: UsePtyStatusResult = {
  sessions: [
    {
      sessionName: 'crewly-orc',
      agentName: 'Orc',
      role: 'orchestrator',
      agentStatus: 'active',
      workingStatus: 'idle',
      ptyPid: 85702,
      memoryUsage: null,
      uptimeSeconds: 3600,
      fsScope: 'sandboxed',
      netScope: 'localhost',
    },
  ],
  summary: { totalAgents: 10, isolatedCount: 10, sharedCount: 0, status: 'healthy' },
  loading: false,
  error: null,
  refresh: vi.fn(),
};
const usePtyStatus = vi.fn(() => ptyResult);

vi.mock('../../hooks/usePtyStatus', () => ({ usePtyStatus: () => usePtyStatus() }));

const useApprovalLog = vi.fn();
const useDataSovereignty = vi.fn();
vi.mock('../../hooks/useApprovalLog', () => ({ useApprovalLog: () => useApprovalLog() }));
vi.mock('../../hooks/useDataSovereignty', () => ({ useDataSovereignty: () => useDataSovereignty(), formatBytes: String }));

describe('SecurityTab', () => {
  beforeEach(() => {
    usePtyStatus.mockReturnValue(ptyResult);
  });

  it('shows the isolation check from live data', () => {
    render(<SecurityTab />);
    expect(screen.getByText('10 of 10 agents isolated')).toBeInTheDocument();
    expect(screen.getByTestId('isolation-status')).toHaveTextContent('Healthy');
  });

  it('marks approvals and storage as not connected instead of showing sample data', () => {
    render(<SecurityTab />);
    expect(screen.getByTestId('approvals-not-connected')).toHaveTextContent('Not connected yet');
    expect(screen.getByTestId('storage-not-connected')).toHaveTextContent('Not connected yet');
    expect(useApprovalLog).not.toHaveBeenCalled();
    expect(useDataSovereignty).not.toHaveBeenCalled();
    expect(screen.queryByText('~/.crewly/memory/')).not.toBeInTheDocument();
    expect(screen.getByTestId('security-score-note')).toHaveTextContent('No overall score yet');
  });

  it('keeps the isolation map behind a click', () => {
    render(<SecurityTab />);
    expect(screen.queryByText('Orc')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Agent isolation map'));
    expect(screen.getByText('Orc')).toBeInTheDocument();
  });

  it('flags a problem in the attention tone', () => {
    usePtyStatus.mockReturnValue({ ...ptyResult, summary: { totalAgents: 3, isolatedCount: 2, sharedCount: 1, status: 'warning' } });
    render(<SecurityTab />);
    expect(screen.getByText('2 of 3 agents isolated')).toBeInTheDocument();
    expect(screen.getByTestId('isolation-status')).toHaveTextContent('Warning');
  });

  it('says when the sessions could not be loaded', () => {
    usePtyStatus.mockReturnValue({ ...ptyResult, error: 'Failed to fetch PTY sessions' });
    render(<SecurityTab />);
    expect(screen.getByText('Could not load the running sessions')).toBeInTheDocument();
    expect(screen.getByTestId('isolation-status')).toHaveTextContent('Error');
  });
});
