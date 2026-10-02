/**
 * Dashboard Page Tests
 *
 * The redesigned Dashboard: Get started, Waiting on you, Your crew right
 * now, and the header "⋯" holding Factory / New project / New team.
 *
 * @module pages/Dashboard.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard, DASHBOARD_LINKS, RUNNING_ITEMS_API, fetchRunningItems } from './Dashboard';
import { apiService } from '../services/api.service';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../services/api.service', () => ({
  apiService: { getTeams: vi.fn() },
}));

// The cards have their own tests; here they only have to be mounted.
vi.mock('@/components/Dashboard/WaitingOnYouCard', () => ({
  WaitingOnYouCard: ({ directory }: { directory: Map<string, unknown> }) => (
    <div data-testid="waiting-on-you-card-mock" data-agents={directory.size} />
  ),
}));
vi.mock('@/components/Onboarding/GettingStartedCard', () => ({
  GettingStartedCard: () => <div data-testid="getting-started-card-mock" />,
}));

const teams = [
  {
    id: 'team-1',
    name: 'CE',
    members: [
      { id: 'm1', name: 'Owen', sessionName: 'ce-owen', role: 'developer', systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code' },
      { id: 'm2', name: 'Sam', sessionName: 'ce-sam', role: 'developer', systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code' },
    ],
  },
];

function mockFetch(body: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => body }));
}

const renderDashboard = () => render(<MemoryRouter><Dashboard /></MemoryRouter>);

describe('Dashboard Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiService.getTeams).mockResolvedValue(teams as never);
    mockFetch({ success: true, data: [{ target: 'ce-owen', status: 'running', title: 'working on CE-81' }] });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the header, Get started, Waiting on you (with the agent lookup) and the crew', async () => {
    renderDashboard();
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByTestId('getting-started-card-mock')).toBeInTheDocument();
    expect(await screen.findByText('Your crew right now')).toBeInTheDocument();
    expect(screen.getByTestId('crew-ce-owen')).toHaveTextContent('Owen · CE — working on CE-81');
    expect(screen.getByTestId('crew-idle')).toHaveTextContent('1 idle — Sam');
    expect(screen.getByTestId('waiting-on-you-card-mock')).toHaveAttribute('data-agents', '2');
    expect(fetch).toHaveBeenCalledWith(RUNNING_ITEMS_API);
  });

  it('no longer shows the health bar, score cards or project/team grids', async () => {
    renderDashboard();
    await screen.findByText('Your crew right now');
    expect(screen.queryByTestId('health-bar')).not.toBeInTheDocument();
    expect(screen.queryByText('Create New Project')).not.toBeInTheDocument();
    expect(screen.queryByText('Running Agents')).not.toBeInTheDocument();
  });

  it('keeps Factory, New project and New team in the header ⋯', async () => {
    renderDashboard();
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'More dashboard actions' }));
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open the 3D Factory' }));
    expect(mockNavigate).toHaveBeenLastCalledWith('/factory');
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'New project' }));
    expect(mockNavigate).toHaveBeenLastCalledWith(DASHBOARD_LINKS.newProject);
    expect(DASHBOARD_LINKS.newProject).toBe('/projects?create=true');
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'New team' }));
    expect(mockNavigate).toHaveBeenLastCalledWith('/teams?create=true');
  });

  it('shows a retry line when the crew cannot load', async () => {
    vi.mocked(apiService.getTeams).mockRejectedValueOnce(new Error('down')).mockResolvedValue(teams as never);
    renderDashboard();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your crew.");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Your crew right now')).toBeInTheDocument());
  });

  it('fetchRunningItems is best-effort', async () => {
    mockFetch({}, false);
    expect(await fetchRunningItems()).toEqual([]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('x')));
    expect(await fetchRunningItems()).toEqual([]);
  });
});
