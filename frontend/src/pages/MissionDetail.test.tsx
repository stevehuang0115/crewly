/**
 * MissionDetail Page Tests
 *
 * @module pages/MissionDetail.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MissionDetail } from './MissionDetail';

// Mock api.service
vi.mock('../services/api.service', () => ({
  apiService: {
    getMission: vi.fn(),
  },
}));

// Mock UI components
vi.mock('../components/UI/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => (
    <div data-testid="loading-spinner">{text || 'Loading...'}</div>
  ),
}));

import { apiService } from '../services/api.service';

const mockMission = {
  id: '12345678-abcd-1234-abcd-123456789012',
  objective: 'Deliver V3 Architecture',
  ownerTeamId: 'team-alpha-123',
  successCriteria: ['All tests pass', 'Build succeeds'],
  currentStrategy: 'Incremental delivery with CI/CD pipeline',
  activeProjectTaskIds: ['task-1', 'task-2'],
  cadence: '0 9 * * 1',
  status: 'active' as const,
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-05T10:00:00.000Z',
  learnings: ['Parallel execution is faster'],
};

/**
 * Renders the MissionDetail within router context with a given ID.
 *
 * @param id - Mission ID for the route param
 */
function renderWithRouter(id = '12345678-abcd-1234-abcd-123456789012') {
  return render(
    <MemoryRouter initialEntries={[`/missions/${id}`]}>
      <Routes>
        <Route path="/missions/:id" element={<MissionDetail />} />
        <Route path="/missions" element={<div>Missions List</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MissionDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    vi.mocked(apiService.getMission).mockReturnValue(new Promise(() => {}));
    renderWithRouter();

    expect(screen.getByText('Loading mission...')).toBeTruthy();
  });

  it('renders mission details after loading', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mission-detail-page')).toBeTruthy();
    });

    expect(screen.getByText('Deliver V3 Architecture')).toBeTruthy();
    expect(screen.getByText('All tests pass')).toBeTruthy();
    expect(screen.getByText('Incremental delivery with CI/CD pipeline')).toBeTruthy();
  });

  it('renders "Back to Missions" navigation link', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mission-detail-back')).toBeTruthy();
    });

    expect(screen.getByText('Back to Missions')).toBeTruthy();
  });

  it('renders error state on API failure', async () => {
    vi.mocked(apiService.getMission).mockRejectedValue(new Error('Network error'));
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mission-detail-error')).toBeTruthy();
    });

    expect(screen.getByText('Network error')).toBeTruthy();
    expect(screen.getByText('Back to Missions')).toBeTruthy();
  });

  it('renders not-found state when mission is null', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(null);
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Mission not found.')).toBeTruthy();
    });
  });

  it('renders learnings section when present', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mission-detail-page')).toBeTruthy();
    });

    expect(screen.getByText('Parallel execution is faster')).toBeTruthy();
  });
});
