import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockTelegramService = {
	initialize: jest.fn<(config: unknown) => Promise<void>>().mockResolvedValue(undefined),
	startPolling: jest.fn(),
	isConnected: jest.fn<() => boolean>().mockReturnValue(true),
	sendMessage: jest.fn<(chatId: string, text: string, replyTo?: number) => Promise<number>>().mockResolvedValue(1),
	disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	getStatus: jest.fn<() => Record<string, unknown>>().mockReturnValue({ connected: true, botUsername: 'testbot' }),
};

jest.mock('../../telegram/telegram.service.js', () => ({
	getTelegramService: () => mockTelegramService,
}));

import { TelegramMessengerAdapter } from './telegram-messenger.adapter.js';

describe('TelegramMessengerAdapter', () => {
	let adapter: TelegramMessengerAdapter;

	beforeEach(() => {
		jest.clearAllMocks();
		adapter = new TelegramMessengerAdapter();
	});

	describe('platform', () => {
		it('should be telegram', () => {
			expect(adapter.platform).toBe('telegram');
		});
	});

	describe('initialize', () => {
		it('should delegate to TelegramService with mapped config', async () => {
			await adapter.initialize({ token: 'test-token' });
			expect(mockTelegramService.initialize).toHaveBeenCalledWith({ botToken: 'test-token' });
			expect(mockTelegramService.startPolling).toHaveBeenCalled();
		});

		it('should throw when token is missing', async () => {
			await expect(adapter.initialize({})).rejects.toThrow('token is required');
		});
	});

	describe('sendMessage', () => {
		it('should delegate to TelegramService', async () => {
			await adapter.sendMessage('12345', 'Hello!');
			expect(mockTelegramService.sendMessage).toHaveBeenCalledWith('12345', 'Hello!', undefined);
		});

		it('should pass threadId as replyToMessageId', async () => {
			await adapter.sendMessage('12345', 'Reply', { threadId: '55' });
			expect(mockTelegramService.sendMessage).toHaveBeenCalledWith('12345', 'Reply', 55);
		});

		it('should throw when not connected', async () => {
			mockTelegramService.isConnected.mockReturnValueOnce(false);
			await expect(adapter.sendMessage('12345', 'hi')).rejects.toThrow('not connected');
		});
	});

	describe('getStatus', () => {
		it('should return status from TelegramService', () => {
			const status = adapter.getStatus();
			expect(status).toEqual({
				connected: true,
				platform: 'telegram',
				details: { connected: true, botUsername: 'testbot' },
			});
		});
	});

	describe('disconnect', () => {
		it('should delegate to TelegramService', async () => {
			await adapter.disconnect();
			expect(mockTelegramService.disconnect).toHaveBeenCalled();
		});
	});
});
