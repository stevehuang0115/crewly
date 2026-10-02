import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Teams, TEAMS_VISIBLE } from './Teams';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const api = vi.hoisted(() => ({
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  deleteTeam: vi.fn(),
  createTeam: vi.fn(),
  startTeam: vi.fn(),
  stopTeam: vi.fn(),
}));
vi.mock('@/services/api.service', () => ({ apiService: api }));
vi.mock('../services/websocket.service', () => ({ webSocketService: { on: vi.fn(), off: vi.fn() } }));
vi.mock('@/utils/error-handling', () => ({ logSilentError: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ getAccessToken: () => 'tok' }) }));

const cloud = vi.hoisted(() => ({ isConnected: false, tier: null as string | null }));
vi.mock('../hooks/useCloudConnection', () => ({ useCloudConnection: () => cloud }));
const devices = vi.hoisted(() => ({ list: [] as unknown[], refresh: vi.fn() }));
vi.mock('../hooks/useDeviceHeartbeat', () => ({
  useDeviceHeartbeat: () => ({ devices: devices.list, isLoading: false, error: null, refresh: devices.refresh }),
}));
const pins = vi.hoisted(() => ({ togglePin: vi.fn() }));
vi.mock('../hooks/usePinnedFavorites', () => ({
  usePinnedFavorites: () => ({ isPinned: () => false, togglePin: pins.togglePin, pinnedItems: [] }),
}));

vi.mock('../components/Modals/TeamModal', () => ({
  TeamModal: ({ isOpen, onClose, onSubmit }: { isOpen: boolean; onClose: () => void; onSubmit: (d: unknown) => void }) =>
    isOpen ? (
      <div data-testid="team-modal">
        <button onClick={() => onSubmit({ name: 'New Crew', members: [] })}>Submit team</button>
        <button onClick={onClose}>Close modal</button>
      </div>
    ) : null,
}));
vi.mock('../components/Modals/TeamMemberModal', () => ({ TeamMemberModal: () => null }));
vi.mock('@/components/SignInNeededChip', () => ({ SignInNeededChip: () => null }));

const member = (id: string, name: string, agentStatus = 'inactive', role = 'developer') => ({ id, name, role, agentStatus });
const team = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  projectIds: [],
  members: [],
  createdAt: '',
  updatedAt: '',
  ...over,
});

const teams = [
  team('t1', 'Frontend Crew', { projectIds: ['p1'], members: [member('m1', 'Alice', 'active'), member('m2', 'Bob')] }),
  team('t2', 'Backend Crew', { projectIds: ['p2'], members: [member('m3', 'Carol')] }),
  team('parent', 'Platform', { members: [member('m4', 'Victor')] }),
  team('child', 'Platform Child', { parentTeamId: 'parent', members: [member('m5', 'Zed')] }),
];

const renderTeams = (props: React.ComponentProps<typeof Teams> = {}) =>
  render(
    <MemoryRouter>
      <Teams {...props} />
    </MemoryRouter>,
  );

// Multi-step UI tests: allow more than the 5s default on a busy machine.
vi.setConfig({ testTimeout: 20000 });

