import { initializeCloudIfConfigured, startSlackCloudSync } from './cloud-initializer.js';
import { CloudClientService } from './cloud-client.service.js';

// Slack v3: the Cloud-owned Slack config is pulled right after login.
const mockRefreshSlackCloudConfig = jest.fn().mockResolvedValue(undefined);
jest.mock('../slack/slack-initializer.js', () => ({
	refreshSlackCloudConfig: () => mockRefreshSlackCloudConfig(),
}));

// Mock logger
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn().mockReturnValue({
			createComponentLogger: jest.fn().mockReturnValue({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// Mock fs/promises
jest.mock('fs/promises', () => ({
	readFile: jest.fn(),
	writeFile: jest.fn().mockResolvedValue(undefined),
	mkdir: jest.fn().mockResolvedValue(undefined),
	unlink: jest.fn().mockResolvedValue(undefined),
}));

// Mock the controller auto-connect (dynamic import)
jest.mock('../../controllers/cloud/cloud.controller.js', () => ({
	autoConnectRelayFromToken: jest.fn(),
}));

const mockSyncStart = jest.fn();

jest.mock('./cloud-sync.service.js', () => ({
	CloudSyncService: {
		getInstance: () => ({
			start: mockSyncStart,
		}),
	},
}));

const mockGetOrCreateIdentity = jest.fn().mockResolvedValue({
	deviceId: 'test-device-uuid',
	deviceName: 'test-hostname',
});

jest.mock('./device-identity.service.js', () => ({
	DeviceIdentityService: {
		getInstance: () => ({
			getOrCreateIdentity: mockGetOrCreateIdentity,
		}),
	},
}));

import { readFile } from 'fs/promises';
const mockReadFile = jest.mocked(readFile);

// Config reads are synchronous and writes atomic in cloud-config-file.ts; route them to the
// fs/promises mocks below / a controllable read result so these tests stay about the service.
jest.mock('./cloud-config-file.js', () => {
  const actual = jest.requireActual('./cloud-config-file.js');
  const nodePath = jest.requireActual('path');
  return {
    ...actual,
    readCloudConfigFile: jest.fn(() => ({ status: 'missing' })),
    writeCloudConfigFile: jest.fn(async (config: unknown) => {
      const fsp = jest.requireMock('fs/promises');
      const file = actual.getCloudConfigPath();
      await fsp.mkdir(nodePath.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(config, null, 2), 'utf-8');
    }),
  };
});
import { readCloudConfigFile, validateCloudConfig } from './cloud-config-file.js';
const mockReadConfig = jest.mocked(readCloudConfigFile);
/** What readCloudConfigFile returns for a config object the test "put on disk". */
const cfgRead = (c: unknown) =>
  validateCloudConfig(c)
    ? ({ status: 'damaged', reason: String(validateCloudConfig(c)), quarantinedTo: null } as const)
    : ({ status: 'ok', config: c as never, repaired: false } as const);

describe('CloudInitializer', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		CloudClientService.resetInstance();
	});

	it('should skip when already connected', async () => {
		const client = CloudClientService.getInstance();
		// Simulate already connected
		client.connectLocal('https://api.crewlyai.com', 'token', 'pro');

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(false);
		expect(result.success).toBe(true);
	});

	it('should skip when no persisted config exists', async () => {
		mockReadConfig.mockReturnValue({ status: 'missing' });

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(false);
		expect(result.success).toBe(false);
	});

	it('should restore connection from persisted config', async () => {
		const config = {
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token-123',
			tier: 'pro',
			connectedAt: '2026-03-20T00:00:00Z',
		};
		mockReadConfig.mockReturnValue(cfgRead(config));

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(true);
		expect(result.success).toBe(true);

		const client = CloudClientService.getInstance();
		expect(client.isConnected()).toBe(true);
		expect(client.getTier()).toBe('pro');
	});

	it('should handle invalid config file gracefully', async () => {
		mockReadConfig.mockReturnValue({ status: 'damaged', reason: 'bad json', quarantinedTo: null });

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(false);
		expect(result.success).toBe(false);
	});

	it('should handle config with missing required fields', async () => {
		mockReadConfig.mockReturnValue(cfgRead({ cloudUrl: 'https://example.com' }));

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(false);
		expect(result.success).toBe(false);
	});

	// (The relay auto-connect assertion that used to live here referenced
	// `autoConnectRelayFromToken`, which no longer exists — the suite did not
	// compile. Relay registration is covered by cloud-sync.service.test.ts.)

	it('should pull the Cloud-owned Slack config on successful restore', async () => {
		const config = {
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token',
			tier: 'pro',
			connectedAt: '2026-03-20T00:00:00Z',
		};
		mockReadConfig.mockReturnValue(cfgRead(config));

		await initializeCloudIfConfigured();
		await new Promise((r) => setImmediate(r));

		expect(mockRefreshSlackCloudConfig).toHaveBeenCalled();
	});

	it('should start CloudSyncService on successful restore', async () => {
		const config = {
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token-sync',
			tier: 'pro',
			connectedAt: '2026-03-20T00:00:00Z',
		};
		mockReadConfig.mockReturnValue(cfgRead(config));

		await initializeCloudIfConfigured();

		expect(mockSyncStart).toHaveBeenCalledWith({
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token-sync',
			deviceId: 'test-device-uuid',
			deviceName: 'test-hostname',
		});
	});

	it('should pass refreshToken to connectLocal when present in config', async () => {
		const config = {
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token',
			tier: 'pro',
			connectedAt: '2026-03-20T00:00:00Z',
			refreshToken: 'refresh-token-persisted',
		};
		mockReadConfig.mockReturnValue(cfgRead(config));

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(true);
		expect(result.success).toBe(true);

		const client = CloudClientService.getInstance();
		expect(client.isConnected()).toBe(true);
		// The refresh token should have been passed to connectLocal
		// Verify by checking that the service has a token (indirect verification)
		expect(client.getToken()).toBeTruthy();
	});

	describe('refresh token rotation on startup (1.20.372 regression)', () => {
		const realFetch = global.fetch;
		const jwtWithExp = (expMs: number): string =>
			`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ type: 'refresh', exp: Math.floor(expMs / 1000) })).toString('base64url')}.s`;
		const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
		let refreshBodies: Array<{ refreshToken: string; rotate?: boolean }>;

		/** Cloud: /api/cloud/refresh answers with `body`; every other call (relay-token validate) fails quietly. */
		function mockCloud(body: Record<string, unknown>): void {
			refreshBodies = [];
			global.fetch = jest.fn(async (url: unknown, init?: { body?: string }) => {
				if (String(url).includes('/api/cloud/refresh')) {
					refreshBodies.push(JSON.parse(String(init?.body)));
					return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
				}
				return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response;
			}) as unknown as typeof fetch;
		}

		/** The refresh token inside the last config written to "disk". */
		function lastWrittenRefreshToken(): string | undefined {
			const fsp = jest.requireMock('fs/promises');
			const calls = (fsp.writeFile as jest.Mock).mock.calls;
			return (JSON.parse(calls[calls.length - 1][1]) as { refreshToken?: string }).refreshToken;
		}

		afterEach(() => {
			global.fetch = realFetch;
		});

		it('(a) expired access token + near-expiry refresh token: the client and the persisted config both hold the successor', async () => {
			const stale = jwtWithExp(Date.now() + 2 * 86_400_000);
			mockCloud({ success: true, accessToken: 'fresh-access', refreshToken: 'successor-rt' });
			mockReadConfig.mockReturnValue(
				cfgRead({ cloudUrl: 'https://api.crewlyai.com', token: 'expired-access-token', tier: 'pro', connectedAt: '2026-03-20T00:00:00Z', refreshToken: stale }),
			);

			const result = await initializeCloudIfConfigured();
			await flush();

			expect(result).toMatchObject({ attempted: true, success: true });
			expect(refreshBodies).toHaveLength(1);
			expect(refreshBodies[0]).toMatchObject({ refreshToken: stale, rotate: true });
			const client = CloudClientService.getInstance();
			expect(client.getRefreshToken()).toBe('successor-rt');
			expect(lastWrittenRefreshToken()).toBe('successor-rt');
		});

		it('(b) the hourly refresh after that startup uses the successor and keeps it', async () => {
			const stale = jwtWithExp(Date.now() + 2 * 86_400_000);
			mockCloud({ success: true, accessToken: 'fresh-access', refreshToken: 'successor-rt' });
			mockReadConfig.mockReturnValue(
				cfgRead({ cloudUrl: 'https://api.crewlyai.com', token: 'expired-access-token', tier: 'pro', connectedAt: '2026-03-20T00:00:00Z', refreshToken: stale }),
			);
			await initializeCloudIfConfigured();
			await flush();

			mockCloud({ success: true, accessToken: 'hourly-access' });
			const client = CloudClientService.getInstance();
			expect(await client.tryRefreshToken()).toBe(true);
			await flush();

			expect(refreshBodies).toHaveLength(1);
			expect(refreshBodies[0].refreshToken).toBe('successor-rt');
			expect(client.getRefreshToken()).toBe('successor-rt');
			expect(lastWrittenRefreshToken()).toBe('successor-rt');
		});

		it('(c) no rotation (refresh token far from expiry): the old behaviour is unchanged', async () => {
			const far = jwtWithExp(Date.now() + 25 * 86_400_000);
			mockCloud({ success: true, accessToken: 'fresh-access' });
			mockReadConfig.mockReturnValue(
				cfgRead({ cloudUrl: 'https://api.crewlyai.com', token: 'expired-access-token', tier: 'pro', connectedAt: '2026-03-20T00:00:00Z', refreshToken: far }),
			);

			await initializeCloudIfConfigured();
			await flush();

			expect(refreshBodies[0].rotate).toBeUndefined();
			expect(CloudClientService.getInstance().getRefreshToken()).toBe(far);
			expect(lastWrittenRefreshToken()).toBe(far);
		});
	});

	it('should log hasRefreshToken correctly when refreshToken is present', async () => {
		const config = {
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token',
			tier: 'free',
			connectedAt: '2026-03-20T00:00:00Z',
			refreshToken: 'rt-123',
		};
		mockReadConfig.mockReturnValue(cfgRead(config));

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(true);
		expect(result.success).toBe(true);
	});

	it('should not fail initialization if CloudSyncService.start throws', async () => {
		const config = {
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token',
			tier: 'pro',
			connectedAt: '2026-03-20T00:00:00Z',
		};
		mockReadConfig.mockReturnValue(cfgRead(config));
		mockSyncStart.mockImplementation(() => { throw new Error('Sync start failed'); });

		const result = await initializeCloudIfConfigured();

		// Should still succeed — sync failure is non-fatal
		expect(result.attempted).toBe(true);
		expect(result.success).toBe(true);
	});

	describe('startSlackCloudSync', () => {
		it('asks the Slack initializer to refresh the Cloud config (non-blocking)', async () => {
			startSlackCloudSync();
			await new Promise((r) => setImmediate(r));
			expect(mockRefreshSlackCloudConfig).toHaveBeenCalledTimes(1);
		});

		it('swallows a failing refresh', async () => {
			mockRefreshSlackCloudConfig.mockRejectedValueOnce(new Error('cloud down'));
			expect(() => startSlackCloudSync()).not.toThrow();
			await new Promise((r) => setImmediate(r));
		});
	});
});
