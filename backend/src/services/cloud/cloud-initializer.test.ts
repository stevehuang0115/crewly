import { initializeCloudIfConfigured } from './cloud-initializer.js';
import { CloudClientService } from './cloud-client.service.js';

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

const mockReadFile = require('fs/promises').readFile as jest.Mock;

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

		const { autoConnectRelayFromToken } = require('../../controllers/cloud/cloud.controller.js');
		expect(autoConnectRelayFromToken).toHaveBeenCalledWith('jwt-token');
	});
});
