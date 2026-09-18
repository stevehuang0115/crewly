/**
 * Tests for TeamObjectives — verifies the team's missions are fetched and
 * filtered by owner, KR counts render, and the wiki knowledge links resolve.
 *
 * @module components/TeamDetail/TeamObjectives.test
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TeamObjectives } from './TeamObjectives';

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

const getMissionsMock = vi.fn();
vi.mock('../../services/api.service', () => ({
  apiService: {
    getMissions: () => getMissionsMock(),
  },
}));

describe('TeamObjectives', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    getMissionsMock.mockReset();
  });

  it('renders only missions owned by the team, with KR counts', async () => {
    getMissionsMock.mockResolvedValue([
      { id: 'm1', objective: 'Grow XHS following', ownerTeamId: 'team-a', status: 'active', keyResults: [{ id: 'k1', title: 'x', status: 'on_track' }] },
      { id: 'm2', objective: 'Other team mission', ownerTeamId: 'team-b', status: 'active' },
    ]);

    render(<TeamObjectives teamId="team-a" />);

    await waitFor(() => expect(screen.getByText('Grow XHS following')).toBeInTheDocument());
    expect(screen.queryByText('Other team mission')).not.toBeInTheDocument();
    expect(screen.getByText('1 key result')).toBeInTheDocument();
  });

  it('shows per-status KR counts, the level badge and a pending-approval chip', async () => {
    getMissionsMock.mockResolvedValue([
      {
        id: 'm1',
        objective: 'Grow XHS following',
        ownerTeamId: 'team-a',
        status: 'active',
        level: 'team',
        approval: { state: 'pending_approval' },
        keyResults: [
          { id: 'k1', title: 'a', status: 'on_track' },
          { id: 'k2', title: 'b', status: 'on_track' },
          { id: 'k3', title: 'c', status: 'off_track' },
        ],
      },
      { id: 'm2', objective: 'Approved one', ownerTeamId: 'team-a', status: 'active', level: 'team', approval: { state: 'approved' } },
    ]);

    render(<TeamObjectives teamId="team-a" />);

    await waitFor(() => expect(screen.getByTestId('team-mission-m1')).toBeInTheDocument());
    const row = screen.getByTestId('team-mission-m1');
    expect(row.querySelector('[data-testid="kr-count-on_track"]')).toHaveTextContent('2 on track');
    expect(row.querySelector('[data-testid="kr-count-off_track"]')).toHaveTextContent('1 off track');
    expect(row.querySelector('[data-testid="level-badge-team"]')).toBeInTheDocument();
    expect(row.querySelector('[data-testid="approval-chip-pending_approval"]')).toBeInTheDocument();
    // Approved missions carry no chip and no counts row
    const approved = screen.getByTestId('team-mission-m2');
    expect(approved.querySelector('[data-testid^="approval-chip-"]')).toBeNull();
    expect(approved.querySelector('[data-testid="kr-status-counts"]')).toBeNull();
  });

  it('shows an empty state when the team owns no missions', async () => {
    getMissionsMock.mockResolvedValue([]);
    render(<TeamObjectives teamId="team-a" />);
    await waitFor(() => expect(screen.getByText(/No missions/i)).toBeInTheDocument());
  });

  it('navigates to a mission on click', async () => {
    getMissionsMock.mockResolvedValue([
      { id: 'm1', objective: 'Grow XHS following', ownerTeamId: 'team-a', status: 'active' },
    ]);
    render(<TeamObjectives teamId="team-a" />);
    await waitFor(() => expect(screen.getByTestId('team-mission-m1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('team-mission-m1'));
    expect(navigateMock).toHaveBeenCalledWith('/missions/m1');
  });

  it('links norms and SOPs to the team wiki', async () => {
    getMissionsMock.mockResolvedValue([]);
    render(<TeamObjectives teamId="team-a" />);
    await waitFor(() => expect(screen.getByTestId('team-norms-link')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('team-norms-link'));
    expect(navigateMock).toHaveBeenCalledWith('/wiki?team=team-a&focus=team-norm');
    fireEvent.click(screen.getByTestId('team-sops-link'));
    expect(navigateMock).toHaveBeenCalledWith('/wiki?team=team-a&focus=sop');
  });

  it('still renders knowledge links when getMissions fails', async () => {
    getMissionsMock.mockRejectedValue(new Error('boom'));
    render(<TeamObjectives teamId="team-a" />);
    await waitFor(() => expect(screen.getByTestId('team-knowledge')).toBeInTheDocument());
  });
});
