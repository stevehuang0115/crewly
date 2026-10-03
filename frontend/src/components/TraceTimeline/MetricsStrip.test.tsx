/**
 * Tests for the run metrics strip.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MetricsStrip, metricTiles, outcomeTone } from './MetricsStrip';
import { traceMetrics } from '../../test/trace.fixtures';

describe('MetricsStrip', () => {
	it('shows the numbers at a glance and flags what needs the owner', () => {
		render(<MetricsStrip metrics={traceMetrics()} />);
		expect(screen.getByTestId('trace-outcome')).toHaveTextContent('Waiting on you');
		expect(within(screen.getByTestId('trace-metric-wall')).getByText('2h 30m')).toBeInTheDocument();
		const owner = screen.getByTestId('trace-metric-owner-wait');
		expect(owner).toHaveTextContent('1h');
		expect(owner).toHaveTextContent('40% of the time');
		expect(owner.className).toContain('bg-attention-soft');
		expect(screen.getByTestId('trace-metric-touches')).toHaveAttribute('title', 'Answered 1, approved 1, sent back 1, corrected 0, manual 0');
		expect(screen.getByTestId('trace-metric-stalls')).toHaveTextContent('1');
		expect(screen.getByTestId('trace-metric-cost')).toHaveTextContent('$1.23');
		expect(screen.getByTestId('trace-metric-cost')).toHaveTextContent('34k tokens');
		expect(screen.getByText('1 of 2 runs done')).toBeInTheDocument();
	});

	it('keeps the breakdowns behind Details, with agent names', () => {
		render(<MetricsStrip metrics={traceMetrics()} nameOf={(s) => (s === 'ella' ? 'Ella' : s)} />);
		expect(screen.queryByText(/nudges 2/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Details/ }));
		expect(screen.getByText(/nudges 2 · redeliveries 0 · wakes 1/)).toBeInTheDocument();
		expect(screen.getByText('Ella 34k $1.23')).toBeInTheDocument();
		expect(screen.getByText(/waiting on you 1 \(longer than 30m\)/)).toBeInTheDocument();
	});

	it('does not flag a calm run', () => {
		const m = traceMetrics({
			time: { wallMs: 600_000, activeMs: 600_000, waitingOwnerMs: 0, waitingAgentMs: 0, idleMs: 0, activeSource: 'inferred' },
			rework: { sendBacks: 0, retries: 0, failedVerifications: 0, subagentSendBacks: 0, total: 0 },
			stalls: { thresholdMinutes: 30, count: 0, totalMs: 0, byCause: { runtime_quota: 0, delivery_failure: 0, waiting_on_owner: 0, waiting_on_agent: 0, nobody_pushing: 0 }, items: [] },
			outcome: { state: 'done', workItems: { total: 0, done: 0, failed: 0, open: 0 } },
		});
		const tiles = metricTiles(m);
		expect(tiles.filter((t) => t.attention)).toEqual([]);
		expect(tiles.find((t) => t.id === 'active')?.title).toBe('Estimated from agent activity');
		expect(outcomeTone('done')).toBe('success');
		expect(outcomeTone('failed')).toBe('danger');
		expect(outcomeTone('in_progress')).toBe('primary');
		expect(outcomeTone('no_open_work')).toBe('neutral');
	});

	it('says when a stall is still going', () => {
		const base = traceMetrics();
		const m = traceMetrics({ stalls: { ...base.stalls, items: [{ ...base.stalls.items[0], ongoing: true }] } });
		render(<MetricsStrip metrics={m} />);
		expect(screen.getByTestId('trace-metric-stalls')).toHaveTextContent('one still going');
	});
});
