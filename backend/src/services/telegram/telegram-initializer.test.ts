import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockTelegramService = {
	initialize: jest.fn<(config: unknown) => Promise<void>>().mockResolvedValue(undefined),
	startPolling: jest.fn(),
	isConnected: jest.fn<() => boolean>().mockReturnValue(true),
	disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	stopPolling: jest.fn(),
	removeAllListeners: jest.fn(),
};

const mockBridge = {
	setMessageQueueService: jest.fn(),
	initialize: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	destroy: jest.fn(),
};

jest.mock('./telegram.service.js', () => ({
	getTelegramService: () => mockTelegramService,
	resetTelegramService: jest.fn(),
}));

jest.mock('./telegram-orchestrator-bridge.js', () => ({
	getTelegramOrchestratorBridge: () => mockBridge,
	resetTelegramOrchestratorBridge: jest.fn(),
}));

jest.mock('./telegram-credentials.service.js', () => ({
	loadTelegramCredentials: jest.fn<() => Promise<{ botToken: string } | null>>().mockResolvedValue(null),
}));

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
				debug: jest.fn(),
			}),
		}),
	},
}));

import { loadTelegramCredentials } from './telegram-credentials.service.js';
import {
	initializeTelegramIfConfigured,
	shutdownTelegram,
	isTelegramConfigured,
	getTelegramConfigFromEnv,
	getTelegramConfig,
} from './telegram-initializer.js';

describe('TelegramInitializer', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('isTelegramConfigured', () => {
		it('should return false when TELEGRAM_BOT_TOKEN is not set', () => {
			delete process.env.TELEGRAM_BOT_TOKEN;
			expect(isTelegramConfigured()).toBe(false);
		});

		it('should return true when TELEGRAM_BOT_TOKEN is set', () => {
			process.env.TELEGRAM_BOT_TOKEN = 'test-token';
			expect(isTelegramConfigured()).toBe(true);
		});
	});

	describe('getTelegramConfigFromEnv', () => {
		it('should return null when no env vars set', () => {
			delete process.env.TELEGRAM_BOT_TOKEN;
			expect(getTelegramConfigFromEnv()).toBeNull();
		});

		it('should return config from env vars', () => {
			process.env.TELEGRAM_BOT_TOKEN = 'env-token';
			process.env.TELEGRAM_DEFAULT_CHAT_ID = '999';
			process.env.TELEGRAM_ALLOWED_USERS = '111,222';

			const config = getTelegramConfigFromEnv();
			expect(config).toEqual({
				botToken: 'env-token',
				defaultChatId: '999',
				allowedUserIds: ['111', '222'],
			});
		});
	});

	describe('getTelegramConfig', () => {
		it('should prefer env vars over saved credentials', async () => {
			process.env.TELEGRAM_BOT_TOKEN = 'env-token';
			// Don't set loadTelegramCredentials mock — env vars take priority so it's never called

			const config = await getTelegramConfig();
			expect(config?.botToken).toBe('env-token');
		});

		it('should fall back to saved credentials', async () => {
			delete process.env.TELEGRAM_BOT_TOKEN;
			(loadTelegramCredentials as jest.MockedFunction<typeof loadTelegramCredentials>)
				.mockResolvedValueOnce({ botToken: 'saved-token' });

			const config = await getTelegramConfig();
			expect(config?.botToken).toBe('saved-token');
		});

		it('should return null when nothing is configured', async () => {
			delete process.env.TELEGRAM_BOT_TOKEN;
			(loadTelegramCredentials as jest.MockedFunction<typeof loadTelegramCredentials>)
				.mockResolvedValueOnce(null);

			const config = await getTelegramConfig();
			expect(config).toBeNull();
		});
	});

	describe('initializeTelegramIfConfigured', () => {
		it('should return not attempted when not configured', async () => {
			delete process.env.TELEGRAM_BOT_TOKEN;
			(loadTelegramCredentials as jest.MockedFunction<typeof loadTelegramCredentials>)
				.mockResolvedValueOnce(null);

			const result = await initializeTelegramIfConfigured();
			expect(result).toEqual({ attempted: false, success: false });
		});

		it('should initialize service and bridge when configured', async () => {
			process.env.TELEGRAM_BOT_TOKEN = 'test-token';

			const mockQueue = {} as any;
			const result = await initializeTelegramIfConfigured({ messageQueueService: mockQueue });

			expect(result).toEqual({ attempted: true, success: true });
			expect(mockTelegramService.initialize).toHaveBeenCalledWith(
				expect.objectContaining({ botToken: 'test-token' })
			);
			expect(mockBridge.setMessageQueueService).toHaveBeenCalledWith(mockQueue);
			expect(mockBridge.initialize).toHaveBeenCalled();
			expect(mockTelegramService.startPolling).toHaveBeenCalled();
		});

		it('should return error on initialization failure', async () => {
			process.env.TELEGRAM_BOT_TOKEN = 'bad-token';
			mockTelegramService.initialize.mockRejectedValueOnce(new Error('Invalid token'));

			const result = await initializeTelegramIfConfigured();
			expect(result).toEqual({
				attempted: true,
				success: false,
				error: 'Invalid token',
			});
		});
	});

	describe('shutdownTelegram', () => {
		it('should disconnect when connected', async () => {
			mockTelegramService.isConnected.mockReturnValue(true);
			await shutdownTelegram();
			expect(mockTelegramService.disconnect).toHaveBeenCalled();
		});

		it('should not disconnect when not connected', async () => {
			mockTelegramService.isConnected.mockReturnValue(false);
			await shutdownTelegram();
			expect(mockTelegramService.disconnect).not.toHaveBeenCalled();
		});

		it('should not throw on disconnect error', async () => {
			mockTelegramService.isConnected.mockReturnValue(true);
			mockTelegramService.disconnect.mockRejectedValueOnce(new Error('fail'));
			await expect(shutdownTelegram()).resolves.not.toThrow();
		});
	});
});
