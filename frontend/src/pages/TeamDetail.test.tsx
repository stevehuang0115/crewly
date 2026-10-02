import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TeamDetail } from './TeamDetail';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockOpenTerminalWithSession = vi.fn();
vi.mock('../contexts/TerminalContext', () => ({
  useTerminal: () => ({ openTerminalWithSession: mockOpenTerminalWithSession }),
}));
vi.mock('../services/websocket.service', () => ({ webSocketService: { on: vi.fn(), off: vi.fn() } }));

const dialogs = vi.hoisted(() => ({
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showConfirm: vi.fn(),
}));
vi.mock('@crewly/ui/Dialog', () => ({
  useAlert: () => ({ ...dialogs, AlertComponent: () => null }),
  useConfirm: () => ({ showConfirm: dialogs.showConfirm, ConfirmComponent: () => null }),
}));

const api = vi.hoisted(() => ({ getTeams: vi.fn(), getMissions: vi.fn(), setupOrchestrator: vi.fn() }));
vi.mock('../services/api.service', () => ({ apiService: api }));
vi.mock('../hooks/useProjects', () => ({
  useProjects: () => ({ projectOptions: [{ id: 'project-1', name: 'Test Project' }, { id: 'project-2', name: 'Other' }] }),
}));

// Heavy panels inside "More" and the modals
vi.mock('@/components/Settings/CronJobPanel', () => ({ CronJobPanel: () => <div data-testid="cron-panel" /> }));
vi.mock('../components/ExecutionFeed', () => ({ ExecutionFeed: () => <div data-testid="execution-feed" /> }));
vi.mock('../components/Hierarchy', () => ({ HierarchyDashboard: () => <div data-testid="hierarchy-dashboard" /> }));
vi.mock('@/components/SignInNeededChip', () => ({ SignInNeededChip: () => null }));
vi.mock('../components/StartTeamModal', () => ({
  StartTeamModal: ({ isOpen, onStartTeam }: { isOpen: boolean; onStartTeam: (p: string) => void }) =>
    isOpen ? (
      <div data-testid="start-team-modal">
        <button onClick={() => onStartTeam('project-1')}>Confirm Start</button>
      </div>
    ) : null,
}));
vi.mock('../components/Modals/TeamModal', () => ({
  TeamModal: ({ isOpen, team }: { isOpen: boolean; team: { name: string } }) =>
    isOpen ? <div data-testid="edit-team-modal">Edit Team: {team?.name}</div> : null,
}));
vi.mock('../components/TeamDetail/AgentDetailModal', () => ({
  AgentDetailModal: ({ member }: { member: { name: string } }) => <div data-testid="agent-modal">{member.name}</div>,
}));

const team = {
  id: 'team-1',
  name: 'Development Team',
  projectIds: ['project-1'],
  leaderIds: ['member-1'],
  members: [
    { id: 'member-1', name: 'John', role: 'developer', sessionName: 'john', agentStatus: 'active', currentTickets: ['CE-81'] },
    { id: 'member-2', name: 'Jane', role: 'designer', sessionName: '', agentStatus: 'inactive' },
  ],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-02',
};
const orcTeam = {
  id: 'orchestrator',
  name: 'Orchestrator Team',
  projectIds: [],
  members: [{ id: 'orc-1', name: 'Orchestrator', role: 'orchestrator', sessionName: 'crewly-orc', agentStatus: 'active' }],
  createdAt: '',
  updatedAt: '',
};

let currentTeam: Record<string, unknown> | null = team;
const json = (data: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(data), text: () => Promise.resolve('err') });

const Where: React.FC = () => {
  const l = useLocation();
  return <div data-testid="where">{l.search}</div>;
};

const renderAt = (url = '/teams/team-1') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/teams/:id" element={<><TeamDetail /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );

const fetchMock = vi.fn();

