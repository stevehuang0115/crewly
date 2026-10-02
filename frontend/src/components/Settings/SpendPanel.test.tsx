/**
 * Tests for Settings → System → Spend.
 *
 * @module components/Settings/SpendPanel.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpendPanel, capLabel, raiseAmount } from './SpendPanel';
import { spendService, type SpendView } from '../../services/spend.service';

vi.mock('../../services/spend.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/spend.service')>()),
  spendService: { get: vi.fn(), setCaps: vi.fn(), raise: vi.fn() },
}));

const svc = vi.mocked(spendService);

function view(over: Partial<SpendView> = {}): SpendView {
  return {
    today: '2026-10-02',
    days: [
      { date: '2026-10-01', totalUsd: 3, byAgent: { 'crewly-orc': 3 }, byRuntime: { 'crewly-agent': 3 } },
      { date: '2026-10-02', totalUsd: 5.5, byAgent: { 'crewly-orc': 5.5 }, byRuntime: { 'crewly-agent': 5.5 } },
    ],
    agents: [
      { session: 'crewly-orc', name: 'Orc', runtimes: ['crewly-agent'], todayUsd: 5.5, windowUsd: 8.5, daily: [3, 5.5], capUsd: 5, capSource: 'override', stopped: true, stopReason: 'Orc hit its daily spend cap ($5.00)' },
      { session: 'ella-1', name: 'Ella', runtimes: ['claude-code'], todayUsd: 0, windowUsd: 0, daily: [0, 0], capUsd: null, capSource: 'none', stopped: false },
    ],
    byRuntime: { 'crewly-agent': 8.5 },
    totalUsd: 8.5,
    todayUsd: 5.5,
    p90AgentDayUsd: 5.5,
    caps: { defaultAgentCapUsd: null, totalCapUsd: null, agentCapsUsd: { 'crewly-orc': 5 } },
    raisedToday: {},
    totalCapTodayUsd: null,
    suggestedAgentCapUsd: 6,
    totalStopped: false,
    ...over,
  };
}

describe('SpendPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.get.mockResolvedValue(view());
  });

  it('shows today and 7 days, by agent and runtime', async () => {
    render(<SpendPanel />);
    expect(await screen.findByTestId('spend-today')).toHaveTextContent('$5.50');
    expect(screen.getByTestId('spend-window')).toHaveTextContent('$8.50');
    expect(screen.getAllByText(/Crewly Agent \$5\.50/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('spend-agent-crewly-orc')).toHaveTextContent('Orc');
    // An agent with no spend and no cap is left out.
    expect(screen.queryByTestId('spend-agent-ella-1')).toBeNull();
    expect(svc.get).toHaveBeenCalledWith(7);
  });

  it('shows the stop and raises for today', async () => {
    svc.raise.mockResolvedValue({ session: 'crewly-orc', capUsd: 10 });
    render(<SpendPanel />);
    expect(await screen.findByTestId('spend-stopped-crewly-orc')).toHaveTextContent('Orc hit its daily spend cap ($5.00) — stopped until midnight');
    fireEvent.click(screen.getByRole('button', { name: 'Raise to $10 today' }));
    await waitFor(() => expect(svc.raise).toHaveBeenCalledWith('crewly-orc', 10));
    expect(await screen.findByTestId('spend-note')).toHaveTextContent('Orc raised to $10.00 for today. Queued messages are being delivered.');
  });

  it('suggests the p90 and saves the default, the total and an override', async () => {
    svc.setCaps.mockResolvedValue(view().caps);
    render(<SpendPanel />);
    expect(await screen.findByTestId('spend-suggestion')).toHaveTextContent('Suggested: $6');
    fireEvent.click(screen.getByRole('button', { name: 'Use suggested $6' }));
    fireEvent.change(screen.getByLabelText('Daily total cap, all agents (USD)'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Daily cap for Orc'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    await waitFor(() =>
      expect(svc.setCaps).toHaveBeenCalledWith({ defaultAgentCapUsd: 6, totalCapUsd: 20, agents: { 'crewly-orc': 'default' } }),
    );
  });

  it('rejects an unreadable cap without calling the API', async () => {
    render(<SpendPanel />);
    fireEvent.change(await screen.findByLabelText('Daily cap per agent (USD)'), { target: { value: 'lots' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    expect(await screen.findByText('Caps must be a positive amount in USD, or empty for off.')).toBeInTheDocument();
    expect(svc.setCaps).not.toHaveBeenCalled();
  });

  it('shows the total-cap stop', async () => {
    svc.get.mockResolvedValue(view({ totalCapTodayUsd: 5, totalStopped: true }));
    render(<SpendPanel />);
    expect(await screen.findByText(/All agents together hit the daily total spend cap \(\$5\.00\)/)).toBeInTheDocument();
  });

  it('shows a load error with Retry', async () => {
    svc.get.mockRejectedValueOnce(new Error('Spend tracking is not ready yet'));
    render(<SpendPanel />);
    expect(await screen.findByText(/Spend tracking is not ready yet/)).toBeInTheDocument();
  });
});

describe('helpers', () => {
  it('raiseAmount doubles the cap and stays above the spend', () => {
    expect(raiseAmount(5, 5.5)).toBe(10);
    expect(raiseAmount(1, 9.2)).toBe(11);
  });
  it('capLabel', () => {
    expect(capLabel({ capUsd: 5, capSource: 'default' })).toBe('$5.00 (default)');
    expect(capLabel({ capUsd: 10, capSource: 'raised' })).toBe('$10.00 (raised today)');
    expect(capLabel({ capUsd: null, capSource: 'exempt' })).toBe('No cap (exempt)');
    expect(capLabel({ capUsd: null, capSource: 'none' })).toBe('No cap');
  });
});
