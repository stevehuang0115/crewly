/**
 * Telegram Service
 *
 * Core service for Telegram Bot API integration with long-polling
 * for incoming messages. Manages bot lifecycle, incoming message
 * polling, and outgoing message delivery.
 *
 * @module services/telegram/telegram
 */

import { EventEmitter } from 'events';
import { TELEGRAM_CONSTANTS } from '../../constants.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { formatError } from '../../utils/format-error.js';
import type { TelegramConfig } from './telegram-credentials.service.js';

/**
 * Telegram Bot API Update object (simplified).
 */
export interface TelegramUpdate {
	/** Unique update identifier */
	update_id: number;
	/** Incoming message (present when a text message is received) */
	message?: TelegramMessage;
}

/**
 * Telegram Bot API Message object (simplified).
 */
export interface TelegramMessage {
	/** Unique message identifier */
	message_id: number;
	/** Sender information */
	from?: {
		id: number;
		is_bot: boolean;
		first_name: string;
		last_name?: string;
		username?: string;
	};
	/** Chat information */
	chat: {
		id: number;
		type: 'private' | 'group' | 'supergroup' | 'channel';
		title?: string;
		first_name?: string;
		last_name?: string;
		username?: string;
	};
	/** Date the message was sent (Unix timestamp) */
	date: number;
	/** Message text */
	text?: string;
	/** If the message is a reply, the original message */
	reply_to_message?: TelegramMessage;
}

/**
 * Incoming message event payload emitted by TelegramService.
 */
export interface TelegramIncomingMessage {
	/** Telegram chat ID */
	chatId: string;
	/** Telegram message ID */
	messageId: number;
	/** Sender user ID */
	userId: string;
	/** Sender display name */
	userName: string;
	/** Message text content */
	text: string;
	/** Unix timestamp */
	timestamp: number;
	/** Reply-to message ID (if replying) */
	replyToMessageId?: number;
}

/**
 * TelegramService manages the Telegram Bot API connection, incoming
 * message polling via getUpdates, and outgoing message delivery.
 *
 * Events:
 * - 'message' — Emitted when a text message is received
 * - 'error' — Emitted on polling errors
 * - 'connected' — Emitted when polling starts
 * - 'disconnected' — Emitted when polling stops
 *
 * @example
 * ```typescript
 * const service = getTelegramService();
 * await service.initialize({ botToken: 'BOT_TOKEN' });
 * service.on('message', (msg) => console.log(msg.text));
 * service.startPolling();
 * ```
 */
export class TelegramService extends EventEmitter {
	private logger: ComponentLogger;
	private config: TelegramConfig | null = null;
	private botInfo: { id: number; username: string } | null = null;
	private polling = false;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private lastUpdateOffset = 0;
	private consecutiveFailures = 0;
	private connected = false;

	constructor() {
		super();
		this.logger = LoggerService.getInstance().createComponentLogger('TelegramService');
	}

	/**
	 * Initialize the Telegram service by validating the bot token.
	 *
	 * @param config - Telegram configuration with bot token
	 * @throws Error if token is invalid or validation fails
	 */
	async initialize(config: TelegramConfig): Promise<void> {
		if (!config.botToken) {
			throw new Error('Telegram bot token is required');
		}

		// Validate token via getMe
		const resp = await fetch(`${TELEGRAM_CONSTANTS.API_BASE}${config.botToken}/getMe`, {
			signal: AbortSignal.timeout(TELEGRAM_CONSTANTS.FETCH_TIMEOUT_MS),
		});

		if (!resp.ok) {
			throw new Error(`Telegram token validation failed (HTTP ${resp.status})`);
		}

		const data = (await resp.json()) as {
			ok: boolean;
			result?: { id: number; username: string };
			description?: string;
		};

		if (!data.ok || !data.result) {
			throw new Error(data.description || 'Telegram token validation failed');
		}

		this.config = config;
		this.botInfo = { id: data.result.id, username: data.result.username };
		this.logger.info('Telegram bot validated', { username: data.result.username });
	}

	/**
	 * Start long-polling for incoming messages.
	 * Emits 'message' events for each incoming text message.
	 */
	startPolling(): void {
		if (this.polling) {
			this.logger.warn('Polling already active');
			return;
		}

		if (!this.config) {
			throw new Error('TelegramService not initialized — call initialize() first');
		}

		this.polling = true;
		this.connected = true;
		this.consecutiveFailures = 0;
		this.emit('connected');
		this.logger.info('Polling started');
		this.poll();
	}

	/**
	 * Stop polling for incoming messages.
	 */
	stopPolling(): void {
		this.polling = false;
		this.connected = false;

		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}

