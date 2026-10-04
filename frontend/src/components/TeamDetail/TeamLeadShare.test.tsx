/**
 * Tests for TeamLeadShare — lead share of team tokens on the team page (crewly#1083).
 *
 * @module components/TeamDetail/TeamLeadShare.test
 */

import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TeamLeadShare, formatShare, formatTokens } from './TeamLeadShare';

const getLeadShareMock = vi.fn();
vi.mock('../../services/api.service', () => ({
  apiService: {
    getTeamLeadShare: (id: string) => getLeadShareMock(id),
  },
}));

const period = (lead: number, team: number, flagged = false) => ({ lead, team, share: team ? lead / team : null, flagged });

describe('TeamLeadShare', () => {
  beforeEach(() => {
    getLeadShareMock.mockReset();
  });

  it('shows today and this week, flags over half, nudges and kept work', async () => {
    getLeadShareMock.mockResolvedValue({
      row: { teamId: 't1', teamName: 'Think Tank', leads: ['Atlas'], leadSessions: ['tt-atlas'], today: period(80, 100, true), week: period(306_000_000, 327_000_000, true) },
      nudges: { total: { count: 3, followed: 2 }, day: { count: 1, followed: 1 } },
      keptWork: [{ at: '2026-10-04T10:00:00Z', session: 'tt-atlas', reason: "needs the owner's Stripe login", work: 'Billing settings' }],
      flagShare: 0.5,
    });
    render(<TeamLeadShare teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('team-lead-share')).toBeInTheDocument());
    expect(getLeadShareMock).toHaveBeenCalledWith('t1');
    expect(screen.getByText('Lead share (Atlas)')).toBeInTheDocument();
    expect(screen.getByTestId('lead-share-Today')).toHaveTextContent('80%');
    expect(screen.getByTestId('lead-share-This week')).toHaveTextContent('94%');
    expect(screen.getAllByText(/over half/)).toHaveLength(2);
    expect(screen.getByText(/Nudged to delegate 3×, delegated after 2/)).toBeInTheDocument();
    expect(screen.getByText(/Billing settings/)).toBeInTheDocument();
  });

  it('renders nothing for a team without a lead row', async () => {
    getLeadShareMock.mockResolvedValue({ row: null, nudges: { total: { count: 0, followed: 0 }, day: { count: 0, followed: 0 } }, keptWork: [], flagShare: 0.5 });
    const { container } = render(<TeamLeadShare teamId="t2" />);
    await waitFor(() => expect(getLeadShareMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden when the request fails', async () => {
    getLeadShareMock.mockRejectedValue(new Error('down'));
    const { container } = render(<TeamLeadShare teamId="t3" />);
    await waitFor(() => expect(getLeadShareMock).toHaveBeenCalledWith('t3'));
    expect(container).toBeEmptyDOMElement();
  });

  it('formats shares and token counts', () => {
    expect(formatShare(null)).toBe('–');
    expect(formatShare(0.634)).toBe('63%');
    expect(formatTokens(306_000_000)).toBe('306M');
    expect(formatTokens(4_200_000)).toBe('4.2M');
    expect(formatTokens(12_400)).toBe('12k');
  });
});
