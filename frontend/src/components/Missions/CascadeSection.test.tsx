/**
 * Tests for CascadeSection — parent link, rolled-up progress and children.
 *
 * @module components/Missions/CascadeSection.test
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CascadeSection } from './CascadeSection';
import type { CascadeOKRSummary } from '../../types/mission.types';

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

const getCascadeSummaryMock = vi.fn();
vi.mock('../../services/api.service', () => ({
  apiService: {
    getCascadeSummary: (...a: unknown[]) => getCascadeSummaryMock(...a),
  },
}));

const summary: CascadeOKRSummary = {
  missionId: 'co-1',
  level: 'company',
  totalKRs: 2,
  achieved: 1,
  onTrack: 1,
  atRisk: 0,
  offTrack: 0,
  notStarted: 0,
  overallProgress: 70,
  recommendation: 'continue',
  childMissionCount: 2,
  rolledUpProgress: 64,
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
      overallProgress: 80,
      recommendation: 'continue',
      childMissionCount: 1,
      rolledUpProgress: 75,
      children: [],
    },
    {
      missionId: 'team-2',
      level: 'team',
      totalKRs: 0,
      achieved: 0,
      onTrack: 0,
      atRisk: 0,
      offTrack: 0,
      notStarted: 0,
      overallProgress: 0,
      recommendation: 'continue',
      childMissionCount: 0,
      rolledUpProgress: 40,
      children: [],
    },
  ],
};

const names = new Map([
  ['co-1', 'Company: profitability'],
  ['team-1', 'Team: grow MRR'],
]);

describe('CascadeSection', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    getCascadeSummaryMock.mockReset();
  });

  it('renders the rolled-up progress and each child with its own roll-up', async () => {
    getCascadeSummaryMock.mockResolvedValue(summary);
    render(<CascadeSection missionId="co-1" level="company" missionNames={names} />);

    await waitFor(() => expect(screen.getByTestId('cascade-rollup')).toBeInTheDocument());
    expect(within(screen.getByTestId('cascade-rollup-bar')).getByTestId('progress-percent')).toHaveTextContent('64%');
    expect(screen.getByTestId('cascade-recommendation')).toHaveTextContent('Continue');
    expect(screen.getByText(/Own progress 70%/)).toBeInTheDocument();

    const child1 = screen.getByTestId('cascade-child-team-1');
    expect(child1).toHaveTextContent('Team: grow MRR');
    expect(within(child1).getByTestId('progress-percent')).toHaveTextContent('75%');
    // Unknown names fall back to an id prefix
    expect(screen.getByTestId('cascade-child-team-2')).toHaveTextContent('team-2');
    expect(getCascadeSummaryMock).toHaveBeenCalledWith('co-1');
  });

  it('links to the parent and to a child', async () => {
    getCascadeSummaryMock.mockResolvedValue({ ...summary, missionId: 'team-1', level: 'team', children: [] });
    render(<CascadeSection missionId="team-1" level="team" parentMissionId="co-1" missionNames={names} />);

    const parent = screen.getByTestId('cascade-parent-link');
    expect(parent).toHaveTextContent('Company: profitability');
    fireEvent.click(parent);
    expect(navigateMock).toHaveBeenCalledWith('/missions/co-1');
    await waitFor(() => expect(screen.getByTestId('cascade-children-empty')).toBeInTheDocument());
  });

  it('shows "root" when there is no parent and the error state on failure', async () => {
    getCascadeSummaryMock.mockRejectedValue(new Error('Mission not found'));
    render(<CascadeSection missionId="co-1" level="company" missionNames={names} />);
    expect(screen.getByTestId('cascade-parent-none')).toHaveTextContent('company root');
    await waitFor(() => expect(screen.getByTestId('cascade-error')).toHaveTextContent('Mission not found'));
  });

  it('re-fetches when refreshKey changes', async () => {
    getCascadeSummaryMock.mockResolvedValue(summary);
    const { rerender } = render(<CascadeSection missionId="co-1" level="company" missionNames={names} refreshKey={0} />);
    await waitFor(() => expect(getCascadeSummaryMock).toHaveBeenCalledTimes(1));
    rerender(<CascadeSection missionId="co-1" level="company" missionNames={names} refreshKey={1} />);
    await waitFor(() => expect(getCascadeSummaryMock).toHaveBeenCalledTimes(2));
  });
});
