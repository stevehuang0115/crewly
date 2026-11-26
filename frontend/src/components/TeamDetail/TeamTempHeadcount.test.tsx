/**
 * Tests for TeamTempHeadcount — the temporary agent headcount setting and
 * the list of temporary members.
 *
 * @module components/TeamDetail/TeamTempHeadcount.test
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TeamTempHeadcount, MAX_TEMP_HEADCOUNT } from './TeamTempHeadcount';

const getMock = vi.fn();
const setMock = vi.fn();
vi.mock('../../services/api.service', () => ({
  apiService: {
    getTeamTempMembers: (id: string) => getMock(id),
    setTeamTempHeadcount: (id: string, n: number) => setMock(id, n),
  },
}));

const view = (over: Record<string, unknown> = {}) => ({
  teamId: 't1',
  headcount: { used: 1, limit: 2 },
  members: [
    {
      id: 'm-temp',
      name: 'Temp-Developer-1',
      role: 'developer',
      sessionName: 'mkt-temp-developer-1-member-1',
      temporary: { createdBy: 'mkt-owen', createdAt: '2026-11-26T10:00:00Z', reason: 'two launches this week', expiresAt: '2026-11-29T10:00:00Z' },
    },
  ],
  ...over,
});

describe('TeamTempHeadcount', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
  });

  it('shows the headcount, how much is in use and each temporary member with its reason', async () => {
    getMock.mockResolvedValue(view());
    render(<TeamTempHeadcount teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('team-temp-headcount')).toBeInTheDocument());
    const select = screen.getByLabelText('Temporary agent headcount') as HTMLSelectElement;
    expect(select.value).toBe('2');
    expect(select.options).toHaveLength(MAX_TEMP_HEADCOUNT + 1);
    expect(screen.getByTestId('temp-headcount-used')).toHaveTextContent('1 of 2 in use.');
    expect(screen.getByTestId('temp-member-m-temp')).toHaveTextContent('Temp-Developer-1');
    expect(screen.getByTestId('temp-member-m-temp')).toHaveTextContent('two launches this week');
  });

  it('saves a new headcount and shows the fresh state', async () => {
    getMock.mockResolvedValueOnce(view()).mockResolvedValueOnce(view({ headcount: { used: 1, limit: 4 } }));
    setMock.mockResolvedValue(undefined);
    render(<TeamTempHeadcount teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('team-temp-headcount')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Temporary agent headcount'), { target: { value: '4' } });
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('t1', 4));
    await waitFor(() => expect(screen.getByTestId('temp-headcount-used')).toHaveTextContent('1 of 4 in use.'));
  });

  it('says temporary members are off at 0', async () => {
    getMock.mockResolvedValue(view({ headcount: { used: 0, limit: 0 }, members: [] }));
    render(<TeamTempHeadcount teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('temp-headcount-used')).toHaveTextContent('The lead cannot add temporary members.'));
  });

  it('shows the server\'s message when the save is refused', async () => {
    getMock.mockResolvedValue(view());
    setMock.mockRejectedValue(new Error("Only the owner sets a team's temporary headcount."));
    render(<TeamTempHeadcount teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('team-temp-headcount')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Temporary agent headcount'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Only the owner sets a team's temporary headcount."));
  });

  it('stays hidden when the backend has no such route', async () => {
    getMock.mockRejectedValue(new Error('404'));
    const { container } = render(<TeamTempHeadcount teamId="t1" />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
