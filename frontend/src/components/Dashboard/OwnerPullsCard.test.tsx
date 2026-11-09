// @vitest-environment jsdom
/**
 * Tests for the Dashboard "Pulled you in this week" card (crewly#1387).
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { OwnerPullsCard, OWNER_PULLS_URL, changeWords, type OwnerPullsData } from './OwnerPullsCard';

const week = (total: number, byKind: Record<string, number> = {}, bySource: OwnerPullsData['thisWeek']['bySource'] = []) => ({ total, byKind, bySource });

function mockFetch(pulls: OwnerPullsData | null, ok = true): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({ ok, json: async () => ({ success: ok, data: pulls ? { pulls } : undefined }) });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OwnerPullsCard', () => {
  it('shows the count, change, kinds, top three sources and active minutes', async () => {
    const fn = mockFetch({
      thisWeek: week(7, { decision: 4, review: 2, stuck: 1 }, [
        { agent: 'Sam', team: 'CE', count: 3 },
        { agent: 'Lee', team: 'SteamFun', count: 2 },
        { agent: 'Pia', team: 'CE', count: 1 },
        { agent: 'Zed', team: 'CE', count: 1 },
      ]),
      lastWeek: week(10),
      change: -3,
      ownerActiveMinutes: { thisWeek: 40, lastWeek: 55 },
    });
    render(<OwnerPullsCard />);
    await waitFor(() => expect(screen.getByTestId('owner-pulls')).toBeInTheDocument());
    expect(fn).toHaveBeenCalledWith(OWNER_PULLS_URL);
    expect(screen.getByTestId('owner-pulls-count')).toHaveTextContent('7 times (down 3 from last week) · you were active about 40 min (last week 55)');
    expect(screen.getByTestId('owner-pulls-kinds')).toHaveTextContent('4 decision needed, 2 review or approval, 1 agent stuck or error');
    expect(screen.getByTestId('owner-pulls-sources')).toHaveTextContent('Top sources: Sam (CE) 3, Lee (SteamFun) 2, Pia (CE) 1');
    expect(screen.getByTestId('owner-pulls-sources')).not.toHaveTextContent('Zed');
  });

  it('renders nothing when there were no pulls, when the call is refused, or when it throws', async () => {
    const fn = mockFetch({ thisWeek: week(0), lastWeek: week(0), change: 0 });
    const { container, unmount } = render(<OwnerPullsCard />);
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();

    const refused = mockFetch(null, false);
    const r2 = render(<OwnerPullsCard />);
    await waitFor(() => expect(refused).toHaveBeenCalled());
    expect(r2.container).toBeEmptyDOMElement();
    r2.unmount();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const r3 = render(<OwnerPullsCard />);
    await new Promise((r) => setTimeout(r, 10));
    expect(r3.container).toBeEmptyDOMElement();
  });

  it('words the change', () => {
    expect(changeWords(0)).toBe('same as last week');
    expect(changeWords(2)).toBe('up 2 from last week');
    expect(changeWords(-1)).toBe('down 1 from last week');
  });
});
