/**
 * Tests for the generic run timeline page.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TraceDetail } from './TraceDetail';
import { timelineData, TRACE_ID } from '../test/trace.fixtures';

vi.mock('../services/api.service', () => ({ apiService: { getTeams: vi.fn().mockResolvedValue([]) } }));

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('TraceDetail', () => {
	it('titles the page with what started the run and shows its timeline', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: timelineData() }) });
		render(
			<MemoryRouter initialEntries={[`/tickets/traces/${TRACE_ID}`]}>
				<Routes>
					<Route path="/tickets/traces/:traceId" element={<TraceDetail />} />
				</Routes>
			</MemoryRouter>,
		);
		expect(await screen.findByText('TKT-012: Fix the FAQ schema')).toBeInTheDocument();
		expect(screen.getByText(/^Request · started/)).toBeInTheDocument();
		expect(screen.getByTestId('trace-timeline-groups')).toBeInTheDocument();
		// The trace id is plumbing: in the URL, never on the page.
		expect(document.body.textContent).not.toContain(TRACE_ID);
		expect(fetchMock).toHaveBeenCalledWith(`/api/traces/${TRACE_ID}/timeline`);
	});
});
