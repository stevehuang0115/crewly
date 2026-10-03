/**
 * Tests for the experiments API client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentsApiError, fetchExperiment, fetchExperiments } from './experiments.service';

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): void {
	fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('experiments.service', () => {
	it('lists and reads cards', async () => {
		respond({ success: true, data: [{ id: 'EXP-1' }] });
		await expect(fetchExperiments()).resolves.toEqual([{ id: 'EXP-1' }]);
		respond({ success: true, data: { id: 'EXP 2' } });
		await fetchExperiment('EXP 2');
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/experiments', '/api/experiments/EXP%202']);
	});

	it('throws the server error', async () => {
		respond({ success: false, error: 'Experiments are not running' }, 503);
		await expect(fetchExperiments()).rejects.toThrow('Experiments are not running');
		respond({ success: false, error: 'off' }, 503);
		await expect(fetchExperiments()).rejects.toMatchObject({ status: 503 });
		respond({ success: false, error: 'off' }, 503);
		await expect(fetchExperiments()).rejects.toBeInstanceOf(ExperimentsApiError);
		fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new Error('x'); } });
		await expect(fetchExperiment('EXP-1')).rejects.toThrow('HTTP 500');
	});
});
