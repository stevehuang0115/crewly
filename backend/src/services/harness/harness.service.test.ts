/**
 * Tests for the harness service facade and its factories.
 */

import { HarnessApiKeyService } from './harness-api-key.service.js';
import { HarnessInstallService } from './harness-install.service.js';
import { HarnessStatusService } from './harness-status.service.js';
import {
	HarnessService,
	UnknownHarnessError,
	createHarnessService,
	getHarnessService,
	setHarnessServiceForTesting,
	type HarnessServiceParts,
} from './harness.service.js';
import type { HarnessStatus } from './harness.types.js';
import { LoginBrokerService } from './login-broker.service.js';
import { OrcHarnessStore } from './orc-harness.store.js';

const STATUS: HarnessStatus = {
	id: 'codex-cli',
	displayName: 'Codex',
	installed: true,
	version: '0.156.1',
	latestVersion: '0.156.1',
	updateAvailable: false,
	loginState: 'logged_in',
	loginSource: 'api_key',
	loginMethods: [],
};

/**
 * Parts with jest mocks.
 *
 * @returns Mocked parts
 */
function mockParts() {
	return {
		status: { listStatuses: jest.fn(async () => [STATUS]), getStatus: jest.fn(async () => STATUS), getSystemTools: jest.fn(() => [{ id: 'jq', installed: true, installHint: 'brew install jq' }]) },
		install: { startInstall: jest.fn(() => ({ jobId: 'j1' })), getJob: jest.fn(() => ({ jobId: 'j1' })) },
		broker: { start: jest.fn(() => ({ id: 's1' })) },
		apiKeys: { submit: jest.fn(async () => undefined) },
		orc: { get: jest.fn(async () => 'claude-code'), set: jest.fn(async (id: string) => id) },
	};
}

describe('HarnessService', () => {
	it('builds the overview from status, orc store and system tools', async () => {
		const parts = mockParts();
		const service = new HarnessService(parts as unknown as HarnessServiceParts);
		expect(await service.getOverview()).toEqual({
			harnesses: [STATUS],
			orcHarness: 'claude-code',
			systemTools: [{ id: 'jq', installed: true, installHint: 'brew install jq' }],
		});
	});

	it('validates harness ids before delegating', async () => {
		const parts = mockParts();
		const service = new HarnessService(parts as unknown as HarnessServiceParts);
		expect(() => service.requireHarnessId('nope')).toThrow(UnknownHarnessError);
		await expect(service.getStatus('nope')).rejects.toBeInstanceOf(UnknownHarnessError);
		expect(() => service.startInstall('opencode-cli')).toThrow(UnknownHarnessError);
		await expect(service.setOrcHarness('nope')).rejects.toBeInstanceOf(UnknownHarnessError);
		expect(() => service.startLogin('nope', 'device')).toThrow(UnknownHarnessError);
		await expect(service.submitApiKey('nope', 'k')).rejects.toBeInstanceOf(UnknownHarnessError);
		expect(parts.install.startInstall).not.toHaveBeenCalled();
	});

	it('delegates each operation', async () => {
		const parts = mockParts();
		const service = new HarnessService(parts as unknown as HarnessServiceParts);
		expect(await service.getStatus('codex-cli')).toBe(STATUS);
		expect(service.startInstall('codex-cli')).toEqual({ jobId: 'j1' });
		expect(service.getInstallJob('j1')).toEqual({ jobId: 'j1' });
		expect(await service.setOrcHarness('codex-cli')).toBe('codex-cli');
		expect(service.startLogin('codex-cli', 'device')).toEqual({ id: 's1' });
		expect(parts.broker.start).toHaveBeenCalledWith('codex-cli', 'device');
		expect(await service.submitApiKey('codex-cli', 'key')).toBe(STATUS);
		expect(parts.apiKeys.submit).toHaveBeenCalledWith('codex-cli', 'key');
	});
});

describe('factories', () => {
	afterEach(() => setHarnessServiceForTesting(null));

	it('createHarnessService wires real parts', () => {
		const service = createHarnessService({ updateDefaultRuntime: async () => undefined });
		expect(service.status).toBeInstanceOf(HarnessStatusService);
		expect(service.install).toBeInstanceOf(HarnessInstallService);
		expect(service.broker).toBeInstanceOf(LoginBrokerService);
		expect(service.apiKeys).toBeInstanceOf(HarnessApiKeyService);
		expect(service.orc).toBeInstanceOf(OrcHarnessStore);
	});

	it('getHarnessService returns one backend instance, replaceable in tests', () => {
		const fake = new HarnessService(mockParts() as unknown as HarnessServiceParts);
		setHarnessServiceForTesting(fake);
		expect(getHarnessService()).toBe(fake);
		setHarnessServiceForTesting(null);
		const real = getHarnessService();
		expect(real).toBeInstanceOf(HarnessService);
		expect(getHarnessService()).toBe(real);
	});
});
