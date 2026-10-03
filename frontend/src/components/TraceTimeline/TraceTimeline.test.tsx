/**
 * Tests for the run timeline loader: trace id or lookup by entity, no trace,
 * errors, refresh and polling, at phone width.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TraceTimeline } from './TraceTimeline';
import { timelineData, TRACE_ID, traceMetrics } from '../../test/trace.fixtures';

const fetchMock = vi.fn();

/**
 * Queue one fetch response.
 *
 * @param body - JSON body
 * @param status - HTTP status
 */
function respond(body: unknown, status = 200): void {
	fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('TraceTimeline', () => {
	it('loads a trace by id and renders the strip and the groups', async () => {
		respond({ success: true, data: timelineData() });
		const loaded = vi.fn();
		render(<TraceTimeline traceId={TRACE_ID} pollMs={0} onLoaded={loaded} />);
		expect(screen.getByTestId('trace-timeline-loading')).toBeInTheDocument();
		expect(await screen.findByTestId('trace-metrics-strip')).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledWith(`/api/traces/${TRACE_ID}/timeline`);
		expect(screen.getAllByRole('listitem').filter((li) => li.dataset.kind)).toHaveLength(3);
		expect(screen.getByText('Stalled 1h — waiting on you')).toBeInTheDocument();
		expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ root: expect.objectContaining({ traceId: TRACE_ID }) }));
	});

	it('finds the trace from an entity', async () => {
		respond({ success: true, data: { traceId: TRACE_ID, root: {} } });
		respond({ success: true, data: timelineData() });
		render(<TraceTimeline refParam="requestId" refId="req 1" pollMs={0} />);
		await screen.findByTestId('trace-timeline');
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/traces/by-ref?requestId=req%201', `/api/traces/${TRACE_ID}/timeline`]);
	});

	it('says so when the entity has no trace', async () => {
		respond({ success: false, error: 'No trace' }, 404);
		render(<TraceTimeline refParam="experimentId" refId="EXP-1" pollMs={0} />);
		expect(await screen.findByText('No timeline for this yet')).toBeInTheDocument();
	});

	it('shows an error with Retry', async () => {
		respond({ success: false, error: 'boom' }, 500);
		respond({ success: true, data: timelineData() });
		render(<TraceTimeline traceId={TRACE_ID} pollMs={0} />);
		expect(await screen.findByText('boom')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
		expect(await screen.findByTestId('trace-timeline')).toBeInTheDocument();
	});

	it('shows an empty run and a truncated note', async () => {
		respond({ success: true, data: timelineData({ groups: [], truncated: true }) });
		render(<TraceTimeline traceId={TRACE_ID} pollMs={0} />);
		expect(await screen.findByTestId('trace-timeline-empty')).toBeInTheDocument();
		expect(screen.getByText(/hit the trace size limit/)).toBeInTheDocument();
	});

	it('refreshes on demand and polls only while the run is unfinished', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		respond({ success: true, data: timelineData() });
		render(<TraceTimeline traceId={TRACE_ID} pollMs={1000} />);
		await screen.findByTestId('trace-timeline');
		respond({ success: true, data: timelineData({ metrics: traceMetrics({ outcome: { state: 'done', workItems: { total: 1, done: 1, failed: 0, open: 0 } } }) }) });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1100);
		});
		await waitFor(() => expect(screen.getByTestId('trace-outcome')).toHaveTextContent('Done'));
		const calls = fetchMock.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(fetchMock.mock.calls.length).toBe(calls);
		respond({ success: true, data: timelineData() });
		fireEvent.click(screen.getByTestId('trace-timeline-refresh'));
		await waitFor(() => expect(fetchMock.mock.calls.length).toBe(calls + 1));
	});

	it('lays the strip out in two columns at phone width', async () => {
		window.innerWidth = 390;
		respond({ success: true, data: timelineData() });
		render(<TraceTimeline traceId={TRACE_ID} pollMs={0} />);
		const strip = await screen.findByTestId('trace-metrics-strip');
		const grid = strip.querySelector('dl');
		expect(grid?.className).toContain('grid-cols-2');
		expect(grid?.className).toContain('sm:flex');
	});
});