		this.emit('disconnected');
		this.logger.info('Polling stopped');
	}

	/**
	 * Send a text message to a Telegram chat.
	 *
	 * @param chatId - Telegram chat ID
	 * @param text - Message content
	 * @param replyToMessageId - Optional message ID to reply to
	 * @returns The sent message ID
	 * @throws Error if service is not initialized or send fails
	 */
	async sendMessage(
		chatId: string,
		text: string,
		replyToMessageId?: number
	): Promise<number> {
		if (!this.config) {
			throw new Error('TelegramService not initialized');
		}

		// Truncate message if too long
		const truncatedText =
			text.length > TELEGRAM_CONSTANTS.MAX_MESSAGE_LENGTH
				? text.slice(0, TELEGRAM_CONSTANTS.MAX_MESSAGE_LENGTH - 20) + '\n\n...(truncated)'
				: text;

		const body: Record<string, unknown> = {
			chat_id: chatId,
			text: truncatedText,
			parse_mode: 'Markdown',
		};

		if (replyToMessageId) {
			body.reply_to_message_id = replyToMessageId;
		}

		const resp = await fetch(
			`${TELEGRAM_CONSTANTS.API_BASE}${this.config.botToken}/sendMessage`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(TELEGRAM_CONSTANTS.FETCH_TIMEOUT_MS),
			}
		);

		if (!resp.ok) {
			const details = await resp.text();
			throw new Error(`Telegram send failed (${resp.status}): ${details}`);
		}

		const data = (await resp.json()) as {
			ok: boolean;
			result?: { message_id: number };
		};

		return data.result?.message_id ?? 0;
	}

	/**
	 * Check if the service is currently connected and polling.
	 *
	 * @returns True if polling is active
	 */
	isConnected(): boolean {
		return this.connected && this.polling;
	}

	/**
	 * Get the current service status.
	 *
	 * @returns Status object with connection state and bot info
	 */
	getStatus(): Record<string, unknown> {
		return {
			connected: this.isConnected(),
			polling: this.polling,
			botUsername: this.botInfo?.username ?? null,
			botId: this.botInfo?.id ?? null,
			consecutiveFailures: this.consecutiveFailures,
			lastUpdateOffset: this.lastUpdateOffset,
		};
	}

	/**
	 * Disconnect the service and stop polling.
	 */
	async disconnect(): Promise<void> {
		this.stopPolling();
		this.config = null;
		this.botInfo = null;
		this.lastUpdateOffset = 0;
		this.consecutiveFailures = 0;
	}

	/**
	 * Get the bot's username.
	 *
	 * @returns Bot username or null if not initialized
	 */
	getBotUsername(): string | null {
		return this.botInfo?.username ?? null;
	}

	/**
	 * Internal polling loop. Calls getUpdates and schedules next poll.
	 */
	private async poll(): Promise<void> {
		if (!this.polling || !this.config) return;

		try {
			const updates = await this.getUpdates();
			this.consecutiveFailures = 0;

			for (const update of updates) {
				this.processUpdate(update);
			}
		} catch (error) {
			this.consecutiveFailures++;
			this.logger.error('Polling error', {
				error: formatError(error),
				consecutiveFailures: this.consecutiveFailures,
			});
			this.emit('error', error);

			if (this.consecutiveFailures >= TELEGRAM_CONSTANTS.MAX_CONSECUTIVE_FAILURES) {
				this.logger.error('Max consecutive failures reached — pausing polling');
				this.stopPolling();
				return;
			}
		}

		// Schedule next poll
		if (this.polling) {
			this.pollTimer = setTimeout(() => this.poll(), TELEGRAM_CONSTANTS.POLL_INTERVAL_MS);
		}
	}

	/**
	 * Call the Telegram getUpdates API with long polling.
	 *
	 * @returns Array of updates
	 */
	private async getUpdates(): Promise<TelegramUpdate[]> {
		if (!this.config) return [];

		const params = new URLSearchParams({
			timeout: String(TELEGRAM_CONSTANTS.LONG_POLL_TIMEOUT_S),
			allowed_updates: JSON.stringify(['message']),
		});

		if (this.lastUpdateOffset > 0) {
			params.set('offset', String(this.lastUpdateOffset));
		}

		const resp = await fetch(
			`${TELEGRAM_CONSTANTS.API_BASE}${this.config.botToken}/getUpdates?${params}`,
			{
				signal: AbortSignal.timeout(TELEGRAM_CONSTANTS.FETCH_TIMEOUT_MS),
			}
		);

		if (!resp.ok) {
			throw new Error(`getUpdates failed (HTTP ${resp.status})`);
		}

		const data = (await resp.json()) as {
			ok: boolean;
			result?: TelegramUpdate[];
		};

		const updates = data.result ?? [];

		// Update offset to acknowledge processed updates
		if (updates.length > 0) {
			const maxId = Math.max(...updates.map((u) => u.update_id));
			this.lastUpdateOffset = maxId + 1;
		}

		return updates;
	}

	/**
	 * Process a single Telegram update and emit events.
	 *
	 * @param update - The update to process
	 */
	private processUpdate(update: TelegramUpdate): void {
		if (!update.message?.text) return;

		const msg = update.message;

		// Skip messages from bots
		if (msg.from?.is_bot) return;

		// Check allowed users filter
		if (
			this.config?.allowedUserIds &&
			this.config.allowedUserIds.length > 0 &&
			!this.config.allowedUserIds.includes(String(msg.from?.id))
		) {
			this.logger.debug('Message from non-allowed user ignored', {
				userId: msg.from?.id,
			});
			return;
		}

		const incoming: TelegramIncomingMessage = {
			chatId: String(msg.chat.id),
			messageId: msg.message_id,
			userId: String(msg.from?.id ?? 0),
			userName:
				msg.from?.first_name +
				(msg.from?.last_name ? ` ${msg.from.last_name}` : ''),
			text: msg.text!,
			timestamp: msg.date,
			replyToMessageId: msg.reply_to_message?.message_id,
		};

		this.logger.debug('Incoming message', {
			chatId: incoming.chatId,
			userId: incoming.userId,
			textLength: incoming.text.length,
		});

		this.emit('message', incoming);
	}
}

/** Singleton instance */
let instance: TelegramService | null = null;

/**
 * Get the TelegramService singleton.
 *
 * @returns The service instance
 */
export function getTelegramService(): TelegramService {
	if (!instance) {
		instance = new TelegramService();
	}
	return instance;
}

/**
 * Reset the TelegramService singleton (for testing).
 */
export function resetTelegramService(): void {
	if (instance) {
		instance.stopPolling();
		instance.removeAllListeners();
	}
	instance = null;
}
