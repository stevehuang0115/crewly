/**
 * Tests for MissionProgressSection — WorkItem counts by status.
 *
 * @module components/Missions/MissionProgressSection.test
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MissionProgressSection } from './MissionProgressSection';

const getMissionProgressMock = vi.fn();
vi.mock('../../services/api.service', () => ({
  apiService: {
    getMissionProgress: (...a: unknown[]) => getMissionProgressMock(...a),
  },
}));

describe('MissionProgressSection', () => {
  beforeEach(() => {
    getMissionProgressMock.mockReset();
  });

  it('renders the completion bar and per-status counts', async () => {
    getMissionProgressMock.mockResolvedValue({
      missionId: 'm-1',
      status: 'active',
      phase: 2,
      totalTasks: 10,
      completedTasks: 6,
      runningTasks: 1,
      queuedTasks: 2,
      blockedTasks: 1,
      failedTasks: 0,
      progressPercent: 60,
      totalCost: 1.2345,
    });
    render(<MissionProgressSection missionId="m-1" />);

    await waitFor(() => expect(screen.getByTestId('mission-progress-rows')).toBeInTheDocument());
    expect(within(screen.getByTestId('mission-progress-bar')).getByTestId('progress-percent')).toHaveTextContent('60%');
    expect(screen.getByTestId('mission-progress-bar')).toHaveTextContent('6/10 tasks');
    expect(screen.getByTestId('mission-progress-completedTasks')).toHaveTextContent('6');
    expect(screen.getByTestId('mission-progress-blockedTasks')).toHaveTextContent('1');
    expect(screen.getByTestId('mission-progress-cost')).toHaveTextContent('$1.23');
    expect(getMissionProgressMock).toHaveBeenCalledWith('m-1');
  });

  it('shows the empty state when there are no work items', async () => {
    getMissionProgressMock.mockResolvedValue({
      missionId: 'm-1', status: 'active', phase: 0, totalTasks: 0, completedTasks: 0, runningTasks: 0,
      queuedTasks: 0, blockedTasks: 0, failedTasks: 0, progressPercent: 0, totalCost: 0,
    });
    render(<MissionProgressSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('mission-progress-empty')).toBeInTheDocument());
  });

  it('shows the error state', async () => {
    getMissionProgressMock.mockRejectedValue(new Error('Mission not found'));
    render(<MissionProgressSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('mission-progress-error')).toHaveTextContent('Mission not found'));
  });
});
