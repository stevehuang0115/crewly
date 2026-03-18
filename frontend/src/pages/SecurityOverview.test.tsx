// @vitest-environment jsdom
/**
 * SecurityOverview Page Tests
 *
 * @module pages/SecurityOverview.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SecurityOverview } from './SecurityOverview';

// Mock hooks
vi.mock('../hooks/usePtyStatus', () => ({
  usePtyStatus: vi.fn(() => ({
    sessions: [
      {
        sessionName: 'agent-sam',
        agentName: 'Sam',
        role: 'team-leader',
        agentStatus: 'active',
        workingStatus: 'coding',
        ptyPid: 4821,
        memoryUsage: 134217728,
        uptimeSeconds: 8040,
        fsScope: 'sandboxed',
        netScope: 'localhost',
      },
    ],
    summary: {
      totalAgents: 1,
      isolatedCount: 1,
      sharedCount: 0,
      status: 'healthy',
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

vi.mock('../hooks/useApprovalLog', () => ({
  useApprovalLog: vi.fn(() => ({
    events: [],
    filteredEvents: [
      {
        id: 'ev-1',
        timestamp: '2026-03-17T13:24:01.000Z',
        sessionName: 'agent-sam',
        agentName: 'Sam',
        toolName: 'git push',
        outcome: 'approved',
        riskLevel: 'medium',
      },
    ],
    summary: {
      totalToday: 12,
      deniedToday: 2,
      bypassedToday: 0,
      status: 'enforced',
    },
    filter: {},
    setFilter: vi.fn(),
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

vi.mock('../hooks/useDataSovereignty', () => ({
  useDataSovereignty: vi.fn(() => ({
    entries: [
      { path: '~/.crewly/memory/', type: 'Agent Memory', sizeBytes: 13000000, isExternal: false },
    ],
    summary: {
      totalLocalBytes: 48200000,
      externalConnections: 0,
      cloudSync: 'disabled',
      status: 'secure',
      lastScan: '2026-03-17T13:25:00.000Z',
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
  formatBytes: vi.fn((bytes: number) => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }),
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <SecurityOverview />
    </MemoryRouter>
  );

describe('SecurityOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render page header', () => {
    renderPage();
    expect(screen.getByText('Security Overview')).toBeInTheDocument();
    expect(screen.getByText('Your instance security posture at a glance')).toBeInTheDocument();
  });

  it('should render three summary cards', () => {
    renderPage();
    expect(screen.getByTestId('card-pty')).toBeInTheDocument();
    expect(screen.getByTestId('card-storage')).toBeInTheDocument();
    expect(screen.getByTestId('card-approvals')).toBeInTheDocument();
  });

  it('should show PTY summary stats', () => {
    renderPage();
    const ptyCard = screen.getByTestId('card-pty');
    expect(ptyCard).toHaveTextContent('1 agents');
    expect(ptyCard).toHaveTextContent('1 isolated');
    expect(ptyCard).toHaveTextContent('0 shared');
    expect(ptyCard).toHaveTextContent('HEALTHY');
  });

  it('should show storage summary stats', () => {
    renderPage();
    const storageCard = screen.getByTestId('card-storage');
    expect(storageCard).toHaveTextContent('Local DB');
    expect(storageCard).toHaveTextContent('0 cloud');
    expect(storageCard).toHaveTextContent('SECURE');
  });

  it('should show approvals summary stats', () => {
    renderPage();
    const approvalsCard = screen.getByTestId('card-approvals');
    expect(approvalsCard).toHaveTextContent('12 today');
    expect(approvalsCard).toHaveTextContent('2 denied');
    expect(approvalsCard).toHaveTextContent('0 bypassed');
    expect(approvalsCard).toHaveTextContent('ENFORCED');
  });

  it('should render PTY Isolation Map section', () => {
    renderPage();
    expect(screen.getByText('PTY Isolation Map')).toBeInTheDocument();
  });

  it('should render Approval Audit Log section', () => {
    renderPage();
    expect(screen.getByText('Approval Audit Log')).toBeInTheDocument();
  });

  it('should render Data Sovereignty Report section', () => {
    renderPage();
    expect(screen.getByText('Data Sovereignty Report')).toBeInTheDocument();
  });

  it('should show agent data in PTY map', () => {
    renderPage();
    // Sam appears in both PTY map and audit log
    const samElements = screen.getAllByText('Sam');
    expect(samElements.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('PTY pid:4821')).toBeInTheDocument();
  });

  it('should show approval events', () => {
    renderPage();
    expect(screen.getByText('git push')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('should show storage entries in data sovereignty report', () => {
    renderPage();
    expect(screen.getByText('~/.crewly/memory/')).toBeInTheDocument();
    expect(screen.getByText('Agent Memory')).toBeInTheDocument();
  });
});
