/**
 * Tests for the traces API client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTraceByRef, fetchTraceMetrics, fetchTraceTimeline, TraceApiError } from './traces.service';

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): void {
	fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('traces.service', () => {
	it('fetches the timeline and metrics, with an optional stall threshold', async () => {
		respond({ success: true, data: { groups: [] } });
		await expect(fetchTraceTimeline('tr-20261003-0000abcd')).resolves.toEqual({ groups: [] });
		respond({ success: true, data: { traceId: 'x' } });
		await fetchTraceMetrics('tr-20261003-0000abcd', 45);
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/traces/tr-20261003-0000abcd/timeline', '/api/traces/tr-20261003-0000abcd/metrics?stallMinutes=45']);
	});

	it('looks a trace up by entity; 404 is no trace, other failures throw', async () => {
		respond({ success: true, data: { traceId: 't', root: {} } });
		await expect(fetchTraceByRef('ticketId', 'CE-7')).resolves.toEqual({ traceId: 't', root: {} });
		expect(fetchMock).toHaveBeenLastCalledWith('/api/traces/by-ref?ticketId=CE-7');
		respond({ success: false, error: 'No trace' }, 404);
		await expect(fetchTraceByRef('workItemId', 'w')).resolves.toBeNull();
		respond({ success: false, error: 'boom' }, 500);
		await expect(fetchTraceByRef('workItemId', 'w')).rejects.toBeInstanceOf(TraceApiError);
	});

	it('reports the server error and status', async () => {
		respond({ success: false, error: 'Not a trace id' }, 400);
		await expect(fetchTraceTimeline('bad')).rejects.toMatchObject({ message: 'Not a trace id', status: 400 });
		fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error('html'); } });
		await expect(fetchTraceTimeline('bad')).rejects.toMatchObject({ message: 'HTTP 502' });
	});
});
