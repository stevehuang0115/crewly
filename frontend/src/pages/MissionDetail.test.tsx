/**
 * MissionDetail Page Tests
 *
 * @module pages/MissionDetail.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MissionDetail } from './MissionDetail';

// Mock api.service
vi.mock('../services/api.service', () => ({
  apiService: {
    getMission: vi.fn(),
    updateMission: vi.fn(),
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

  // ---------------------------------------------------------------------------
  // Edit mode
  // ---------------------------------------------------------------------------

  it('shows an Edit button in view mode', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mission-edit')).toBeTruthy();
    });
  });

  it('switches to edit mode and pre-populates the objective input', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mission-edit')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('mission-edit'));

    const input = screen.getByTestId('edit-objective') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('Deliver V3 Architecture');
    expect(screen.getByTestId('mission-save')).toBeTruthy();
    expect(screen.getByTestId('mission-cancel')).toBeTruthy();
  });

  it('cancel exits edit mode and discards changes', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mission-edit')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('mission-edit'));
    const input = screen.getByTestId('edit-objective') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'NEW OBJECTIVE' } });
    fireEvent.click(screen.getByTestId('mission-cancel'));

    // Back to view mode with original text
    expect(screen.queryByTestId('edit-objective')).toBeFalsy();
    expect(screen.getByText('Deliver V3 Architecture')).toBeTruthy();
  });

  it('save submits the patch and re-renders with the server response', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    const updated = { ...mockMission, objective: 'New objective', priority: 'critical' as const };
    vi.mocked(apiService.updateMission).mockResolvedValue(updated);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mission-edit')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('mission-edit'));
    fireEvent.change(screen.getByTestId('edit-objective'), { target: { value: 'New objective' } });
    fireEvent.change(screen.getByTestId('edit-priority'), { target: { value: 'critical' } });
    fireEvent.click(screen.getByTestId('mission-save'));

    await waitFor(() => {
      expect(apiService.updateMission).toHaveBeenCalledTimes(1);
    });

    const [, patch] = vi.mocked(apiService.updateMission).mock.calls[0];
    expect(patch.objective).toBe('New objective');
    expect(patch.priority).toBe('critical');

    // After save, view mode restored with updated content
    await waitFor(() => {
      expect(screen.queryByTestId('edit-objective')).toBeFalsy();
    });
    expect(screen.getByText('New objective')).toBeTruthy();
  });

  it('surfaces server error and stays in edit mode when save fails', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    vi.mocked(apiService.updateMission).mockRejectedValue(new Error('Parent chain contains a cycle'));

    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId('mission-edit')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('mission-edit'));
    fireEvent.click(screen.getByTestId('mission-save'));

    await waitFor(() => {
      expect(screen.getByTestId('mission-save-error')).toBeTruthy();
    });
    expect(screen.getByTestId('edit-objective')).toBeTruthy();
  });

  it('blocks save when objective is empty', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mission-edit')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('mission-edit'));
    fireEvent.change(screen.getByTestId('edit-objective'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('mission-save'));

    await waitFor(() => {
      expect(screen.getByTestId('mission-save-error')).toBeTruthy();
    });
    expect(apiService.updateMission).not.toHaveBeenCalled();
  });
});
