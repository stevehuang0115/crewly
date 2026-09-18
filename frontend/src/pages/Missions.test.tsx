// Layout + ScoreCard consistency
// Updated: PageToolbar adoption
/**
 * Missions Page Tests
 *
 * @module pages/Missions.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Missions } from './Missions';

// Mock api.service
vi.mock('../services/api.service', () => ({
  apiService: {
    getMissions: vi.fn(),
    createMission: vi.fn(),
    getCascadeSummary: vi.fn(),
    getTeams: vi.fn(),
    getProjects: vi.fn(),
    approveMission: vi.fn(),
    rejectMission: vi.fn(),
  },
}));

// Mock UI components to simplify rendering
vi.mock('../components/UI/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading...</div>,
}));

import { apiService } from '../services/api.service';

const mockMission = {
  id: '12345678-abcd-1234-abcd-123456789012',
  objective: 'Deliver V3 Architecture',
  ownerTeamId: 'team-alpha-123',
  successCriteria: ['All tests pass', 'Build succeeds', 'Deployed to staging'],
  currentStrategy: 'Incremental delivery with CI/CD pipeline',
  activeProjectTaskIds: ['task-1', 'task-2'],
  cadence: '0 9 * * 1',
  status: 'active' as const,
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-05T10:00:00.000Z',
  learnings: [],
};

/**
 * Helper to render within router context.
 */