describe('Teams list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloud.isConnected = false;
    cloud.tier = null;
    devices.list = [];
    api.getTeams.mockResolvedValue(teams);
    api.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Web' },
      { id: 'p2', name: 'API' },
    ]);
    api.startTeam.mockResolvedValue(undefined);
    api.stopTeam.mockResolvedValue(undefined);
    api.deleteTeam.mockResolvedValue(undefined);
  });

  it('shows the loading state', () => {
    api.getTeams.mockImplementation(() => new Promise(() => {}));
    renderTeams();
    expect(screen.getByText('Loading teams...')).toBeInTheDocument();
  });

  it('lists top-level teams as compact rows (sub-teams stay under their parent)', async () => {
    renderTeams();
    const row = await screen.findByTestId('team-row-t1');
    expect(within(row).getByText('Frontend Crew')).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText('Web')).toBeInTheDocument());
    expect(within(row).getByText('Alice, Bob')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(screen.getByTestId('team-row-parent')).getByText('1 sub-team · 1 member')).toBeInTheDocument();
    expect(screen.queryByTestId('team-row-child')).not.toBeInTheDocument();
  });

  it('reports the top-level team count for the tab pill', async () => {
    const onCount = vi.fn();
    renderTeams({ onCount });
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(3));
  });

  it('searches by team or member name', async () => {
    renderTeams();
    await screen.findByText('Frontend Crew');
    fireEvent.change(screen.getByLabelText('Search teams'), { target: { value: 'carol' } });
    expect(screen.queryByText('Frontend Crew')).not.toBeInTheDocument();
    expect(screen.getByText('Backend Crew')).toBeInTheDocument();
  });

  it('filters by status and project through one Filter button', async () => {
    renderTeams();
    await screen.findByText('Frontend Crew');
    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByRole('radio', { name: /Active/ }));
    expect(screen.getByText('Frontend Crew')).toBeInTheDocument();
    expect(screen.queryByText('Backend Crew')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Status: Active' }));
    // The popover is still open: pick a project
    fireEvent.click(screen.getByRole('radio', { name: 'API' }));
    expect(screen.queryByText('Frontend Crew')).not.toBeInTheDocument();
    expect(screen.getByText('Backend Crew')).toBeInTheDocument();
  });

  it('shows the empty state when nothing matches', async () => {
    renderTeams();
    await screen.findByText('Frontend Crew');
    fireEvent.change(screen.getByLabelText('Search teams'), { target: { value: 'zzz' } });
    expect(screen.getByText('No teams found')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your search or filters')).toBeInTheDocument();
  });

  it('offers Create Team when there are no teams', async () => {
    api.getTeams.mockResolvedValue([]);
    renderTeams();
    fireEvent.click(await screen.findByRole('button', { name: /Create Team/ }));
    expect(screen.getByTestId('team-modal')).toBeInTheDocument();
  });

  it('switches to the tree view (parent and sub-teams)', async () => {
    renderTeams();
    await screen.findByText('Frontend Crew');
    fireEvent.click(screen.getByRole('button', { name: 'Tree view' }));
    expect(screen.getByText('Platform Child')).toBeInTheDocument();
    expect(screen.queryByTestId('teams-list')).not.toBeInTheDocument();
  });

  it('opens a team, starts and stops from the row', async () => {
    renderTeams();
    fireEvent.click(await screen.findByText('Frontend Crew'));
    expect(mockNavigate).toHaveBeenCalledWith('/teams/t1');

    fireEvent.click(screen.getByTestId('start-btn-t2'));
    await waitFor(() => expect(api.startTeam).toHaveBeenCalledWith('t2'));

    fireEvent.click(screen.getByTestId('stop-btn-t1'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop Team' }));
    await waitFor(() => expect(api.stopTeam).toHaveBeenCalledWith('t1'));
  });

  it('keeps edit, chat, wiki, pin and delete in the row menu', async () => {
    renderTeams();
    await screen.findByText('Frontend Crew');
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'More actions for Frontend Crew' }));
    open();
    fireEvent.click(screen.getByText('Edit team'));
    expect(mockNavigate).toHaveBeenCalledWith('/teams/t1?edit=true');
    open();
    fireEvent.click(screen.getByText('Open chat'));
    expect(mockNavigate).toHaveBeenCalledWith('/team-chat?team=t1');
    open();
    fireEvent.click(screen.getByText('Open wiki'));
    expect(mockNavigate).toHaveBeenCalledWith('/wiki?team=t1');
    open();
    fireEvent.click(screen.getByText('Pin to favorites'));
    expect(pins.togglePin).toHaveBeenCalledWith({ id: 't1', name: 'Frontend Crew', type: 'team' });
    open();
    fireEvent.click(screen.getByText('Delete team'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteTeam).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(screen.queryByText('Frontend Crew')).not.toBeInTheDocument());
  });

  it('creates a team through the controlled modal', async () => {
    const onCreateOpenChange = vi.fn();
    api.createTeam.mockResolvedValue(team('t9', 'New Crew'));
    renderTeams({ createOpen: true, onCreateOpenChange });
    await screen.findByText('Frontend Crew');
    fireEvent.click(screen.getByText('Submit team'));
    await waitFor(() => expect(api.createTeam).toHaveBeenCalled());
    expect(onCreateOpenChange).toHaveBeenCalledWith(false);
    expect(await screen.findByText('New Crew')).toBeInTheDocument();
  });

  it(`shows ${TEAMS_VISIBLE} rows, then "Show all"`, async () => {
    api.getTeams.mockResolvedValue(Array.from({ length: TEAMS_VISIBLE + 1 }, (_, i) => team(`x${i}`, `Crew ${i}`)));
    renderTeams();
    await screen.findByText('Crew 0');
    expect(screen.queryByText(`Crew ${TEAMS_VISIBLE}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Show all ${TEAMS_VISIBLE + 1}` }));
    expect(screen.getByText(`Crew ${TEAMS_VISIBLE}`)).toBeInTheDocument();
  });

  it('shows other online devices for Pro cloud users, collapsed', async () => {
    cloud.isConnected = true;
    cloud.tier = 'pro';
    devices.list = [{ deviceId: 'd1', deviceName: 'Air', email: 'a@b.c', teams: [{ id: 'x', name: 'Remote Crew', memberCount: 2 }] }];
    renderTeams();
    const toggle = await screen.findByRole('button', { name: /Online devices \(1\)/ });
    fireEvent.click(toggle);
    expect(screen.getByText('Air')).toBeVisible();
    expect(screen.getByText('Remote Crew')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh devices' }));
    expect(devices.refresh).toHaveBeenCalled();
  });
});
