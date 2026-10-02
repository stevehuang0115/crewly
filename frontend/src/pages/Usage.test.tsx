/**
 * Tests for the Usage page (`/usage`).
 *
 * @module pages/Usage.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Usage, agentBars, teamBars, usageHeadline } from './Usage';
import { usageService } from '../services/usage.service';
import { M, makeCapsView, makeUsageStats } from '../test/usage.fixtures';

vi.mock('../services/usage.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/usage.service')>()),
  usageService: { stats: vi.fn(), caps: vi.fn(), setCaps: vi.fn(), boost: vi.fn(), endBoost: vi.fn() },
}));

const svc = vi.mocked(usageService);

const renderPage = () =>
  render(
    <MemoryRouter>
      <Usage />
    </MemoryRouter>,
  );

describe('Usage page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.stats.mockResolvedValue(makeUsageStats());
    svc.caps.mockResolvedValue(makeCapsView());
  });

  it('opens on today with the headline, top agents and teams; caps and details collapsed', async () => {
    renderPage();
    expect(await screen.findByTestId('usage-headline')).toHaveTextContent('12.4M today');
    expect(screen.getByTestId('usage-subline')).toHaveTextContent('No daily cap set.');
    expect(svc.stats).toHaveBeenCalledWith(1, ['team', 'agent', 'runtime', 'workItem']);
    expect(svc.caps).toHaveBeenCalledWith(1);

    expect(screen.getByTestId('usage-agent-ce-nova')).toHaveTextContent('CE · Codex');
    expect(screen.getByTestId('usage-agent-ce-nova')).toHaveTextContent('team CE hit its daily token cap');
    expect(screen.getByTestId('usage-team-t-ce')).toHaveTextContent('Stopped until midnight');
    expect(screen.getByTestId('usage-team-(unattributed)')).toHaveTextContent('Orc (no team)');

    expect(screen.queryByLabelText('All agents together, per day')).not.toBeInTheDocument();
    expect(screen.queryByTestId('usage-runtimes')).not.toBeInTheDocument();
  });

  it('shows "X of Y today" with a bar when there is an all-agents cap', async () => {
    svc.caps.mockResolvedValue(makeCapsView({ totalCapTodayTokens: 15 * M }));
    renderPage();
    expect(await screen.findByTestId('usage-headline')).toHaveTextContent('12.4M of 15M today');
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '83');
    expect(screen.getByTestId('usage-subline')).toHaveTextContent('Close to the daily cap');
  });

  it('switches the range (7 / 30 days)', async () => {
    renderPage();
    await screen.findByTestId('usage-headline');
    fireEvent.click(screen.getByTestId('usage-period-30'));
    await waitFor(() => expect(svc.stats).toHaveBeenLastCalledWith(30, ['team', 'agent', 'runtime', 'workItem']));
    expect(await screen.findByTestId('usage-headline')).toHaveTextContent('100M in the last 30 days');
    fireEvent.click(screen.getByTestId('usage-period-7'));
    await waitFor(() => expect(svc.caps).toHaveBeenLastCalledWith(7));
  });

  it('"Boost a team" opens the caps and the per-team list; one tap boosts a team', async () => {
    svc.boost.mockResolvedValue({ id: 'b1', target: 'team:t-ce', extraTokens: 50 * M, until: '', createdAt: '' });
    renderPage();
    await screen.findByTestId('usage-headline');
    fireEvent.click(screen.getByRole('button', { name: 'Boost a team' }));
    const row = screen.getByTestId('usage-cap-team-t-ce');
    fireEvent.click(within(row).getByRole('button', { name: '+50M today' }));
    await waitFor(() => expect(svc.boost).toHaveBeenCalledWith({ scope: 'team', id: 't-ce', extraTokens: 50 * M }));
    expect(await screen.findByTestId('usage-note')).toHaveTextContent('CE: +50M tokens until midnight.');
  });

  it('Details shows runtimes and work items linked to their run', async () => {
    renderPage();
    await screen.findByTestId('usage-headline');
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByTestId('usage-runtime-codex-cli')).toHaveTextContent('Codex');
    expect(screen.getByRole('link', { name: 'Refresh bulletin page' })).toHaveAttribute('href', '/tickets/runs/wi-1');
    expect(screen.getByTestId('usage-split')).toHaveTextContent('80M cached');
  });

  it('when all agents hit the total cap, says so with "Unlimited today"', async () => {
    svc.caps.mockResolvedValue(makeCapsView({ totalStopped: true, totalCapTodayTokens: 12 * M }));
    svc.boost.mockResolvedValue({ id: 'b2', target: '*', unlimited: true, until: '', createdAt: '' });
    renderPage();
    const banner = await screen.findByTestId('usage-total-stopped');
    fireEvent.click(within(banner).getByRole('button', { name: 'Unlimited today' }));
    await waitFor(() => expect(svc.boost).toHaveBeenCalledWith({ scope: 'all', unlimited: true }));
  });

  it('shows a load error with Retry', async () => {
    svc.stats.mockRejectedValueOnce(new Error('Usage tracking is not ready yet'));
    renderPage();
    expect(await screen.findByText(/Usage tracking is not ready yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('usage-headline')).toBeInTheDocument();
  });
});

describe('usageHeadline', () => {
  it('describes 7 / 30 days with today so far', () => {
    const h = usageHeadline('7', makeUsageStats(), makeCapsView({ totalCapTodayTokens: 200 * M }));
    expect(h).toEqual({ headline: '100M in the last 7 days', subline: 'Today so far: 12.4M of 200M', pct: null });
  });

  it('today under the cap resets at midnight', () => {
    const h = usageHeadline('1', makeUsageStats(), makeCapsView({ totalCapTodayTokens: 200 * M }));
    expect(h.subline).toBe('Resets at midnight.');
    expect(h.pct).toBe(6);
  });
});

describe('agentBars / teamBars', () => {
  it('labels agents by team and runtime, and teams by their cap', () => {
    const stats = makeUsageStats();
    const caps = makeCapsView();
    expect(agentBars(stats, caps)[1]).toEqual({ key: 'crewly-orc', name: 'Orc', sub: 'Claude Code', alert: undefined, total: 30 * M, detail: '30M input (15M cached) · 0 output · 1 turns' });
    expect(teamBars(stats, caps)[0]).toMatchObject({ key: 't-ce', name: 'CE', sub: '51M today · 50M cap', alert: 'Stopped until midnight' });
    expect(teamBars(stats, caps)[1]).toMatchObject({ name: 'Orc (no team)', sub: '' });
  });
});
