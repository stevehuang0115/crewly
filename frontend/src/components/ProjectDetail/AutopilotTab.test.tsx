import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutopilotTab, autopilotState, dayTitle, headline, stopLine, topStallCauses } from './AutopilotTab';
import type { AutopilotDayStats, AutopilotPeriodStats, AutopilotRunDay, AutopilotStats, AutopilotStatus } from '../../services/autopilot.service';

const getAutopilotStats = vi.fn();
const getAutopilotRuns = vi.fn();
const getAutopilotStatus = vi.fn();
const setAutopilotSpeedMode = vi.fn();
vi.mock('../../services/autopilot.service', () => ({
  getAutopilotStats: (...a: unknown[]) => getAutopilotStats(...a),
  getAutopilotRuns: (...a: unknown[]) => getAutopilotRuns(...a),
  getAutopilotStatus: (...a: unknown[]) => getAutopilotStatus(...a),
  setAutopilotSpeedMode: (...a: unknown[]) => setAutopilotSpeedMode(...a),
}));

function status(over: Partial<AutopilotStatus> = {}): AutopilotStatus {
  return {
    project: { id: 'p1', name: 'CE' },
    settings: { enabled: true, dailyBudgetTokens: 50_000_000, speedMode: 'normal', budgetSource: 'explicit', replansPerDay: 4, replansPerDaySource: 'mode' },
    speedMode: 'normal',
    stopReason: null,
    stopReasonText: null,
    stoppedSince: null,
    lastSelfReview: null,
    nextSelfReviewAt: null,
    replansToday: 1,
    ...over,
  };
}

const H = 3_600_000;
function period(over: Partial<AutopilotPeriodStats> = {}): AutopilotPeriodStats {
  const none = { count: 0, ms: 0 };
  return {
    triaged: 0, started: 0, done: 0, verified: 0, sentBack: 0, stalled: 0,
    cycleTime: { toDone: { count: 0, medianMs: null, meanMs: null }, toVerified: { count: 0, medianMs: null, meanMs: null } },
    ownerTouches: { answered: 0, approved: 0, sentBack: 0, corrected: 0, total: 0 },
    stalls: { count: 0, totalMs: 0, byCause: { runtime_quota: none, delivery_failure: none, waiting_on_owner: none, waiting_on_agent: none, nobody_pushing: none } },
    interventions: { nudges: 0, redeliveries: 0, wakes: 0, corrections: 0, guardBlocks: 0, misroutes: 0, total: 0 },
    tokens: 0, costUsd: 0, budget: { dailyBudgetTokens: 20_000_000, ledgerTokens: 0, ledgerCostUsd: 0, pct: 0 }, pausedMs: 0,
    ...over,
  };
}
const day = (d: string, over: Partial<AutopilotPeriodStats> = {}, runTraceId: string | null = null): AutopilotDayStats => ({ day: d, runTraceId, ticketTraceIds: [], ...period(over) });

function stats(over: Partial<AutopilotStats> = {}): AutopilotStats {
  return {
    project: { id: 'p1', name: 'CE' },
    settings: { enabled: true, dailyBudgetTokens: 20_000_000, retro: null },
    pausedForToday: false,
    label: null,
    range: { start: '2026-10-01', end: '2026-10-03' },
    days: [day('2026-10-01'), day('2026-10-02', { verified: 2, started: 3, costUsd: 4 }, 'tr-20261002-aaaaaaaa'), day('2026-10-03', { verified: 1 })],
    total: period({
      verified: 3, started: 4, costUsd: 6.3, sentBack: 1,
      ownerTouches: { answered: 2, approved: 1, sentBack: 0, corrected: 1, total: 4 },
      stalls: { count: 3, totalMs: 5 * H, byCause: { runtime_quota: { count: 0, ms: 0 }, delivery_failure: { count: 0, ms: 0 }, waiting_on_owner: { count: 2, ms: 4 * H }, waiting_on_agent: { count: 0, ms: 0 }, nobody_pushing: { count: 1, ms: H } } },
    }),
    labels: ['feed', 'web'],
    ...over,
  };
}
const runs: AutopilotRunDay[] = [
  { day: '2026-10-03', runTraceId: null, traces: [] },
  { day: '2026-10-02', runTraceId: 'tr-20261002-aaaaaaaa', traces: [{ traceId: 'tr-20261002-bbbbbbbb', kind: 'ticket', summary: 'CE-7: Feed chips', labels: ['feed'], updatedAt: 'x' }] },
];

const renderTab = () => render(<MemoryRouter><AutopilotTab projectId="p1" /></MemoryRouter>);

