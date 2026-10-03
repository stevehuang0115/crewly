/**
 * Tests for Tickets › Experiments.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Experiments, experimentMetricLabel, experimentStatus } from './Experiments';
import { experimentCard as card } from '../test/trace.fixtures';

vi.mock('../services/experiments.service', async (importOriginal) => ({
	...(await importOriginal<typeof import('../services/experiments.service')>()),
	fetchExperiments: vi.fn(),
}));
import { ExperimentsApiError, fetchExperiments } from '../services/experiments.service';


function renderList() {
	return render(
		<MemoryRouter initialEntries={['/tickets?tab=experiments']}>
			<Routes>
				<Route path="/tickets" element={<Experiments />} />
				<Route path="/tickets/experiments/:id" element={<div>Experiment page</div>} />
			</Routes>
		</MemoryRouter>,
	);
}

describe('Experiments', () => {
	beforeEach(() => vi.clearAllMocks());

	it('lists cards, newest first, and opens one', async () => {
		vi.mocked(fetchExperiments).mockResolvedValue([card({ id: 'EXP-1', title: 'Older', updatedAt: '2026-09-01T00:00:00Z' }), card()]);
		renderList();
		const rows = await screen.findAllByTestId(/experiment-row-/);
		expect(rows.map((r) => r.dataset.testid)).toEqual(['experiment-row-EXP-3', 'experiment-row-EXP-1']);
		expect(screen.getAllByText('EXP-3 · GSC clicks · https://visa.example/h1b · CE-7 · 14-day window')).toHaveLength(1);
		expect(screen.getAllByText('Measuring').length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole('button', { name: /FAQ schema on the H-1B page/ }));
		expect(screen.getByText('Experiment page')).toBeInTheDocument();
	});

	it('shows an empty state and errors', async () => {
		vi.mocked(fetchExperiments).mockResolvedValueOnce([]);
		const { unmount } = renderList();
		expect(await screen.findByText('No experiments yet')).toBeInTheDocument();
		unmount();
		vi.mocked(fetchExperiments).mockRejectedValueOnce(new Error('Experiments are not running')).mockResolvedValueOnce([card()]);
		renderList();
		expect(await screen.findByText('Experiments are not running')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
		expect(await screen.findByTestId('experiment-row-EXP-3')).toBeInTheDocument();
	});

	it('shows an empty state, not the raw error, when experiments are off (503)', async () => {
		vi.mocked(fetchExperiments).mockRejectedValueOnce(new ExperimentsApiError('Experiments are not running (starting up, or CREWLY_EXPERIMENTS=0)', 503));
		renderList();
		expect(await screen.findByTestId('experiments-off')).toHaveTextContent('Experiments are not running');
		expect(screen.queryByText(/CREWLY_EXPERIMENTS=0\)/)).not.toBeInTheDocument();
	});

	it('words statuses and metrics', () => {
		expect(experimentStatus({ status: 'done', verdict: 'worked' })).toEqual({ label: 'Worked', tone: 'success' });
		expect(experimentStatus({ status: 'done', verdict: 'didnt' })).toEqual({ label: "Didn't work", tone: 'danger' });
		expect(experimentStatus({ status: 'done', verdict: 'inconclusive' }).label).toBe('Inconclusive');
		expect(experimentStatus({ status: 'planned' }).label).toBe('Not shipped');
		expect(experimentStatus({ status: 'cancelled' }).tone).toBe('neutral');
		expect(experimentMetricLabel({ metric: { source: 'ga4', measure: 'events', event: 'generate_lead' } })).toBe('GA4 events · generate_lead');
		expect(experimentMetricLabel({ metric: { source: 'gsc', measure: 'clicks', label: 'CE organic clicks' } })).toBe('CE organic clicks');
	});
});
