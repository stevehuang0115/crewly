/**
 * system-control API client tests (fetch mocked).
 *
 * @module services/system-control.service.test
 */

import { vi, describe, it, expect, afterEach } from 'vitest';
import { fetchUpdateStatus, isBackendUp, startSystemAction } from './system-control.service';
import { SystemControlApiError } from '../types/system-control.types';

/**
 * A fetch Response stand-in.
 *
 * @param status - HTTP status
 * @param body - JSON body
 * @returns Response-like
 */
function res(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('system-control.service', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reads the status, with ?refresh=1 on demand', async () => {
		const f = vi.fn().mockResolvedValue(res(200, { success: true, data: { bootId: 'b1' } }));
		global.fetch = f;
		await expect(fetchUpdateStatus(true)).resolves.toEqual({ bootId: 'b1' });
		expect(f.mock.calls[0][0]).toBe('/api/system/update-status?refresh=1');
	});

	it('posts the action as the dashboard and returns it', async () => {
		const f = vi.fn().mockResolvedValue(res(202, { success: true, data: { action: { id: 'a1' } } }));
		global.fetch = f;
		await expect(startSystemAction('restart', 'idle')).resolves.toEqual({ id: 'a1' });
		const [url, init] = f.mock.calls[0];
		expect(url).toBe('/api/system/restart');
		expect(init.method).toBe('POST');
		expect(init.headers['X-Crewly-Caller']).toBe('dashboard');
		expect(JSON.parse(init.body)).toEqual({ when: 'idle' });
	});

	it('turns a refusal into an error with status and code', async () => {
		global.fetch = vi.fn().mockResolvedValue(res(409, { success: false, code: 'dev-checkout', error: 'update it with git' }));
		const err = await startSystemAction('upgrade', 'now').catch((e) => e);
		expect(err).toBeInstanceOf(SystemControlApiError);
		expect(err).toMatchObject({ status: 409, code: 'dev-checkout', message: 'update it with git' });
	});

	it('reports a network failure as status 0', async () => {
		global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		await expect(fetchUpdateStatus()).rejects.toMatchObject({ status: 0 });
		await expect(isBackendUp()).resolves.toBe(false);
	});
});