function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('Missions Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiService.getCascadeSummary).mockRejectedValue(new Error('no cascade'));
    vi.mocked(apiService.getTeams).mockResolvedValue([]);
    vi.mocked(apiService.getProjects).mockResolvedValue([]);
  });

  it('renders loading state initially', () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    );
    renderWithRouter(<Missions />);
    expect(screen.getByTestId('missions-loading')).toBeTruthy();
  });

  it('renders empty state when no missions exist', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-empty')).toBeTruthy();
    });

    expect(screen.getByText('No missions created yet.')).toBeTruthy();
  });

  it('renders New Mission button', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-empty')).toBeTruthy();
    });

    expect(screen.getByTestId('missions-new')).toBeTruthy();
    expect(screen.getByText('New Mission')).toBeTruthy();
  });

  it('renders mission list when data is returned', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([mockMission]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    expect(screen.getByText('Deliver V3 Architecture')).toBeTruthy();
    expect(screen.getByText('2 active tasks')).toBeTruthy();
    expect(screen.getByTestId(`mission-row-${mockMission.id}`)).toBeTruthy();
  });

  it('renders error state on API failure', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error'),
    );
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    expect(screen.getByText('Network error')).toBeTruthy();
  });

  it('filters missions by status', async () => {
    const completedMission = { ...mockMission, id: 'completed-1', status: 'completed', objective: 'Old Mission' };
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockMission,
      completedMission,
    ]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    // Click Completed filter
    fireEvent.click(screen.getByRole('tab', { name: /Completed/ }));

    expect(screen.getByText('Old Mission')).toBeTruthy();
    expect(screen.queryByText('Deliver V3 Architecture')).toBeFalsy();
  });

  it('searches missions by objective', async () => {
    const anotherMission = { ...mockMission, id: 'other-1', objective: 'Marketing Campaign' };
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockMission,
      anotherMission,
    ]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    // Type in search
    const searchInput = screen.getByPlaceholderText(/Search by mission/);
    fireEvent.change(searchInput, { target: { value: 'Marketing' } });

    // Search is debounced (setTimeout, 0ms in tests) so the filter applies asynchronously.
    await waitFor(() => {
      expect(screen.queryByText('Deliver V3 Architecture')).toBeFalsy();
    });
    expect(screen.getByText('Marketing Campaign')).toBeTruthy();
  });

  it('shows success criteria badges', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([mockMission]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    expect(screen.getByText('All tests pass')).toBeTruthy();
    expect(screen.getByText('Build succeeds')).toBeTruthy();
  });

  it('calls refresh when button is clicked', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-empty')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('missions-refresh'));

    expect(apiService.getMissions).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Priority / Period / Team filters
  // ---------------------------------------------------------------------------

  const now = new Date();
  const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const criticalActiveMission = {
    ...mockMission,
    id: 'crit-1',
    objective: 'Critical Active Q2',
    ownerTeamId: 'team-alpha',
    priority: 'critical',
    period: { type: 'quarterly', startDate: yesterday, endDate: tomorrow, label: '2026 Q2' },
  };
  const mediumPastMission = {
    ...mockMission,
    id: 'med-1',
    objective: 'Medium Past Work',
    ownerTeamId: 'team-beta',
    priority: 'medium',
    period: { type: 'monthly', startDate: past, endDate: past, label: '2026-03 March' },
  };
  const lowUpcomingMission = {
    ...mockMission,
    id: 'low-1',
    objective: 'Low Upcoming Plan',
    ownerTeamId: 'team-alpha',
    priority: 'low',
    period: { type: 'monthly', startDate: future, endDate: future, label: '2026-06 June' },
  };

  it('renders priority badge for missions that have priority', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([criticalActiveMission]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    const badge = screen.getByTestId(`mission-priority-${criticalActiveMission.id}`);
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('Critical');
  });

  it('renders period label when mission has a period', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([criticalActiveMission]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    expect(screen.getByTestId(`mission-period-${criticalActiveMission.id}`)).toBeTruthy();
    expect(screen.getByText('2026 Q2')).toBeTruthy();
  });

  it('filters by priority when a priority pill is selected', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      criticalActiveMission,
      mediumPastMission,
    ]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('priority-filter-critical'));

    expect(screen.getByText('Critical Active Q2')).toBeTruthy();
    expect(screen.queryByText('Medium Past Work')).toBeFalsy();
  });

  it('filters by period state (current/past/upcoming)', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      criticalActiveMission,
      mediumPastMission,
      lowUpcomingMission,
    ]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('period-filter-current'));
    expect(screen.getByText('Critical Active Q2')).toBeTruthy();
    expect(screen.queryByText('Medium Past Work')).toBeFalsy();
    expect(screen.queryByText('Low Upcoming Plan')).toBeFalsy();

    fireEvent.click(screen.getByTestId('period-filter-past'));
    expect(screen.getByText('Medium Past Work')).toBeTruthy();
    expect(screen.queryByText('Critical Active Q2')).toBeFalsy();

    fireEvent.click(screen.getByTestId('period-filter-upcoming'));
    expect(screen.getByText('Low Upcoming Plan')).toBeTruthy();
    expect(screen.queryByText('Critical Active Q2')).toBeFalsy();
  });

  it('filters by team', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      criticalActiveMission,
      mediumPastMission,
    ]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('team-filter-team-beta'));

    expect(screen.getByText('Medium Past Work')).toBeTruthy();
    expect(screen.queryByText('Critical Active Q2')).toBeFalsy();
  });

  it('sorts missions by priority when status is equal', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      lowUpcomingMission,        // low, active
      criticalActiveMission,     // critical, active
    ]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    const rows = screen.getAllByTestId(/^mission-row-/);
    // Critical should come before low when both are active
    expect(rows[0].getAttribute('data-testid')).toBe(`mission-row-${criticalActiveMission.id}`);
    expect(rows[1].getAttribute('data-testid')).toBe(`mission-row-${lowUpcomingMission.id}`);
  });

  // ---------------------------------------------------------------------------
  // KR cards and parent hierarchy
  // ---------------------------------------------------------------------------

  const parentMission = {
    ...mockMission,
    id: 'parent-1',
    objective: 'Company-level OKR',
    priority: 'critical',
  };

  const childMissionWithKrs = {
    ...mockMission,
    id: 'child-1',
    objective: 'Team OKR — ship V3',
    parentMissionId: 'parent-1',
    priority: 'high',
    successCriteria: [],
    keyResults: [
      {
        id: 'kr-1',
        title: 'Reach $5k MRR',
        metricType: 'currency',
        baseline: 0,
        target: 5000,
        current: 1500,
        unit: '$',
        status: 'on_track',
      },
      {
        id: 'kr-2',
        title: 'Reduce onboarding time',
        metricType: 'number',
        baseline: 30,
        target: 5,
        current: 5,
        unit: 'min',
        status: 'achieved',
      },
    ],
  };

  it('renders a KR card for every key result and hides successCriteria preview', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([childMissionWithKrs]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    expect(screen.getByTestId(`mission-krs-${childMissionWithKrs.id}`)).toBeTruthy();
    expect(screen.getByTestId(`mission-kr-${childMissionWithKrs.id}-kr-1`)).toBeTruthy();
    expect(screen.getByTestId(`mission-kr-${childMissionWithKrs.id}-kr-2`)).toBeTruthy();
    expect(screen.getByText('Reach $5k MRR')).toBeTruthy();
    expect(screen.getByText(/2 KRs/)).toBeTruthy();
  });

  it('nests a child under its parent (no parent chip) when both are in the list', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      childMissionWithKrs,
      parentMission,
    ]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    const children = screen.getByTestId(`mission-children-${parentMission.id}`);
    expect(children.querySelector(`[data-testid="mission-row-${childMissionWithKrs.id}"]`)).toBeTruthy();
    expect(screen.queryByTestId(`mission-parent-${childMissionWithKrs.id}`)).toBeNull();
    // Only the parent is a top-level node
    const list = screen.getByTestId('missions-list');
    const topLevel = Array.from(list.children).map((el) => el.getAttribute('data-testid'));
    expect(topLevel).toEqual([`mission-node-${parentMission.id}`]);
  });

  it('renders a parent chip fallback when parent mission is not in the list', async () => {
    const orphan = { ...childMissionWithKrs, id: 'orphan-1', parentMissionId: 'ghost-xyz' };
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([orphan]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    const chip = screen.getByTestId('mission-parent-orphan-1');
    expect(chip).toBeTruthy();
    // Falls back to an 8-char ID prefix when parent isn't loaded
    expect(chip.textContent).toMatch(/ghost-xy/);
  });
  // ---------------------------------------------------------------------------
  // Cascade levels, roll-up, approval
  // ---------------------------------------------------------------------------

  const companyMission = {
    ...mockMission,
    id: 'co-1',
    objective: 'Company: reach profitability',
    level: 'company',
    approval: { state: 'approved' },
    keyResults: [],
  };
  const teamMission = {
    ...mockMission,
    id: 'team-1',
    objective: 'Team: grow MRR',
    parentMissionId: 'co-1',
    level: 'team',
    approval: { state: 'approved' },
    keyResults: [],
  };
  const projectMission = {
    ...mockMission,
    id: 'proj-1',
    objective: 'Project: launch pricing page',
    parentMissionId: 'team-1',
    level: 'project',
    projectId: 'p-1',
    approval: { state: 'pending_approval', proposedBy: 'agent-1' },
    keyResults: [],
  };

  it('renders company → team → project nested three levels deep with level badges', async () => {
    vi.mocked(apiService.getMissions).mockResolvedValue([projectMission, teamMission, companyMission]);
    renderWithRouter(<Missions />);

    await waitFor(() => expect(screen.getByTestId('missions-list')).toBeTruthy());

    const teamChildren = screen.getByTestId('mission-children-team-1');
    expect(teamChildren.querySelector('[data-testid="mission-row-proj-1"]')).toBeTruthy();
    const companyChildren = screen.getByTestId('mission-children-co-1');
    expect(companyChildren.querySelector('[data-testid="mission-row-team-1"]')).toBeTruthy();

    expect(screen.getByTestId('mission-row-co-1').querySelector('[data-testid="level-badge-company"]')).toBeTruthy();
    expect(screen.getByTestId('mission-row-team-1').querySelector('[data-testid="level-badge-team"]')).toBeTruthy();
    expect(screen.getByTestId('mission-row-proj-1').querySelector('[data-testid="level-badge-project"]')).toBeTruthy();
  });

  it('promotes a filtered child to a root when its parent is filtered out', async () => {
    vi.mocked(apiService.getMissions).mockResolvedValue([
      { ...companyMission, status: 'completed' },
      teamMission,
    ]);
    renderWithRouter(<Missions />);
    await waitFor(() => expect(screen.getByTestId('missions-list')).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /Active/ }));
    expect(screen.getByTestId('mission-row-team-1')).toBeTruthy();
    expect(screen.queryByTestId('mission-row-co-1')).toBeNull();
  });

  it('renders the rolled-up progress bar and KR status counts from the cascade summary', async () => {
    vi.mocked(apiService.getMissions).mockResolvedValue([companyMission, teamMission]);
    vi.mocked(apiService.getCascadeSummary).mockResolvedValue({
      missionId: 'co-1',
      level: 'company',
      totalKRs: 2,
      achieved: 1,
      onTrack: 0,
      atRisk: 1,
      offTrack: 0,
      notStarted: 0,
      overallProgress: 60,
      recommendation: 'continue',
      childMissionCount: 1,
      rolledUpProgress: 72,
      children: [
        {
          missionId: 'team-1',
          level: 'team',
          totalKRs: 1,
          achieved: 0,
          onTrack: 1,
          atRisk: 0,
          offTrack: 0,
          notStarted: 0,
          overallProgress: 84,
          recommendation: 'continue',
          childMissionCount: 0,
          rolledUpProgress: 84,
          children: [],
        },
      ],
    });
    renderWithRouter(<Missions />);

    await waitFor(() => expect(screen.getByTestId('mission-rollup-co-1')).toBeTruthy());
    // Only the root is fetched; the child's roll-up comes from the flattened tree
    expect(apiService.getCascadeSummary).toHaveBeenCalledTimes(1);
    expect(apiService.getCascadeSummary).toHaveBeenCalledWith('co-1');

    const root = screen.getByTestId('mission-rollup-co-1');
    expect(root.textContent).toContain('72%');
    expect(root.textContent).toContain('Rolled-up (1 child)');
    expect(root.querySelector('[data-testid="kr-count-achieved"]')?.textContent).toContain('1 achieved');
    expect(root.querySelector('[data-testid="kr-count-at_risk"]')?.textContent).toContain('1 at risk');

    const child = screen.getByTestId('mission-rollup-team-1');
    expect(child.textContent).toContain('84%');
  });

  it('shows the pending chip with Approve/Reject and updates the chip after approval', async () => {
    vi.mocked(apiService.getMissions).mockResolvedValue([companyMission, teamMission, projectMission]);
    vi.mocked(apiService.approveMission).mockResolvedValue({
      ...projectMission,
      approval: { state: 'approved', decidedBy: 'steve', decidedAt: '2026-09-18T00:00:00.000Z' },
    });
    renderWithRouter(<Missions />);

    await waitFor(() => expect(screen.getByTestId('missions-list')).toBeTruthy());
    expect(screen.getByTestId('missions-pending-hint').textContent).toContain('1 proposal');
    const row = screen.getByTestId('mission-row-proj-1');
    expect(row.querySelector('[data-testid="approval-chip-pending_approval"]')).toBeTruthy();
    // Approved (legacy) missions do not show a chip
    expect(screen.getByTestId('mission-row-co-1').querySelector('[data-testid^="approval-chip-"]')).toBeNull();

    fireEvent.click(screen.getByTestId('approve-proj-1'));

    await waitFor(() =>
      expect(screen.getByTestId('mission-row-proj-1').querySelector('[data-testid="approval-chip-approved"]')).toBeTruthy(),
    );
    expect(apiService.approveMission).toHaveBeenCalledWith('proj-1');
    expect(screen.queryByTestId('approve-proj-1')).toBeNull();
    expect(screen.queryByTestId('missions-pending-hint')).toBeNull();
  });

  it('shows the team name from the teams API instead of the raw id', async () => {
    vi.mocked(apiService.getTeams).mockResolvedValue([
      { id: 'team-alpha-123', name: 'Alpha Squad' },
    ] as never);
    vi.mocked(apiService.getMissions).mockResolvedValue([mockMission]);
    renderWithRouter(<Missions />);

    await waitFor(() =>
      expect(screen.getByTestId(`mission-team-${mockMission.id}`).textContent).toContain('Alpha Squad'),
    );
  });

  it('renders the cadence on each row', async () => {
    vi.mocked(apiService.getMissions).mockResolvedValue([mockMission]);
    renderWithRouter(<Missions />);
    await waitFor(() => expect(screen.getByTestId('missions-list')).toBeTruthy());
    expect(screen.getByTestId(`mission-cadence-${mockMission.id}`).textContent).toContain('0 9 * * 1');
  });

  // ---------------------------------------------------------------------------
  // Create modal: level / parent / project pickers
  // ---------------------------------------------------------------------------

  it('filters the parent picker to the valid parent level and requires a project for project missions', async () => {
    vi.mocked(apiService.getMissions).mockResolvedValue([companyMission, teamMission]);
    vi.mocked(apiService.getProjects).mockResolvedValue([{ id: 'p-1', name: 'Pricing site' }] as never);
    vi.mocked(apiService.createMission).mockResolvedValue({});
    renderWithRouter(<Missions />);
    await waitFor(() => expect(screen.getByTestId('missions-list')).toBeTruthy());

    fireEvent.click(screen.getByTestId('missions-new'));
    // Company level: no parent picker, no project picker
    expect(screen.queryByTestId('create-mission-parent')).toBeNull();
    expect(screen.queryByTestId('create-mission-project')).toBeNull();

    // Team level: only company missions are offered as parents
    fireEvent.change(screen.getByTestId('create-mission-level'), { target: { value: 'team' } });
    const parentSelect = screen.getByTestId('create-mission-parent') as HTMLSelectElement;
    const teamParentLabels = Array.from(parentSelect.options).map((o) => o.textContent);
    expect(teamParentLabels).toContain('Company: reach profitability');
    expect(teamParentLabels).not.toContain('Team: grow MRR');

    // Project level: only team missions are offered, and the project picker appears
    fireEvent.change(screen.getByTestId('create-mission-level'), { target: { value: 'project' } });
    const projParentSelect = screen.getByTestId('create-mission-parent') as HTMLSelectElement;
    const projParentLabels = Array.from(projParentSelect.options).map((o) => o.textContent);
    expect(projParentLabels).toContain('Team: grow MRR');
    expect(projParentLabels).not.toContain('Company: reach profitability');
    expect(screen.getByTestId('create-mission-project')).toBeTruthy();

    fireEvent.change(screen.getByTestId('create-mission-objective'), { target: { value: 'Ship pricing page' } });
    fireEvent.change(screen.getByTestId('create-mission-team'), { target: { value: 'team-alpha-123' } });
    fireEvent.change(projParentSelect, { target: { value: 'team-1' } });

    // Missing project → validation error, no API call
    fireEvent.click(screen.getByTestId('create-mission-submit'));
    await waitFor(() => expect(screen.getByTestId('create-mission-error')).toBeTruthy());
    expect(apiService.createMission).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('create-mission-project'), { target: { value: 'p-1' } });
    fireEvent.click(screen.getByTestId('create-mission-submit'));

    await waitFor(() => expect(apiService.createMission).toHaveBeenCalledTimes(1));
    expect(apiService.createMission).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'project', parentMissionId: 'team-1', projectId: 'p-1', ownerTeamId: 'team-alpha-123' }),
    );
  });
});
