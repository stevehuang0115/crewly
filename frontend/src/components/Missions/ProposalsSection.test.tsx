/**
 * Tests for ProposalsSection — pending children render with approve/reject
 * and disappear once decided.
 *
 * @module components/Missions/ProposalsSection.test
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProposalsSection } from './ProposalsSection';

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

const api = { getProposals: vi.fn(), approveMission: vi.fn(), rejectMission: vi.fn() };
vi.mock('../../services/api.service', () => ({
  apiService: {
    getProposals: (...a: unknown[]) => api.getProposals(...a),
    approveMission: (...a: unknown[]) => api.approveMission(...a),
    rejectMission: (...a: unknown[]) => api.rejectMission(...a),
  },
}));

const proposal = {
  id: 'child-1',
  objective: 'Team: grow MRR',
  ownerTeamId: 'team-growth',
  successCriteria: ['Hit $5k MRR'],
  currentStrategy: '',
  activeProjectTaskIds: [],
  cadence: '0 9 * * 1',
  status: 'active' as const,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  level: 'team' as const,
  parentMissionId: 'co-1',
  approval: { state: 'pending_approval' as const, proposedBy: 'orchestrator' },
};

describe('ProposalsSection', () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    navigateMock.mockReset();
  });

  it('renders nothing when there are no pending proposals', async () => {
    api.getProposals.mockResolvedValue([]);
    const { container } = render(<ProposalsSection parentMissionId="co-1" />);
    await waitFor(() => expect(api.getProposals).toHaveBeenCalledWith('co-1'));
    expect(container.firstChild).toBeNull();
  });

  it('lists proposals with proposer and approve/reject, and removes an approved one', async () => {
    api.getProposals.mockResolvedValue([proposal]);
    api.approveMission.mockResolvedValue({ ...proposal, approval: { state: 'approved' } });
    const onDecided = vi.fn();
    render(<ProposalsSection parentMissionId="co-1" onDecided={onDecided} />);

    await waitFor(() => expect(screen.getByTestId('proposal-child-1')).toBeInTheDocument());
    expect(screen.getByTestId('proposals-section')).toHaveTextContent('Proposals awaiting approval (1)');
    expect(screen.getByText(/Proposed by orchestrator/)).toBeInTheDocument();
    expect(screen.getByText('Hit $5k MRR')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('approve-child-1'));

    await waitFor(() => expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ id: 'child-1' })));
    expect(screen.queryByTestId('proposals-section')).toBeNull();
  });

  it('navigates to the proposal on click', async () => {
    api.getProposals.mockResolvedValue([proposal]);
    render(<ProposalsSection parentMissionId="co-1" />);
    await waitFor(() => expect(screen.getByTestId('proposal-link-child-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('proposal-link-child-1'));
    expect(navigateMock).toHaveBeenCalledWith('/missions/child-1');
  });
});
