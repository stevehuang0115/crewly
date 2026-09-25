/**
 * Tests for the CLI's access to the harness engine: in-process service,
 * backend-vs-in-process login driver, and the backend REST driver.
 */

import type { HarnessService } from '../../../backend/src/services/harness/harness.service.js';
import {
	createBackendLoginDriver,
	createCliHarnessService,
	createInProcessLoginDriver,
	getBackendPort,
	isBackendRunning,
	localBackendUrl,
	pickLoginDriver,
	type HttpJson,
} from './harness-engine.js';

const SESSION = { id: 's1', harnessId: 'claude-code', method: 'subscription', state: 'awaiting_user', url: 'https://x', userCode: null, needsInput: true, message: null, screen: '', startedAt: '', updatedAt: '' };

describe('backend location', () => {
	it('uses WEB_PORT or the default port', () => {
		expect(getBackendPort({ WEB_PORT: '9001' })).toBe(9001);
		expect(getBackendPort({ WEB_PORT: 'nope' })).toBeGreaterThan(0);
		expect(getBackendPort({})).toBeGreaterThan(0);
		expect(localBackendUrl(9001)).toBe('http://localhost:9001');
	});

	it('isBackendRunning checks /health and never throws', async () => {
		const up: HttpJson = jest.fn(async () => ({ status: 200, body: {} }));
		expect(await isBackendRunning(9001, up)).toBe(true);
		expect(up).toHaveBeenCalledWith('GET', 'http://localhost:9001/health');
		expect(await isBackendRunning(9001, async () => ({ status: 503, body: {} }))).toBe(false);
		expect(await isBackendRunning(9001, async () => { throw new Error('ECONNREFUSED'); })).toBe(false);
	});
});

describe('login drivers', () => {
	it('backend driver calls the /api/harness contract and unwraps data', async () => {
		const http = jest.fn<ReturnType<HttpJson>, Parameters<HttpJson>>(async () => ({ status: 200, body: { success: true, data: SESSION } }));
		const driver = createBackendLoginDriver('http://localhost:8787', http);
		expect(driver.where).toBe('backend');
		expect(await driver.start('claude-code', 'subscription')).toEqual(SESSION);
		await driver.get('s1');
		await driver.input('s1', 'code#state');
		await driver.cancel('s1');
		expect(http.mock.calls).toEqual([
			['POST', 'http://localhost:8787/api/harness/claude-code/login', { method: 'subscription' }],
			['GET', 'http://localhost:8787/api/harness/login/s1'],
			['POST', 'http://localhost:8787/api/harness/login/s1/input', { text: 'code#state' }],
			['POST', 'http://localhost:8787/api/harness/login/s1/cancel'],
		]);
	});

	it('backend driver surfaces API errors', async () => {
		const driver = createBackendLoginDriver('http://localhost:8787', async () => ({ status: 409, body: { success: false, error: 'Codex is not installed' } }));
		await expect(driver.start('codex-cli', 'device')).rejects.toThrow('Codex is not installed');
		const bare = createBackendLoginDriver('http://localhost:8787', async () => ({ status: 500, body: null }));
		await expect(bare.get('s1')).rejects.toThrow('HTTP 500');
	});

	it('in-process driver delegates to the service broker', async () => {
		const service = {
			startLogin: jest.fn(() => SESSION),
			broker: { get: jest.fn(() => SESSION), input: jest.fn(() => SESSION), cancel: jest.fn(() => SESSION) },
		} as unknown as HarnessService;
		const driver = createInProcessLoginDriver(service);
		expect(driver.where).toBe('in-process');
		await driver.start('claude-code', 'subscription');
		await driver.get('s1');
		await driver.input('s1', 'x');
		await driver.cancel('s1');
		expect(service.startLogin).toHaveBeenCalledWith('claude-code', 'subscription');
		expect(service.broker.input).toHaveBeenCalledWith('s1', 'x');
	});

	it('pickLoginDriver prefers the running backend', async () => {
		const service = {} as HarnessService;
		expect((await pickLoginDriver(service, { port: 8787, http: async () => ({ status: 200, body: {} }) })).where).toBe('backend');
		expect((await pickLoginDriver(service, { port: 8787, http: async () => { throw new Error('down'); } })).where).toBe('in-process');
	});
});

describe('createCliHarnessService', () => {
	it('builds an engine with every part', () => {
		const service = createCliHarnessService();
		expect(service.status).toBeDefined();
		expect(service.install).toBeDefined();
		expect(service.broker).toBeDefined();
		expect(service.apiKeys).toBeDefined();
		expect(service.orc).toBeDefined();
	});
});
