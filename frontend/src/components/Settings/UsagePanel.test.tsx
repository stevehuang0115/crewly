/**
 * Tests for Settings → System → Usage.
 *
 * @module components/Settings/UsagePanel.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsagePanel, teamCapLabel } from './UsagePanel';
import { usageService, type CapsView, type UsageStats } from '../../services/usage.service';

vi.mock('../../services/usage.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/usage.service')>()),
  usageService: { stats: vi.fn(), caps: vi.fn(), setCaps: vi.fn(), boost: vi.fn(), endBoost: vi.fn() },
}));

const svc = vi.mocked(usageService);
const M = 1_000_000;
const row = (key: string, label: string, total: number, extra: object = {}) => ({ key, label, total, input: total, cachedInput: total / 2, output: 0, events: 1, share: total / (100 * M), ...extra });

function stats(): UsageStats {
  return {
    days: 7,
    since: '2026-09-26T04:00:00.000Z',
    today: '2026-10-02',
    totals: { input: 95 * M, cachedInput: 80 * M, output: 5 * M, total: 100 * M, events: 10 },
    todayTotals: { input: 11 * M, cachedInput: 9 * M, output: M, total: 12.4 * M, events: 3 },
    groupBy: ['team', 'agent', 'runtime', 'workItem'],
    rows: [],
    groups: {
      team: [row('t-ce', 'CE', 70 * M), row('(unattributed)', 'Orc (no team)', 30 * M)],
      agent: [row('ce-nova', 'Nova', 40 * M, { meta: { team: 'CE', runtimes: ['codex-cli'] } }), row('crewly-orc', 'Orc', 30 * M, { meta: { runtimes: ['claude-code'] } })],
      runtime: [row('claude-code', 'claude-code', 60 * M), row('codex-cli', 'codex-cli', 40 * M)],
      workItem: [row('wi-1', 'Refresh bulletin page', 9 * M, { link: '/workitems/wi-1', meta: { agent: 'Nova', team: 'CE', status: 'completed' } })],
    },
  };
}

function caps(over: Partial<CapsView> = {}): CapsView {
  return {
    today: '2026-10-02',
    todayTokens: 12.4 * M,
    totalTokens: 100 * M,
    agents: [{ session: 'ce-nova', name: 'Nova', teamId: 't-ce', runtimes: ['codex-cli'], todayTokens: 6 * M, windowTokens: 40 * M, capTokens: null, baseCapTokens: null, capSource: 'none', boosted: false, unlimited: false, stopped: true, stopReason: 'Nova is stopped: team CE hit its daily token cap (50M tokens)' }],
    teams: [
      { teamId: 't-ce', name: 'CE', members: ['ce-nova'], todayTokens: 51 * M, baseCapTokens: 50 * M, capTokens: 50 * M, extraTokens: 0, unlimited: false, boosts: [], stopped: true },
      { teamId: 't-idle', name: 'Idle', members: [], todayTokens: 0, baseCapTokens: null, capTokens: null, extraTokens: 0, unlimited: false, boosts: [], stopped: false },
    ],
    caps: { defaultAgentCapTokens: null, totalCapTokens: null, agentCapsTokens: {}, teamCapsTokens: { 't-ce': 50 * M } },
    boosts: [],
    totalCapTodayTokens: null,
    suggestedAgentCapTokens: 8 * M,
    totalStopped: false,
    ...over,
  };
}

const renderPanel = () =>
  render(
    <MemoryRouter>
      <UsagePanel />
    </MemoryRouter>,
  );

describe('UsagePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.stats.mockResolvedValue(stats());
    svc.caps.mockResolvedValue(caps());
  });

  it('shows totals in tokens with cached input separate, by team / agent / runtime and top work items with links', async () => {
    renderPanel();
    expect(await screen.findByTestId('usage-total')).toHaveTextContent('100M tokens');
    expect(screen.getByTestId('usage-cached')).toHaveTextContent('80M cached input · 5M output');
    expect(screen.getByTestId('usage-today')).toHaveTextContent('12.4M tokens');
    expect(screen.getByTestId('usage-team-t-ce')).toHaveTextContent('CE');
    expect(screen.getByTestId('usage-team-cap-t-ce')).toHaveTextContent('50M cap');
    expect(screen.getByTestId('usage-team-t-ce')).toHaveTextContent('Stopped until midnight');
    // A team with no usage, no cap and no boost is left out.
    expect(screen.queryByTestId('usage-team-t-idle')).toBeNull();
    expect(screen.getByTestId('usage-team-(unattributed)')).toHaveTextContent('Orc (no team)');
    expect(screen.getByTestId('usage-agent-ce-nova')).toHaveTextContent('CE · Codex');
    expect(screen.getByTestId('usage-runtime-codex-cli')).toHaveTextContent('Codex');
    const link = screen.getByRole('link', { name: 'Refresh bulletin page' });
    expect(link).toHaveAttribute('href', '/workitems/wi-1');
    expect(svc.stats).toHaveBeenCalledWith(7, ['team', 'agent', 'runtime', 'workItem']);
  });

  it('switches the period (today / 30 days)', async () => {
    renderPanel();
    await screen.findByTestId('usage-total');
    fireEvent.click(screen.getByTestId('usage-period-30'));
    await waitFor(() => expect(svc.stats).toHaveBeenLastCalledWith(30, ['team', 'agent', 'runtime', 'workItem']));
    fireEvent.click(screen.getByTestId('usage-period-1'));
    await waitFor(() => expect(svc.caps).toHaveBeenLastCalledWith(1));
  });

  it('one tap on a team row boosts it (+cap today, or unlimited today)', async () => {
    svc.boost.mockResolvedValue({ id: 'b1', target: 'team:t-ce', extraTokens: 50 * M, until: '', createdAt: '' });
    renderPanel();
    await screen.findByTestId('usage-team-t-ce');
    fireEvent.click(screen.getByRole('button', { name: '+50M today' }));
    await waitFor(() => expect(svc.boost).toHaveBeenCalledWith({ scope: 'team', id: 't-ce', extraTokens: 50 * M }));
    expect(await screen.findByTestId('usage-note')).toHaveTextContent('CE: +50M tokens until midnight.');
    fireEvent.click(screen.getByRole('button', { name: 'Unlimited today' }));
    await waitFor(() => expect(svc.boost).toHaveBeenLastCalledWith({ scope: 'team', id: 't-ce', unlimited: true }));
  });

  it('unlimited today for everyone, and ending a boost', async () => {
    svc.boost.mockResolvedValue({ id: 'b2', target: '*', unlimited: true, until: '', createdAt: '' });
    renderPanel();
    fireEvent.click(await screen.findByText('Unlimited today for everyone'));
    await waitFor(() => expect(svc.boost).toHaveBeenCalledWith({ scope: 'all', unlimited: true }));

    svc.caps.mockResolvedValue(
      caps({
        boosts: [{ id: 'b3', target: 'team:t-ce', unlimited: true, until: '', createdAt: '' }],
        teams: [{ ...caps().teams[0], unlimited: true, boosts: [{ id: 'b3', target: 'team:t-ce', unlimited: true, until: '', createdAt: '' }], stopped: false }],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(await screen.findByRole('button', { name: 'End boost' }));
    await waitFor(() => expect(svc.endBoost).toHaveBeenCalledWith('b3'));
  });

  it('saves caps in tokens (default, total, team) and rejects dollar amounts', async () => {
    svc.setCaps.mockResolvedValue(caps().caps);
    renderPanel();
    expect(await screen.findByTestId('usage-suggestion')).toHaveTextContent('Suggested: 8M');
    fireEvent.change(screen.getByLabelText('Per agent (tokens)'), { target: { value: '$5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    expect(await screen.findByText('Caps are token amounts like 5M or 500k, or empty for off.')).toBeInTheDocument();
    expect(svc.setCaps).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Per agent (tokens)'), { target: { value: '8M' } });
    fireEvent.change(screen.getByLabelText('All agents together (tokens)'), { target: { value: '200M' } });
    fireEvent.change(screen.getByLabelText('Daily cap for team CE'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    await waitFor(() => expect(svc.setCaps).toHaveBeenCalledWith({ defaultAgentCapTokens: 8 * M, totalCapTokens: 200 * M, teams: { 't-ce': null } }));
  });

  it('shows a load error with Retry', async () => {
    svc.stats.mockRejectedValueOnce(new Error('Usage tracking is not ready yet'));
    renderPanel();
    expect(await screen.findByText(/Usage tracking is not ready yet/)).toBeInTheDocument();
  });
});

describe('teamCapLabel', () => {
  it('describes caps and boosts', () => {
    expect(teamCapLabel({ baseCapTokens: 50 * M, capTokens: 70 * M, extraTokens: 20 * M, unlimited: false })).toBe('70M cap (+20M today)');
    expect(teamCapLabel({ baseCapTokens: 50 * M, capTokens: 50 * M, extraTokens: 0, unlimited: false })).toBe('50M cap');
    expect(teamCapLabel({ baseCapTokens: null, capTokens: null, extraTokens: 0, unlimited: true })).toBe('Unlimited today');
    expect(teamCapLabel({ baseCapTokens: null, capTokens: null, extraTokens: 0, unlimited: false })).toBe('No cap');
  });
});
