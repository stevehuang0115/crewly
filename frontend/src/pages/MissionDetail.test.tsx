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
    getMissions: vi.fn(),
    getKeyResults: vi.fn(),
    createKeyResult: vi.fn(),
    updateKeyResult: vi.fn(),
    deleteKeyResult: vi.fn(),
    measureKeyResult: vi.fn(),
    getCascadeSummary: vi.fn(),
    getProposals: vi.fn(),
    approveMission: vi.fn(),
    rejectMission: vi.fn(),
    getMissionProgress: vi.fn(),
  },
}));

// Mock UI components
vi.mock('@crewly/ui/LoadingSpinner', () => ({
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
    vi.mocked(apiService.getMissions).mockResolvedValue([]);
    vi.mocked(apiService.getKeyResults).mockResolvedValue([]);
    vi.mocked(apiService.getCascadeSummary).mockRejectedValue(new Error('no cascade'));
    vi.mocked(apiService.getProposals).mockResolvedValue([]);
    vi.mocked(apiService.getMissionProgress).mockRejectedValue(new Error('no progress'));
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
  // ---------------------------------------------------------------------------
  // OKR cascade sections
  // ---------------------------------------------------------------------------

  const cascadeSummary = {
    missionId: mockMission.id,
    level: 'team' as const,
    totalKRs: 1,
    achieved: 0,
    onTrack: 1,
    atRisk: 0,
    offTrack: 0,
    notStarted: 0,
    overallProgress: 40,
    recommendation: 'continue' as const,
    childMissionCount: 1,
    rolledUpProgress: 55,
    children: [
      {
        missionId: 'proj-1',
        level: 'project' as const,
        totalKRs: 1,
        achieved: 0,
        onTrack: 1,
        atRisk: 0,
        offTrack: 0,
        notStarted: 0,
        overallProgress: 70,
        recommendation: 'continue' as const,
        childMissionCount: 0,
        rolledUpProgress: 70,
        children: [],
      },
    ],
  };

  it('renders level badge, parent link and cascade children with rolled-up progress', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue({
      ...mockMission,
      level: 'team',
      parentMissionId: 'co-1',
      approval: { state: 'approved' },
    });
    vi.mocked(apiService.getMissions).mockResolvedValue([
      { id: 'co-1', objective: 'Company: profitability', level: 'company' },
      { id: 'proj-1', objective: 'Project: pricing page', level: 'project', parentMissionId: mockMission.id },
    ]);
    vi.mocked(apiService.getCascadeSummary).mockResolvedValue(cascadeSummary);
    renderWithRouter();

    await waitFor(() => expect(screen.getByTestId('mission-detail-page')).toBeTruthy());
    expect(screen.getByTestId('level-badge-team')).toBeTruthy();
    // Legacy/approved missions show no approval chip
    expect(screen.queryByTestId('approval-chip-approved')).toBeNull();

    await waitFor(() => expect(screen.getByTestId('cascade-parent-link')).toHaveTextContent('Company: profitability'));
    await waitFor(() => expect(screen.getByTestId('cascade-child-proj-1')).toHaveTextContent('Project: pricing page'));
    expect(screen.getByTestId('cascade-rollup-bar')).toHaveTextContent('55%');
    expect(screen.getByTestId('cascade-child-progress-proj-1')).toHaveTextContent('70%');
    expect(screen.getByTestId('mission-parent-link')).toHaveTextContent('Company: profitability');
  });

  it('renders the Key Results table and posts a measurement', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    const kr = {
      id: 'kr-1',
      missionId: mockMission.id,
      title: 'Reach $5k MRR',
      metricType: 'currency',
      baseline: 0,
      target: 5000,
      current: 1000,
      unit: '$',
      status: 'off_track',
      measurementSource: 'manual',
      linkedWorkItemIds: [],
      measurements: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    vi.mocked(apiService.getKeyResults).mockResolvedValue([kr] as never);
    vi.mocked(apiService.measureKeyResult).mockResolvedValue({ value: 3000, measuredAt: 'now', source: 'user' });
    renderWithRouter();

    await waitFor(() => expect(screen.getByTestId('kr-row-kr-1')).toBeTruthy());
    expect(screen.getByTestId('kr-values-kr-1')).toHaveTextContent('$0 → $1,000 → $5,000');

    fireEvent.click(screen.getByTestId('kr-measure-kr-1'));
    fireEvent.change(screen.getByTestId('kr-measure-value-kr-1'), { target: { value: '3000' } });
    vi.mocked(apiService.getKeyResults).mockResolvedValue([{ ...kr, current: 3000, status: 'on_track' }] as never);
    fireEvent.click(screen.getByTestId('kr-measure-submit-kr-1'));

    await waitFor(() =>
      expect(apiService.measureKeyResult).toHaveBeenCalledWith(mockMission.id, 'kr-1', { value: 3000, source: 'user' }),
    );
    await waitFor(() => expect(screen.getByTestId('kr-status-kr-1')).toHaveTextContent('On track'));
    // A measurement refreshes the mission header + roll-ups
    await waitFor(() => expect(apiService.getMission).toHaveBeenCalledTimes(2));
  });

  it('shows pending child proposals with approve, and hides them once decided', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue({ ...mockMission, level: 'company' });
    const proposal = {
      ...mockMission,
      id: 'child-1',
      objective: 'Team: grow MRR',
      level: 'team',
      parentMissionId: mockMission.id,
      approval: { state: 'pending_approval', proposedBy: 'orchestrator' },
    };
    vi.mocked(apiService.getProposals).mockResolvedValue([proposal] as never);
    vi.mocked(apiService.approveMission).mockResolvedValue({ ...proposal, approval: { state: 'approved' } } as never);
    renderWithRouter();

    await waitFor(() => expect(screen.getByTestId('proposal-child-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('approve-child-1'));

    await waitFor(() => expect(apiService.approveMission).toHaveBeenCalledWith('child-1'));
    await waitFor(() => expect(screen.queryByTestId('proposals-section')).toBeNull());
  });

  it('lets the owner approve this mission when it is itself a pending proposal', async () => {
    const approved = {
      ...mockMission,
      level: 'team',
      parentMissionId: 'co-1',
      approval: { state: 'approved', decidedBy: 'steve', decidedAt: '2026-09-18T00:00:00.000Z' },
    };
    // First load: pending. The post-decision refresh returns the approved mission.
    vi.mocked(apiService.getMission)
      .mockResolvedValue(approved)
      .mockResolvedValueOnce({ ...approved, approval: { state: 'pending_approval', proposedBy: 'orchestrator' } });
    vi.mocked(apiService.approveMission).mockResolvedValue(approved as never);
    renderWithRouter();

    await waitFor(() => expect(screen.getByTestId('mission-pending-banner')).toBeTruthy());
    expect(screen.getByTestId('approval-chip-pending_approval')).toBeTruthy();

    fireEvent.click(screen.getByTestId(`approve-${mockMission.id}`));

    await waitFor(() => expect(screen.getByTestId('approval-chip-approved')).toBeTruthy());
    expect(screen.queryByTestId('mission-pending-banner')).toBeNull();
  });

  it('renders execution progress from /progress', async () => {
    vi.mocked(apiService.getMission).mockResolvedValue(mockMission);
    vi.mocked(apiService.getMissionProgress).mockResolvedValue({
      missionId: mockMission.id,
      status: 'active',
      phase: 1,
      totalTasks: 4,
      completedTasks: 1,
      runningTasks: 1,
      queuedTasks: 2,
      blockedTasks: 0,
      failedTasks: 0,
      progressPercent: 25,
      totalCost: 0.5,
    });
    renderWithRouter();

    await waitFor(() => expect(screen.getByTestId('mission-progress-rows')).toBeTruthy());
    expect(screen.getByTestId('mission-progress-bar')).toHaveTextContent('1/4 tasks');
    expect(screen.getByTestId('mission-progress-queuedTasks')).toHaveTextContent('2');
  });
});