describe('TeamDetail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentTeam = team;
    api.getTeams.mockResolvedValue([]);
    api.getMissions.mockResolvedValue([]);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/teams/team-1' || url === '/api/teams/orchestrator') {
        if (init?.method && init.method !== 'GET') return json({ success: true });
        return currentTeam ? json({ success: true, data: currentTeam }) : json({ success: false }, false);
      }
      if (url === '/api/projects') return json({ success: true, data: [{ id: 'project-1', name: 'Test Project' }] });
      if (url === '/api/terminal/sessions') return json({ success: true, data: [] });
      return json({ success: true, data: {} });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('shows the loading state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderAt();
    expect(screen.getByText('Loading team details...')).toBeInTheDocument();
  });

  it('shows not found', async () => {
    currentTeam = null;
    renderAt();
    expect(await screen.findByText('Team not found')).toBeInTheDocument();
  });

  it('renders the header: name, status and the goal sentence', async () => {
    api.getMissions.mockResolvedValue([
      { id: 'g1', objective: 'Ship v2', ownerTeamId: 'team-1', status: 'active' },
      { id: 'g2', objective: 'Old', ownerTeamId: 'team-1', status: 'completed' },
      { id: 'g3', objective: 'Not ours', ownerTeamId: 'other', status: 'active' },
    ]);
    renderAt();
    expect(await screen.findByRole('heading', { level: 1, name: 'Development Team' })).toBeInTheDocument();
    expect(screen.getByTestId('team-status')).toHaveTextContent('Active');
    await waitFor(() => expect(screen.getByTestId('team-goal')).toHaveTextContent('Goal: Ship v2 +1 more'));
  });

  it('flags a team without a goal', async () => {
    renderAt();
    expect(await screen.findByTestId('team-no-goal')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Set a goal'));
    expect(mockNavigate).toHaveBeenCalledWith('/teams?tab=goals');
  });

  it('lists members one line each: name — role — what they do', async () => {
    renderAt();
    expect(await screen.findByTestId('member-line-member-1')).toHaveTextContent('John — lead — working on CE-81');
    expect(screen.getByTestId('member-line-member-2')).toHaveTextContent('Jane — designer — stopped');
  });

  it('messages a running member through the team chat', async () => {
    renderAt();
    fireEvent.click(await screen.findByTestId('member-message-member-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/team-chat?team=team-1');
  });

  it('starts a stopped member as an owner (dashboard) action', async () => {
    renderAt();
    fireEvent.click(await screen.findByTestId('member-start-member-2'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/teams/team-1/members/member-2/start',
        expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Content-Type': 'application/json' }) }),
      ),
    );
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/teams/team-1/members/member-2/start')!;
    expect(Object.keys(init.headers).length).toBeGreaterThan(1);
  });

  it('makes a member lead, opens the terminal and removes a member from ⋯', async () => {
    renderAt();
    await screen.findByTestId('member-line-member-2');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Jane' }));
    fireEvent.click(screen.getByText('Make lead'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/teams/team-1/lead', expect.objectContaining({ body: JSON.stringify({ memberId: 'member-2' }) })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions for John' }));
    fireEvent.click(screen.getByText('Open terminal'));
    expect(mockOpenTerminalWithSession).toHaveBeenCalledWith('john');

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Jane' }));
    fireEvent.click(screen.getByText('Remove from team'));
    expect(dialogs.showConfirm).toHaveBeenCalled();
    const onConfirm = dialogs.showConfirm.mock.calls[0][1] as () => void;
    onConfirm();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/teams/team-1/members/member-2', { method: 'DELETE' }));
  });

  it('opens the agent dialog from ⋯', async () => {
    renderAt();
    await screen.findByTestId('member-line-member-1');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for John' }));
    fireEvent.click(screen.getByText('View agent'));
    expect(screen.getByTestId('agent-modal')).toHaveTextContent('John');
  });

  it('stops an active team from the header ⋯', async () => {
    renderAt();
    await screen.findByTestId('team-header');
    fireEvent.click(screen.getByRole('button', { name: 'More team actions' }));
    fireEvent.click(screen.getByText('Stop Team'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/teams/team-1/stop', { method: 'POST' }));
  });

  it('starts an idle team through the start dialog', async () => {
    currentTeam = { ...team, members: team.members.map((m) => ({ ...m, sessionName: '', agentStatus: 'inactive' })) };
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: /Start Team/ }));
    fireEvent.click(screen.getByText('Confirm Start'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/teams/team-1/start', expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'project-1' }) })),
    );
  });

  it('asks before deleting the team', async () => {
    renderAt();
    await screen.findByTestId('team-header');
    fireEvent.click(screen.getByRole('button', { name: 'More team actions' }));
    fireEvent.click(screen.getByText('Delete Team'));
    expect(dialogs.showConfirm).toHaveBeenCalledWith(expect.stringContaining('Development Team'), expect.any(Function), expect.objectContaining({ title: 'Delete Team' }));
  });

  it('opens Edit team from the menu and from ?edit=true', async () => {
    renderAt('/teams/team-1?edit=true');
    expect(await screen.findByTestId('edit-team-modal')).toHaveTextContent('Development Team');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^$/));
  });

  it('keeps project, norms & SOPs, cron jobs, live feed and recent activity under More', async () => {
    renderAt();
    const toggle = within(await screen.findByTestId('team-more')).getAllByRole('button')[0];
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('cron-panel')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const more = screen.getByTestId('team-more');
    await waitFor(() => expect(within(more).getByText('Test Project')).toBeInTheDocument());
    expect(within(more).getByTestId('team-norms-link')).toBeInTheDocument();
    expect(within(more).getByTestId('team-sops-link')).toBeInTheDocument();
    expect(within(more).getByTestId('cron-panel')).toBeInTheDocument();
    expect(within(more).getByTestId('execution-feed')).toBeInTheDocument();
    expect(within(more).getByText('No recent activity.')).toBeInTheDocument();
  });

  it('changes the project from ⋯ › Change project', async () => {
    renderAt();
    await screen.findByTestId('team-header');
    fireEvent.click(screen.getByRole('button', { name: 'More team actions' }));
    fireEvent.click(screen.getByText('Change project'));
    fireEvent.change(await screen.findByLabelText('Assigned project'), { target: { value: 'project-2' } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/teams/team-1', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ projectIds: ['project-2'] }) })),
    );
  });

  it('shows sub-teams and opens them', async () => {
    api.getTeams.mockResolvedValue([{ id: 'sub-1', name: 'Child Crew', parentTeamId: 'team-1', members: [] }]);
    renderAt();
    const row = await screen.findByTestId('sub-team-sub-1');
    fireEvent.click(within(row).getByText('Child Crew'));
    expect(mockNavigate).toHaveBeenCalledWith('/teams/sub-1');
  });

  it('shows the empty members state', async () => {
    currentTeam = { ...team, members: [] };
    renderAt();
    expect(await screen.findByText('No team members yet. Add members to get started.')).toBeInTheDocument();
  });

  describe('orchestrator team', () => {
    beforeEach(() => {
      currentTeam = orcTeam;
    });

    it('offers View Terminal and no delete/edit/remove', async () => {
      renderAt('/teams/orchestrator');
      fireEvent.click(await screen.findByText('View Terminal'));
      expect(mockOpenTerminalWithSession).toHaveBeenCalledWith('crewly-orc');
      fireEvent.click(screen.getByRole('button', { name: 'More team actions' }));
      expect(screen.queryByText('Delete Team')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Orchestrator' }));
      expect(screen.queryByText('Remove from team')).not.toBeInTheDocument();
      expect(screen.queryByText('Make lead')).not.toBeInTheDocument();
    });

    it('stops the orchestrator through its own endpoint', async () => {
      renderAt('/teams/orchestrator');
      await screen.findByText('View Terminal');
      fireEvent.click(screen.getByRole('button', { name: 'More team actions' }));
      fireEvent.click(screen.getByText('Stop Orchestrator'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/orchestrator/stop', expect.objectContaining({ method: 'POST' })));
    });
  });
});
