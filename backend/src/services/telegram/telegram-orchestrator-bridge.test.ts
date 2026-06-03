import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// Create a mock TelegramService (EventEmitter with methods)
const mockTelegramService = Object.assign(new EventEmitter(), {
	sendMessage: jest.fn<(chatId: string, text: string, replyTo?: number) => Promise<number>>().mockResolvedValue(1),
	isConnected: jest.fn<() => boolean>().mockReturnValue(true),
	initialize: jest.fn<(config: unknown) => Promise<void>>().mockResolvedValue(undefined),
	startPolling: jest.fn(),
	stopPolling: jest.fn(),
	disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	getStatus: jest.fn<() => Record<string, unknown>>().mockReturnValue({ connected: true }),
	getBotUsername: jest.fn<() => string | null>().mockReturnValue('testbot'),
});

jest.mock('./telegram.service.js', () => ({
	getTelegramService: () => mockTelegramService,
	TelegramService: jest.fn(),
	resetTelegramService: jest.fn(),
}));

const mockThreadStore = {
	appendUserMessage: jest.fn<(chatId: string, userName: string, message: string) => Promise<void>>().mockResolvedValue(undefined),
	appendBotReply: jest.fn<(chatId: string, message: string) => Promise<void>>().mockResolvedValue(undefined),
};

jest.mock('./telegram-thread-store.service.js', () => ({
	TelegramThreadStoreService: jest.fn(() => mockThreadStore),
	getTelegramThreadStore: () => mockThreadStore,
	setTelegramThreadStore: jest.fn(),
	resetTelegramThreadStore: jest.fn(),
}));

jest.mock('../orchestrator/index.js', () => ({
	isOrchestratorActive: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
	isAgentActive: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
	getOrchestratorOfflineMessage: jest.fn<() => string>().mockReturnValue('Orchestrator is offline'),
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

jest.mock('../../utils/format-error.js', () => ({
	formatError: (e: unknown) => String(e),
}));

import { isOrchestratorActive } from '../orchestrator/index.js';
import { TelegramOrchestratorBridge, resetTelegramOrchestratorBridge } from './telegram-orchestrator-bridge.js';

describe('TelegramOrchestratorBridge', () => {
	let bridge: TelegramOrchestratorBridge;
	const mockQueueService = {
		enqueue: jest.fn(),
	};

	beforeEach(() => {
		jest.clearAllMocks();
		resetTelegramOrchestratorBridge();
		mockTelegramService.removeAllListeners();
		(isOrchestratorActive as jest.MockedFunction<typeof isOrchestratorActive>).mockResolvedValue(true);

		bridge = new TelegramOrchestratorBridge();
		bridge.setMessageQueueService(mockQueueService as any);
	});

	afterEach(() => {
		bridge.destroy();
	});

	describe('initialize', () => {
		it('should subscribe to message events', async () => {
			await bridge.initialize();
			expect(mockTelegramService.listenerCount('message')).toBe(1);
		});

		it('should not initialize twice', async () => {
			await bridge.initialize();
			await bridge.initialize(); // second call is no-op
			expect(mockTelegramService.listenerCount('message')).toBe(1);
		});
	});

	describe('handleIncomingMessage', () => {
		const testMessage = {
			chatId: '12345',
			messageId: 55,
			userId: '42',
			userName: 'Alice',
			text: 'Hello team',
			timestamp: 1700000000,
		};

		it('should enqueue message to queue service', async () => {
			await bridge.initialize();

			mockTelegramService.emit('message', testMessage);
			await new Promise(resolve => setTimeout(resolve, 10));

			expect(mockQueueService.enqueue).toHaveBeenCalledWith(
				expect.objectContaining({
					content: 'Hello team',
					conversationId: 'TELEGRAM-12345',
					source: 'telegram',
					sourceMetadata: expect.objectContaining({
						chatId: '12345',
						messageId: 55,
						userId: '42',
						userName: 'Alice',
						telegramResolve: expect.any(Function),
					}),
				})
			);
		});

		it('should store user message in thread store', async () => {
			await bridge.initialize();

			mockTelegramService.emit('message', testMessage);
			await new Promise(resolve => setTimeout(resolve, 10));

			expect(mockThreadStore.appendUserMessage).toHaveBeenCalledWith('12345', 'Alice', 'Hello team');
		});

		it('should send offline message when orchestrator is inactive', async () => {
			(isOrchestratorActive as jest.MockedFunction<typeof isOrchestratorActive>).mockResolvedValue(false);

			await bridge.initialize();
			mockTelegramService.emit('message', testMessage);
			await new Promise(resolve => setTimeout(resolve, 10));

			expect(mockTelegramService.sendMessage).toHaveBeenCalledWith(
				'12345',
				'Orchestrator is offline',
				55
			);
			expect(mockQueueService.enqueue).not.toHaveBeenCalled();
		});

		it('should send error when no queue service is set', async () => {
			const bridgeWithoutQueue = new TelegramOrchestratorBridge();
			await bridgeWithoutQueue.initialize();

			mockTelegramService.emit('message', testMessage);
			await new Promise(resolve => setTimeout(resolve, 10));

			expect(mockTelegramService.sendMessage).toHaveBeenCalledWith(
				'12345',
				expect.stringContaining('not available'),
				55
			);

			bridgeWithoutQueue.destroy();
		});
	});

	describe('response routing', () => {
		it('should send response back to Telegram when resolved', async () => {
			await bridge.initialize();

			const testMessage = {
				chatId: '12345',
				messageId: 55,
				userId: '42',
				userName: 'Alice',
				text: 'Hello',
				timestamp: 1700000000,
			};

			mockTelegramService.emit('message', testMessage);
			await new Promise(resolve => setTimeout(resolve, 10));

			// Get the resolve callback from enqueue call
			const enqueueCall = mockQueueService.enqueue.mock.calls[0]![0] as {
				sourceMetadata: { telegramResolve: (response: string) => void };
			};
			const resolveCallback = enqueueCall.sourceMetadata.telegramResolve;

			// Simulate orchestrator response
			resolveCallback('Here is your answer');

			await new Promise(resolve => setTimeout(resolve, 10));

			expect(mockTelegramService.sendMessage).toHaveBeenCalledWith(
				'12345',
				'Here is your answer',
				55
			);
		});

		it('should skip the reply when the orchestrator response is empty', async () => {
			await bridge.initialize();

			const testMessage = {
				chatId: '12345',
				messageId: 55,
				userId: '42',
				userName: 'Alice',
				text: 'Hello',
				timestamp: 1700000000,
			};

			mockTelegramService.emit('message', testMessage);
			await new Promise(resolve => setTimeout(resolve, 10));

			const enqueueCall = mockQueueService.enqueue.mock.calls[0]![0] as {
				sourceMetadata: { telegramResolve: (response: string) => void };
			};

			// Simulate an empty/whitespace capture from the PTY-backed orchestrator.
			enqueueCall.sourceMetadata.telegramResolve('   ');
			await new Promise(resolve => setTimeout(resolve, 10));

			// No blank message and no misleading "something went wrong" error are sent,
			// and nothing is stored as a bot reply.
			expect(mockTelegramService.sendMessage).not.toHaveBeenCalled();
			expect(mockThreadStore.appendBotReply).not.toHaveBeenCalled();
		});
	});

	describe('destroy', () => {
		it('should remove all message listeners', async () => {
			await bridge.initialize();
			expect(mockTelegramService.listenerCount('message')).toBe(1);

			bridge.destroy();
			expect(mockTelegramService.listenerCount('message')).toBe(0);
		});
	});
});
