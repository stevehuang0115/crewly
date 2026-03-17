import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

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

jest.mock('../../utils/format-error.js', () => ({
	formatError: (e: unknown) => String(e),
}));

import { TelegramService, resetTelegramService, getTelegramService } from './telegram.service.js';

describe('TelegramService', () => {
	let service: TelegramService;
	const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;

	beforeEach(() => {
		resetTelegramService();
		service = new TelegramService();
		globalThis.fetch = mockFetch;
		mockFetch.mockReset();
		jest.useFakeTimers();
	});

	afterEach(() => {
		service.stopPolling();
		service.removeAllListeners();
		jest.useRealTimers();
	});

	describe('initialize', () => {
		it('should validate bot token via getMe', async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { id: 123, username: 'testbot' } }), { status: 200 })
			);

			await service.initialize({ botToken: 'valid-token' });
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/getMe'),
				expect.any(Object)
			);
		});

		it('should throw on empty bot token', async () => {
			await expect(service.initialize({ botToken: '' })).rejects.toThrow('bot token is required');
		});

		it('should throw on HTTP error from getMe', async () => {
			mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

			await expect(service.initialize({ botToken: 'bad-token' })).rejects.toThrow('validation failed');
		});

		it('should throw when getMe returns ok: false', async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: false, description: 'Invalid token' }), { status: 200 })
			);

			await expect(service.initialize({ botToken: 'bad-token' })).rejects.toThrow('Invalid token');
		});
	});

	describe('startPolling / stopPolling', () => {
		beforeEach(async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { id: 123, username: 'testbot' } }), { status: 200 })
			);
			await service.initialize({ botToken: 'valid-token' });
		});

		it('should emit connected event when polling starts', () => {
			const connectedHandler = jest.fn();
			service.on('connected', connectedHandler);

			mockFetch.mockResolvedValue(
				new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
			);

			service.startPolling();
			expect(connectedHandler).toHaveBeenCalled();
			expect(service.isConnected()).toBe(true);
		});

		it('should emit disconnected event when polling stops', () => {
			const disconnectedHandler = jest.fn();
			service.on('disconnected', disconnectedHandler);

			mockFetch.mockResolvedValue(
				new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
			);

			service.startPolling();
			service.stopPolling();
			expect(disconnectedHandler).toHaveBeenCalled();
			expect(service.isConnected()).toBe(false);
		});

		it('should throw if startPolling called without initialize', () => {
			const uninitService = new TelegramService();
			expect(() => uninitService.startPolling()).toThrow('not initialized');
		});

		it('should not start polling twice', () => {
			mockFetch.mockResolvedValue(
				new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
			);

			service.startPolling();
			service.startPolling(); // should be no-op
			expect(service.isConnected()).toBe(true);
		});
	});

	describe('processUpdate (via polling)', () => {
		beforeEach(async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { id: 123, username: 'testbot' } }), { status: 200 })
			);
			await service.initialize({ botToken: 'valid-token' });
		});

		it('should emit message event for incoming text messages', async () => {
			const messageHandler = jest.fn();
			service.on('message', messageHandler);

			// First poll returns an update
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({
					ok: true,
					result: [{
						update_id: 1001,
						message: {
							message_id: 55,
							from: { id: 42, is_bot: false, first_name: 'Alice', last_name: 'Smith' },
							chat: { id: 100, type: 'private' },
							date: 1700000000,
							text: 'Hello bot',
						},
					}],
				}), { status: 200 })
			);

			service.startPolling();

			// Wait for the async poll to complete
			await jest.advanceTimersByTimeAsync(0);

			expect(messageHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					chatId: '100',
					messageId: 55,
					userId: '42',
					userName: 'Alice Smith',
					text: 'Hello bot',
					timestamp: 1700000000,
				})
			);
		});

		it('should skip bot messages', async () => {
			const messageHandler = jest.fn();
			service.on('message', messageHandler);

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({
					ok: true,
					result: [{
						update_id: 1002,
						message: {
							message_id: 56,
							from: { id: 99, is_bot: true, first_name: 'OtherBot' },
							chat: { id: 100, type: 'private' },
							date: 1700000001,
							text: 'Bot message',
						},
					}],
				}), { status: 200 })
			);

			service.startPolling();
			await jest.advanceTimersByTimeAsync(0);

			expect(messageHandler).not.toHaveBeenCalled();
		});

		it('should skip updates without text', async () => {
			const messageHandler = jest.fn();
			service.on('message', messageHandler);

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({
					ok: true,
					result: [{
						update_id: 1003,
						message: {
							message_id: 57,
							from: { id: 42, is_bot: false, first_name: 'Alice' },
							chat: { id: 100, type: 'private' },
							date: 1700000002,
						},
					}],
				}), { status: 200 })
			);

			service.startPolling();
			await jest.advanceTimersByTimeAsync(0);

			expect(messageHandler).not.toHaveBeenCalled();
		});
	});

	describe('sendMessage', () => {
		beforeEach(async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { id: 123, username: 'testbot' } }), { status: 200 })
			);
			await service.initialize({ botToken: 'valid-token' });
		});

		it('should send message via Bot API', async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 })
			);

			const msgId = await service.sendMessage('12345', 'Hello!');
			expect(msgId).toBe(77);
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('/sendMessage'),
				expect.objectContaining({
					method: 'POST',
				})
			);
		});

		it('should include reply_to_message_id when provided', async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { message_id: 78 } }), { status: 200 })
			);

			await service.sendMessage('12345', 'Reply', 55);

			const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]!;
			const body = JSON.parse((lastCall[1] as RequestInit).body as string);
			expect(body.reply_to_message_id).toBe(55);
		});

		it('should throw when not initialized', async () => {
			const uninitService = new TelegramService();
			await expect(uninitService.sendMessage('123', 'hi')).rejects.toThrow('not initialized');
		});

		it('should throw on API error', async () => {
			mockFetch.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

			await expect(service.sendMessage('123', 'hi')).rejects.toThrow('send failed');
		});

		it('should truncate messages exceeding max length', async () => {
			const longText = 'a'.repeat(5000);
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { message_id: 79 } }), { status: 200 })
			);

			await service.sendMessage('12345', longText);

			const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]!;
			const body = JSON.parse((lastCall[1] as RequestInit).body as string);
			expect(body.text.length).toBeLessThanOrEqual(4096);
			expect(body.text).toContain('...(truncated)');
		});
	});

	describe('getStatus', () => {
		it('should return disconnected status when not initialized', () => {
			const status = service.getStatus();
			expect(status.connected).toBe(false);
			expect(status.botUsername).toBeNull();
		});

		it('should return bot info after initialization', async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { id: 123, username: 'testbot' } }), { status: 200 })
			);
			await service.initialize({ botToken: 'valid-token' });

			const status = service.getStatus();
			expect(status.botUsername).toBe('testbot');
			expect(status.botId).toBe(123);
		});
	});

	describe('disconnect', () => {
		it('should clear state and stop polling', async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { id: 123, username: 'testbot' } }), { status: 200 })
			);
			await service.initialize({ botToken: 'valid-token' });

			mockFetch.mockResolvedValue(
				new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
			);
			service.startPolling();
			expect(service.isConnected()).toBe(true);

			await service.disconnect();
			expect(service.isConnected()).toBe(false);
			expect(service.getBotUsername()).toBeNull();
		});
	});

	describe('singleton', () => {
		it('getTelegramService returns singleton', () => {
			const a = getTelegramService();
			const b = getTelegramService();
			expect(a).toBe(b);
		});

		it('resetTelegramService clears singleton', () => {
			const a = getTelegramService();
			resetTelegramService();
			const b = getTelegramService();
			expect(a).not.toBe(b);
		});
	});

	describe('allowed users filter', () => {
		it('should skip messages from non-allowed users', async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { id: 123, username: 'testbot' } }), { status: 200 })
			);
			await service.initialize({
				botToken: 'valid-token',
				allowedUserIds: ['999'],
			});

			const messageHandler = jest.fn();
			service.on('message', messageHandler);

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({
					ok: true,
					result: [{
						update_id: 2001,
						message: {
							message_id: 60,
							from: { id: 42, is_bot: false, first_name: 'Blocked' },
							chat: { id: 100, type: 'private' },
							date: 1700000010,
							text: 'Should be ignored',
						},
					}],
				}), { status: 200 })
			);

			service.startPolling();
			await jest.advanceTimersByTimeAsync(0);

			expect(messageHandler).not.toHaveBeenCalled();
		});
	});
});
