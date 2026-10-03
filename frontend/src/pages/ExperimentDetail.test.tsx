/**
 * Tests for the experiment card page and its Timeline tab.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ExperimentDetail } from './ExperimentDetail';
import { experimentCard as card } from '../test/trace.fixtures';

vi.mock('../services/experiments.service', () => ({ fetchExperiment: vi.fn(), fetchExperiments: vi.fn() }));
vi.mock('../components/TraceTimeline', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../components/TraceTimeline')>();
	return {
		...actual,
		TraceTimeline: ({ traceId, refParam, refId }: { traceId?: string | null; refParam?: string; refId?: string }) => (
			<div data-testid="trace-timeline-stub">{`trace=${traceId ?? 'none'} ref=${refParam}:${refId}`}</div>
		),
	};
});
import { fetchExperiment } from '../services/experiments.service';

function renderAt(url: string) {
	return render(
		<MemoryRouter initialEntries={[url]}>
			<Routes>
				<Route path="/tickets/experiments/:id" element={<ExperimentDetail />} />
			</Routes>
		</MemoryRouter>,
	);
}

describe('ExperimentDetail', () => {
	beforeEach(() => vi.clearAllMocks());

	it('shows an autopilot card\'s process before / during and its other outcome metrics', async () => {
		const proc = (shipped: number) => ({
			range: { start: 'a', end: 'b' }, ticketsStarted: shipped + 1, ticketsShipped: shipped, ownerTouches: 2 * shipped,
			ownerTouchesPerTicket: shipped ? 2 : null, stalls: 1, stallMs: 2 * 3_600_000, costUsd: 1.5 * shipped, costPerShippedTicket: shipped ? 1.5 : null,
		});
		vi.mocked(fetchExperiment).mockResolvedValue(
			card({
				autopilot: {
					projectId: 'p-ce', projectName: 'CE', label: 'feed', checkIns: 1, processBaseline: proc(0), processResult: proc(6),
					outcomes: [{ metric: { source: 'ga4', measure: 'sessions', page: '/feed' }, verdictReason: 'sessions 100 → 160 (+60%)' }],
				},
			}),
		);
		renderAt('/tickets/experiments/EXP-3');
		const section = await screen.findByTestId('experiment-autopilot');
		expect(section).toHaveTextContent('Autopilot: CE · feed');
		expect(section).toHaveTextContent('0 shipped (1 started) · 0 owner touches · stalls 2h');
		expect(section).toHaveTextContent('6 shipped (7 started) · 2 owner touches per ticket');
		expect(section).toHaveTextContent('ga4 sessions /feed');
		expect(section).toHaveTextContent('sessions 100 → 160 (+60%)');
	});

	it('hides a no-data process baseline instead of showing zeros', async () => {
		vi.mocked(fetchExperiment).mockResolvedValue(
			card({
				autopilot: {
					projectId: 'p-ce', projectName: 'CE', checkIns: 0, outcomes: [],
					processBaseline: { range: { start: 'a', end: 'b' }, ticketsStarted: 0, ticketsShipped: 0, ownerTouches: 0, ownerTouchesPerTicket: null, stalls: 0, stallMs: 0, costUsd: 0, costPerShippedTicket: null, noData: true },
				},
			}),
		);
		renderAt('/tickets/experiments/EXP-3');
		const section = await screen.findByTestId('experiment-autopilot');
		expect(section).not.toHaveTextContent('Before');
		expect(section).toHaveTextContent('During');
	});

	it('shows the card: hypothesis, baseline, result, verdict and its log', async () => {
		vi.mocked(fetchExperiment).mockResolvedValue(
			card({
				status: 'done',
				verdict: 'worked',
				verdictReason: 'clicks 100 → 150 (+50%)',
				baseline: { start: '2026-09-15', end: '2026-09-28', total: 100, volume: 4000 },
				result: { start: '2026-10-01', end: '2026-10-14', total: 150, volume: 4200 },
				timeline: [
					{ at: '2026-10-01T10:00:00Z', event: 'created', detail: 'by seo-lead on CE-7' },
					{ at: '2026-10-15T10:00:00Z', event: 'measured', detail: 'worked: clicks 100 → 150' },
				],
			}),
		);
		renderAt('/tickets/experiments/EXP-3');
		expect(await screen.findByText('FAQ schema on the H-1B page')).toBeInTheDocument();
		expect(fetchExperiment).toHaveBeenCalledWith('EXP-3');
		expect(screen.getByText('FAQ schema → clicks from 100 to 140')).toBeInTheDocument();
		expect(screen.getByText('100 (2026-09-15 – 2026-09-28)')).toBeInTheDocument();
		expect(screen.getByText('Worked — clicks 100 → 150 (+50%)')).toBeInTheDocument();
		const log = screen.getByTestId('experiment-card-log');
		expect(log.textContent).toMatch(/measured.*created/);
	});

	it('has a Timeline tab showing the card trace', async () => {
		vi.mocked(fetchExperiment).mockResolvedValue(card());
		renderAt('/tickets/experiments/EXP-3');
		fireEvent.click(await screen.findByRole('tab', { name: 'Timeline' }));
		expect(await screen.findByTestId('trace-timeline-stub')).toHaveTextContent('trace=tr-20261003-0000abcd ref=experimentId:EXP-3');
	});

	it('looks the trace up by experiment when the card has none', async () => {
		vi.mocked(fetchExperiment).mockResolvedValue(card({ traceId: 'exp:EXP-3' }));
		renderAt('/tickets/experiments/EXP-3?tab=timeline');
		expect(await screen.findByTestId('trace-timeline-stub')).toHaveTextContent('trace=none ref=experimentId:EXP-3');
	});

	it('shows not found with Retry', async () => {
		vi.mocked(fetchExperiment).mockRejectedValueOnce(new Error('Experiment not found: EXP-9')).mockResolvedValueOnce(card());
		renderAt('/tickets/experiments/EXP-9');
		expect(await screen.findByText('Experiment not found: EXP-9')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
		expect(await screen.findByText('FAQ schema on the H-1B page')).toBeInTheDocument();
	});
});
