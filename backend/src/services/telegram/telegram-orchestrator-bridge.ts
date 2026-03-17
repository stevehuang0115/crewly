/**
 * Telegram-Orchestrator Bridge
 *
 * Routes messages between Telegram and the Crewly orchestrator,
 * enabling mobile control of AI teams via Telegram bot.
 *
 * Flow:
 * 1. TelegramService emits 'message' event for each incoming text
 * 2. This bridge enqueues the message to MessageQueueService
 * 3. QueueProcessor delivers it to the orchestrator
 * 4. ResponseRouter calls the telegramResolve callback
 * 5. Bridge sends the response back to the Telegram chat
 *
 * @module services/telegram/telegram-orchestrator-bridge
 */

import { getTelegramService, TelegramService, TelegramIncomingMessage } from './telegram.service.js';
import {
	getTelegramThreadStore,
	setTelegramThreadStore,
	TelegramThreadStoreService,
} from './telegram-thread-store.service.js';
import { isOrchestratorActive, getOrchestratorOfflineMessage } from '../orchestrator/index.js';
import type { MessageQueueService } from '../messaging/message-queue.service.js';
import { TELEGRAM_CONSTANTS, MESSAGE_QUEUE_CONSTANTS } from '../../constants.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { formatError } from '../../utils/format-error.js';

/**
 * TelegramOrchestratorBridge routes incoming Telegram messages to the
 * orchestrator via the message queue, and sends responses back.
 *
 * @example
 * ```typescript
 * const bridge = getTelegramOrchestratorBridge();
 * bridge.setMessageQueueService(queueService);
 * await bridge.initialize();
 * ```
 */
export class TelegramOrchestratorBridge {
	private logger: ComponentLogger;
	private telegramService: TelegramService;
	private messageQueueService: MessageQueueService | null = null;
	private threadStore: TelegramThreadStoreService;
	private initialized = false;

	constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('TelegramBridge');
		this.telegramService = getTelegramService();
		this.threadStore = new TelegramThreadStoreService();
		setTelegramThreadStore(this.threadStore);
	}

	/**
	 * Set the MessageQueueService for enqueuing incoming messages.
	 *
	 * @param service - The MessageQueueService instance
	 */
	setMessageQueueService(service: MessageQueueService): void {
		this.messageQueueService = service;
	}

	/**
	 * Initialize the bridge by subscribing to TelegramService events.
	 * Must be called after TelegramService.initialize() and startPolling().
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			this.logger.warn('Bridge already initialized');
			return;
		}

		this.telegramService.on('message', (msg: TelegramIncomingMessage) => {
			this.handleIncomingMessage(msg).catch((error) => {
				this.logger.error('Failed to handle incoming message', {
					error: formatError(error),
					chatId: msg.chatId,
				});
			});
		});

		this.initialized = true;
		this.logger.info('Bridge initialized');
	}

	/**
	 * Handle an incoming Telegram message by enqueuing it for the orchestrator.
	 *
	 * @param msg - The incoming Telegram message
	 */
	private async handleIncomingMessage(msg: TelegramIncomingMessage): Promise<void> {
		// Store the message in the thread file
		await this.threadStore.appendUserMessage(msg.chatId, msg.userName, msg.text);

		// Check if orchestrator is active
		if (!(await isOrchestratorActive())) {
			const offlineMsg = getOrchestratorOfflineMessage();
			await this.telegramService.sendMessage(
				msg.chatId,
				offlineMsg,
				msg.messageId
			);
			return;
		}

		// Enqueue via MessageQueueService if available
		if (this.messageQueueService) {
			await this.enqueueMessage(msg);
		} else {
			this.logger.warn('No MessageQueueService — cannot deliver message to orchestrator');
			await this.telegramService.sendMessage(
				msg.chatId,
				'Message queue is not available. Please try again later.',
				msg.messageId
			);
		}
	}

	/**
	 * Enqueue a Telegram message into the message queue with a resolve callback.
	 *
	 * @param msg - The incoming message to enqueue
	 */
	private async enqueueMessage(msg: TelegramIncomingMessage): Promise<void> {
		if (!this.messageQueueService) return;

		// Create a promise that will be resolved by the ResponseRouter
		const responsePromise = new Promise<string>((resolve) => {
			const conversationId = `${TELEGRAM_CONSTANTS.CHAT_PREFIX}-${msg.chatId}`;

			this.messageQueueService!.enqueue({
				content: msg.text,
				conversationId,
				source: 'telegram',
				sourceMetadata: {
					chatId: msg.chatId,
					messageId: msg.messageId,
					userId: msg.userId,
					userName: msg.userName,
					telegramResolve: resolve,
				},
			});
		});

		// Wait for response and send it back to Telegram
		try {
			const response = await Promise.race([
				responsePromise,
				new Promise<string>((_, reject) =>
					setTimeout(
						() => reject(new Error('Response timeout')),
						MESSAGE_QUEUE_CONSTANTS.DEFAULT_MESSAGE_TIMEOUT
					)
				),
			]);

			// Store the bot reply
			await this.threadStore.appendBotReply(msg.chatId, response);

			// Send reply back to Telegram
			await this.telegramService.sendMessage(msg.chatId, response, msg.messageId);
		} catch (error) {
			this.logger.error('Failed to deliver response to Telegram', {
				error: formatError(error),
				chatId: msg.chatId,
			});

			await this.telegramService.sendMessage(
				msg.chatId,
				'Sorry, something went wrong processing your message. Please try again.',
				msg.messageId
			).catch(() => {
				// Swallow send failure for error message
			});
		}
	}

	/**
	 * Clean up the bridge by removing event listeners.
	 */
	destroy(): void {
		this.telegramService.removeAllListeners('message');
		this.initialized = false;
		this.logger.info('Bridge destroyed');
	}
}

/** Singleton instance */
let instance: TelegramOrchestratorBridge | null = null;

/**
 * Get the TelegramOrchestratorBridge singleton.
 *
 * @returns The bridge instance
 */
export function getTelegramOrchestratorBridge(): TelegramOrchestratorBridge {
	if (!instance) {
		instance = new TelegramOrchestratorBridge();
	}
	return instance;
}

/**
 * Reset the TelegramOrchestratorBridge singleton (for testing).
 */
export function resetTelegramOrchestratorBridge(): void {
	if (instance) {
		instance.destroy();
	}
	instance = null;
}
