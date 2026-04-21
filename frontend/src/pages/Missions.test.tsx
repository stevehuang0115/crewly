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
      expect(screen.getByTestId('missions-error')).toBeTruthy();
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
    fireEvent.click(screen.getByTestId('filter-completed'));

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
    const searchInput = screen.getByTestId('missions-search');
    fireEvent.change(searchInput, { target: { value: 'Marketing' } });

    expect(screen.getByText('Marketing Campaign')).toBeTruthy();
    expect(screen.queryByText('Deliver V3 Architecture')).toBeFalsy();
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

  it('renders parent chip when parentMissionId resolves to an existing mission', async () => {
    (apiService.getMissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      parentMission,
      childMissionWithKrs,
    ]);
    renderWithRouter(<Missions />);

    await waitFor(() => {
      expect(screen.getByTestId('missions-list')).toBeTruthy();
    });

    const chip = screen.getByTestId(`mission-parent-${childMissionWithKrs.id}`);
    expect(chip).toBeTruthy();
    expect(chip.textContent).toMatch(/Company-level OKR/);
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
});