describe('AutopilotTab', () => {
  beforeEach(() => {
    getAutopilotStats.mockReset().mockResolvedValue(stats());
    getAutopilotRuns.mockReset().mockResolvedValue(runs);
    getAutopilotStatus.mockReset().mockResolvedValue(status());
    setAutopilotSpeedMode.mockReset().mockImplementation(async (_p: string, mode: 'rush' | 'normal' | 'chill') => status({ speedMode: mode }));
  });

  it('switches the speed, warns on Rush, and shows why it stopped and the last self-review', async () => {
    getAutopilotStatus.mockResolvedValue(
      status({
        stopReason: 'waiting_on_owner',
        stopReasonText: 'waiting on you',
        stoppedSince: '2026-10-04T14:05:00.000Z',
        lastSelfReview: { at: '2026-10-04T13:00:00.000Z', by: 'ce-owen', gap: '620 of 1,000 visitors', moved: 'feed cards', nextBet: 'two cards a day' },
      }),
    );
    renderTab();
    expect(await screen.findByTestId('autopilot-speed')).toBeInTheDocument();
    expect(screen.getByTestId('autopilot-stop')).toHaveTextContent('Stopped: waiting on you');
    expect(screen.getByTestId('autopilot-self-review')).toHaveTextContent('620 of 1,000 visitors · next bet: two cards a day');
    expect(screen.queryByTestId('autopilot-rush-warning')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('autopilot-speed-rush'));
    await waitFor(() => expect(setAutopilotSpeedMode).toHaveBeenCalledWith('p1', 'rush'));
    expect(await screen.findByTestId('autopilot-rush-warning')).toHaveTextContent('whole daily budget');
  });

  it('keeps the numbers when the status cannot be read (not the owner)', async () => {
    getAutopilotStatus.mockRejectedValue(new Error('Only the owner'));
    renderTab();
    expect(await screen.findByTestId('autopilot-headline')).toBeInTheDocument();
    expect(screen.queryByTestId('autopilot-speed')).not.toBeInTheDocument();
  });

  it('shows the headline, the bars, the top stall causes and links to the run timelines', async () => {
    renderTab();
    expect(await screen.findByTestId('autopilot-headline')).toHaveTextContent('Last 14 days: 3 tickets shipped · 1.3 owner touches per ticket · $2.10 per shipped ticket');
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByTestId('autopilot-bar-2026-10-02')).toHaveAttribute('title', expect.stringContaining('2 shipped, 3 started'));
    const stalls = screen.getByTestId('autopilot-stalls');
    expect(stalls.textContent).toMatch(/waiting on you.*nobody pushing/);
    expect(screen.getByRole('link', { name: /run$/ })).toHaveAttribute('href', '/tickets/traces/tr-20261002-aaaaaaaa');
    expect(screen.getByRole('link', { name: 'CE-7: Feed chips' })).toHaveAttribute('href', '/tickets/traces/tr-20261002-bbbbbbbb');
    expect(getAutopilotStats).toHaveBeenCalledWith('p1', 14, null);
  });

  it('changes the range and filters by label', async () => {
    renderTab();
    await screen.findByTestId('autopilot-headline');
    fireEvent.click(screen.getByRole('button', { name: /7 days/ }));
    await waitFor(() => expect(getAutopilotStats).toHaveBeenLastCalledWith('p1', 7, null));
    fireEvent.click(screen.getByRole('button', { name: /^feed/ }));
    await waitFor(() => expect(getAutopilotRuns).toHaveBeenLastCalledWith('p1', 7, 'feed'));
  });

  it('shows an empty state when the autopilot is off and never ran, and an error state', async () => {
    getAutopilotStats.mockResolvedValue(stats({ settings: { enabled: false, dailyBudgetTokens: 1, retro: null } }));
    getAutopilotRuns.mockResolvedValue([{ day: '2026-10-03', runTraceId: null, traces: [] }]);
    const { unmount } = renderTab();
    expect(await screen.findByText('Autopilot is off')).toBeInTheDocument();
    unmount();
    getAutopilotStats.mockRejectedValue(new Error('Only the owner'));
    renderTab();
    expect(await screen.findByText('Autopilot numbers are not available')).toBeInTheDocument();
  });

  it('helpers', () => {
    expect(autopilotState(stats({ pausedForToday: true }))).toEqual({ label: 'Paused on budget today', tone: 'attention' });
    expect(autopilotState(stats({ settings: { enabled: false, dailyBudgetTokens: 1, retro: null } })).label).toBe('Off');
    expect(headline(stats({ total: period({ started: 2 }), label: 'feed' }), 7)).toBe('Last 7 days (feed): 0 tickets shipped · 2 started');
    expect(topStallCauses(stats()).map((c) => c.cause)).toEqual(['waiting_on_owner', 'nobody_pushing']);
    expect(dayTitle(day('2026-10-02', { pausedMs: H }))).toContain('paused');
    expect(stopLine(status())).toBeNull();
    expect(stopLine(status({ stopReason: 'no_ideas', stopReasonText: 'the last goal replan found nothing to do' }))).toBe('Stopped: the last goal replan found nothing to do');
  });
});
