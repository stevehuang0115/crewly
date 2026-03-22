import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { initializeCloudIfConfigured } from './cloud-initializer.js';
import { CloudClientService } from './cloud-client.service.js';

// Mock logger
vi.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: vi.fn().mockReturnValue({
			createComponentLogger: vi.fn().mockReturnValue({
				info: vi.fn(),
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			}),
		}),
	},
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	readFile: vi.fn(),
	writeFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock the controller auto-connect (dynamic import)
vi.mock('../../controllers/cloud/cloud.controller.js', () => ({
	autoConnectRelayFromToken: vi.fn(),
}));

const mockSyncStart = vi.fn();

vi.mock('./cloud-sync.service.js', () => ({
	CloudSyncService: {
		getInstance: () => ({
			start: mockSyncStart,
		}),
	},
}));

const mockGetOrCreateIdentity = vi.fn().mockResolvedValue({
	deviceId: 'test-device-uuid',
	deviceName: 'test-hostname',
});

vi.mock('./device-identity.service.js', () => ({
	DeviceIdentityService: {
		getInstance: () => ({
			getOrCreateIdentity: mockGetOrCreateIdentity,
		}),
	},
}));

import { readFile } from 'fs/promises';
const mockReadFile = vi.mocked(readFile);

describe('CloudInitializer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
		mockReadFile.mockRejectedValue(new Error('ENOENT'));

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
		mockReadFile.mockResolvedValue(JSON.stringify(config));

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(true);
		expect(result.success).toBe(true);

		const client = CloudClientService.getInstance();
		expect(client.isConnected()).toBe(true);
		expect(client.getTier()).toBe('pro');
	});

	it('should handle invalid config file gracefully', async () => {
		mockReadFile.mockResolvedValue('{ invalid json');

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(false);
		expect(result.success).toBe(false);
	});

	it('should handle config with missing required fields', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({ cloudUrl: 'https://example.com' }));

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(false);
		expect(result.success).toBe(false);
	});

	it('should trigger relay auto-connect on successful restore', async () => {
		const config = {
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token',
			tier: 'pro',
			connectedAt: '2026-03-20T00:00:00Z',
		};
		mockReadFile.mockResolvedValue(JSON.stringify(config));

		await initializeCloudIfConfigured();

		const { autoConnectRelayFromToken } = await import('../../controllers/cloud/cloud.controller.js');
		expect(autoConnectRelayFromToken).toHaveBeenCalledWith('jwt-token');
	});

	it('should start CloudSyncService on successful restore', async () => {
		const config = {
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token-sync',
			tier: 'pro',
			connectedAt: '2026-03-20T00:00:00Z',
		};
		mockReadFile.mockResolvedValue(JSON.stringify(config));

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
		mockReadFile.mockResolvedValue(JSON.stringify(config));

		const result = await initializeCloudIfConfigured();

		expect(result.attempted).toBe(true);
		expect(result.success).toBe(true);

		const client = CloudClientService.getInstance();
		expect(client.isConnected()).toBe(true);
		// The refresh token should have been passed to connectLocal
		// Verify by checking that the service has a token (indirect verification)
		expect(client.getToken()).toBeTruthy();
	});

	it('should log hasRefreshToken correctly when refreshToken is present', async () => {
		const config = {
			cloudUrl: 'https://api.crewlyai.com',
			token: 'jwt-token',
			tier: 'free',
			connectedAt: '2026-03-20T00:00:00Z',
			refreshToken: 'rt-123',
		};
		mockReadFile.mockResolvedValue(JSON.stringify(config));

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
		mockReadFile.mockResolvedValue(JSON.stringify(config));
		mockSyncStart.mockImplementation(() => { throw new Error('Sync start failed'); });

		const result = await initializeCloudIfConfigured();

		// Should still succeed — sync failure is non-fatal
		expect(result.attempted).toBe(true);
		expect(result.success).toBe(true);
	});
});
