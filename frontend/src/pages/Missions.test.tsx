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
});
